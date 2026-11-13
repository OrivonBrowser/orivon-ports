// The Chain over `orivon.use`: reads through ETH_NET_0_1_READONLY (the person's light client), the address and
// signatures through ETH_0_1, and the broadcast through ETH_NET_0_1. Each code is asked for the first time a
// call needs it and no sooner, with only the groups that call needs, so a visitor who only searches is never
// asked for a wallet.

import { keccak256 } from './keccak.js'
import { toHex } from './bytes.js'
import {
  blockParam, ChainError, checkLogSpan, parseQuantity, pollReceipt, quantityHex, suggestFees, toAddressList
} from './chain.js'

/** @typedef {import('./chain.js').Chain} Chain */
/** @typedef {import('./chain.js').TxRequest} TxRequest */
/** @typedef {(code: string[], options?: { groups?: string[] }) => Promise<readonly (Record<string, any> | null)[]>} OrivonUse */

const READ_CODE = 'ETH_NET_0_1_READONLY'

/**
 * What the answering integration takes of one code from one page: 16 calls in flight, and a bucket of 64 calls that gains 8 a
 * second. The queue keeps under both: 8 in flight, a bucket of 48 and 7 a second, so a call is refused as `limit` only when
 * another reader of the same code has spent the rest.
 */
export const QUEUE_LIMITS = Object.freeze({ inFlight: 8, burst: 48, perSecond: 7, retries: 5, backoffMs: 250 })

/**
 * Runs calls so that no more than `inFlight` are open and the calls started never outrun a bucket of `burst` that gains
 * `perSecond` a second. A call refused as `limit` goes back to the front, the bucket counts as empty and the whole queue
 * waits, doubling from `backoffMs`, because the integration's bucket that refused one refuses the next; after `retries`
 * refusals the call fails with the last one.
 * @param {{ inFlight?: number, burst?: number, perSecond?: number, retries?: number, backoffMs?: number }} [limits]
 */
export function callQueue (limits = {}) {
  const { inFlight = QUEUE_LIMITS.inFlight, burst = QUEUE_LIMITS.burst, perSecond = QUEUE_LIMITS.perSecond } = limits
  const { retries = QUEUE_LIMITS.retries, backoffMs = QUEUE_LIMITS.backoffMs } = limits
  /** @type {{ task: () => Promise<unknown>, tries: number, resolve: (value: unknown) => void, reject: (error: unknown) => void }[]} */
  const waiting = []
  let open = 0
  let tokens = burst
  let counted = Date.now()
  let pausedUntil = 0
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let wake

  function pump () {
    if (wake !== undefined) return
    while (waiting.length > 0 && open < inFlight) {
      const now = Date.now()
      tokens = Math.min(burst, tokens + ((now - counted) * perSecond) / 1000)
      counted = now
      const wait = Math.max(pausedUntil - now, tokens >= 1 ? 0 : Math.ceil(((1 - tokens) * 1000) / perSecond))
      if (wait > 0) {
        wake = setTimeout(() => { wake = undefined; pump() }, wait)
        return
      }
      tokens -= 1
      launch(/** @type {NonNullable<(typeof waiting)[number]>} */ (waiting.shift()))
    }
  }

  /** @param {(typeof waiting)[number]} item */
  function launch (item) {
    open++
    item.task().then(item.resolve, (error) => {
      if (error instanceof ChainError && error.reason === 'limit' && item.tries < retries) {
        pausedUntil = Math.max(pausedUntil, Date.now() + backoffMs * 2 ** item.tries)
        tokens = 0
        item.tries++
        waiting.unshift(item)
      } else item.reject(error)
    }).finally(() => { open--; pump() })
  }

  return {
    /** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
    run (task) {
      return new Promise((resolve, reject) => {
        waiting.push({ task, tries: 0, resolve: /** @type {(value: unknown) => void} */ (resolve), reject })
        pump()
      })
    }
  }
}

/** @type {WeakMap<object, ReturnType<typeof callQueue>>} the one queue of each page's `orivon`, whichever chains are made over it */
const queues = new WeakMap()

/** @type {WeakMap<object, Map<string, number>>} the last nonce each account broadcast from this page, by the page's `orivon` */
const broadcast = new WeakMap()

/**
 * The nonce of an account's next transaction: the node's count of mined ones, or one past the last this page
 * broadcast when the node has not caught up with it. ETH_NET_0_1 answers `latest`, `finalized`, `safe`, a number or a
 * hash and refuses `pending` (its light client sees no mempool), so a transaction still waiting is known only from here.
 * A reload starts again from the node's count.
 * @param {object} orivon the page's `orivon`
 * @param {string} account
 * @param {number} mined `getTransactionCount(account, 'latest')`
 */
export function nonceAfter (orivon, account, mined) {
  const last = broadcast.get(orivon)?.get(account.toLowerCase())
  return last === undefined ? mined : Math.max(mined, last + 1)
}

/** Records that a transaction with this nonce went out, or may have. @param {object} orivon @param {string} account @param {number} nonce */
export function noteBroadcast (orivon, account, nonce) {
  let book = broadcast.get(orivon)
  if (book === undefined) broadcast.set(orivon, book = new Map())
  const key = account.toLowerCase()
  book.set(key, Math.max(book.get(key) ?? nonce, nonce))
}

/**
 * What a failed handle call or `use` means to the site. A `denied` or `closed` is the person (or the grant being
 * taken back); `unavailable` is the answering integration being gone.
 * @param {unknown} error
 * @param {string} [fn]
 */
export function fromOrivonError (error, fn = '') {
  if (error instanceof ChainError) return error
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : 'Orivon refused the call'
  const cause = { cause: error }
  if (code === 'denied' || code === 'revoked' || code === 'closed') return new ChainError('declined', message, cause)
  if (code === 'timeout') return new ChainError('timeout', message, cause)
  if (code === 'limit') return new ChainError('limit', message, cause)
  if (code === 'invalid') return new ChainError(fn === 'estimateGas' ? 'reverted' : 'invalid', message, cause)
  return new ChainError('unavailable', message, cause)
}

/** The wire form of a transaction: no undefined field, quantities as hex strings, data as its own buffer. @param {{ [key: string]: unknown, data?: Uint8Array | undefined }} tx */
function wireTx (tx) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of ['from', 'to', 'gas', 'nonce', 'chainId']) {
    const value = /** @type {Record<string, unknown>} */ (tx)[key]
    if (value !== undefined) out[key] = value
  }
  for (const key of ['value', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
    const value = /** @type {Record<string, bigint | undefined>} */ (tx)[key]
    if (value !== undefined) out[key] = quantityHex(value)
  }
  if (tx.data !== undefined) out['data'] = tx.data.slice()
  return out
}

/** @param {any} raw @returns {import('./chain.js').Log} */
function logOf (raw) {
  return {
    address: raw.address, topics: [...raw.topics], data: raw.data, blockNumber: raw.blockNumber,
    transactionHash: raw.transactionHash, logIndex: raw.logIndex, removed: raw.removed === true
  }
}

/** @param {any} raw @returns {import('./chain.js').Block | null} */
function blockOf (raw) {
  if (raw === null) return null
  return {
    number: raw.number, hash: raw.hash, parentHash: raw.parentHash, timestamp: raw.timestamp,
    gasLimit: raw.gasLimit, gasUsed: raw.gasUsed, miner: raw.miner, transactions: [...raw.transactions],
    baseFeePerGas: raw.baseFeePerGas === null ? null : parseQuantity(raw.baseFeePerGas)
  }
}

/** @param {any} raw @returns {import('./chain.js').Receipt | null} */
function receiptOf (raw) {
  if (raw === null) return null
  return {
    transactionHash: raw.transactionHash, blockHash: raw.blockHash, blockNumber: raw.blockNumber,
    status: raw.status, gasUsed: raw.gasUsed, effectiveGasPrice: parseQuantity(raw.effectiveGasPrice),
    contractAddress: raw.contractAddress, logs: raw.logs.map(logOf)
  }
}

/**
 * @param {{ use: OrivonUse }} orivon the page's `window.orivon`, or the `use` of the call being served
 * @param {{ queue?: ReturnType<typeof callQueue> }} [options] `queue`: the one queue of a page whose chains are made per call, so that
 *   every call the page makes keeps under the limits together, not each chain on its own
 * @returns {Chain}
 */
export function orivonChain (orivon, options = {}) {
  /** @type {Map<string, Promise<readonly (Record<string, any> | null)[]>>} */
  const asked = new Map()

  /**
   * One question per set of codes and groups; a failed one is asked again next time, an answer is kept.
   * @param {string[]} codes @param {string[]} [groups]
   */
  async function grant (codes, groups) {
    const key = `${codes.join()}|${(groups ?? []).join()}`
    let pending = asked.get(key)
    if (pending === undefined) {
      pending = orivon.use(codes, groups === undefined ? undefined : { groups }).catch((error) => {
        asked.delete(key)
        throw fromOrivonError(error)
      })
      asked.set(key, pending)
    }
    const handles = await pending
    if (handles.every((handle) => handle === null)) throw new ChainError('declined', 'the person did not allow it')
    return handles
  }

  /** @param {Record<string, any> | null | undefined} handle @param {string} fn @param {unknown[]} args */
  async function invoke (handle, fn, args) {
    const member = handle?.[fn]
    if (typeof member !== 'function') throw new ChainError('declined', `${fn} was not allowed`)
    try {
      return await member(...args)
    } catch (error) {
      throw fromOrivonError(error, fn)
    }
  }

  let queue = options.queue ?? queues.get(orivon)
  if (queue === undefined) queues.set(orivon, queue = callQueue())
  const lined = queue
  const read = async (/** @type {string} */ fn, /** @type {unknown[]} */ ...args) => {
    const handle = (await grant([READ_CODE]))[0]
    return await lined.run(() => invoke(handle, fn, args))
  }
  const wallet = async (/** @type {string[]} */ groups) => (await grant(['ETH_0_1'], groups))[0]

  /** @type {Promise<number> | undefined} */
  let walletChain

  async function addresses () {
    return /** @type {string[]} */ (await invoke(await wallet(['addresses']), 'getAddresses', []))
  }

  async function sendTransaction (/** @type {TxRequest} */ tx) {
    const [eth, net] = await grant(['ETH_0_1', 'ETH_NET_0_1'], ['addresses', 'sign', 'broadcast'])
    const from = tx.from ?? /** @type {string[]} */ (await invoke(eth, 'getAddresses', []))[0]
    if (from === undefined) throw new ChainError('declined', 'no address was given')
    walletChain ??= invoke(eth, 'chainId', []).catch((error) => { walletChain = undefined; throw error })
    const filled = { ...tx, from }
    filled.nonce ??= nonceAfter(orivon, from, /** @type {number} */ (await read('getTransactionCount', from, 'latest')))
    if (filled.gas === undefined) {
      const estimate = /** @type {number} */ (await read('estimateGas', wireTx({ from, to: tx.to, data: tx.data, value: tx.value }), 'latest'))
      filled.gas = Math.ceil((estimate * 12) / 10)
    }
    if (filled.gasPrice === undefined && filled.maxFeePerGas === undefined) {
      const fees = await suggestFees(chain)
      if (fees === null) filled.gasPrice = await chain.gasPrice()
      else Object.assign(filled, fees)
    }
    const signed = /** @type {Uint8Array} */ (await invoke(eth, 'signTransaction', [wireTx({ ...filled, chainId: await walletChain })]))
    const hash = '0x' + toHex(keccak256(signed))
    try {
      const answered = await invoke(net, 'sendRawTransaction', [signed])
      noteBroadcast(orivon, from, filled.nonce)
      if (String(answered).toLowerCase() !== hash) throw new ChainError('badAnswer', 'the node answered another transaction hash', { hash })
    } catch (error) {
      if (error instanceof ChainError && error.reason === 'timeout') {
        noteBroadcast(orivon, from, filled.nonce)
        throw new ChainError('unknownOutcome', 'the broadcast took too long to know whether it went out', { cause: error, hash })
      }
      throw error
    }
    return hash
  }

  /** @type {Chain} */
  const chain = {
    kind: 'orivon',
    chainId: async () => /** @type {number} */ (await read('chainId')),
    blockNumber: async () => /** @type {number} */ (await read('blockNumber')),
    getBlock: async (ref) => blockOf(await read('getBlock', blockParam(ref, true))),
    call: async (tx, ref, options) => /** @type {any} */ (await read('call', wireTx(tx), blockParam(ref), ...(options === undefined ? [] : [options]))),
    getLogs: async (filter) => {
      checkLogSpan(filter)
      const wire = { fromBlock: blockParam(filter.fromBlock), toBlock: blockParam(filter.toBlock) }
      const address = toAddressList(filter.address)
      const logs = /** @type {any[]} */ (await read('getLogs', {
        ...wire, ...(address.length === 0 ? {} : { address }), ...(filter.topics === undefined ? {} : { topics: filter.topics })
      }))
      return logs.map(logOf)
    },
    getCode: async (address, ref) => /** @type {Uint8Array} */ (await read('getCode', address, blockParam(ref))),
    getStorageAt: async (address, slot, ref) => /** @type {Uint8Array} */ (await read('getStorageAt', address, slot, blockParam(ref))),
    getTransactionCount: async (address, ref) => /** @type {number} */ (await read('getTransactionCount', address, blockParam(ref))),
    estimateGas: async (tx, ref) => /** @type {number} */ (await read('estimateGas', wireTx(tx), blockParam(ref))),
    gasPrice: async () => parseQuantity(await read('gasPrice')),
    maxPriorityFeePerGas: async () => parseQuantity(await read('maxPriorityFeePerGas')),
    getTransactionReceipt: async (hash) => receiptOf(await read('getTransactionReceipt', hash)),
    addresses,
    signMessage: async (message) => /** @type {Uint8Array} */ (await invoke(await wallet(['addresses', 'sign']), 'signMessage', [message.slice()])),
    sendTransaction,
    waitForReceipt: async (hash, options) => await pollReceipt(chain, hash, options)
  }
  return chain
}
