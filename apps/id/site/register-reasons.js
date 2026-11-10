// Why a registration cannot go on, by name. `recover` says what the person can do: edit the input, retry the
// step, or nothing. The words are plain defaults; a page may draw its own around the same names.

import { decodeRevert } from './sdk/abi.js'
import { ChainError } from './sdk/chain.js'
import { RelayError } from './relay.js'

/** @typedef {'edit' | 'retry' | 'none'} Recover */

/** @type {Readonly<Record<string, { recover: Recover, words: string }>>} */
export const REASONS = Object.freeze({
  empty: { recover: 'edit', words: 'Type the name you want.' },
  notAscii: { recover: 'edit', words: 'A name uses the letters a to z, the digits 0 to 9 and hyphens only.' },
  invalidLabel: { recover: 'edit', words: 'This is not a name the registrar sells: 3 to 63 letters, digits or hyphens, none at either end, and not shaped like an address.' },
  reserved: { recover: 'edit', words: 'This name is kept by Orivon and is not for sale.' },
  taken: { recover: 'edit', words: 'Someone already holds this name.' },
  daiBelowFloor: { recover: 'retry', words: 'Sales are paused while DAI trades below 80 cents. Try again later.' },
  noBeneficiary: { recover: 'retry', words: 'Sales are paused: the registrar has no payee at the moment. Try again later.' },
  v1Unreachable: { recover: 'retry', words: 'Sales are paused: the registry cannot be reached from orivonid.eth at the moment.' },
  salesClosed: { recover: 'retry', words: 'Sales are closed at the moment. Try again later.' },
  notEnoughDai: { recover: 'none', words: 'The wallet holds less DAI than the name costs.' },
  receiverRefuses: {
    recover: 'none',
    words: 'This wallet is a contract, or an account that delegates to one, and its code does not accept the name token (ERC-1155), so the sale would fail. Use an ordinary account.'
  },
  resolverBlocked: { recover: 'none', words: 'A contract that is not a resolver you control sits at the address Orivon ID uses for your resolver.' },
  recordDiscarded: { recover: 'edit', words: 'The registration saved in this browser did not match its own name and price, so it was dropped and nothing was sent. Start the registration again.' },
  pendingExists: { recover: 'none', words: 'Another registration of this wallet is still in progress. Finish or forget it first.' },
  noWallet: { recover: 'none', words: 'No wallet is available to sign.' },
  declined: { recover: 'retry', words: 'The request was declined, so nothing was sent.' },
  unavailable: { recover: 'retry', words: 'The Ethereum node or the wallet could not answer. Nothing was sent by this step.' },
  timeout: { recover: 'retry', words: 'The node took too long to answer.' },
  limit: { recover: 'retry', words: 'Too many requests were sent at once. Try again in a moment.' },
  refused: { recover: 'retry', words: 'The node or the wallet refused the request as malformed.' },
  badAnswer: { recover: 'retry', words: 'The node answered something this page cannot read.' },
  unknownOutcome: { recover: 'retry', words: 'It is not known whether the transaction went out. Check again before sending another.' },
  reverted: { recover: 'retry', words: 'The transaction would fail on chain.' },
  commitmentTooNew: { recover: 'retry', words: 'The commitment is not a minute old yet.' },
  commitmentTooOld: { recover: 'retry', words: 'The commitment is more than a day old, or was never made.' },
  resolverNotOwn: { recover: 'none', words: 'A resolver may be set only when the owner is the sender.' },
  allowanceShort: { recover: 'retry', words: 'The DAI approval is smaller than the price.' },
  relayFailed: { recover: 'retry', words: 'The private relay did not take the transaction. Nothing was sent. You can send it publicly instead.' },
  notMined: { recover: 'retry', words: 'The transaction was not mined in time. It may still be.' },
  notAttributed: { recover: 'retry', words: 'The name is bought, but it does not yet resolve to this address on chain.' }
})

/** The registrar's revert strings, in its check order, and what DAI says when a payment cannot be taken. */
export const REVERT_REASONS = Object.freeze([
  ['invalid label', 'invalidLabel'],
  ['resolver only for your own name', 'resolverNotOwn'],
  ['commitment too new', 'commitmentTooNew'],
  ['commitment too old', 'commitmentTooOld'],
  ['v1 unreachable', 'v1Unreachable'],
  ['DAI below $0.80', 'daiBelowFloor'],
  ['no beneficiary', 'noBeneficiary'],
  ['Dai/insufficient-balance', 'notEnoughDai'],
  ['Dai/insufficient-allowance', 'allowanceShort']
])

/** @type {Readonly<Record<string, string>>} */
const CHAIN_REASONS = Object.freeze({
  noWallet: 'noWallet', declined: 'declined', unavailable: 'unavailable', timeout: 'timeout', limit: 'limit', invalid: 'refused',
  unknownOutcome: 'unknownOutcome', badAnswer: 'badAnswer'
})

/** The words a revert carries, from its data when a node gave it and from the message otherwise. @param {ChainError} error */
function revertText (error) {
  const found = error.revert === undefined ? null : decodeRevert(error.revert)
  const fromData = found?.kind === 'reason' ? found.reason : ''
  return `${fromData} ${error.message}`.trim()
}

/** The registrar's reason for a revert, or null when its text is none of the known ones. @param {string} text @returns {string | null} */
export function revertReason (text) {
  const lower = text.toLowerCase()
  for (const [message, reason] of REVERT_REASONS) if (lower.includes(String(message).toLowerCase())) return String(reason)
  return null
}

/**
 * What a failed read, estimate or send means to the person: a name from REASONS and the text behind it.
 * @param {unknown} error
 * @returns {{ reason: string, detail: string }}
 */
export function reasonOfError (error) {
  if (error instanceof RelayError) return { reason: 'relayFailed', detail: error.message }
  if (!(error instanceof ChainError)) return { reason: 'unavailable', detail: error instanceof Error ? error.message : String(error) }
  if (error.reason === 'reverted') {
    const text = revertText(error)
    return { reason: revertReason(text) ?? 'reverted', detail: text }
  }
  return { reason: CHAIN_REASONS[error.reason] ?? 'unavailable', detail: error.message }
}
