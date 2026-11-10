// What NAMES_0_1.resolve answers for the records a name's resolver holds, as Orivon's own ENS resolver answers it: the
// contenthash is the owner's default, the text records that name content follow in a fixed order, and anything the
// browser would not load is left out. A value is passed as the owner wrote it, in the form of an address; the browser
// reads every record again before it loads anything from it.

import { addressOfContenthash } from './orv-contenthash.js'

/** What the answer says it came from. The browser shows the name of this integration's row instead for a page load. */
export const SOURCE = 'Orivon ID'

/** The longest value and the most records an answer may hold: the standard's bounds. */
export const MAX_VALUE = 2048
export const MAX_RECORDS = 16

/** The text key each listed record is read from, in the order they are listed. */
export const TEXT_KEYS = Object.freeze([
  ['content.ipfs', 'ipfs'], ['content.bzz', 'bzz'], ['content.arw', 'arw'], ['content.magnet', 'magnet'],
  ['content.https', 'https'], ['content.http', 'http'], ['content.ddoc', 'ddoc']
])

const NOT_VISIBLE_ASCII = /[^\x21-\x7e]/
const HEX_64 = /^[0-9a-fA-F]{64}$/
const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$/
const BUNDLE_HASH = /^sha256:[0-9a-f]{64}$/

/**
 * What follows `prefix` or `slashed` in `value`, or the whole value when it carries neither; a path, query or fragment gives nothing.
 * @param {string} value
 * @param {string} prefix
 * @param {string} [slashed]
 */
function rootOf (value, prefix, slashed) {
  let rest = value
  if (value.startsWith(prefix)) rest = value.slice(prefix.length)
  else if (slashed !== undefined && value.startsWith(slashed)) rest = value.slice(slashed.length)
  return rest === '' || /[/?#]/.test(rest) ? null : rest
}

/** @param {'https' | 'http'} scheme @param {string} value @returns {string | null} */
function webAddress (scheme, value) {
  if (!value.startsWith(`${scheme}://`) || /[?#\\]/.test(value)) return null
  const authority = value.slice(scheme.length + 3).split('/')[0] ?? ''
  if (authority === '' || authority.includes('@')) return null
  try {
    const url = new URL(value)
    return url.protocol === `${scheme}:` && url.hostname !== '' && url.username === '' && url.password === '' ? url.href : null
  } catch {
    return null
  }
}

/**
 * The text record `value` of a listed `type`, as an address, or null when it is not a well-formed one.
 * @param {string} type one of the second column of TEXT_KEYS
 * @param {string} value
 * @returns {string | null}
 */
export function textAddress (type, value) {
  if (value === '' || value.length > MAX_VALUE || NOT_VISIBLE_ASCII.test(value)) return null
  switch (type) {
    case 'ipfs': {
      if (value.startsWith('ipns://') || value.startsWith('/ipns/')) {
        const key = rootOf(value, 'ipns://', '/ipns/')
        return key === null ? null : `ipns://${key}`
      }
      const cid = rootOf(value, 'ipfs://', '/ipfs/')
      return cid === null ? null : `ipfs://${cid}`
    }
    case 'bzz': {
      const reference = rootOf(value, 'bzz://')
      return reference !== null && HEX_64.test(reference) ? `bzz://${reference.toLowerCase()}` : null
    }
    case 'arw': {
      const id = rootOf(value, 'ar://')
      return id !== null && ARWEAVE_ID.test(id) ? `ar://${id}` : null
    }
    case 'magnet': return /^magnet:\?(?:.*&)?xt=urn:bt[im]h:/i.test(value) ? value : null
    case 'https': case 'http': return webAddress(type, value)
    case 'ddoc': return BUNDLE_HASH.test(value) ? value : null
    default: return null
  }
}

/** @typedef {{ type: string, value: string }} Pointer */
/** @typedef {{ ownerDefault: Pointer | null, records: Pointer[], provenance: { by: string, proven: boolean, block?: number } }} Answer */

/**
 * @param {{ contenthash: Uint8Array | null, texts: Record<string, string | null> }} found the resolver's records, by text key
 * @param {number} [block] the block they were read at
 * @returns {Answer}
 */
export function answerOf (found, block) {
  const provenance = { by: SOURCE, proven: false, ...(block === undefined ? {} : { block }) }
  const address = found.contenthash === null ? null : addressOfContenthash(found.contenthash)
  const ownerDefault = address === null || address.value.length > MAX_VALUE ? null : { type: address.type, value: address.value }
  /** @type {{ type: string, value: string }[]} */
  const records = []
  for (const [key, type] of TEXT_KEYS) {
    const raw = found.texts[key]
    const value = typeof raw === 'string' ? textAddress(type, raw) : null
    if (value !== null && records.length < MAX_RECORDS) records.push({ type, value })
  }
  return { ownerDefault, records, provenance }
}

/**
 * The answer for a name that is not there, or is not the owner's alone: what Orivon's ENS gives a name with no records.
 * @param {number} [block]
 * @returns {Answer}
 */
export const notFound = (block) => answerOf({ contenthash: null, texts: {} }, block)
