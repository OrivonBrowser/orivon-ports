// NAMES_0_2.setRecord for `.og`: points a name at an IPFS, IPNS or Swarm site by writing the text key its resolver reads
// (`content.ipfs` for ipfs:// and ipns://, `content.bzz` for bzz://) from the person's wallet. The resolver contract lets the registry
// owner and the name's controller write, but this resolver answers a record only while the holder is the controller or there is none,
// so only the holder writes, and a wrapped name's holder only through itself as the controller (its registry owner is the wrapper).
// Nothing is signed for an account that cannot write. The wallet shows the transaction and the person confirms it there: this page
// never holds a key.

import { encodeCall, sameAddress, ZERO_ADDRESS } from '../sdk/abi.js'
import { ChainError } from '../sdk/chain.js'
import { readContract } from '../sdk/read.js'
import { holderOf } from './og-freshness.js'
import { keyOf, parseOgName } from './og-name.js'
import { PROXY } from './og-pins.js'
import { pinBlock, readName } from './og-state.js'

/** @typedef {import('../sdk/chain.js').Chain} Chain */
/** @typedef {import('./og-tail.js').Session} Session */
/** @typedef {import('./og-freshness.js').NameReads} NameReads */
/** @typedef {{ status: 'sent' | 'seen' | 'declined' | 'not-manager' | 'no-resolver' | 'failed', transaction?: string, value?: string, previous?: string | null, block?: number, proven?: boolean }} SetResult */

const CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,200})$/
const IPNS_KEY = /^(?:k[0-9a-z]{50,}|(?:12D3KooW|Qm)[1-9A-HJ-NP-Za-km-z]{40,})$/
const SWARM_REFERENCE = /^[0-9a-fA-F]{64}$/

/** The time a call keeps for its answer once the transaction is in: reading the record back and returning. */
const ANSWER_RESERVE_MS = 1_500

/** @param {string} message */
const invalid = (message) => Object.assign(new Error(message), { code: 'invalid' })

/**
 * The text key and value a `contenthash` value of the standard is written as, or null when it is not one: ipfs:// takes a content id,
 * ipns:// a key, bzz:// the 64 hexadecimal characters of a Swarm reference, and nothing follows any of them.
 * @param {unknown} value
 * @returns {{ key: string, text: string } | null}
 */
export function contenthashRecord (value) {
  if (typeof value !== 'string') return null
  const match = /^(ipfs|ipns|bzz):\/\/([^/?#\s]+)$/.exec(value)
  const [, scheme, root] = match ?? []
  if (scheme === 'ipfs' && root !== undefined && CID.test(root)) return { key: 'content.ipfs', text: `ipfs://${root}` }
  if (scheme === 'ipns' && root !== undefined && IPNS_KEY.test(root)) return { key: 'content.ipfs', text: `ipns://${root}` }
  if (scheme === 'bzz' && root !== undefined && SWARM_REFERENCE.test(root)) return { key: 'content.bzz', text: `bzz://${root.toLowerCase()}` }
  return null
}

/**
 * Whether `account` may write the name's records so that the resolver will answer them, and if not, what to do about it in words.
 * That is the holder, with no controller or itself as the controller: a controller that is not the holder (a seller's leftover, or
 * one the holder never chose) keeps every record out of the answer, so a write it makes, or one made over it, would be paid for
 * and never seen. For a wrapped name the registry's owner is the wrapper, so the write goes through the controller, and the holder
 * must be it.
 * @param {string} label
 * @param {NameReads} reads the name at a block
 * @param {string} account
 * @returns {{ manager: true } | { manager: false, words: string }}
 */
export function managerOf (label, reads, account) {
  const { found, holder, wrapped, stranded } = holderOf(keyOf(label), reads)
  if (!found || holder === null) return { manager: false, words: `${label}.og is not registered, so no account can set its records.` }
  if (stranded) return { manager: false, words: `${label}.og is held by the wrapper with no token for it, so no account can set its records.` }
  if (!sameAddress(holder, account)) return { manager: false, words: wrapped ? `${label}.og is wrapped and held by another account.` : `${label}.og is owned by another account.` }
  const { controller } = reads
  if (controller === null) return { manager: false, words: `The resolver contract did not say who controls ${label}.og, so a record written now could not be vouched for. Try again shortly.` }
  if (wrapped) {
    if (sameAddress(controller, holder)) return { manager: true }
    return {
      manager: false,
      words: `${label}.og is wrapped, so the registry's owner is the wrapper and its resolver takes records only from a controller set before the name was wrapped, and yours is not. Unwrap it, make your account its controller with setController, and wrap it again.`
    }
  }
  if (sameAddress(controller, ZERO_ADDRESS) || sameAddress(controller, holder)) return { manager: true }
  return { manager: false, words: `${label}.og is yours, but another account is its controller, so the resolver would not answer a record written now. Clear the controller with unsetController, or make your account the controller with setController, and set the record again.` }
}

/**
 * @param {Chain} chain the person's Ethereum node and wallet
 * @param {Session} session
 * @param {{ name: unknown, recordType: unknown, value: unknown }} request what the standard's `setRecord` was called with
 * @param {{ deadlineAt?: number, progress?: (detail: string, fraction?: number) => void }} [options]
 * @returns {Promise<SetResult>} the standard's answer; the words of a refusal go to `progress`, which only a watched call shows
 */
export async function setOgRecord (chain, session, request, options = {}) {
  const label = parseOgName(request.name)
  if (label === null) throw invalid('that is not a name this resolver serves')
  if (request.recordType !== 'contenthash') throw invalid('only the contenthash record can be set')
  const written = contenthashRecord(request.value)
  if (written === null) throw invalid('the value must be an ipfs://, ipns:// or bzz:// address with nothing after it')
  const { deadlineAt = Infinity, progress } = options
  const key = keyOf(label)
  try {
    const account = (await chain.addresses())[0]
    if (account === undefined) return { status: 'declined' }
    const block = await pinBlock(chain, { latest: true })
    const reads = await readName(chain, key, block)
    const right = managerOf(label, reads, account)
    if (!right.manager) {
      progress?.(right.words)
      return { status: 'not-manager' }
    }
    const previous = reads.values[written.key]
    /** @type {string} */
    let transaction
    try {
      transaction = await chain.sendTransaction({ from: account, to: PROXY, data: encodeCall('setTextRecord(bytes32,string,string)', [key, written.key, written.text]) })
    } catch (error) {
      // An estimate that reverts is the contract's "Not yours": the name moved between the read and the send.
      if (error instanceof ChainError && error.reason === 'reverted') return { status: 'not-manager' }
      throw error
    }
    session.written.set(label, block)
    const left = deadlineAt - session.now() - ANSWER_RESERVE_MS
    if (left <= 0) return { status: 'sent', transaction, value: written.text }
    try {
      const receipt = await chain.waitForReceipt(transaction, { timeoutMs: left })
      if (receipt.status !== 1) return { status: 'failed', transaction }
      session.written.set(label, receipt.blockNumber)
      const [now] = await readContract(chain, PROXY, 'getTextRecord(bytes32,string)', [key, written.key], ['string'], receipt.blockNumber)
      if (now !== written.text) return { status: 'sent', transaction, value: written.text }
      return { status: 'seen', transaction, value: written.text, previous: previous === null || previous === undefined || previous === '' ? null : previous, block: receipt.blockNumber, proven: false }
    } catch (error) {
      // The transaction is out: a wait or a read that failed after it leaves the answer at "sent".
      if (error instanceof ChainError) return { status: 'sent', transaction, value: written.text }
      throw error
    }
  } catch (error) {
    if (error instanceof ChainError && error.reason === 'declined') return { status: 'declined' }
    throw error
  }
}
