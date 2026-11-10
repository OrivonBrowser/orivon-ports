// What the search view says about a name, from what the person typed and what the chain answered. Pure.

import { sameAddress } from './sdk/abi.js'
import { nameOf, price } from './sdk/orivonid.js'
import { REASONS, reasonOfError } from './register-reasons.js'
import { formatDai, readName } from './words.js'

/** @typedef {Awaited<ReturnType<typeof import('./sdk/orivonid.js').salesStatus>>} Sales */
/**
 * @typedef {{ kind: 'unchecked' } | { kind: 'reading' } | { kind: 'read', holder: string | null, reason: string | null }
 *   | { kind: 'failed', words: string }} Reading
 * What the node answered about the name the person asked about. `reason` is why a free name cannot be bought now.
 */

/**
 * Why the registrar is not selling, as a name from REASONS, or null while it sells. The same order as the check the
 * registration makes, so the two never disagree about the reason.
 * @param {Sales} sales
 */
export function salesReason (sales) {
  if (sales.open) return null
  const reachable = sales.reachable.ethToR0 && sales.reachable.r0ToR1
  if (sales.daiAboveFloor === false) return 'daiBelowFloor'
  if (sales.beneficiary === null) return 'noBeneficiary'
  return reachable ? 'salesClosed' : 'v1Unreachable'
}

/** @param {string} reason */
const wordsOf = (reason) => REASONS[reason]?.words ?? ''

/** The reasons of a registration check that come after the name was found free: the sale is shut. */
const SALE_SHUT = ['daiBelowFloor', 'noBeneficiary', 'v1Unreachable', 'salesClosed']
/** And the ones that stop this account while the name is free and for sale. */
const ACCOUNT_STOPS = ['notEnoughDai', 'receiverRefuses', 'resolverBlocked']

/**
 * What the node said about the name, from the state the registration check left (register-flow.js).
 * @param {Record<string, any>} state
 * @returns {Reading}
 */
export function readingOf (state) {
  const reason = String(state['reason'])
  if (state['phase'] === 'checking' && state['what'] === 'name') return { kind: 'reading' }
  if (state['phase'] === 'ready') return { kind: 'read', holder: null, reason: null }
  if (state['phase'] !== 'failed' || state['during'] !== 'checking') return { kind: 'unchecked' }
  if (reason === 'taken') return { kind: 'read', holder: String(state['holder'] ?? ''), reason: null }
  if (SALE_SHUT.includes(reason)) return { kind: 'read', holder: null, reason }
  if (ACCOUNT_STOPS.includes(reason)) return { kind: 'read', holder: null, reason: null }
  return { kind: 'failed', words: `${wordsOf(reason) || String(state['detail'] ?? '')} Check the name again.` }
}

/**
 * @typedef {object} SearchView
 * @property {'empty' | 'problem' | 'unchecked' | 'reading' | 'taken' | 'mine' | 'closed' | 'available' | 'unreadable'} state
 * @property {'neutral' | 'ok' | 'warn' | 'bad'} tone
 * @property {string} headline the line under the field
 * @property {string} words what to do or why
 * @property {string | null} label
 * @property {string | null} name
 * @property {bigint | null} price
 * @property {string | null} priceText
 * @property {boolean} canCheck whether pressing the button may ask the node about the name
 */

/** @type {SearchView} */
const NOTHING = {
  state: 'empty', tone: 'neutral', headline: '', words: 'Type the name you want: the letters a to z, the digits 0 to 9 and hyphens.',
  label: null, name: null, price: null, priceText: null, canCheck: false
}

/** Said beside the search: nothing is looked up while the person types. */
export const TYPING_WORDS = 'Nothing is looked up while you type: the name is checked when you press the button.'

/**
 * What the page shows for what was typed. Typing alone asks the node nothing: the format is judged here and the price
 * is a table, so the node learns the name only when the person asks (`askAboutName`).
 * @param {{ input: string, reading: Reading, asked: string | null, account: string | null }} parts `asked` is the name last asked about; `account` the connected address, if any
 * @returns {SearchView}
 */
export function searchView ({ input, reading, asked, account }) {
  const typed = readName(input)
  if (typed.kind === 'empty') return NOTHING
  if (typed.kind === 'problem') return { ...NOTHING, state: 'problem', tone: 'bad', headline: typed.words, words: '' }
  const label = typed.label
  const name = nameOf(label)
  const cost = price(label)
  const base = { label, name, price: cost, priceText: formatDai(cost) }
  const costWords = `It costs ${base.priceText}, paid once. There is no yearly fee.`
  if (asked !== label || reading.kind === 'unchecked') {
    return {
      ...NOTHING, ...base, state: 'unchecked', headline: `${name} costs ${base.priceText}.`,
      words: 'Paid once, with no yearly fee. Press the button to see whether it is free.', canCheck: true
    }
  }
  if (reading.kind === 'reading') return { ...NOTHING, ...base, state: 'reading', headline: `Looking up ${name}…`, words: '' }
  if (reading.kind === 'failed') return { ...NOTHING, ...base, state: 'unreadable', tone: 'warn', headline: `Could not look up ${name}.`, words: reading.words, canCheck: true }
  if (reading.holder !== null) {
    const mine = account !== null && sameAddress(reading.holder, account)
    return mine
      ? { ...NOTHING, ...base, state: 'mine', tone: 'ok', headline: `You already hold ${name}.`, words: 'It is listed under My IDs.' }
      : { ...NOTHING, ...base, state: 'taken', tone: 'bad', headline: `${name} is taken.`, words: wordsOf('taken') }
  }
  if (reading.reason !== null) {
    return { ...NOTHING, ...base, state: 'closed', tone: 'warn', headline: `${name} is free, but it cannot be bought right now.`, words: wordsOf(reading.reason), canCheck: true }
  }
  return { ...NOTHING, ...base, state: 'available', tone: 'ok', headline: `${name} is available.`, words: costWords }
}

/**
 * Pressing the button: the one thing that asks the node about a name. It is the registration check, which hides a name
 * of 3 or 4 letters among 7 others (register-decoys.js), so it is made once for the name, never per key. Typing never
 * comes here.
 * @param {{ input: string, connect: () => Promise<string | null>, check: (label: string) => Promise<unknown> }} parts
 * @returns {Promise<{ asked: true, label: string } | { asked: false, why: 'format' | 'noAddress' }>}
 */
export async function askAboutName ({ input, connect, check }) {
  const typed = readName(input)
  if (typed.kind !== 'name') return { asked: false, why: 'format' }
  if (await connect() === null) return { asked: false, why: 'noAddress' }
  await check(typed.label)
  return { asked: true, label: typed.label }
}

/**
 * @typedef {{ kind: 'reading' } | { kind: 'read', sales: Sales } | { kind: 'unknown', words: string, retry: boolean }} SalesRead
 * What the page knows about whether the registrar sells: it is asking, the node answered, or the node could not
 * be asked. `retry` says whether asking again can help: not when Orivon refused the read, which it answers again the
 * same way until the site is opened anew (the strip under the bar says how).
 */

/** The button beside a sales line that could not be read. */
export const SALES_RETRY = 'Check again'

/**
 * A failed read of the sales status, in words. It never reads as open or closed: the page does not know.
 * @param {unknown} error
 * @returns {SalesRead}
 */
export function salesUnknown (error) {
  const found = reasonOfError(error)
  if (found.reason === 'declined') {
    return { kind: 'unknown', retry: false, words: 'Could not check whether sales are open: Orivon is not letting this page read Ethereum.' }
  }
  const why = found.reason === 'timeout' ? 'the node took too long to answer' : 'the Ethereum node did not answer'
  return { kind: 'unknown', retry: true, words: `Could not check whether sales are open: ${why}.` }
}

/**
 * One line on whether the registrar sells at all, and whether the person may ask again.
 * @param {SalesRead} read
 * @returns {{ words: string, retry: boolean }}
 */
export function salesLine (read) {
  if (read.kind === 'reading') return { words: 'Checking whether sales are open…', retry: false }
  if (read.kind === 'unknown') return { words: read.words, retry: read.retry }
  const reason = salesReason(read.sales)
  return { words: reason === null ? 'Sales are open.' : wordsOf(reason), retry: false }
}
