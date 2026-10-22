// Fetches a file by CID from trustless gateways. The gateway returns a CAR;
// every block in it is hashed locally and the path is walked from the CID
// asked for, so a gateway is never trusted.

import { parseCid } from './cid.js'
import { readCar, readPath } from './car.js'

/**
 * @typedef {object} FetchOptions
 * @property {string[]} gateways base URLs, tried in order
 * @property {typeof fetch} [fetchImpl]
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs] per gateway, body included
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
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`${gateway}: ${reason}`)
    }
  }
  throw new Error(`no gateway returned ${root}/${wanted} verified: ${failures.join('; ') || 'no gateways given'}`)
}
