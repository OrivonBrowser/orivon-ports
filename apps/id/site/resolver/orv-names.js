// Resolves a name under `.orv` from the Orivon ID registry on chain: `alice.orv` is `alice.v1.orivonid.eth`. The
// registry (R1) is read directly and no Universal Resolver is asked: the label's resolver, or for a deeper name the
// deepest resolver on the path of subregistries, as ENSv2 finds it. The name loads only when its owner alone controls
// it, so a resolver that someone with a share of the roles put there never answers. Reads are on chain only.

import { sameAddress, ZERO_ADDRESS } from '../sdk/abi.js'
import { ChainError } from '../sdk/chain.js'
import { ADDRESSES, isValidLabel, labelId, readContract, SUFFIX } from '../sdk/orivonid.js'
import { answerOf, notFound } from './orv-answer.js'
import { isContractFailure, isExtended, readRecords } from './orv-records.js'

/** @typedef {import('../sdk/chain.js').Chain} Chain */
/** @typedef {import('./orv-answer.js').Answer} Answer */

export const NAMESPACE = 'orv'

/** The most labels a name may have under `.orv`, the label that was sold included: each costs reads of the registry. */
export const MAX_LABELS = 6

/** The longest ENS name text: what a DNS wire name of 255 bytes holds. */
const MAX_NAME = 253

/** A label below the sold one: 1 to 63 of a-z, 0-9 and inner hyphens, none at positions three and four (ENSIP-15 on ASCII). */
const SUB_LABEL = /^(?!-)(?!..--)[a-z0-9-]{1,63}(?<!-)$/

/** @param {string} message */
const refusal = (message) => Object.assign(new Error(message), { code: 'invalid' })

/** The ENS name of the labels, built from labels already checked. @param {string[]} labels */
export const ensNameOf = (labels) => `${[...labels].reverse().join('.')}.${SUFFIX}`

/**
 * The labels of a `.orv` name from the sold one down: `y.x.alice.orv` is `['alice', 'x', 'y']`. Null when no such name can
 * exist (a label the registrar would not sell, a label that is not ASCII, too many labels). Throws `invalid` for a name
 * that is not under `.orv` at all, which the router should have sent elsewhere.
 * @param {unknown} name
 * @returns {string[] | null}
 */
export function parseOrvName (name) {
  if (typeof name !== 'string') throw refusal('a name is text')
  if (/[^\x21-\x7e]/.test(name)) return null
  const parts = (name.endsWith('.') ? name.slice(0, -1) : name).toLowerCase().split('.')
  if (parts.pop() !== NAMESPACE) throw refusal(`${name} is not a .${NAMESPACE} name`)
  const sold = parts.pop()
  if (sold === undefined || !isValidLabel(sold) || parts.length + 1 > MAX_LABELS || !parts.every((label) => SUB_LABEL.test(label))) return null
  const labels = [sold, ...parts.reverse()]
  return ensNameOf(labels).length > MAX_NAME ? null : labels
}

/**
 * The address a registry call answers, or null for zero, a revert and an answer that is not an address.
 * @param {Chain} chain
 * @param {string} registry
 * @param {string} signature
 * @param {unknown[]} args
 * @param {number} block
 * @returns {Promise<string | null>}
 */
async function addressOf (chain, registry, signature, args, block) {
  try {
    const [address] = await readContract(chain, registry, signature, args, ['address'], block)
    return sameAddress(/** @type {string} */ (address), ZERO_ADDRESS) ? null : /** @type {string} */ (address)
  } catch (error) {
    if (isContractFailure(error)) return null
    throw error
  }
}

/**
 * The deepest resolver on the path from R1 down `labels`, and whether it is the one of the whole name. The path ends
 * where a label has no subregistry; a resolver found above the end of the name is for the name only if it is ENSIP-10.
 * @param {Chain} chain
 * @param {string[]} labels
 * @param {number} block
 * @returns {Promise<{ resolver: string | null, forName: boolean }>}
 */
export async function findResolver (chain, labels, block) {
  let registry = ADDRESSES.r1
  /** @type {string | null} */
  let resolver = null
  for (const [depth, label] of labels.entries()) {
    const last = depth === labels.length - 1
    const [here, below] = await Promise.all([
      addressOf(chain, registry, 'getResolver(string)', [label], block),
      last ? null : addressOf(chain, registry, 'getSubregistry(string)', [label], block)
    ])
    if (here !== null) resolver = here
    if (last) return { resolver, forName: here !== null }
    if (below === null) return { resolver, forName: false }
    registry = below
  }
  return { resolver, forName: false }
}

/**
 * Whether the owner of the sold label alone controls it: R1 names a holder, and that holder has every role on it. R1 not
 * answering these reads is a failure to report, not a name that is absent.
 * @param {Chain} chain
 * @param {string} label
 * @param {number} block
 */
async function ownedAlone (chain, label, block) {
  const id = labelId(label)
  const [[owner], [count]] = await Promise.all([
    readContract(chain, ADDRESSES.r1, 'getOwner(uint256)', [id], ['address'], block),
    readContract(chain, ADDRESSES.r1, 'roleCount(uint256)', [id], ['uint256'], block)
  ])
  if (sameAddress(/** @type {string} */ (owner), ZERO_ADDRESS)) return false
  const [held] = await readContract(chain, ADDRESSES.r1, 'roles(uint256,address)', [id, owner], ['uint256'], block)
  return held === count
}

/**
 * @param {Chain} chain the person's Ethereum node, read only
 * @param {unknown} name a host such as `alice.orv`, `Alice.ORV.` or `docs.alice.orv`
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Answer>} no owner default and no records for a name that is not there
 */
export async function resolveOrv (chain, name, options = {}) {
  const labels = parseOrvName(name)
  if (labels === null) return notFound()
  const block = await chain.blockNumber()
  const { signal } = options
  if (!await ownedAlone(chain, /** @type {string} */ (labels[0]), block)) return notFound(block)
  signal?.throwIfAborted()
  const { resolver, forName } = await findResolver(chain, labels, block)
  if (resolver === null) return notFound(block)
  const extended = await isExtended(chain, resolver, block)
  if (!forName && !extended) return notFound(block)
  signal?.throwIfAborted()
  const found = await readRecords(chain, resolver, extended, ensNameOf(labels), block, signal)
  const answer = answerOf(found, block)
  if (found.failed > 0 && answer.ownerDefault === null && answer.records.length === 0) {
    throw new ChainError('unavailable', `the resolver of ${String(name)} could not answer`)
  }
  return answer
}
