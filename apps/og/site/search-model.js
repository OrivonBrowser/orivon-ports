// What typing a name shows: the name rule first, then what the chain says about the name, as one of four states and the records with
// the reason each does or does not count. Pure: the reads are made elsewhere (app.js) with the resolver's own functions, and handed
// here as the `Inspection` they return.

import { sameAddress, ZERO_ADDRESS } from './sdk/abi.js'
import { labelProblem } from './resolver/og-name.js'
import { CONTRACT_KEY, TEXT_KEYS } from './resolver/og-pins.js'
import { situationOf } from './register-plan.js'
import { KEY_LABELS, KEY_WORDS, readName, readThrough, shortAddress, SUFFIX } from './words.js'

/** @typedef {import('./resolver/og-names.js').Inspection} Inspection */
/** @typedef {import('./register-plan.js').Facts} Facts */
/**
 * @typedef {object} RecordRow
 * @property {string} key the text key
 * @property {string} label what a person calls it
 * @property {string} value
 * @property {boolean} counts whether the resolver answers with it
 * @property {string} reason the freshness rule's reason, or `left-behind` / `unverified`
 * @property {string} words that reason in plain words
 * @property {boolean} opened whether Orivon loads this kind of address: the web3:// contract is shown, and not opened yet
 */

/** What is said under the field about where a typed name goes. @param {string | null} kind the chain the page was given */
export const typingWords = (kind) => `Typing asks no server anything. When you stop, the name is read from Ethereum through ${readThrough(kind)}.`
export const CHECK_WORDS = 'Check it now'

/** What the person can do with the name, which the registration panel follows. @typedef {'register' | 'continue' | 'finish' | null} Offer */

/** The reasons a record is shown that the freshness rule does not give. */
const EXTRA_REASONS = Object.freeze({
  'left-behind': 'Does not count: a previous holder wrote it. A new holder\'s records count only when written after the name was taken, so write it again to bring it back.',
  unverified: 'Cannot be checked right now, so it is not counted.',
  unopenable: 'Does not count: Orivon opens only the standard spelling of a name, so it never opens this one.'
})

/** @param {string} reason */
const wordsOf = (reason) => /** @type {Record<string, string>} */ (KEY_WORDS)[reason] ?? /** @type {Record<string, string>} */ (EXTRA_REASONS)[reason] ?? reason

/** The keys the search reads: the ones the resolver answers. */
export const ANSWERED_KEYS = Object.freeze(TEXT_KEYS.map(([key]) => key))

/**
 * The records of a name with whether each counts, in the order the resolver lists its keys. A key with no value is left out.
 * @param {Inspection} inspection
 * @param {readonly string[]} [keys] the text keys the inspection read
 * @returns {RecordRow[]}
 */
export function recordRows (inspection, keys = ANSWERED_KEYS) {
  const { reads, verdict, refusal, holder } = inspection
  /** @type {RecordRow[]} */
  const rows = []
  for (const key of keys) {
    const value = reads.values[key] ?? ''
    if (value === '') continue
    const found = verdict?.keys[key]
    const reason = !holder.found ? 'left-behind' : refusal !== null || found === undefined ? 'unverified' : found.reason
    rows.push({ key, label: /** @type {Record<string, string>} */ (KEY_LABELS)[key] ?? key, value, counts: reason === 'passes', reason, words: wordsOf(reason), opened: key !== CONTRACT_KEY })
  }
  return rows
}

/**
 * What the name's controller means, when it matters.
 * @param {Inspection} inspection
 * @returns {string | null}
 */
function controllerWords (inspection) {
  const { controller } = inspection.reads
  if (controller === null || sameAddress(controller, ZERO_ADDRESS)) return null
  const { holder } = inspection
  if (holder.found && holder.holder !== null && sameAddress(controller, holder.holder)) return null
  return `Controller: ${shortAddress(controller)}. It can write this name's records, and a record it writes does not count unless it is also the holder.`
}

/**
 * @typedef {object} NameView
 * @property {'free' | 'reReserved' | 'held' | 'wrapped' | 'stranded'} state
 * @property {'ok' | 'neutral' | 'warn' | 'bad'} tone
 * @property {string} headline
 * @property {string} words
 * @property {string | null} holder the holder's address
 * @property {boolean} mine the connected account holds it
 * @property {string | null} controller words about a controller that is not the holder, if there is one
 * @property {boolean} openable whether the label is in the standard spelling, the only one Orivon opens: a name held in another spelling has no record that counts
 * @property {RecordRow[]} rows
 * @property {string | null} refusal why the records could not be vouched for, in the resolver's words
 * @property {Offer} offer what the registration panel can do with it
 * @property {Facts} facts
 */

/**
 * @param {object} read
 * @param {string} read.label
 * @param {Inspection} read.inspection
 * @param {Facts} read.facts the registration reads at the same block
 * @param {string | null} read.account the connected address
 * @param {readonly string[]} [read.keys] the text keys the inspection read
 * @returns {NameView}
 */
export function describeName ({ label, inspection, facts, account, keys = ANSWERED_KEYS }) {
  const name = `${label}.${SUFFIX}`
  const { holder, reads } = inspection
  const openable = labelProblem(label) === null
  const rows = openable ? recordRows(inspection, keys) : recordRows(inspection, keys).map((row) => ({ ...row, counts: false, reason: 'unopenable', words: wordsOf('unopenable') }))
  const refusal = inspection.refusal === null ? null : inspection.refusal.message
  const base = {
    holder: holder.holder, mine: account !== null && holder.holder !== null && sameAddress(holder.holder, account), controller: openable ? controllerWords(inspection) : null,
    openable, rows, refusal, facts
  }
  if (!holder.found) {
    const left = (reads.controller !== null && !sameAddress(reads.controller, ZERO_ADDRESS)) || rows.length > 0
    return left
      ? {
          ...base, state: 'reReserved', tone: 'ok', offer: 'register', headline: `${name} is free, with a previous holder's state still in place.`,
          words: 'Nobody holds it, so you can register it. Records and a controller from an earlier holder are still on the resolver. ' +
            'None of them count for you, and registering names your address as the controller so only you can write its records.'
        }
      : { ...base, state: 'free', tone: 'ok', offer: 'register', headline: `${name} is free.`, words: 'Nobody holds it. You can register it now.' }
  }
  if (holder.stranded) {
    const waiting = facts.waitForWrap !== null && !sameAddress(facts.waitForWrap, ZERO_ADDRESS) ? facts.waitForWrap : null
    const finishing = account !== null && waiting !== null && sameAddress(waiting, account)
    return {
      ...base, state: 'stranded', tone: 'warn', offer: finishing ? 'finish' : null, headline: `${name} is stuck in the wrapper.`,
      words: 'The wrapper contract holds it but has issued no token for it, so nobody holds it right now. ' +
        (waiting === null ? 'It is waiting for no account.' : `It is waiting for ${shortAddress(waiting)} to finish wrapping it.`) +
        (finishing ? ' That is your address: press "Finish wrapping" to receive the token.' : ' Only that address can finish; until then the name stays there.')
    }
  }
  const who = holder.holder === null ? 'an unknown account' : shortAddress(holder.holder)
  const held = base.mine ? 'This is your name.' : 'It cannot be registered.'
  const offer = openable && base.mine && !holder.wrapped && account !== null && situationOf(facts, account) === 'mine' ? 'continue' : null
  return holder.wrapped
    ? {
        ...base, state: 'wrapped', tone: base.mine ? 'neutral' : 'bad', offer, headline: `${name} is held by ${who}, wrapped.`,
        words: `The holder has the wrapper's token for it, which can be sent or sold. ${held}`
      }
    : {
        ...base, state: 'held', tone: base.mine ? 'neutral' : 'bad', offer, headline: `${name} is held by ${who}, not wrapped.`,
        words: `The registry itself lists the holder; there is no token. ${held}${offer === null ? '' : ' You can wrap it, and set its site.'}`
      }
}

/**
 * @typedef {{ kind: 'reading', label: string } | { kind: 'failed', label: string, words: string } | { kind: 'read', label: string, inspection: Inspection, facts: Facts }} Lookup
 */

/**
 * @typedef {object} SearchView
 * @property {'empty' | 'problem' | 'typed' | 'reading' | 'failed' | 'read'} state
 * @property {'ok' | 'neutral' | 'warn' | 'bad'} tone
 * @property {string} headline
 * @property {string} words
 * @property {string | null} label the name Orivon can open, once the rule passes
 * @property {boolean} canCheck
 * @property {NameView | null} name
 */

/**
 * What the page shows for the text typed, and what was last read.
 * @param {{ input: string, lookup: Lookup | null, account: string | null, kind?: string | null }} parts `lookup` counts only for the name typed now; `account` is the
 *   connected address; `kind` the chain the page was given
 * @returns {SearchView}
 */
export function searchView ({ input, lookup, account, kind = null }) {
  const typed = readName(input)
  if (typed.kind === 'empty') return { state: 'empty', tone: 'neutral', headline: '', words: '', label: null, canCheck: false, name: null }
  if (typed.kind === 'problem') return { state: 'problem', tone: 'bad', headline: 'This name cannot be registered.', words: typed.words, label: null, canCheck: false, name: null }
  const { label } = typed
  const name = `${label}.${SUFFIX}`
  const own = lookup !== null && lookup.label === label ? lookup : null
  if (own === null) return { state: 'typed', tone: 'neutral', headline: name, words: typingWords(kind), label, canCheck: true, name: null }
  if (own.kind === 'reading') return { state: 'reading', tone: 'neutral', headline: `Reading ${name} from Ethereum…`, words: '', label, canCheck: false, name: null }
  if (own.kind === 'failed') return { state: 'failed', tone: 'warn', headline: `${name} could not be read.`, words: own.words, label, canCheck: true, name: null }
  const view = describeName({ label, inspection: own.inspection, facts: own.facts, account })
  return { state: 'read', tone: view.tone, headline: view.headline, words: view.words, label, canCheck: true, name: view }
}

/**
 * The words for a read that failed.
 * @param {unknown} error
 * @returns {string}
 */
export function failureWords (error) {
  const reason = typeof error === 'object' && error !== null && 'reason' in error ? String(error.reason) : ''
  if (reason === 'declined') return 'Orivon did not let this page read Ethereum. Close every tab of this site and open it again to be asked once more.'
  if (error instanceof Error && error.name === 'OgRefusal') return error.message
  return 'Your node did not answer. Check the connection and try again.'
}
