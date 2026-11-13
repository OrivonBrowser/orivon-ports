// The "Verified" badge on an address that holds an Orivon ID, as data: what a check of the ID registry found, as one of a few states, and
// the two lists the page always shows beside it: what the badge proves and what it does not. Pure; the reads are badge-reads.js.

import { SUFFIX } from './sdk/orivonid.js'

/** @typedef {import('./sdk/orivonid.js').Attribution} Attribution */
/** @typedef {{ label: string, attribution: Attribution }} Held */
/**
 * What a check has found so far.
 * @typedef {{ phase: 'idle' } | { phase: 'checking' } | { phase: 'failed', words: string } |
 *   { phase: 'read', names: readonly Held[], lapsed: readonly Held[], complete: boolean }} IdCheck
 */

export const BADGE_WORDS = Object.freeze({
  title: 'Verified',
  proves: [
    'Read from Ethereum just now, through the node the strip at the top of the page names: this address holds that Orivon ID username in the registry, and no other account holds any role on it.',
    'The username resolves back to this address, and this address can write the username\'s records.'
  ],
  doesNot: [
    'It does not say who the person is. Anyone can buy a username, so it is a name, not a check of identity.',
    'It does not say anything about the .og name or its site: the badge is about the holder\'s address, and a name\'s records count by their own rule.',
    'It does not last: the holder can sell the username or change its roles, and the next check shows it.'
  ],
  /** Said when the scan of the registry could not cover every block. */
  recent: 'Inside Orivon only the most recent registrations are searched, so an older username is found only if its name is typed below.'
})

/** Why a clause of the attribution failed, in a few words. @param {Attribution} one @returns {string} */
export function whyNot (one) {
  if (!one.owner.ok) return 'the registry names another address as its holder'
  if (!one.roles.ok) return one.roles.problem === 'rolesUnreadable' ? 'its roles could not be read' : 'another account also holds a role on it'
  if (!one.forward.ok) {
    switch (one.forward.problem) {
      case 'noResolver': return 'it has no resolver, so it does not resolve to the address'
      case 'noAddress': return 'it resolves to no address'
      case 'differentAddress': return 'it resolves to a different address'
      default: return 'its resolver could not be asked'
    }
  }
  return one.records.problem === 'noResolver' ? 'it has no resolver' : 'this address cannot write its records'
}

/**
 * @param {IdCheck} check
 * @returns {{
 *   state: 'idle' | 'checking' | 'failed' | 'verified' | 'partial' | 'none', tone: 'ok' | 'neutral' | 'warn', username: string | null,
 *   usernames: string[], headline: string, words: string | null
 * }}
 */
export function badgeOf (check) {
  if (check.phase === 'idle') return { state: 'idle', tone: 'neutral', username: null, usernames: [], headline: 'Not checked', words: null }
  if (check.phase === 'checking') return { state: 'checking', tone: 'neutral', username: null, usernames: [], headline: 'Checking Orivon ID…', words: null }
  if (check.phase === 'failed') return { state: 'failed', tone: 'warn', username: null, usernames: [], headline: 'Orivon ID could not be checked', words: check.words }
  const verified = check.names.filter((one) => one.attribution.ok)
  const [first] = verified
  if (first !== undefined) {
    const usernames = verified.map((one) => `${one.label}.${SUFFIX}`)
    return { state: 'verified', tone: 'ok', username: usernames[0] ?? null, usernames, headline: BADGE_WORDS.title, words: `Holds ${usernames.join(', ')}.` }
  }
  const [partial] = check.names
  if (partial !== undefined) {
    return {
      state: 'partial', tone: 'warn', username: `${partial.label}.${SUFFIX}`, usernames: [],
      headline: 'Holds an Orivon ID that is not fully in order',
      words: `${partial.label}.${SUFFIX} is held by this address, but ${whyNot(partial.attribution)}, so it is not shown as verified.`
    }
  }
  return {
    state: 'none', tone: 'neutral', username: null, usernames: [], headline: 'No Orivon ID found',
    words: check.complete ? 'This address holds no Orivon ID username.' : `No username was found for this address. ${BADGE_WORDS.recent}`
  }
}
