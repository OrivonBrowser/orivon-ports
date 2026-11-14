// What NAMES_0_1.resolve answers for the records of a `.og` name: the text records that name content, in a fixed order, as
// addresses, and anything the browser would not load left out. The answer has no owner default: Linagee has no record
// that marks one, and the browser loads `records` through its rows in the person's order without one. A value is passed as
// its owner wrote it, in the form of an address; the browser reads every record again before it loads anything from it.

import { CONTRACT_KEY, SOURCE, TEXT_KEYS } from './og-pins.js'

/** The longest value and the most records an answer may hold: the standard's bounds. */
export const MAX_VALUE = 2048
export const MAX_RECORDS = 16

const NOT_VISIBLE_ASCII = /[^\x21-\x7e]/
const HEX_64 = /^[0-9a-fA-F]{64}$/
const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$/
const BUNDLE_HASH = /^sha256:[0-9a-f]{64}$/
const ETHFS_ADDRESS = /^eth:\/\/0x[0-9a-fA-F]{40}$/
const CONTRACT_ADDRESS = /^(?:0x)?([0-9a-fA-F]{40})$/
const CONTRACT_ON_CHAIN = /^(?:0x)?([0-9a-fA-F]{40}):([A-Za-z0-9-]{1,32})$/
const CHAIN_BEFORE_CONTRACT = /^[A-Za-z0-9-]{1,32}:(?:0x)?[0-9a-fA-F]{40}$/
const A_NAME = /^[^\s:/?#]+\.[^\s:/?#]+$/

/** The chain whose contracts a `web3` record may name: Ethereum, by its number. */
const ETHEREUM = '1'

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

/** @typedef {'web3-other-chain' | 'web3-a-name' | 'web3-not-an-address'} Web3Refusal why a `contentcontract` value is not read as the contract of a web3:// site */
/** @typedef {{ ok: true, address: string } | { ok: false, reason: Web3Refusal }} Web3Target */

/**
 * The contract a `contentcontract` value names, as the `web3` record writes it, or why it names none. Read: 40 hexadecimal digits
 * in either case, with or without `0x`, on their own or as `web3://<address>`, and either with `:1` after it (Ethereum, the only
 * chain read). The address is written in lower case, which is the form the browser reads and writes a contract in. A path, a query,
 * a name, another chain and a chain written before the address are not read.
 * @param {string} value
 * @returns {Web3Target}
 */
export function web3Target (value) {
  if (value === '' || value.length > MAX_VALUE || NOT_VISIBLE_ASCII.test(value)) return { ok: false, reason: 'web3-not-an-address' }
  const text = value.startsWith('web3://') ? value.slice('web3://'.length) : value
  const bare = CONTRACT_ADDRESS.exec(text)
  if (bare !== null) return { ok: true, address: `web3://0x${(/** @type {string} */ (bare[1])).toLowerCase()}` }
  const onChain = CONTRACT_ON_CHAIN.exec(text)
  if (onChain !== null) return onChain[2] === ETHEREUM ? { ok: true, address: `web3://0x${(/** @type {string} */ (onChain[1])).toLowerCase()}` } : { ok: false, reason: 'web3-other-chain' }
  if (CHAIN_BEFORE_CONTRACT.test(text)) return { ok: false, reason: 'web3-other-chain' }
  return { ok: false, reason: A_NAME.test(text) ? 'web3-a-name' : 'web3-not-an-address' }
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
    case 'ethfs': return ETHFS_ADDRESS.test(value) ? value : null
    case 'https': case 'http': return webAddress(type, value)
    case 'ddoc': return BUNDLE_HASH.test(value) ? value : null
    case 'web3': {
      const target = web3Target(value)
      return target.ok ? target.address : null
    }
    default: return null
  }
}

/** The keys NAMES_0_2 answers: the content keys, then the contract's, which is a record type of its own. @type {readonly (readonly [string, string])[]} */
const WITH_CONTRACT = Object.freeze([...TEXT_KEYS, Object.freeze([CONTRACT_KEY, 'web3'])])

/** @typedef {{ type: string, value: string }} Pointer */
/** @typedef {{ ownerDefault: null, records: Pointer[], provenance: { by: string, proven: boolean, block?: number } }} Answer */

/**
 * @param {Record<string, string | null | undefined>} counted the values of the keys that counted, by text key
 * @param {number} [block] the block they were read at
 * @param {{ web3?: boolean }} [options] `web3`: answer the contract's `web3` record too, as the answer of NAMES_0_2 does; never the answer of NAMES_0_1
 * @returns {Answer}
 */
export function answerOf (counted, block, options = {}) {
  /** @type {Pointer[]} */
  const records = []
  for (const [key, type] of options.web3 === true ? WITH_CONTRACT : TEXT_KEYS) {
    const raw = counted[key]
    const value = typeof raw === 'string' ? textAddress(type, raw) : null
    if (value !== null && records.length < MAX_RECORDS) records.push({ type, value })
  }
  return { ownerDefault: null, records, provenance: { by: SOURCE, proven: false, ...(block === undefined ? {} : { block }) } }
}

/**
 * The answer for a name that is not there, or whose records do not count: what Orivon's ENS gives a name with no records.
 * @param {number} [block]
 * @returns {Answer}
 */
export const notFound = (block) => answerOf({}, block)
