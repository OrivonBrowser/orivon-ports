// Sign-in protocol v1, the parts both sides share: the request and its bounds, the one message a person signs
// (statement, resources, times), and the response carried back in the URL fragment. PROTOCOL.md is the spec.

import { isAddress, toChecksumAddress } from './abi.js'
import { utf8 } from './bytes.js'
import { isValidLabel, nameOf, SUFFIX } from './orivonid.js'
import { NOT_BEFORE_KEY } from './permissions.js'
import { keyBytes, keyHex } from './p256.js'
import { formatTime } from './siwe.js'

/** The domain of every message, and so the page that signs. */
export const ID_DOMAIN = 'id.orivonstack.eth'
const SCHEME = 'https:'
export { NOT_BEFORE_KEY }
export const MAX_TTL = 15_552_000
export const MIN_TTL = 60
/** The lifetime of a sign-in that asks for no key. */
export const PLAIN_LIFETIME = 600
export const MAX_NAMES = 16
/** How far ahead of the verifier's clock an Issued At may be. */
export const CLOCK_SKEW = 300
export const MAX_RETURN = 2048
/**
 * The longest audience origin a request may carry. The statement names it in full, and with a key the statement is 72
 * characters around it, so the longest one stays a line a person reads at a glance.
 */
export const MAX_AUDIENCE = 64
export const KEY_CURVE = 'p256'

const NONCE = /^[A-Za-z0-9]{16,64}$/
export const STATE = /^[A-Za-z0-9._~-]{1,256}$/
const NAME_RESOURCE = /^orivonid:name:([a-z0-9-]+)\.v1\.orivonid\.eth#(0x[0-9a-f]{40})$/
const KEY_RESOURCE = /^orivonid:key:p256:(0x[0-9a-f]{66})$/

/**
 * @typedef {'badVersion' | 'missingReturn' | 'returnTooLong' | 'returnNotAscii' | 'returnNotUrl' | 'returnNotHttps'
 *   | 'returnHasFragment' | 'returnHasCredentials' | 'audienceTooLong' | 'missingNonce' | 'badNonce' | 'badState' | 'badKey' | 'missingTtl'
 *   | 'badTtl' | 'ttlWithoutKey'} RequestProblem
 */
export const REQUEST_PROBLEMS = [
  'badVersion', 'missingReturn', 'returnTooLong', 'returnNotAscii', 'returnNotUrl', 'returnNotHttps', 'returnHasFragment',
  'returnHasCredentials', 'audienceTooLong', 'missingNonce', 'badNonce', 'badState', 'badKey', 'missingTtl', 'badTtl', 'ttlWithoutKey'
]

/**
 * @typedef {object} Request
 * @property {string} returnUrl canonical
 * @property {string} origin the audience: the origin of `returnUrl`
 * @property {string} nonce
 * @property {string | null} state
 * @property {string | null} key the delegated key, `0x` and 66 lower-case hex digits
 * @property {number | null} ttl seconds, at most MAX_TTL
 */

/**
 * The bounds of every request field, applied to what a URL carried (strings) or a relying site passes in. The
 * relying site's builder and the ID site's reader both end here.
 * @param {{ v?: string, returnUrl?: string, nonce?: string, state?: string, delegate?: string, ttl?: string }} raw
 * @returns {{ ok: true, request: Request } | { ok: false, reason: RequestProblem, field: string }}
 */
export function checkRequest (raw) {
  /** @param {RequestProblem} reason @param {string} field */
  const refuse = (reason, field) => ({ ok: /** @type {const} */ (false), reason, field })
  if (raw.v !== '1') return refuse('badVersion', 'v')
  const target = raw.returnUrl
  if (target === undefined || target === '') return refuse('missingReturn', 'return')
  if (target.length > MAX_RETURN) return refuse('returnTooLong', 'return')
  if (!/^[\x21-\x7e]+$/.test(target)) return refuse('returnNotAscii', 'return')
  if (target.includes('#')) return refuse('returnHasFragment', 'return')
  /** @type {URL} */
  let url
  try {
    url = new URL(target)
  } catch {
    return refuse('returnNotUrl', 'return')
  }
  if (url.protocol !== SCHEME) return refuse('returnNotHttps', 'return')
  if (url.hostname === '') return refuse('returnNotUrl', 'return')
  if (url.username !== '' || url.password !== '') return refuse('returnHasCredentials', 'return')
  if (url.origin.length > MAX_AUDIENCE) return refuse('audienceTooLong', 'return')
  if (raw.nonce === undefined) return refuse('missingNonce', 'nonce')
  if (!NONCE.test(raw.nonce)) return refuse('badNonce', 'nonce')
  if (raw.state !== undefined && !STATE.test(raw.state)) return refuse('badState', 'state')
  let key = null
  let ttl = null
  if (raw.delegate !== undefined) {
    const bytes = /^0x[0-9a-fA-F]{66}$/.test(raw.delegate) ? keyBytes(raw.delegate) : null
    if (bytes === null) return refuse('badKey', 'delegate')
    key = keyHex(bytes)
    if (raw.ttl === undefined) return refuse('missingTtl', 'ttl')
    ttl = /^[1-9][0-9]{0,8}$/.test(raw.ttl) ? Number(raw.ttl) : null
    if (ttl === null || ttl < MIN_TTL || ttl > MAX_TTL) return refuse('badTtl', 'ttl')
  } else if (raw.ttl !== undefined) {
    return refuse('ttlWithoutKey', 'ttl')
  }
  return { ok: true, request: { returnUrl: url.href, origin: url.origin, nonce: raw.nonce, state: raw.state ?? null, key, ttl } }
}

/** The URL a relying site sends the person to. @param {Request} request */
export function requestUrl (request) {
  let query = `v=1&return=${encodeURIComponent(request.returnUrl)}&nonce=${request.nonce}`
  if (request.state !== null) query += `&state=${request.state}`
  if (request.key !== null) query += `&delegate=${request.key}&ttl=${request.ttl}`
  return `${SCHEME}//${ID_DOMAIN}/#/connect?${query}`
}

/** A username, bound to the resolver that held its records when it was signed. @param {string} label @param {string} resolver */
export function nameResource (label, resolver) {
  if (!isAddress(resolver)) throw new TypeError('a resolver address')
  return `orivonid:name:${nameOf(label)}#${resolver.toLowerCase()}`
}

/** @param {string} key 0x hex */
export const keyResource = (key) => `orivonid:key:${KEY_CURVE}:${key}`

/**
 * The names with the resolver each was bound to, then the key if there is one, from the Resources of a message.
 * @param {string[]} resources
 * @returns {{ ok: true, labels: string[], resolvers: string[], key: string | null } | { ok: false, detail: string }}
 */
export function readResources (resources) {
  const labels = []
  const resolvers = []
  let key = null
  for (const [index, resource] of resources.entries()) {
    const name = NAME_RESOURCE.exec(resource)
    const given = KEY_RESOURCE.exec(resource)
    if (name !== null && key === null) {
      const label = /** @type {string} */ (name[1])
      const resolver = /** @type {string} */ (name[2])
      if (!isValidLabel(label)) return { ok: false, detail: `${label} is not a username` }
      if (labels.includes(label)) return { ok: false, detail: `${label} twice` }
      if (/^0x0{40}$/.test(resolver)) return { ok: false, detail: `${label} is bound to no resolver` }
      labels.push(label)
      resolvers.push(resolver)
    } else if (given !== null && key === null && index === resources.length - 1) {
      if (keyBytes(given[1]) === null) return { ok: false, detail: 'the key is not a P-256 point' }
      key = /** @type {string} */ (given[1])
    } else {
      return { ok: false, detail: `resource ${index + 1} is not a username bound to its resolver, or the key in last place` }
    }
  }
  if (labels.length === 0) return { ok: false, detail: 'no username' }
  if (labels.length > MAX_NAMES) return { ok: false, detail: `more than ${MAX_NAMES} usernames` }
  return { ok: true, labels, resolvers, key }
}

/**
 * The statement of a sign-in, in the one wording both sides build. It stays one short line for any audience a request
 * may carry (MAX_AUDIENCE), and it says first what matters most: a key acts as the person. The usernames, the
 * resolvers and the key itself are in Resources.
 * @param {{ origin: string, key: string | null }} parts
 */
export function statementFor ({ origin, key }) {
  if (key === null) return `Sign in to ${origin}. It sees your usernames and cannot act as you.`
  return `Let ${origin} act as you, with its own key, until expiry. It sees your usernames.`
}

/**
 * Every field of the message for a sign-in, from the facts that vary. The ID site signs `buildMessage` of this, and
 * a verifier rebuilds it from the message it was given and requires the same text.
 * `resolvers` holds, in the order of `labels`, the resolver each username's records were on when the person signed.
 * @param {{ address: string, origin: string, nonce: string, issuedAt: number, expiresAt: number, labels: string[], resolvers: string[], key: string | null }} parts
 * @returns {import('./siwe.js').SiweFields}
 */
export function signInFields ({ address, origin, nonce, issuedAt, expiresAt, labels, resolvers, key }) {
  if (resolvers.length !== labels.length) throw new TypeError('a resolver for each username')
  const expirationTime = formatTime(expiresAt)
  return {
    domain: ID_DOMAIN,
    address: toChecksumAddress(address),
    statement: statementFor({ origin, key }),
    uri: origin,
    version: '1',
    chainId: 1,
    nonce,
    issuedAt: formatTime(issuedAt),
    expirationTime,
    resources: [...labels.map((label, index) => nameResource(label, /** @type {string} */ (resolvers[index]))), ...(key === null ? [] : [keyResource(key)])]
  }
}

/**
 * @typedef {object} SignInResponse what the ID site hands back, and what a relying site stores to check later
 * @property {1} v
 * @property {string} message the EIP-4361 text that was signed
 * @property {string} signature 0x and 130 hex digits: r, s, then v as 27 or 28
 * @property {string} address
 * @property {string[]} names the full usernames, as in the message
 * @property {string} [state] the request's, when it had one
 */

/** @param {Uint8Array} bytes */
const toBase64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** @param {string} body @returns {Uint8Array | null} */
function fromBase64Url (body) {
  if (!/^[A-Za-z0-9_-]*$/.test(body) || body.length % 4 === 1) return null
  const bytes = Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0))
  return toBase64Url(bytes) === body ? bytes : null
}

/** The fragment value: base64url of the JSON. @param {SignInResponse} response */
export function encodeResponse (response) {
  const { v, message, signature, address, names, state } = response
  return toBase64Url(utf8(JSON.stringify(state === undefined ? { v, message, signature, address, names } : { v, message, signature, address, names, state })))
}

/**
 * The response a value is, or null when it is not exactly one: other keys, other types, an address that is not
 * EIP-55, a signature that is not 65 bytes of hex, a username that is not under v1.orivonid.eth.
 * @param {unknown} input
 * @returns {SignInResponse | null}
 */
export function checkResponse (input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  if (Object.keys(input).some((key) => !['v', 'message', 'signature', 'address', 'names', 'state'].includes(key))) return null
  const { v, message, signature, address, names, state } = /** @type {Record<string, any>} */ (input)
  const sound = v === 1 && typeof message === 'string' && typeof signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(signature) &&
    typeof address === 'string' && isAddress(address) && address === toChecksumAddress(address) &&
    Array.isArray(names) && names.length <= MAX_NAMES && names.every((name) => typeof name === 'string' && name.endsWith(`.${SUFFIX}`)) &&
    (state === undefined || (typeof state === 'string' && STATE.test(state)))
  if (!sound) return null
  return state === undefined ? { v, message, signature, address, names } : { v, message, signature, address, names, state }
}

/**
 * The response a fragment carries, or null: padding or a foreign alphabet in the base64url, bytes that are not
 * UTF-8, JSON that is not exactly a response.
 * @param {string} body
 * @returns {SignInResponse | null}
 */
export function decodeResponse (body) {
  const bytes = body.length > 32_768 ? null : fromBase64Url(body)
  if (bytes === null) return null
  try {
    return checkResponse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch {
    return null
  }
}

/** @param {string} returnUrl canonical @param {SignInResponse} response */
export const successUrl = (returnUrl, response) => `${returnUrl}#orivonid=${encodeResponse(response)}`

/** @param {string} returnUrl canonical @param {'cancelled' | 'invalid-request'} error @param {string | null} state */
export const errorUrl = (returnUrl, error, state) => `${returnUrl}#orivonid-error=${error}${state === null ? '' : `&state=${state}`}`
