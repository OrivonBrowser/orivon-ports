// How the node reads Ethereum: through the browser's light client when the browser has one and the person allowed it, and from the public
// servers the desktop clients use when it has not or when a read through it fails. Only reads, never a transaction.
//
// pkc-js's name resolvers and the evm-contract challenge read through viem, which sends JSON-RPC over `fetch`. The Worker answers those
// requests in its own process (`installFetchHook`, as it does for the kubo API: no socket, no port), at `ETHEREUM_ORIGIN`: the node's one
// name resolver is given it in place of the desktop clients' six public servers, and the evm-contract challenge is given it as its server
// when its owner named none (`readingFrom` in challenges.js). Each request is read through `orivon.use('ETH_NET_0_1_READONLY')`, which works in a
// forked child as in a page (the question the first use asks is drawn in the app's own tab), and, when that cannot answer, from the
// endpoint's public servers in order, so a browser with no light client reads as the desktop does. The browser's own answer to a revert
// is the answer here too: it is never asked again of the public servers.
//
// The evm-contract challenge reads an author's .eth or .bso name on Ethereum with a client of its own, whatever chain the board is on, and for a board on
// another chain that client asks the server its copy of viem names for Ethereum (`VIEM_MAINNET_URL`), which no option changes. Where the browser has a light client
// the Worker answers that one address as it answers its own (`ensRoute`), so a name is read as the board's own reads are, and nothing else is changed.

/** The code a light client is asked for. */
export const LIGHT_CLIENT_CODE = 'ETH_NET_0_1_READONLY'

/** The address the node's name resolver is given. `.invalid` never resolves, so a request that missed the hook would fail rather than reach a server. */
export const ETHEREUM_ORIGIN = 'http://ethereum.orivon.invalid'

/**
 * The server the evm-contract challenge's own copy of viem names for Ethereum: the one `mainnet` of that copy's chain table gives, which `viem` resolves from the
 * challenge package and not from this Worker (the Worker's own copy names another). A test reads it from that copy, so an update of the package that changes it fails there.
 */
export const VIEM_MAINNET_URL = 'https://ethereum.reth.rs/rpc'

/** How long a read waits for the light client (its handle, its place among the reads in flight, and its answer) before the public servers are asked. */
export const LIGHT_MS = 8_000
/** How long one public server is given before the next is asked. */
export const PUBLIC_MS = 5_000
/** How long the light client is left alone after the browser gave no handle or two reads in a row failed. */
export const OFF_MS = 30_000
/** How many reads the light client is given at once (the browser allows 16 for a code). */
const IN_FLIGHT = 8
/** How many requests one batch may hold. */
const BATCH_MAX = 100
const FAILURES_BEFORE_OFF = 2
/** What a read that ran out of time resolves with, so it is told from any answer. */
const TIMED_OUT = Symbol('timed out')

/**
 * The methods a read may be made with, through either path. Everything else is refused, so a method that signs or sends reaches no one.
 * `eth_createAccessList` and `eth_feeHistory` are reads the light client does not carry, and the public servers do.
 */
const READS = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_estimateGas',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getBlockReceipts', 'eth_getLogs', 'eth_getProof', 'eth_syncing', 'eth_createAccessList', 'web3_clientVersion', 'net_listening'
])

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/
/** What the standard calls a quantity: `0x` and digits with no leading zero, `0x0` for zero. */
const SPELLED = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/
const TAGS = new Set(['latest', 'finalized', 'safe'])

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether `orivon` offers an app a light client: a browser with `orivon.use` as a function. v0.1.0 answers a namespace of calls there, which is no such function. @param {unknown} orivon */
export function canUseLightClient (orivon) {
  return typeof /** @type {any} */ (orivon)?.use === 'function'
}

/** @param {Uint8Array} bytes */
const hexOfBytes = (bytes) => `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
/** @param {string} text */
const bytesOfHex = (text) => Uint8Array.from({ length: (text.length - 2) / 2 }, (_, at) => parseInt(text.slice(2 + at * 2, 4 + at * 2), 16))
/** @param {number} value */
const hexOfNumber = (value) => `0x${value.toString(16)}`

/** A hexadecimal quantity as a safe integer, or null. @param {unknown} value */
function wholeOf (value) {
  if (typeof value !== 'string' || !QUANTITY.test(value)) return null
  const number = BigInt(value)
  return number > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(number)
}

/**
 * A block as the standard reads one: a tag, a hexadecimal number or a block hash; `pending` is `latest` (a light client sees no mempool), `earliest` is
 * block 0, and EIP-1898's object names a number or a hash. Null for anything else, which is left to the public servers.
 * @param {unknown} value @returns {string | null}
 */
function blockOf (value) {
  if (isRecord(value)) {
    const keys = Object.keys(value)
    return keys.length === 1 && (keys[0] === 'blockNumber' || keys[0] === 'blockHash') ? blockOf(value[keys[0]]) : null
  }
  if (typeof value !== 'string') return null
  if (TAGS.has(value)) return value
  if (value === 'pending') return 'latest'
  if (value === 'earliest') return '0x0'
  if (HASH.test(value)) return value
  return QUANTITY.test(value) ? `0x${BigInt(value).toString(16)}` : null
}

/** The transaction object of `eth_call` and `eth_estimateGas` as the standard takes it, or null when it holds what the standard has no name for. @param {unknown} value */
function transactionOf (value) {
  if (!isRecord(value)) return null
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, given] of Object.entries(value)) {
    switch (key) {
      case 'from': case 'to': if (typeof given !== 'string' || !ADDRESS.test(given)) return null; out[key] = given; break
      case 'gas': case 'nonce': { const number = wholeOf(given); if (number === null) return null; out[key] = number; break }
      case 'gasPrice': case 'maxFeePerGas': case 'maxPriorityFeePerGas': case 'value': if (typeof given !== 'string' || !SPELLED.test(given)) return null; out[key] = given; break
      case 'data': case 'input': {
        if (typeof given !== 'string' || !HEX.test(given)) return null
        if (key === 'input' && value['data'] !== undefined && value['data'] !== given) return null
        if (given.length > 2) out['data'] = bytesOfHex(given)
        break
      }
      default: return null
    }
  }
  return out
}

/** @param {unknown} value */
const addressOf = (value) => (typeof value === 'string' && ADDRESS.test(value) ? value : null)

/**
 * @typedef {{ fn: string, args: unknown[], shape: 'quantity' | 'text' | 'bytes' | 'call' }} Plan
 */

/**
 * The call on the light client a JSON-RPC read stands for, or null when the module has none (a block, a receipt, logs, a proof, fee history) or the parameters hold
 * something it has no name for: those are read from the public servers, as they were.
 * @param {string} method @param {unknown} params @returns {Plan | null}
 */
export function planOf (method, params) {
  const list = Array.isArray(params) ? params : []
  const block = (/** @type {unknown} */ given) => (given === undefined ? [] : [blockOf(given)])
  /** @param {Plan} plan */
  const checked = (plan) => (plan.args.some((one) => one === null) ? null : plan)
  switch (method) {
    case 'eth_chainId': return list.length === 0 ? { fn: 'chainId', args: [], shape: 'quantity' } : null
    case 'eth_blockNumber': return list.length === 0 ? { fn: 'blockNumber', args: [], shape: 'quantity' } : null
    case 'eth_gasPrice': return list.length === 0 ? { fn: 'gasPrice', args: [], shape: 'text' } : null
    case 'eth_maxPriorityFeePerGas': return list.length === 0 ? { fn: 'maxPriorityFeePerGas', args: [], shape: 'text' } : null
    case 'eth_getBalance': return list.length >= 1 && list.length <= 2 ? checked({ fn: 'getBalance', args: [addressOf(list[0]), ...block(list[1])], shape: 'text' }) : null
    case 'eth_getTransactionCount': return list.length >= 1 && list.length <= 2 ? checked({ fn: 'getTransactionCount', args: [addressOf(list[0]), ...block(list[1])], shape: 'quantity' }) : null
    case 'eth_getCode': return list.length >= 1 && list.length <= 2 ? checked({ fn: 'getCode', args: [addressOf(list[0]), ...block(list[1])], shape: 'bytes' }) : null
    case 'eth_getStorageAt': {
      const slot = typeof list[1] === 'string' && QUANTITY.test(list[1]) ? list[1] : null
      return list.length >= 2 && list.length <= 3 ? checked({ fn: 'getStorageAt', args: [addressOf(list[0]), slot, ...block(list[2])], shape: 'bytes' }) : null
    }
    case 'eth_call': case 'eth_estimateGas': return list.length >= 1 && list.length <= 2
      ? checked({ fn: method === 'eth_call' ? 'call' : 'estimateGas', args: [transactionOf(list[0]), ...block(list[1])], shape: method === 'eth_call' ? 'call' : 'quantity' })
      : null
    default: return null
  }
}

/** Whether the plan is a call that names no contract. @param {Plan} plan */
const isDeployless = (plan) => plan.fn === 'call' && isRecord(plan.args[0]) && plan.args[0]['to'] === undefined

/**
 * What stands in front of `VIEM_MAINNET_URL`: the node's Ethereum endpoint, for that address and its one path. Only a POST of a JSON-RPC read is answered (the endpoint
 * refuses every method that is not a read, so a transaction or a signature reaches no one), and anything else sent to that address gets a refusal here, never the network.
 * @param {{ handle: (request: Request) => Promise<Response> }} endpoint what `createEthereumReads(...).endpoint(servers)` returns
 */
export function ensRoute (endpoint) {
  const path = new URL(VIEM_MAINNET_URL).pathname
  return {
    /** @param {Request} request */
    async handle (request) {
      if (new URL(request.url).pathname !== path) return new Response('not served', { status: 404 })
      return await endpoint.handle(request)
    }
  }
}

/** An error a JSON-RPC answer carries. */
class RpcFailure extends Error {
  /** @param {number} code @param {string} message @param {string} [data] */
  constructor (code, message, data) { super(message); this.code = code; if (data !== undefined) this.data = data }
}

/**
 * The light client's answer to a read, as a JSON-RPC node answers it: numbers and bytes as hexadecimal, amounts as the standard already spells them, and a revert as the
 * error a node gives, with the return data a library decodes the reason from. A shape the standard does not promise is the browser failing, and is thrown as such.
 * @param {Plan['shape']} shape @param {unknown} value
 */
function resultOf (shape, value) {
  const broken = () => Object.assign(new Error('the light client answered in a shape the standard does not have'), { code: 'unavailable' })
  switch (shape) {
    case 'quantity': if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw broken(); return hexOfNumber(value)
    case 'text': if (typeof value !== 'string' || !SPELLED.test(value)) throw broken(); return value
    case 'bytes': if (!(value instanceof Uint8Array)) throw broken(); return hexOfBytes(value)
    case 'call': {
      if (!isRecord(value)) throw broken()
      if (value['revert'] instanceof Uint8Array) throw new RpcFailure(3, 'execution reverted', hexOfBytes(value['revert']))
      if (value['data'] instanceof Uint8Array) return hexOfBytes(value['data'])
      // An offchain lookup is followed by the browser itself unless asked not to, and this never asks it not to.
      throw broken()
    }
    default: throw broken()
  }
}

/** The code of a refusal by the browser, or `error`. @param {unknown} error */
const codeOf = (error) => String(/** @type {any} */ (error)?.code ?? 'error')

/**
 * @typedef {object} ReadsOptions
 * @property {{ use: (code: string) => Promise<any> }} orivon the Worker's `orivon`, of a browser that has `canUseLightClient`
 * @property {typeof fetch} fetch the process's own fetch, as it is before any hook (the public servers are asked with it)
 * @property {() => number} [now]
 * @property {(line: string) => void} [warn] a line for the bug report: a refusal of the standard, never an address or a value
 * @property {number} [lightMs] @property {number} [publicMs] @property {number} [offMs]
 */

/**
 * @param {ReadsOptions} options
 */
export function createEthereumReads ({ orivon, fetch, now = Date.now, warn = () => {}, lightMs = LIGHT_MS, publicMs = PUBLIC_MS, offMs = OFF_MS }) {
  /** @type {any} */
  let handle = null
  /** @type {Promise<any> | null} */
  let asking = null
  /** Why the light client is not the path: what the browser said, and until when it is left alone. @type {{ why: string, until: number } | null} */
  let off = null
  let failures = 0
  let running = 0
  /** @type {Array<() => void>} */
  const waiting = []
  const counts = { lightClient: 0, public: 0 }

  /** Resolves with `work`'s outcome, or with `onTime` after `ms`. @template T @param {Promise<T>} work @param {number} ms @param {T} onTime @returns {Promise<T>} */
  function within (work, ms, onTime) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { resolve(onTime) }, ms)
      work.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
    })
  }

  /** Puts the light client aside and says why in one line a bug report carries: the browser's code and its words, never an address or a value. @param {string} why @param {string} [words] */
  function setAside (why, words = '') {
    off = { why, until: now() + offMs }
    warn(`ethereum: the browser's light client is not used: ${why}${words === '' ? '' : ` (${words.slice(0, 120)})`}`)
  }

  /** Asks the browser for the light client and checks it answers a block number. Settles with the handle, or null with the reason in `off`. */
  async function ask () {
    try {
      const found = await orivon.use(LIGHT_CLIENT_CODE)
      if (found === null || found === undefined || typeof found.blockNumber !== 'function') { setAside('no-handle'); return null }
      await found.blockNumber()
      handle = found
      failures = 0
      off = null
      return found
    } catch (error) {
      setAside(codeOf(error), String(/** @type {any} */ (error)?.message ?? ''))
      return null
    }
  }

  /** Starts the question when none is open and none is wanted yet; never throws. */
  function start () {
    if (handle !== null || asking !== null || (off !== null && now() < off.until)) return
    asking = ask().finally(() => { asking = null })
  }

  /** The handle, or null when there is none now or it was not given in time. */
  async function lightHandle () {
    if (handle !== null) return handle
    start()
    return asking === null ? null : await within(asking, lightMs, null)
  }

  /** Puts the light client aside for a while. @param {string} why */
  function leave (why) {
    handle = null
    failures = 0
    setAside(why)
  }

  /** @returns {Promise<boolean>} whether a place among the reads in flight was got in time */
  async function place () {
    if (running < IN_FLIGHT) { running += 1; return true }
    let granted = false
    const turn = new Promise((resolve) => { waiting.push(() => { granted = true; resolve(undefined) }) })
    const mine = waiting[waiting.length - 1]
    await within(turn, lightMs, undefined)
    if (granted) return true
    const at = waiting.indexOf(/** @type {() => void} */ (mine))
    if (at !== -1) waiting.splice(at, 1)
    return false
  }
  function release () {
    const next = waiting.shift()
    if (next === undefined) running -= 1
    else next()
  }

  /**
   * One read through the light client: the JSON-RPC answer, or null when the public servers are to be asked (no handle, no place, a failure, a read the module
   * has no call for).
   * @param {{ id: unknown, method: string, params?: unknown }} request
   */
  async function viaLightClient ({ id, method, params }) {
    const plan = planOf(method, params)
    if (plan === null) return null
    const found = await lightHandle()
    if (found === null || !(await place())) return null
    try {
      if (typeof found[plan.fn] !== 'function') return null
      const value = await within(found[plan.fn](...plan.args), lightMs, TIMED_OUT)
      if (value === TIMED_OUT) throw Object.assign(new Error('the light client did not answer in time'), { code: 'timeout' })
      const result = resultOf(plan.shape, value)
      failures = 0
      counts.lightClient += 1
      return { jsonrpc: '2.0', id, result }
    } catch (error) {
      if (error instanceof RpcFailure) {
        failures = 0
        counts.lightClient += 1
        return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } }
      }
      if (codeOf(error) === 'invalid') {
        warn(`the light client refused ${method} as invalid: the read is made from the public servers`)
        return null
      }
      warn(`ethereum: the light client failed ${method}: ${codeOf(error)} (${String(/** @type {any} */ (error)?.message ?? '').slice(0, 120)})`)
      // A call with no `to` runs code the caller sends (viem checks a signature that way, and falls back to recovering the signer itself): a light client may not carry it,
      // which says nothing of the reads it does carry, so it is read from the public servers and not counted.
      if (!isDeployless(plan)) {
        failures += 1
        if (failures >= FAILURES_BEFORE_OFF) leave(codeOf(error))
      }
      return null
    } finally { release() }
  }

  /**
   * One read from the public servers in order: a server that fails, answers with an error status or says it cannot (a rate limit, a server error) gives way to the
   * next, and an answer, a revert included, is given as it came.
   * @param {{ id: unknown, method: string, params?: unknown }} request @param {string[]} servers @param {AbortSignal | undefined} signal
   */
  async function viaPublic ({ id, method, params }, servers, signal) {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? [] })
    for (const url of servers) {
      if (signal?.aborted === true) break
      const control = new AbortController()
      const timer = setTimeout(() => { control.abort() }, publicMs)
      const follow = () => { control.abort() }
      signal?.addEventListener('abort', follow, { once: true })
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: control.signal })
        if (!response.ok) continue
        const answer = await response.json()
        if (!isRecord(answer) || (answer['result'] === undefined && !isRecord(answer['error']))) continue
        const error = answer['error']
        if (isRecord(error) && !(error['code'] === 3 || /revert/i.test(String(error['message'] ?? '')))) continue
        counts.public += 1
        return { jsonrpc: '2.0', id, ...(isRecord(error) ? { error } : { result: answer['result'] }) }
      } catch { /* the next server */ } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', follow)
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32603, message: 'no Ethereum server answered' } }
  }

  /** @param {unknown} one @param {string[]} servers @param {AbortSignal | undefined} signal */
  async function serve (one, servers, signal) {
    if (!isRecord(one) || typeof one['method'] !== 'string') return { jsonrpc: '2.0', id: isRecord(one) ? one['id'] ?? null : null, error: { code: -32600, message: 'not a JSON-RPC request' } }
    const request = { id: one['id'] ?? null, method: one['method'], params: one['params'] }
    if (!READS.has(request.method)) return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `${request.method.slice(0, 60)} is not served: this node only reads Ethereum` } }
    return (await viaLightClient(request)) ?? await viaPublic(request, servers, signal)
  }

  /**
   * An endpoint for the fetch hook, with the public servers a read goes to when the light client cannot answer it.
   * @param {string[]} servers
   */
  function endpoint (servers) {
    return {
      /** @param {Request} request */
      async handle (request) {
        if (request.method !== 'POST') return new Response('only POST is served', { status: 405 })
        let sent
        try { sent = JSON.parse(await request.text()) } catch { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
        const signal = request.signal
        if (Array.isArray(sent)) {
          if (sent.length === 0 || sent.length > BATCH_MAX) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `a batch holds 1 to ${String(BATCH_MAX)} requests` } })
          return Response.json(await Promise.all(sent.map((one) => serve(one, servers, signal))))
        }
        return Response.json(await serve(sent, servers, signal))
      }
    }
  }

  /** What the dashboard says: the path the reads take now and why not the light client, and how many reads each path made. */
  function status () {
    if (handle !== null) return { path: 'light-client', lightClient: counts.lightClient, public: counts.public }
    if (asking !== null) return { path: 'asking', lightClient: counts.lightClient, public: counts.public }
    return { path: 'public', why: off?.why ?? 'not-asked', lightClient: counts.lightClient, public: counts.public }
  }

  return { endpoint, status, look: start }
}
