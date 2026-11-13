// The words and number spellings the page uses in more than one view. Pure: nothing here touches the page or the chain.

import { isAddress } from './sdk/abi.js'
import { labelProblem } from './resolver/og-name.js'

export const SUFFIX = 'og'

/** How far behind Ethereum's latest block Orivon's resolver reads a name: its safe block, about two epochs, on Ethereum mainnet. */
export const SAFE_WAIT = 'about 13 minutes'

/** Why a change to a name shows in Orivon's address bar late. */
export const SAFE_REASON = `The resolver of .og names reads Ethereum only at a block that can no longer be taken back, and on mainnet that block is ${SAFE_WAIT} behind.`

/** What the name rule says, one sentence per reason `labelProblem` names. @param {NonNullable<ReturnType<typeof labelProblem>>} problem @param {string} typed */
export function problemWords (problem, typed) {
  switch (problem.reason) {
    case 'empty': return ''
    case 'dot': return 'A .og name is one word with no dots: the registry has no subnames, so something like sub.alice.og does not exist.'
    case 'tooLong': return `A name is 32 bytes at most and this one is ${problem.bytes ?? 'more'}. A letter outside a to z takes more than one byte.`
    case 'notNormal':
      return `Orivon opens only the standard spelling of a name. "${typed}" and "${problem.normalized ?? ''}" are different names on the registry, ` +
        `and Orivon could never open "${typed}". Use "${problem.normalized ?? ''}".`
    default: return 'This name uses characters the name standard (ENSIP-15) does not allow, so Orivon could never open it.'
  }
}

/**
 * What is wrong with what the person typed, in words, or the label when it is a name Orivon can open. A trailing `.og` is dropped.
 * @param {string} input
 * @returns {{ kind: 'empty' } | { kind: 'problem', reason: string, words: string } | { kind: 'name', label: string }}
 */
export function readName (input) {
  const typed = input.trim().replace(/\.og$/i, '')
  const problem = labelProblem(typed)
  if (problem === null) return { kind: 'name', label: typed }
  return problem.reason === 'empty' ? { kind: 'empty' } : { kind: 'problem', reason: problem.reason, words: problemWords(problem, typed) }
}

/** Only where the full address is one click away. @param {string} address */
export const shortAddress = (address) => isAddress(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address

/** @param {number} count */
export const formatGas = (count) => `${Math.round(count).toLocaleString('en-US')} gas`

/**
 * Ether with the decimals it needs, at most eight, trimmed: 0.0005 ETH.
 * @param {bigint} wei
 */
export function formatEth (wei) {
  if (wei === 0n) return '0 ETH'
  const unit = 10n ** 18n
  const scaled = (wei * 10n ** 8n) / unit
  if (scaled === 0n) return 'less than 0.00000001 ETH'
  const whole = scaled / 10n ** 8n
  const fraction = String(scaled % 10n ** 8n).padStart(8, '0').replace(/0+$/, '')
  return `${whole}${fraction === '' ? '' : `.${fraction}`} ETH`
}

/** What the wallet asks of the person, by the way it signs: Orivon's can sign a series at once, a wallet extension asks for each step. */
export const CONFIRM_WORDS = Object.freeze({
  series: 'Your wallet confirms the whole series once.',
  each: 'Your wallet asks you to confirm each step when its turn comes.',
  unknown: 'Your wallet confirms the whole series once if it can sign one, and otherwise each step when its turn comes. The page says which, before it asks.'
})

/** The three steps the first page explains. */
export const HOW_STEPS = Object.freeze([
  { title: 'Choose a name', words: 'One word of up to 32 bytes in the standard spelling: letters, digits and hyphens, no dots.' },
  {
    title: 'Register',
    words: `${CONFIRM_WORDS.unknown} Each step goes out only after the one before it worked. The wrapper's switch is what can stop it halfway: ` +
      'if wrapping is switched off after the name went to the wrapper, the name waits there until it is switched on again.'
  },
  { title: 'Set a site', words: 'Point the name at an IPFS, Swarm or Arweave address, and Orivon opens it when someone types the name.' }
])

/**
 * Who reads Ethereum for the page, by the chain it was given: Orivon's own light client, or the provider a wallet extension has chosen, which
 * sees every name the page asks about.
 * @param {string | null} kind `orivon`, `eip1193`, or null when the page has no wallet
 */
export const readThrough = (kind) => kind === 'eip1193' ? 'your wallet extension and the RPC provider it uses, which sees every name this page asks about' : 'your own node'

/** What a name held in a spelling other than the standard one is marked with, and why. Such a name is the holder's, and Orivon never opens it. */
export const SPELLING_CHIP = 'Orivon cannot open this spelling'
export const SPELLING_WORDS = 'Orivon opens only the standard spelling of a name, so it never opens this one, and a site written for it is never loaded. ' +
  'You can still give it away, and unwrap it when it is wrapped.'

/** What each text key of a name is called to a person. */
export const KEY_LABELS = Object.freeze({
  'content.ipfs': 'IPFS site',
  'content.bzz': 'Swarm site',
  'content.arw': 'Arweave site',
  'content.magnet': 'Torrent',
  'content.ethfs': 'EthFS site',
  'content.https': 'Web address (https)',
  'content.http': 'Web address (http)',
  'content.ddoc': 'Document',
  contentcontract: 'web3:// contract'
})

/** Why a record does or does not count, in plain words: one sentence per reason the freshness rule gives. */
export const KEY_WORDS = Object.freeze({
  passes: 'Counts: it was written after the name last changed hands, by an account that may write it, and it is the value stored now.',
  'controller-is-not-the-holder': 'Does not count: the name\'s controller is another account than its holder, and it can still write records.',
  'no-SetTextRecord-log': 'Does not count: no log shows who wrote it, so it may predate the holder.',
  'latest-log-carries-another-value': 'Does not count: the latest write of this key says something other than what is stored now.',
  'no-holder-change-log': 'Does not count: the name\'s last change of holder cannot be found in its history.',
  'set-before-the-last-holder-change': 'Does not count: it was written before the name last changed hands, so it may be a previous holder\'s.',
  'set-before-the-last-NewController': 'Does not count: the controller changed after it was written. Writing it again brings it back.'
})

/** Said beside a key Orivon does not open yet. */
export const NOT_OPENED_WORDS = 'Orivon does not open this kind of address yet, so it is shown here and never loaded.'
