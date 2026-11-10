// EIP-4361 (Sign-In with Ethereum): build a message and read one back. The reader is strict: it accepts a text only
// when building the fields it found gives the same text byte for byte, so there is one spelling of every message.
// Grammar: the ABNF of EIP-4361, with RFC 3986 (URI, authority, pchar) and RFC 3339 (date-time) for the leaves.

import { toChecksumAddress } from './abi.js'
import { concat, utf8 } from './bytes.js'
import { keccak256 } from './keccak.js'

export class SiweError extends Error {}

/** The longest message either side builds or reads. */
export const MAX_MESSAGE_BYTES = 8192

/**
 * @typedef {object} SiweFields
 * @property {string} [scheme]
 * @property {string} domain an RFC 3986 authority
 * @property {string} address EIP-55, exactly as the checksum spells it
 * @property {string} [statement] absent means no statement; an empty one is not a message
 * @property {string} uri
 * @property {'1'} version
 * @property {number} chainId
 * @property {string} nonce at least 8 letters and digits
 * @property {string} issuedAt RFC 3339 date-time
 * @property {string} [expirationTime]
 * @property {string} [notBefore]
 * @property {string} [requestId]
 * @property {string[]} [resources] absent means no Resources line; empty means the line with nothing under it
 */

const SUB_DELIMS = "!$&'()*+,;="
const PCT = '%[0-9A-Fa-f]{2}'
const REG_NAME = `(?:[A-Za-z0-9\\-._~${SUB_DELIMS}]|${PCT})*`
const USERINFO = `(?:[A-Za-z0-9\\-._~${SUB_DELIMS}:]|${PCT})*`
const IP_LITERAL = `\\[(?:[0-9A-Fa-f:.]+|[vV][0-9A-Fa-f]+\\.[A-Za-z0-9\\-._~${SUB_DELIMS}:]+)\\]`
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/
const AUTHORITY = new RegExp(`^(?:${USERINFO}@)?(?:${IP_LITERAL}|${REG_NAME})(?::[0-9]*)?$`)
const PATH = new RegExp(`^(?:[A-Za-z0-9\\-._~${SUB_DELIMS}:@/]|${PCT})*$`)
const QUERY_OR_FRAGMENT = new RegExp(`^(?:[A-Za-z0-9\\-._~${SUB_DELIMS}:@/?]|${PCT})*$`)
const REQUEST_ID = new RegExp(`^(?:[A-Za-z0-9\\-._~${SUB_DELIMS}:@]|${PCT})*$`)
const STATEMENT = new RegExp(`^[A-Za-z0-9\\-._~:/?#\\[\\]@${SUB_DELIMS} ]+$`)
const NONCE = /^[A-Za-z0-9]{8,}$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/
const HEAD = ' wants you to sign in with your Ethereum account:'

/** Whether `text` is an RFC 3986 URI. @param {string} text */
export function isUri (text) {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):([^#?]*)(?:\?([^#]*))?(?:#(.*))?$/s.exec(text)
  if (match === null) return false
  const [, , hier = '', query, fragment] = match
  if (query !== undefined && !QUERY_OR_FRAGMENT.test(query)) return false
  if (fragment !== undefined && !QUERY_OR_FRAGMENT.test(fragment)) return false
  if (!hier.startsWith('//')) return PATH.test(hier)
  const slash = hier.indexOf('/', 2)
  return AUTHORITY.test(slash === -1 ? hier.slice(2) : hier.slice(2, slash)) && PATH.test(slash === -1 ? '' : hier.slice(slash))
}

/** Whether `text` is an RFC 3986 authority, the form of the `domain` field. @param {string} text */
export const isAuthority = (text) => text !== '' && AUTHORITY.test(text)

const isLeap = (/** @type {number} */ year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * An RFC 3339 date-time as milliseconds since the epoch, or null when it is not one (an impossible date included).
 * @param {unknown} text
 * @returns {number | null}
 */
export function parseTime (text) {
  const match = typeof text === 'string' ? DATE_TIME.exec(text) : null
  if (match === null) return null
  const [year, month, day, hour, minute, second] = /** @type {number[]} */ (match.slice(1, 7).map(Number))
  const zone = /** @type {string} */ (match[8])
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) return null
  if (day < 1 || day > (month === 2 && isLeap(year) ? 29 : /** @type {number} */ (DAYS[month - 1]))) return null
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  let offset = 0
  if (zone.toUpperCase() !== 'Z') {
    const [offsetHour, offsetMinute] = [Number(zone.slice(1, 3)), Number(zone.slice(4, 6))]
    if (offsetHour > 23 || offsetMinute > 59) return null
    offset = (zone.startsWith('-') ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60_000
  }
  return date.getTime() - offset + Math.floor(Number(`0.${match[7] ?? '0'}`) * 1000)
}

/** The date-time spelling both sides use: UTC, whole seconds, a `Z`. @param {number} seconds */
export function formatTime (seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 253_402_300_799) throw new SiweError('a time outside years 1970 to 9999')
  return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z')
}

/** @param {boolean} condition @param {string} field */
function need (condition, field) {
  if (!condition) throw new SiweError(`${field} is not what EIP-4361 allows`)
}

/**
 * The message for these fields.
 * @param {SiweFields} fields
 * @returns {string}
 */
export function buildMessage (fields) {
  const { scheme, domain, address, statement, uri, version, chainId, nonce, issuedAt, expirationTime, notBefore, requestId, resources } = fields
  need(scheme === undefined || SCHEME.test(scheme), 'scheme')
  need(typeof domain === 'string' && isAuthority(domain), 'domain')
  need(typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) && address === toChecksumAddress(address), 'address')
  need(statement === undefined || (typeof statement === 'string' && STATEMENT.test(statement)), 'statement')
  need(typeof uri === 'string' && isUri(uri), 'uri')
  need(version === '1', 'version')
  need(Number.isSafeInteger(chainId) && chainId >= 0, 'chainId')
  need(typeof nonce === 'string' && NONCE.test(nonce), 'nonce')
  need(parseTime(issuedAt) !== null, 'issuedAt')
  need(expirationTime === undefined || parseTime(expirationTime) !== null, 'expirationTime')
  need(notBefore === undefined || parseTime(notBefore) !== null, 'notBefore')
  need(requestId === undefined || (typeof requestId === 'string' && REQUEST_ID.test(requestId)), 'requestId')
  need(resources === undefined || (Array.isArray(resources) && resources.every((resource) => typeof resource === 'string' && isUri(resource))), 'resources')
  let text = `${scheme === undefined ? '' : `${scheme}://`}${domain}${HEAD}\n${address}\n\n`
  if (statement !== undefined) text += `${statement}\n`
  text += `\nURI: ${uri}\nVersion: ${version}\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}`
  if (expirationTime !== undefined) text += `\nExpiration Time: ${expirationTime}`
  if (notBefore !== undefined) text += `\nNot Before: ${notBefore}`
  if (requestId !== undefined) text += `\nRequest ID: ${requestId}`
  if (resources !== undefined) text += `\nResources:${resources.map((resource) => `\n- ${resource}`).join('')}`
  if (utf8(text).length > MAX_MESSAGE_BYTES) throw new SiweError(`a message of more than ${MAX_MESSAGE_BYTES} bytes`)
  return text
}

/**
 * Reads a message. Throws a SiweError for anything that is not exactly what `buildMessage` writes for the fields
 * it holds: a carriage return, a lower-case address, a second blank line, a field out of order, a leading zero.
 * @param {string} text
 * @returns {SiweFields}
 */
export function parseMessage (text) {
  if (typeof text !== 'string' || utf8(text).length > MAX_MESSAGE_BYTES) throw new SiweError('not a message of at most 8192 bytes')
  const lines = text.split('\n')
  const first = lines[0] ?? ''
  need(first.endsWith(HEAD), 'the first line')
  const origin = first.slice(0, -HEAD.length)
  const marker = origin.indexOf('://')
  /** @type {SiweFields} */
  const fields = /** @type {SiweFields} */ ({ domain: marker === -1 ? origin : origin.slice(marker + 3), address: lines[1] ?? '' })
  if (marker !== -1) fields.scheme = origin.slice(0, marker)
  need(lines[2] === '', 'the line after the address')
  let at = 4
  if (lines[3] !== '') {
    fields.statement = lines[3] ?? ''
    need(lines[4] === '', 'the line after the statement')
    at = 5
  }
  /** @param {string} label @param {boolean} optional @returns {string | undefined} */
  const field = (label, optional) => {
    const line = lines[at]
    if (line === undefined || !line.startsWith(`${label}: `)) {
      need(optional, label)
      return undefined
    }
    at++
    return line.slice(label.length + 2)
  }
  fields.uri = /** @type {string} */ (field('URI', false))
  fields.version = /** @type {'1'} */ (field('Version', false))
  const chain = /** @type {string} */ (field('Chain ID', false))
  need(/^(?:0|[1-9][0-9]{0,15})$/.test(chain), 'chainId')
  fields.chainId = Number(chain)
  fields.nonce = /** @type {string} */ (field('Nonce', false))
  fields.issuedAt = /** @type {string} */ (field('Issued At', false))
  const expirationTime = field('Expiration Time', true)
  const notBefore = field('Not Before', true)
  const requestId = field('Request ID', true)
  if (expirationTime !== undefined) fields.expirationTime = expirationTime
  if (notBefore !== undefined) fields.notBefore = notBefore
  if (requestId !== undefined) fields.requestId = requestId
  if (lines[at] === 'Resources:') {
    at++
    fields.resources = []
    for (; at < lines.length; at++) {
      const line = /** @type {string} */ (lines[at])
      need(line.startsWith('- '), 'a resource line')
      fields.resources.push(line.slice(2))
    }
  }
  need(at === lines.length, 'the end of the message')
  if (buildMessage(fields) !== text) throw new SiweError('the message is not in the one form EIP-4361 gives its fields')
  return fields
}

/** The EIP-191 hash a wallet signs for a personal message. @param {string} text @returns {Uint8Array} */
export function hashMessage (text) {
  const body = utf8(text)
  return keccak256(concat(utf8(`\x19Ethereum Signed Message:\n${body.length}`), body))
}
