// What a registration reads from the chain: the preflight before anything is sent, the account's resolver, and
// the facts each step of the flow is decided from. Nothing here is remembered; every call asks the chain again.

import { sameAddress } from './sdk/abi.js'
import { toHex } from './sdk/bytes.js'
import { ChainError } from './sdk/chain.js'
import { ADDRESSES, attribution, isReserved, labelProblem, normalizeInput, ownerOf, price, readContract, records, salesStatus } from './sdk/orivonid.js'
import { createHider } from './register-decoys.js'
import { ERC1155_ACCEPTED, MIN_COMMITMENT_AGE, RECORD_ROLES, receiverCheck, SALT } from './register-tx.js'

/** @typedef {import('./sdk/chain.js').Chain} Chain */
/** @typedef {{ address: string, mode: 'deploy' | 'reuse' | 'blocked', why: string | null }} ResolverPlan */

/** A revert or an unreadable answer is `fallback`; a node that could not be asked is still an error. @template T @param {Promise<T>} read @param {T} fallback */
async function orElse (read, fallback) {
  try {
    return await read
  } catch (error) {
    if (error instanceof ChainError && (error.reason === 'reverted' || error.reason === 'badAnswer')) return fallback
    throw error
  }
}

/** The address the factory gives the account's resolver. No label is named. @param {Chain} chain @param {string} user @returns {Promise<string>} */
export async function predictedResolver (chain, user) {
  const [predicted] = await readContract(chain, ADDRESSES.verifiableFactory, 'predictProxyAddress(address,uint256)', [user, SALT], ['address'])
  return /** @type {string} */ (predicted)
}

/**
 * The account's one resolver, at the address the factory predicts for it. Reused when the proxy there is a
 * PermissionedResolver and the account holds the roles this site writes with; made when nothing is there;
 * blocked when something else is, which the fixed salt leaves no other address for.
 * @param {Chain} chain
 * @param {string} user
 * @returns {Promise<ResolverPlan>}
 */
export async function resolverFor (chain, user) {
  const address = await predictedResolver(chain, user)
  if ((await chain.getCode(address)).length === 0) return { address, mode: 'deploy', why: null }
  const [implementation] = await orElse(readContract(chain, ADDRESSES.verifiableFactory, 'verifyContract(address)', [address], ['address']), [null])
  if (typeof implementation !== 'string' || !sameAddress(implementation, ADDRESSES.resolverImplementation)) {
    return { address, mode: 'blocked', why: 'the contract there is not a PermissionedResolver made by the factory' }
  }
  const [held] = await orElse(readContract(chain, address, 'hasRootRoles(uint256,address)', [RECORD_ROLES, user], ['bool']), [false])
  if (held !== true) return { address, mode: 'blocked', why: 'the account no longer holds the roles to set its address and text records' }
  return { address, mode: 'reuse', why: null }
}

/** @param {Chain} chain @param {string} account */
async function daiOf (chain, account) {
  const [balance, allowance] = await Promise.all([
    readContract(chain, ADDRESSES.dai, 'balanceOf(address)', [account], ['uint256']),
    readContract(chain, ADDRESSES.dai, 'allowance(address,address)', [account, ADDRESSES.registrar], ['uint256'])
  ])
  return { balance: /** @type {bigint} */ (balance[0]), allowance: /** @type {bigint} */ (allowance[0]) }
}

/**
 * Whether a mint to `account` would be accepted: an account with no code takes any; one with code (a contract, or
 * an account that delegates to one) must answer the ERC-1155 receiver hook with its selector. The hook call carries
 * the label's id, so a short label is asked among decoys.
 * @param {Chain} chain
 * @param {string} account
 * @param {string} label
 * @param {Pick<ReturnType<typeof createHider>, 'among'>} [hider]
 * @param {Uint8Array} [known] the account's code, when the caller has read it
 * @returns {Promise<{ ok: true, kind: 'account' | 'accepts' } | { ok: false, detail: string }>}
 */
export async function receiverOk (chain, account, label, hider = createHider(), known) {
  const code = known ?? await chain.getCode(account)
  if (code.length === 0) return { ok: true, kind: 'account' }
  const result = await hider.among(label, async (one) => await chain.call(receiverCheck(account, one), 'latest', { ccipRead: false }))
  if (result.data !== null && result.data.length >= 4 && toHex(result.data.subarray(0, 4)) === ERC1155_ACCEPTED) return { ok: true, kind: 'accepts' }
  const kind = toHex(code.subarray(0, 3)) === 'ef0100' ? 'delegates to code' : 'is a contract'
  return { ok: false, detail: result.data === null ? `the account ${kind} that reverts on the receiver hook` : `the account ${kind} that does not answer the receiver hook with its selector` }
}

/**
 * @typedef {{ ok: true, label: string, price: bigint, balance: bigint, allowance: bigint, resolver: ResolverPlan, receiver: 'account' | 'accepts' }
 *   | { ok: false, reason: string, detail: string, extra?: Record<string, unknown> }} Check
 */

/**
 * Everything to settle before a first transaction: the input, whether the name is free and for sale, whether the
 * account can pay and receive it, and what its resolver needs. The first problem found is the answer. The label
 * reaches the person's node in two questions (who holds it, and whether the account takes it), each asked among
 * decoys for a short label and never together with another read, so the node's in-flight limit is not reached.
 * @param {Chain} chain
 * @param {unknown} input what the person typed
 * @param {string} account
 * @param {ReturnType<typeof createHider>} [hider]
 * @returns {Promise<Check>}
 */
export async function checkRegistration (chain, input, account, hider = createHider()) {
  const normal = normalizeInput(input)
  if (!normal.ok) return { ok: false, reason: normal.reason, detail: normal.reason }
  const label = normal.label
  const problem = labelProblem(label)
  if (problem !== null) return { ok: false, reason: 'invalidLabel', detail: problem }
  if (isReserved(label)) return { ok: false, reason: 'reserved', detail: label }
  const holder = await hider.among(label, async (one) => await ownerOf(chain, one))
  if (holder !== null) return { ok: false, reason: 'taken', detail: holder, extra: { holder, mine: sameAddress(holder, account) } }
  const [sales, dai, resolver, code] = await Promise.all([salesStatus(chain), daiOf(chain, account), resolverFor(chain, account), chain.getCode(account)])
  if (!sales.open) {
    const reachable = sales.reachable.ethToR0 && sales.reachable.r0ToR1
    const reason = sales.daiAboveFloor === false ? 'daiBelowFloor' : sales.beneficiary === null ? 'noBeneficiary' : !reachable ? 'v1Unreachable' : 'salesClosed'
    return { ok: false, reason, detail: sales.daiRevert ?? sales.beneficiaryRevert ?? reason }
  }
  const cost = price(label)
  if (dai.balance < cost) return { ok: false, reason: 'notEnoughDai', detail: `${dai.balance} of ${cost}`, extra: { have: dai.balance, need: cost } }
  const receiver = await receiverOk(chain, account, label, hider, code)
  if (!receiver.ok) return { ok: false, reason: 'receiverRefuses', detail: receiver.detail }
  if (resolver.mode === 'blocked') return { ok: false, reason: 'resolverBlocked', detail: resolver.why ?? '', extra: { resolver: resolver.address } }
  return { ok: true, label, price: cost, balance: dai.balance, allowance: dai.allowance, resolver, receiver: receiver.kind }
}

/**
 * @typedef {object} Subject
 * @property {string} commitment
 * @property {string} label
 * @property {string} owner
 * @property {string} resolver
 * @property {Record<string, string>} texts
 * @property {Partial<Record<string, string>>} [hashes] the sends stored so far
 * @property {{ step: string } | null} [pending] a send that may not be mined yet
 */

/**
 * Whether the commitment was sent and mined, from what the record holds: a stored hash or a pending send of a later step
 * means the commit went out, and a commit still waiting to be mined does not count. A commitment that stands on chain
 * says so itself; this is for the one that no longer does.
 * @param {Subject} subject
 */
function commitSettled (subject) {
  if (subject.pending?.step === 'commit') return false
  return Object.keys(subject.hashes ?? {}).length > 0 || (subject.pending ?? null) !== null
}

/**
 * The chain as a registration step sees it, read at the newest block. `stale` is true while the node's head is
 * older than a block a receipt already named, so the reads after a send never lag the send.
 *
 * While the commitment matures, nothing here names the label: the commitment's age, the account's allowance, the
 * resolver's code and the block's time are all the node is asked. The label's holder is read once the commitment is
 * old enough to reveal, and after a commitment that has been spent; `holder` is null when it was not read.
 * @param {Chain} chain
 * @param {Subject} subject
 * @param {number} floor
 */
export async function observe (chain, subject, floor) {
  const head = await chain.getBlock('latest')
  if (head === null) throw new ChainError('unavailable', 'the node has no newest block')
  if (head.number < floor) return { stale: true, head }
  const [commitmentAt, dai, code] = await Promise.all([
    readContract(chain, ADDRESSES.registrar, 'commitmentAt(bytes32)', [subject.commitment], ['uint256']),
    daiOf(chain, subject.owner), chain.getCode(subject.resolver)
  ])
  const at = Number(commitmentAt[0])
  const revealable = at !== 0 && head.timestamp >= at + MIN_COMMITMENT_AGE
  const spent = at === 0 && commitSettled(subject)
  const holder = revealable || spent ? await ownerOf(chain, subject.label) : null
  if (holder === null) return { stale: false, head, holder, commitmentAt: at, allowance: dai.allowance, resolverCode: code.length > 0 }
  if (!sameAddress(holder, subject.owner)) return { stale: false, head, holder }
  const found = await records(chain, subject.label, Object.keys(subject.texts))
  const recordsDone = found.addr !== null && sameAddress(found.addr, subject.owner) && Object.entries(subject.texts).every(([key, value]) => found.texts[key] === value)
  const attributed = recordsDone ? await attribution(chain, subject.label, subject.owner) : null
  return { stale: false, head, holder, resolverCode: code.length > 0, recordsDone, attributed }
}
