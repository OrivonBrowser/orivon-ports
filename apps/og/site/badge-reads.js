// The check behind the badge: the Orivon ID SDK's `namesOf`, which finds the usernames an address holds and reads each one's four-clause
// attribution on chain. Nothing is trusted from a reverse record or a remembered name: a name in `known` counts only if the registry
// still gives it to the address.

import { ChainError } from './sdk/chain.js'
import { namesOf } from './sdk/orivonid.js'

/** @typedef {import('./sdk/chain.js').Chain} Chain */
/** @typedef {import('./badge-model.js').IdCheck} IdCheck */

/**
 * @param {Chain} chain
 * @param {string} address
 * @param {readonly string[]} known usernames to check besides the ones the scan finds
 * @param {{ cache?: import('./sdk/orivonid.js').NamesCache | null, find?: typeof namesOf }} [options] `cache`: what the last check returned; `find`: tests give their own
 * @returns {Promise<{ check: IdCheck, cache: import('./sdk/orivonid.js').NamesCache | null }>}
 */
export async function checkOrivonId (chain, address, known, options = {}) {
  const find = options.find ?? namesOf
  try {
    const found = await find(chain, address, { cache: options.cache ?? null, known })
    return { check: { phase: 'read', names: found.names, lapsed: found.lapsed, complete: found.coverage.complete }, cache: found.cache }
  } catch (error) {
    const declined = error instanceof ChainError && error.reason === 'declined'
    const words = declined
      ? 'Orivon did not let this page read Ethereum, so Orivon ID could not be checked.'
      : 'The node did not answer, so Orivon ID could not be checked. Try again in a moment.'
    return {
      check: { phase: 'failed', words },
      cache: options.cache ?? null
    }
  }
}
