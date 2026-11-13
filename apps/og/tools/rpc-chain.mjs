// The Chain the census tool reads Ethereum through: a JSON-RPC node, and two nodes that must say the same. Only the reads the
// resolver makes are here (block, call, logs, storage). The resolver itself never does this: inside Orivon it has no URL to ask.

import { toHex } from '../site/sdk/bytes.js'
import { blockParam, ChainError, parseBytes, parseQuantity, toNumber } from '../site/sdk/chain.js'

/** @typedef {import('../site/sdk/chain.js').Chain} Chain */

const RETRIES = 6
const TIMEOUT_MS = 90_000

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One JSON-RPC request, tried again with a growing pause when the node is busy.
 * @param {string} url
 * @param {string} method
 * @param {unknown[]} params
 * @returns {Promise<unknown>}
 */
async function request (url, method, params) {
  /** @type {unknown} */
  let last
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(TIMEOUT_MS) })
      const text = await response.text()
      if (response.status === 429 || response.status >= 500) throw Object.assign(new Error(`http ${response.status}`), { busy: true })
      const body = JSON.parse(text)
      if (body.error !== undefined) throw Object.assign(new Error(String(body.error.message)), { code: body.error.code, data: body.error.data, busy: body.error.code === -32005 || body.error.code === -32603 })
      return body.result
    } catch (error) {
      last = error
      const busy = !(error instanceof Error) || /** @type {{ busy?: boolean }} */ (error).busy === true || error.name === 'TimeoutError' || error instanceof TypeError || error instanceof SyntaxError
      if (!busy) break
      await pause(1500 * (attempt + 1) ** 2)
    }
  }
  throw last
}

/**
 * @param {unknown} error
 * @param {string} fn
 */
function failure (error, fn) {
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : NaN
  if (code === -32005 || /range|limit|too many|exceed|too large|unavailable/i.test(message)) return new ChainError('limit', `${fn}: ${message}`, { cause: error })
  return new ChainError('unavailable', `${fn}: ${message}`, { cause: error })
}

/** @param {any} raw @returns {import('../site/sdk/chain.js').Log} */
const logOf = (raw) => ({
  address: raw.address, topics: [...raw.topics], data: parseBytes(raw.data), blockNumber: toNumber(raw.blockNumber),
  transactionHash: raw.transactionHash, logIndex: toNumber(raw.logIndex), removed: raw.removed === true
})

/** @param {any} raw @returns {import('../site/sdk/chain.js').Block | null} */
const blockOf = (raw) => raw === null || raw === undefined
  ? null
  : {
      number: toNumber(raw.number), hash: raw.hash, parentHash: raw.parentHash, timestamp: toNumber(raw.timestamp), gasLimit: toNumber(raw.gasLimit),
      gasUsed: toNumber(raw.gasUsed), miner: raw.miner, transactions: raw.transactions.map((/** @type {any} */ tx) => typeof tx === 'string' ? tx : tx.hash),
      baseFeePerGas: raw.baseFeePerGas === undefined || raw.baseFeePerGas === null ? null : parseQuantity(raw.baseFeePerGas)
    }

/** The reads the census tool makes of one node. @param {string} url @returns {Chain} */
export function rpcChain (url) {
  const ask = async (/** @type {string} */ method, /** @type {unknown[]} */ params, /** @type {string} */ fn = method) => {
    try {
      return await request(url, method, params)
    } catch (error) {
      throw failure(error, fn)
    }
  }
  const unsupported = async () => { throw new ChainError('invalid', 'the census tool does not make this call') }
  return /** @type {Chain} */ ({
    kind: 'eip1193',
    chainId: async () => toNumber(await ask('eth_chainId', [])),
    blockNumber: async () => toNumber(await ask('eth_blockNumber', [])),
    getBlock: async (ref) => blockOf(await ask('eth_getBlockByNumber', [blockParam(ref), false], 'getBlock')),
    call: async (tx, ref) => {
      try {
        const answer = await request(url, 'eth_call', [{ to: tx.to, data: tx.data === undefined ? '0x' : `0x${toHex(tx.data)}` }, blockParam(ref)])
        return { data: parseBytes(answer), revert: null, offchainLookup: null }
      } catch (error) {
        const data = /** @type {any} */ (error)?.data
        if (/revert/i.test(String(/** @type {any} */ (error)?.message))) return { data: null, revert: typeof data === 'string' ? parseBytes(data) : new Uint8Array(0), offchainLookup: null }
        throw failure(error, 'call')
      }
    },
    getLogs: async (filter) => {
      const logs = await ask('eth_getLogs', [{ fromBlock: blockParam(filter.fromBlock), toBlock: blockParam(filter.toBlock), address: filter.address, topics: filter.topics }], 'getLogs')
      if (!Array.isArray(logs)) throw new ChainError('badAnswer', 'getLogs: the logs are not a list')
      return logs.map(logOf)
    },
    getCode: async (address, ref) => parseBytes(await ask('eth_getCode', [address, blockParam(ref)], 'getCode')),
    getStorageAt: async (address, slot, ref) => parseBytes(await ask('eth_getStorageAt', [address, slot, blockParam(ref)], 'getStorageAt')),
    getTransactionCount: unsupported,
    estimateGas: unsupported,
    gasPrice: unsupported,
    maxPriorityFeePerGas: unsupported,
    getTransactionReceipt: unsupported,
    addresses: unsupported,
    signMessage: unsupported,
    sendTransaction: unsupported,
    waitForReceipt: unsupported
  })
}

/** Two nodes answered the same read differently. Not a `ChainError`: no part of the cut may take it for the contract's own failure. */
export class NodesDisagree extends Error {
  /** @param {string} message */
  constructor (message) {
    super(message)
    this.name = 'NodesDisagree'
  }
}

/** @param {unknown} value */
const canonical = (value) => JSON.stringify(value, (_key, item) => item instanceof Uint8Array ? `0x${toHex(item)}` : typeof item === 'bigint' ? item.toString() : item)

/** @param {Uint8Array | string | number | object | null | undefined} answer */
const sortedLogs = (answer) => Array.isArray(answer) ? [...answer].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex) : answer

/**
 * Two nodes as one: every read is made of both and compared, and the answer is the one they share. Two answers that differ throw,
 * naming the read: a public node can drop a log that exists, and a count of logs that came from one node alone proves nothing.
 * @param {Chain} first
 * @param {Chain} second
 * @param {{ names?: [string, string] }} [options] what to call each in a failure
 * @returns {Chain}
 */
export function agreeingChain (first, second, options = {}) {
  const [one, two] = options.names ?? ['the first node', 'the second node']
  const both = (/** @type {keyof Chain} */ method) => async (/** @type {unknown[]} */ ...args) => {
    const [a, b] = await Promise.all([/** @type {Function} */ (first[method])(...args), /** @type {Function} */ (second[method])(...args)])
    const [left, right] = method === 'getLogs' ? [sortedLogs(a), sortedLogs(b)] : [a, b]
    if (canonical(left) !== canonical(right)) throw new NodesDisagree(`${one} and ${two} disagree about ${String(method)}(${canonical(args).slice(0, 300)})`)
    return a
  }
  return /** @type {Chain} */ ({ kind: 'eip1193', chainId: both('chainId'), getBlock: both('getBlock'), call: both('call'), getLogs: both('getLogs'), getCode: both('getCode'), getStorageAt: both('getStorageAt') })
}
