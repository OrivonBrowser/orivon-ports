// Reads from trustless gateways. A gateway answers with a CAR; every block in it is hashed locally and the walk
// starts from the CID asked for, so a gateway is never trusted. `fetchVerified` returns one file's bytes (the
// build uses it); `fetchBlocks` and `fetchFileBlob` stream the answer through a byte cap and report progress,
// which is how the receiving page reads a share.

import { parseCid } from './cid.js'
import { readCar, readPath } from './car.js'
import { readCarStream, TooLargeError } from './car-stream.js'
import { readFileBlob } from './dagread.js'

/**
 * @typedef {object} FetchOptions
 * @property {string[]} gateways base URLs, tried in order
 * @property {typeof fetch} [fetchImpl]
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs] per gateway, body included
 */

/**
 * @typedef {object} StreamOptions
 * @property {string[]} gateways base URLs, tried in order
 * @property {typeof fetch} [fetchImpl]
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs] a gateway must answer within this, and must not go quiet for longer while it sends
 * @property {number} [maxBytes] the most one answer may carry
 * @property {(bytes: number) => void} [onProgress] bytes received so far from the gateway being read
 * @property {'block' | 'entity'} [scope] `block`: the one block asked for; `entity`: the whole file, or the directory itself
 */

/** @param {string} path */
function encodePath (path) {
  return path.split('/').filter((segment) => segment !== '').map(encodeURIComponent).join('/')
}

/**
 * One gateway: the CAR for `cid` + `path`, verified, and the file's bytes.
 * @param {string} gateway @param {string} cid @param {string} path
 * @param {typeof fetch} fetchImpl @param {AbortSignal | undefined} signal @param {number} timeoutMs
 */
async function fromGateway (gateway, cid, path, fetchImpl, signal, timeoutMs) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  signal?.addEventListener('abort', abort)
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
  try {
    const encoded = encodePath(path)
    const url = `${gateway.replace(/\/+$/, '')}/ipfs/${cid}${encoded ? '/' + encoded : ''}?format=car&dag-scope=entity`
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.ipld.car' }, signal: controller.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const car = new Uint8Array(await response.arrayBuffer())
    // A path request's CAR names the terminal file in its header, not the URL's
    // root, so the header proves nothing: each block is hashed, and the walk
    // from `cid` fails unless the blocks on the path are there.
    const blocks = await readCar(car)
    return readPath(blocks, cid, path)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/** @param {unknown} error */
function reasonOf (error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The file at `path` below `cid` (default `index.html`; an empty string means
 * the root is itself the file), from the first gateway whose answer verifies.
 * @param {string} cid
 * @param {string | undefined} path
 * @param {FetchOptions} options
 * @returns {Promise<{ bytes: Uint8Array, gateway: string }>}
 */
export async function fetchVerified (cid, path, { gateways, fetchImpl = fetch, signal, timeoutMs = 30000 }) {
  const root = parseCid(cid).string
  const wanted = path === undefined ? 'index.html' : path
  /** @type {string[]} */
  const failures = []
  for (const gateway of gateways) {
    if (signal?.aborted) throw new Error('fetch aborted')
    try {
      const bytes = await fromGateway(gateway, root, wanted, fetchImpl, signal, timeoutMs)
      return { bytes, gateway }
    } catch (error) {
      failures.push(`${gateway}: ${reasonOf(error)}`)
    }
  }
  throw new Error(`no gateway returned ${root}/${wanted} verified: ${failures.join('; ') || 'no gateways given'}`)
}

/**
 * One gateway's CAR for `cid`, read as it arrives into a map of verified blocks.
 * @param {string} gateway @param {string} cid
 * @param {{ fetchImpl: typeof fetch, signal?: AbortSignal, timeoutMs: number, maxBytes: number, scope: string, onProgress?: (bytes: number) => void }} options
 */
async function streamFromGateway (gateway, cid, options) {
  const { fetchImpl, signal, timeoutMs, maxBytes, scope, onProgress } = options
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  signal?.addEventListener('abort', abort)
  let timer = setTimeout(() => controller.abort(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
  const alive = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new Error(`it went quiet for ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
  }
  try {
    const url = `${gateway.replace(/\/+$/, '')}/ipfs/${cid}?format=car&dag-scope=${scope}`
    const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.ipld.car' }, signal: controller.signal })
    if (!response.ok) throw new Error(response.status === 404 ? 'it does not have this' : `HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) throw new TooLargeError(maxBytes)
    if (!response.body) throw new Error('it sent no body')
    alive()
    /** @type {Map<string, Uint8Array>} */
    const blocks = new Map()
    for await (const block of readCarStream(response.body, { maxBytes, onBytes: (total) => { alive(); onProgress?.(total) } })) {
      blocks.set(block.cid, block.data)
    }
    return blocks
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * The blocks a gateway sends for `cid`, each checked, from the first gateway that sends any. A gateway that fails,
 * or sends a block that does not match, is skipped; an answer over `maxBytes` ends the read, since another gateway
 * would send the same thing.
 * @param {string} cid
 * @param {StreamOptions} options
 * @returns {Promise<{ blocks: Map<string, Uint8Array>, gateway: string }>}
 */
export async function fetchBlocks (cid, options) {
  const { gateways, fetchImpl = fetch, signal, timeoutMs = 30000, maxBytes = Infinity, scope = 'entity', onProgress } = options
  const root = parseCid(cid).string
  /** @type {string[]} */
  const failures = []
  for (const gateway of gateways) {
    signal?.throwIfAborted()
    try {
      const blocks = await streamFromGateway(gateway, root, { fetchImpl, timeoutMs, maxBytes, scope, ...(signal ? { signal } : {}), ...(onProgress ? { onProgress } : {}) })
      if (!blocks.has(root)) throw new Error('it did not send the block asked for')
      return { blocks, gateway }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled.', 'AbortError')
      if (error instanceof TooLargeError) throw error
      failures.push(`${new URL(gateway).host}: ${reasonOf(error)}`)
    }
  }
  throw new Error(`No IPFS gateway could give ${root}: ${failures.join('; ') || 'no gateways given'}`)
}

/**
 * One block, checked against its CID.
 * @param {string} cid
 * @param {StreamOptions} options
 * @returns {Promise<Uint8Array>}
 */
export async function fetchBlock (cid, options) {
  const { blocks } = await fetchBlocks(cid, { ...options, scope: 'block', maxBytes: options.maxBytes ?? 4 * 1024 * 1024 })
  return /** @type {Uint8Array} */ (blocks.get(parseCid(cid).string))
}

/**
 * A whole file below `cid`, as a Blob, every block checked.
 * @param {string} cid
 * @param {StreamOptions} options
 * @returns {Promise<{ blob: Blob, gateway: string }>}
 */
export async function fetchFileBlob (cid, options) {
  const { blocks, gateway } = await fetchBlocks(cid, { ...options, scope: 'entity' })
  return { blob: readFileBlob(blocks, parseCid(cid).string), gateway }
}
