// The words and number spellings the page uses in more than one view. Pure: nothing here touches the page or the chain.

import { isAddress } from './sdk/abi.js'
import { isReserved, labelProblem, normalizeInput, price } from './sdk/orivonid.js'
import { REASONS } from './register-reasons.js'

/** What the registrar's label rule says, one sentence per reason `labelProblem` names. */
export const LABEL_WORDS = Object.freeze({
  tooShort: 'A name needs at least 3 characters.',
  tooLong: 'A name can have 63 characters at most.',
  edgeHyphen: 'A name cannot begin or end with a hyphen.',
  doubleHyphen: 'A name cannot have hyphens in both its third and its fourth place.',
  badCharacter: 'Use only the letters a to z, the digits 0 to 9 and hyphens.',
  addressLike: 'A name cannot be 0x followed by 40 hexadecimal digits, because it would look like an address.'
})

/**
 * What is wrong with what the person typed, in words, or null when it is a name the registrar can sell.
 * @param {string} input
 * @returns {{ kind: 'empty' } | { kind: 'problem', reason: string, words: string } | { kind: 'name', label: string }}
 */
export function readName (input) {
  const normal = normalizeInput(input)
  if (!normal.ok) {
    return normal.reason === 'empty' ? { kind: 'empty' } : { kind: 'problem', reason: normal.reason, words: REASONS['notAscii']?.words ?? '' }
  }
  const problem = labelProblem(normal.label)
  if (problem !== null) return { kind: 'problem', reason: problem, words: LABEL_WORDS[problem] }
  if (isReserved(normal.label)) return { kind: 'problem', reason: 'reserved', words: REASONS['reserved']?.words ?? '' }
  return { kind: 'name', label: normal.label }
}

/** The three prices the registrar charges, for the table beside the name field. @returns {{ lengths: string, wei: bigint }[]} */
export function priceTable () {
  return [
    { lengths: '3 letters', wei: price('abc') },
    { lengths: '4 letters', wei: price('abcd') },
    { lengths: '5 letters or more', wei: price('abcde') }
  ]
}

/** DAI with up to two decimals and no trailing zeros. @param {bigint} wei */
export function formatDai (wei) {
  const unit = 10n ** 18n
  const whole = wei / unit
  const cents = (wei % unit) / (unit / 100n)
  return `${whole}${cents === 0n ? '' : `.${String(cents).padStart(2, '0').replace(/0$/, '')}`} DAI`
}

/** Only where the full address is one click away. @param {string} address */
export const shortAddress = (address) => isAddress(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address

/** Minutes and seconds, as a clock: 0:42. @param {number} seconds */
export function formatClock (seconds) {
  const whole = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** UTC, so the same moment reads the same everywhere: 6 Dec 2026, 12:00 UTC. @param {number} unixSeconds */
export function formatTime (unixSeconds) {
  const date = new Date(unixSeconds * 1000)
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

/** @param {number} count @param {string} unit */
const plural = (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'}`

/** A length of time in the largest whole unit it fills: 1 hour, 7 days. @param {number} seconds */
export function formatDuration (seconds) {
  if (seconds >= 86_400 && seconds % 86_400 === 0) return plural(seconds / 86_400, 'day')
  if (seconds >= 3600 && seconds % 3600 === 0) return plural(seconds / 3600, 'hour')
  if (seconds >= 60 && seconds % 60 === 0) return plural(seconds / 60, 'minute')
  return plural(seconds, 'second')
}

/** The first and last bytes of a key, which is what a person can compare. @param {string} key 0x and hex */
export const keyPreview = (key) => key.length > 20 ? `${key.slice(0, 10)}…${key.slice(-8)}` : key
