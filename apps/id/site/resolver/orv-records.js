// Reads a name's contenthash and content text records from its resolver, on chain only: all in one multicall when the
// resolver is an ENSIP-10 one, otherwise (or when it cannot answer the batch) one call each, a few at a time. A record
// that is empty, or that the resolver says it has no profile for, is absent; one it fails to answer is failed.

import { AbiError, decode, encodeCall, selector } from '../sdk/abi.js'
import { toHex } from '../sdk/bytes.js'
import { ChainError } from '../sdk/chain.js'
import { dnsEncode, namehash } from '../sdk/ens.js'
import { rawCall, readContract } from '../sdk/orivonid.js'
import { TEXT_KEYS } from './orv-answer.js'

/** @typedef {import('../sdk/chain.js').Chain} Chain */
/** @typedef {{ value: Uint8Array | string } | 'absent' | 'failed'} Outcome */
/** @typedef {{ call: Uint8Array, text: boolean }} Profile */

/** The ERC-165 id of ENSIP-10's `resolve(bytes,bytes)`. */
export const EXTENDED_RESOLVER = '0x9061b923'

/** How many records one resolver is asked for at once when they are asked one by one. */
const AT_ONCE = 4

const UNSUPPORTED_PROFILE = toHex(selector('UnsupportedResolverProfile(bytes4)'))

/** Whether a failure is the contract's (a revert, an answer that does not decode) and not the node's or the person's. @param {unknown} error */
export const isContractFailure = (error) =>
  error instanceof AbiError || (error instanceof ChainError && (error.reason === 'reverted' || error.reason === 'badAnswer'))

/**
 * Whether `resolver` says it takes ENSIP-10 calls. A resolver that does not answer the question does not.
 * @param {Chain} chain
 * @param {string} resolver
 * @param {number} block
 */
export async function isExtended (chain, resolver, block) {
  try {
    return (await readContract(chain, resolver, 'supportsInterface(bytes4)', [EXTENDED_RESOLVER], ['bool'], block))[0] === true
  } catch (error) {
    if (isContractFailure(error)) return false
    throw error
  }
}

/**
 * What a revert's data says about one record: no profile for it is an absent record, anything else a failure.
 * @param {Uint8Array} revert
 * @returns {Outcome}
 */
const revertOutcome = (revert) => toHex(revert.subarray(0, 4)) === UNSUPPORTED_PROFILE ? 'absent' : 'failed'

/** @param {boolean} text @param {Uint8Array} answer the ABI-encoded value of one profile call @returns {Outcome} */
function valueOutcome (text, answer) {
  try {
    const [value] = decode([text ? 'string' : 'bytes'], answer)
    return (value instanceof Uint8Array && value.length === 0) || value === '' ? 'absent' : { value: /** @type {Uint8Array | string} */ (value) }
  } catch {
    return 'failed'
  }
}

/**
 * One item of a multicall answer: the encoded value, or the data the call reverted with, which starts with a selector.
 * @param {boolean} text
 * @param {Uint8Array} item
 * @returns {Outcome}
 */
function itemOutcome (text, item) {
  if (item.length === 0) return 'absent'
  const valueFollows = item.length >= 32 && item.subarray(0, 31).every((byte) => byte === 0) && item[31] === 0x20
  return valueFollows ? valueOutcome(text, item) : revertOutcome(item)
}

/**
 * One `resolve(name, inner)`: the profile's ABI-encoded answer.
 * @param {Chain} chain
 * @param {string} resolver
 * @param {Uint8Array} dns
 * @param {Uint8Array} inner
 * @param {number} block
 * @returns {Promise<Uint8Array>}
 */
async function resolveCall (chain, resolver, dns, inner, block) {
  return /** @type {Uint8Array} */ (decode(['bytes'], await rawCall(chain, resolver, encodeCall('resolve(bytes,bytes)', [dns, inner]), block))[0])
}

/**
 * Every record in one `resolve(name, multicall(calls))`.
 * @param {Chain} chain
 * @param {string} resolver
 * @param {Uint8Array} dns
 * @param {Profile[]} profiles
 * @param {number} block
 * @returns {Promise<Outcome[]>}
 */
async function readTogether (chain, resolver, dns, profiles, block) {
  const answer = await resolveCall(chain, resolver, dns, encodeCall('multicall(bytes[])', [profiles.map((one) => one.call)]), block)
  const items = /** @type {Uint8Array[]} */ (decode(['bytes[]'], answer)[0])
  if (items.length !== profiles.length) throw new ChainError('badAnswer', `it answered ${items.length} of ${profiles.length} records`)
  return profiles.map((one, index) => itemOutcome(one.text, /** @type {Uint8Array} */ (items[index])))
}

/**
 * @param {Chain} chain
 * @param {string} resolver
 * @param {boolean} extended
 * @param {Uint8Array} dns
 * @param {Profile} one
 * @param {number} block
 * @returns {Promise<Outcome>}
 */
async function readOne (chain, resolver, extended, dns, one, block) {
  try {
    const answer = extended ? await resolveCall(chain, resolver, dns, one.call, block) : await rawCall(chain, resolver, one.call, block)
    return valueOutcome(one.text, answer)
  } catch (error) {
    if (!isContractFailure(error)) throw error
    return error instanceof ChainError && error.revert !== undefined ? revertOutcome(error.revert) : 'failed'
  }
}

/**
 * @param {Chain} chain
 * @param {string} resolver the name's resolver
 * @param {boolean} extended whether it takes ENSIP-10 calls (`isExtended`)
 * @param {string} name the ENS name, such as `alice.v1.orivonid.eth`
 * @param {number} block every read is made at this block
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ contenthash: Uint8Array | null, texts: Record<string, string | null>, failed: number }>}
 */
export async function readRecords (chain, resolver, extended, name, block, signal) {
  const dns = dnsEncode(name)
  const node = namehash(name)
  /** @type {Profile[]} */
  const profiles = [
    { call: encodeCall('contenthash(bytes32)', [node]), text: false },
    ...TEXT_KEYS.map(([key]) => ({ call: encodeCall('text(bytes32,string)', [node, key]), text: true }))
  ]
  /** @type {Outcome[] | null} */
  let outcomes = null
  if (extended) {
    try {
      outcomes = await readTogether(chain, resolver, dns, profiles, block)
    } catch (error) {
      if (!isContractFailure(error)) throw error
    }
  }
  if (outcomes === null) {
    outcomes = []
    for (let from = 0; from < profiles.length; from += AT_ONCE) {
      signal?.throwIfAborted()
      const group = profiles.slice(from, from + AT_ONCE)
      outcomes.push(...await Promise.all(group.map(async (one) => await readOne(chain, resolver, extended, dns, one, block))))
    }
  }
  const [hash, ...texts] = outcomes
  return {
    contenthash: typeof hash === 'object' && hash.value instanceof Uint8Array ? hash.value : null,
    texts: Object.fromEntries(TEXT_KEYS.map(([key], index) => {
      const outcome = texts[index]
      return [key, typeof outcome === 'object' && typeof outcome.value === 'string' ? outcome.value : null]
    })),
    failed: outcomes.filter((outcome) => outcome === 'failed').length
  }
}
