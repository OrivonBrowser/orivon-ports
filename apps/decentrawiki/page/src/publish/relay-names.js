// The two calls free pinning answers about an address: keep it up (`name/keep`), and give back the newest
// record it holds (`name/record`). The relay checks a record before it keeps it; its refusals come in
// Kubo's shape, `{"Message": …}`, and are shown in its own words.

import { IPNS_RECORD_TYPE, MAX_RECORD_BYTES } from '../ipfs/ipns.js'
import { relayRefusal } from './page-node.js'
import { PinningError } from './pinning.js'

/** The relay reads a version it did not pin, and puts the record on the network: about two minutes at most. */
export const KEEP_TIMEOUT_MS = 150_000
const RECORD_TIMEOUT_MS = 15_000

/** @param {AbortSignal | undefined} signal @param {number} ms */
function within (signal, ms) {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** @param {string} endpoint @param {string} path @param {string} name */
function url (endpoint, path, name) {
  return `${endpoint.replace(/\/+$/, '')}/api/v0/name/${path}?arg=${encodeURIComponent(name)}`
}

/**
 * Asks Orivon's node to keep an address up, with the record that points it at a version.
 * @param {{ endpoint: string, name: string, record: Uint8Array, expect?: { value: string, sequence: number }, signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<{ value: string, sequence: number, keptUntil: number }>}
 */
export async function keepName ({ endpoint, name, record, expect, signal, fetchImpl = fetch, timeoutMs = KEEP_TIMEOUT_MS }) {
  let response
  try {
    response = await fetchImpl(url(endpoint, 'keep', name), { method: 'POST', headers: { 'content-type': IPNS_RECORD_TYPE }, body: /** @type {BufferSource} */ (record), signal: within(signal, timeoutMs) })
  } catch {
    if (signal?.aborted) throw new PinningError('aborted', 'Pointing the address at this version was cancelled.')
    throw new PinningError('unreachable', 'Orivon\'s node did not answer in time. Check your connection and try again: sending the same record again costs nothing.')
  }
  if (!response.ok) throw await relayRefusal(response)
  /** @type {any} */
  let line
  try {
    line = await response.json()
  } catch {
    line = null
  }
  const keptUntil = typeof line?.KeptUntil === 'string' ? Date.parse(line.KeptUntil) : NaN
  if (typeof line?.Value !== 'string' || !Number.isFinite(keptUntil)) {
    throw new PinningError('bad-answer', 'Orivon\'s node answered in a form this page does not understand.')
  }
  if (expect !== undefined && (line.Value !== expect.value || Number(line.Sequence) !== expect.sequence)) {
    throw new PinningError('bad-answer', 'Orivon\'s node kept a different record than the one sent, so the address is not recorded as kept.')
  }
  return { value: line.Value, sequence: Number(line.Sequence), keptUntil }
}

/**
 * The newest record Orivon's node holds for an address, or null when it holds none.
 * @param {{ endpoint: string, name: string, signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<Uint8Array | null>}
 */
export async function keptRecord ({ endpoint, name, signal, fetchImpl = fetch, timeoutMs = RECORD_TIMEOUT_MS }) {
  let response
  try {
    response = await fetchImpl(url(endpoint, 'record', name), { method: 'POST', signal: within(signal, timeoutMs) })
  } catch {
    if (signal?.aborted) throw new PinningError('aborted', 'The look-up was cancelled.')
    throw new PinningError('unreachable', 'Orivon\'s node did not answer. Check your connection and try again.')
  }
  if (response.status === 404) return null
  if (!response.ok) throw await relayRefusal(response)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > MAX_RECORD_BYTES) throw new PinningError('bad-answer', 'Orivon\'s node sent a record larger than a record may be.')
  return bytes
}
