// Contract reads through a Chain: one call, a decoded call, a batch of calls in one `aggregate3`, and a resolver's records, which
// are asked in one call when the resolver or Multicall3 can take them together and one by one otherwise. Everything a node or a
// contract answers is untrusted: a revert or an answer that does not decode is the contract's failure, a node that could not be
// asked is not.

import { AbiError, decode, decodeRevert, encodeCall } from './abi.js'
import { ChainError } from './chain.js'
import { dnsEncode } from './ens.js'

/** @typedef {import('./chain.js').Chain} Chain */
/** @typedef {import('./chain.js').BlockRef} BlockRef */

/** The ERC-165 id of ENSIP-10's `resolve(bytes,bytes)`. */
export const ENSIP10_INTERFACE = '0x9061b923'

/** Multicall3, at the same address on every chain it is deployed to. Only its `aggregate3` is used, and only to read. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'

/** @param {Uint8Array} revert */
function revertWords (revert) {
  const found = decodeRevert(revert)
  if (found.kind === 'reason') return found.reason
  if (found.kind === 'panic') return `panic ${found.code}`
  return found.kind === 'custom' ? `error ${found.selector}` : 'reverted'
}

/**
 * Whether a failure is the contract's (a revert, an answer that does not decode) and not the node's or the person's.
 * @param {unknown} error
 */
export const isContractFailure = (error) =>
  error instanceof AbiError || (error instanceof ChainError && (error.reason === 'reverted' || error.reason === 'badAnswer'))

/**
 * One call, on chain only: an off-chain lookup is not an answer here.
 * @param {Chain} chain
 * @param {string} to
 * @param {Uint8Array} data
 * @param {BlockRef} [block]
 */
export async function rawCall (chain, to, data, block) {
  const result = await chain.call({ to, data }, block, { ccipRead: false })
  if (result.data !== null) return result.data
  const revert = result.revert ?? result.offchainLookup ?? new Uint8Array(0)
  throw new ChainError('reverted', result.revert === null ? 'an off-chain lookup' : revertWords(revert), { revert })
}

/**
 * Calls `signature` on a contract and decodes its answer. Rejects `reverted` with the revert reason in the
 * message, and `badAnswer` for an answer that is empty (no contract there) or does not decode.
 * @param {Chain} chain
 * @param {string} to
 * @param {string} signature
 * @param {unknown[]} args
 * @param {string[]} outputs
 * @param {BlockRef} [block]
 */
export async function readContract (chain, to, signature, args, outputs, block) {
  const data = await rawCall(chain, to, encodeCall(signature, args), block)
  try {
    return decode(outputs, data)
  } catch (error) {
    if (error instanceof AbiError) throw new ChainError('badAnswer', `${signature} answered something else than ${outputs.join(',')}`, { cause: error })
    throw error
  }
}

/**
 * A revert or an unreadable answer becomes `fallback`; a node that could not be asked is still an error.
 * @template T @template F
 * @param {Promise<T>} read
 * @param {F} fallback
 * @returns {Promise<T | F>}
 */
export async function orElse (read, fallback) {
  try {
    return await read
  } catch (error) {
    if (error instanceof ChainError && (error.reason === 'reverted' || error.reason === 'badAnswer')) return fallback
    throw error
  }
}

/**
 * Whether a resolver says it takes ENSIP-10 calls. One that does not answer the question does not.
 * @param {Chain} chain
 * @param {string} resolver
 * @param {BlockRef} [block]
 */
export async function isExtended (chain, resolver, block) {
  const answer = await orElse(readContract(chain, resolver, 'supportsInterface(bytes4)', [ENSIP10_INTERFACE], ['bool'], block), [false])
  return answer[0] === true
}

/**
 * Calls a resolver for `name` as ENSIP-10 says: through its `resolve` when it declares it, directly otherwise.
 * @param {Chain} chain
 * @param {string} resolver
 * @param {string} name
 * @param {Uint8Array} inner the profile call, such as addr(node)
 * @param {BlockRef} [block]
 * @returns {Promise<Uint8Array>} the profile's ABI-encoded answer
 */
export async function resolveWith (chain, resolver, name, inner, block) {
  if (!await isExtended(chain, resolver, block)) return await rawCall(chain, resolver, inner, block)
  const [answer] = await readContract(chain, resolver, 'resolve(bytes,bytes)', [dnsEncode(name), inner], ['bytes'], block)
  return /** @type {Uint8Array} */ (answer)
}

/**
 * @typedef {object} Profile One record asked of a resolver.
 * @property {Uint8Array} call the profile call, such as `addr(node)` or `text(node, key)`
 * @property {string} output the ABI type it answers
 */
/** @typedef {{ ok: true, value: unknown } | { ok: false }} Answer one record read: its value, or that the resolver failed it */

/** @param {Profile} profile @param {Uint8Array} data the ABI-encoded value, or what a failed call left @returns {Answer} */
function answerOf (profile, data) {
  try {
    return { ok: true, value: decode([profile.output], data)[0] }
  } catch (error) {
    if (error instanceof AbiError) return { ok: false }
    throw error
  }
}

/**
 * Every record in the resolver's own `multicall`: through ENSIP-10's `resolve` for a resolver that declares it (the
 * PermissionedResolver takes no profile call any other way, and says per record which call it refused), directly
 * otherwise. A resolver that takes none of this reverts as a whole, and so does one whose multicall stops at the first
 * revert, which leaves the next way to read to tell which record it was.
 * @param {Chain} chain @param {string} resolver @param {boolean} extended @param {Uint8Array} dns @param {Profile[]} profiles @param {BlockRef} [block]
 * @returns {Promise<Answer[]>}
 */
async function viaResolver (chain, resolver, extended, dns, profiles, block) {
  const batch = encodeCall('multicall(bytes[])', [profiles.map((one) => one.call)])
  const answer = extended
    ? /** @type {Uint8Array} */ (decode(['bytes'], await rawCall(chain, resolver, encodeCall('resolve(bytes,bytes)', [dns, batch]), block))[0])
    : await rawCall(chain, resolver, batch, block)
  const items = /** @type {Uint8Array[]} */ (decode(['bytes[]'], answer)[0])
  if (items.length !== profiles.length) throw new ChainError('badAnswer', `the resolver answered ${items.length} of ${profiles.length} records`)
  return profiles.map((one, index) => answerOf(one, /** @type {Uint8Array} */ (items[index])))
}

/**
 * Every record in one `aggregate3` of Multicall3, each call allowed to fail on its own. An address with no code
 * answers nothing, which does not decode, so a chain without Multicall3 falls through to the next way to read.
 * @param {Chain} chain @param {string} resolver @param {boolean} extended @param {Uint8Array} dns @param {Profile[]} profiles @param {BlockRef} [block]
 * @returns {Promise<Answer[]>}
 */
async function viaMulticall3 (chain, resolver, extended, dns, profiles, block) {
  const calls = profiles.map((one) => [resolver, true, extended ? encodeCall('resolve(bytes,bytes)', [dns, one.call]) : one.call])
  const results = /** @type {[boolean, Uint8Array][]} */ (decode(['(bool,bytes)[]'], await rawCall(chain, MULTICALL3, encodeCall('aggregate3((address,bool,bytes)[])', [calls]), block))[0])
  if (results.length !== profiles.length) throw new ChainError('badAnswer', `Multicall3 answered ${results.length} of ${profiles.length} calls`)
  return profiles.map((one, index) => {
    const [success, returned] = /** @type {[boolean, Uint8Array]} */ (results[index])
    if (!success) return { ok: false }
    try {
      return answerOf(one, extended ? /** @type {Uint8Array} */ (decode(['bytes'], returned)[0]) : returned)
    } catch (error) {
      if (error instanceof AbiError) return { ok: false }
      throw error
    }
  })
}

/**
 * Every record one call at a time: the present way, kept for a resolver and a chain that take no batch.
 * @param {Chain} chain @param {string} resolver @param {boolean} extended @param {Uint8Array} dns @param {Profile[]} profiles @param {BlockRef} [block]
 * @returns {Promise<Answer[]>}
 */
async function oneByOne (chain, resolver, extended, dns, profiles, block) {
  return await Promise.all(profiles.map(async (one) => {
    try {
      const data = extended
        ? /** @type {Uint8Array} */ (decode(['bytes'], await rawCall(chain, resolver, encodeCall('resolve(bytes,bytes)', [dns, one.call]), block))[0])
        : await rawCall(chain, resolver, one.call, block)
      return answerOf(one, data)
    } catch (error) {
      if (isContractFailure(error)) return { ok: false }
      throw error
    }
  }))
}

/**
 * The records a resolver answers for a name, asked in as few calls as the resolver and the chain allow: one `multicall`
 * of the resolver (ENSIP-10's `resolve` around it when the resolver declares that), else one `aggregate3` of Multicall3,
 * else one call each. A record the resolver fails is that record's `{ ok: false }` and never the whole read's; a node
 * that cannot be asked rejects, as every read does. Each way is tried only when the one before it failed as a whole.
 * @param {Chain} chain
 * @param {string} resolver
 * @param {string} name the ENS name the records are of
 * @param {Profile[]} profiles
 * @param {BlockRef} [block]
 * @returns {Promise<Answer[]>} one answer per profile, in order
 */
export async function readProfiles (chain, resolver, name, profiles, block) {
  if (profiles.length === 0) return []
  const extended = await isExtended(chain, resolver, block)
  const dns = dnsEncode(name)
  if (profiles.length > 1) {
    for (const way of [viaResolver, viaMulticall3]) {
      try {
        return await way(chain, resolver, extended, dns, profiles, block)
      } catch (error) {
        if (!isContractFailure(error)) throw error
      }
    }
  }
  return await oneByOne(chain, resolver, extended, dns, profiles, block)
}

/**
 * Calls in one `aggregate3` of Multicall3 at one block, each allowed to fail on its own. The answers are in the order of the calls: the
 * returned data of a call that succeeded, null for one that reverted. Multicall3 not answering as a whole is the node's failure.
 * @param {Chain} chain
 * @param {{ to: string, data: Uint8Array }[]} calls
 * @param {BlockRef} block
 * @returns {Promise<(Uint8Array | null)[]>}
 */
export async function readTogether (chain, calls, block) {
  const batch = encodeCall('aggregate3((address,bool,bytes)[])', [calls.map((call) => [call.to, true, call.data])])
  let results
  try {
    results = /** @type {[boolean, Uint8Array][]} */ (decode(['(bool,bytes)[]'], await rawCall(chain, MULTICALL3, batch, block))[0])
  } catch (error) {
    if (isContractFailure(error)) throw new ChainError('badAnswer', 'Multicall3 did not answer the batch', { cause: error })
    throw error
  }
  if (results.length !== calls.length) throw new ChainError('badAnswer', `Multicall3 answered ${results.length} of ${calls.length} calls`)
  return results.map(([success, returned]) => success ? returned : null)
}
