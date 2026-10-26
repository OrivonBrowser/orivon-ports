// Reading an address and finding what it shows: the forms an IPNS address takes in the Import field, and
// the newest record that checks out among Orivon's node and the trustless gateways. No source is trusted:
// a record counts only when it verifies against the name.

import { parseCid } from './ipfs/cid.js'
import { IPNS_RECORD_TYPE, MAX_RECORD_BYTES, parseName, verifyRecord } from './ipfs/ipns.js'
import { keptRecord } from './publish/relay-names.js'
import { FREE } from './publish/targets.js'

/** Gateways that give the record of a name to a page: both answer with CORS. */
export const RECORD_GATEWAYS = ['https://ipfs.orbitor.dev', 'https://ipfs.filebase.io']
const LOOKUP_TIMEOUT_MS = 15_000

/** @typedef {{ cid: string, bytes: Uint8Array, record: import('./ipfs/ipns.js').IpnsRecord, source: string }} Found */

/** @param {string} text @returns {string} */
function decoded (text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * `ipns://<name>[/path]`, `/ipns/<name>`, a subdomain gateway (`https://<name>.ipns.<host>/…`) or a path
 * gateway (`https://<host>/ipns/<name>/…`). Null for anything else; an IpnsError, in words, for an address of
 * that shape (`ipns://` or `/ipns/`) whose name is not a name this editor can use.
 * @param {string} text @returns {{ name: string, path: string } | null}
 */
export function parseIpnsAddress (text) {
  const value = text.trim()
  /** @param {string} name @param {string} rest */
  const found = (name, rest) => {
    const clean = decoded((rest ?? '').replace(/^\/+/, '').split(/[?#]/)[0] ?? '')
    return { name: parseName(decoded(name)).name, path: clean === '' || clean.endsWith('/') ? `${clean}index.html` : clean }
  }
  let match = /^ipns:\/\/([^/?#]+)(.*)$/i.exec(value) ?? /^\/ipns\/([^/?#]+)(.*)$/.exec(value)
  if (match) return found(match[1] ?? '', match[2] ?? '')
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    match = /^([a-z0-9]+)\.ipns\./.exec(url.hostname)
    if (match) return found(match[1] ?? '', url.pathname)
    match = /^\/ipns\/([^/]+)(.*)$/.exec(url.pathname)
    if (match) return found(match[1] ?? '', match[2] ?? '')
  } catch {
    // A web address that only looks like a gateway's is not an IPNS address.
  }
  return null
}

/** The version a record points at, when it points at a bare `/ipfs/<cid>`. @param {string} value @returns {string | null} */
export function versionOf (value) {
  const match = /^\/ipfs\/([^/]+)\/?$/.exec(value)
  try {
    return match === null ? null : parseCid(match[1] ?? '').string
  } catch {
    return null
  }
}

/** @param {AbortSignal | undefined} signal @param {number} ms */
function within (signal, ms) {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** A gateway's record for a name: the bytes, or null when it holds none; a failure to answer throws. @param {string} gateway @param {string} name @param {typeof fetch} fetchImpl @param {AbortSignal} signal */
async function gatewayRecord (gateway, name, fetchImpl, signal) {
  const response = await fetchImpl(`${gateway.replace(/\/+$/, '')}/ipns/${name}`, { headers: { accept: IPNS_RECORD_TYPE }, signal })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${gateway} answered ${response.status}`)
  if (Number(response.headers.get('content-length') ?? 0) > MAX_RECORD_BYTES) return null
  const bytes = new Uint8Array(await response.arrayBuffer())
  return bytes.length > MAX_RECORD_BYTES ? null : bytes
}

/**
 * The newest record for `name` that verifies, among Orivon's node and the gateways, asked at once. The highest
 * sequence wins. Null when the sources answered and none had a usable record; an Error when none answered.
 * @param {string} name
 * @param {{ fetchImpl?: typeof fetch, now?: number, timeoutMs?: number, signal?: AbortSignal, endpoint?: string, gateways?: string[] }} [options]
 * @returns {Promise<Found | null>}
 */
export async function findRecord (name, { fetchImpl = fetch, now = Date.now(), timeoutMs = LOOKUP_TIMEOUT_MS, signal, endpoint = FREE.values.endpoint ?? '', gateways = RECORD_GATEWAYS } = {}) {
  const sources = [
    { source: endpoint, ask: () => keptRecord({ endpoint, name, fetchImpl, timeoutMs, ...(signal ? { signal } : {}) }) },
    ...gateways.map((gateway) => ({ source: gateway, ask: () => gatewayRecord(gateway, name, fetchImpl, within(signal, timeoutMs)) }))
  ]
  const answers = await Promise.allSettled(sources.map(async ({ source, ask }) => {
    const bytes = await ask()
    if (bytes === null) return null
    try {
      const record = await verifyRecord(bytes, name, { now })
      const cid = versionOf(record.value)
      return cid === null ? null : /** @type {Found} */ ({ cid, bytes, record, source })
    } catch {
      return null
    }
  }))
  if (answers.every((answer) => answer.status === 'rejected')) {
    throw new Error('Could not ask Orivon\'s node or any gateway about this address. Check your connection and try again.')
  }
  /** @type {Found | null} */
  let best = null
  for (const answer of answers) {
    if (answer.status === 'fulfilled' && answer.value !== null && (best === null || answer.value.record.sequence > best.record.sequence)) best = answer.value
  }
  return best
}
