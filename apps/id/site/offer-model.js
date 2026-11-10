// Why a username the address holds cannot sign anyone in, and what the person can do about it, in words. The consent
// screen and My IDs both draw this. Pure.

import { moveAdvice, retryOrMove, whyNotOffered } from './connect-request.js'
import { ROLE_SET_RESOLVER } from './register-tx.js'
import { nameOf } from './sdk/orivonid.js'

const LATER = 'Try again in a moment.'

/** Where the move to an own resolver, and the saving of records, are done. */
const MY_IDS = Object.freeze({ href: '#/me', label: 'Open My IDs' })

/** @typedef {import('./sdk/orivonid.js').Attribution} Attribution */

/**
 * What a name's address record says about it, in words. `fixable` adds that saving the records on My IDs sets it.
 * @param {string | null} problem
 * @param {boolean} [fixable]
 */
export function forwardWords (problem, fixable = true) {
  const saving = fixable ? (problem === 'noAddress' ? ' Saving the records sets it to your address.' : ' Saving the records sets it to yours.') : ''
  switch (problem) {
    case 'noResolver': return 'This ID has no resolver, so nothing says which address it belongs to.'
    case 'noAddress': return `The address record is empty.${saving}`
    case 'differentAddress': return `The address record points to another address.${saving}`
    case 'resolverFailed': return 'Its resolver did not answer.'
    default: return 'Its records could not be read.'
  }
}

/**
 * Whether My IDs can move a name to a resolver of its holder: the address holds the name alone, with the right to change
 * its resolver, and cannot write the records on the one it has. A name whose records are already held is not moved; one
 * the address does not hold alone is refused, since the registry would let another account undo the move.
 * @param {Attribution} found
 * @returns {{ offered: true } | { offered: false, reason: 'held' | 'owner' | 'roles' | 'rolesUnreadable' | 'setResolver', words: string | null, retry: boolean }}
 */
export function moveOffer (found) {
  const name = nameOf(found.label)
  /** @param {'held' | 'owner' | 'roles' | 'rolesUnreadable' | 'setResolver'} reason @param {string | null} words @param {boolean} [retry] */
  const no = (reason, words, retry = false) => ({ offered: /** @type {const} */ (false), reason, words, retry })
  if (found.records.ok) return no('held', null)
  if (!found.owner.ok) return no('owner', `This address does not hold ${name}, so it cannot move it.`)
  if (found.roles.problem === 'rolesUnreadable') return no('rolesUnreadable', `The registry would not say who holds roles on ${name}. Try again in a moment.`, true)
  if (!found.roles.ok) return no('roles', `Another account holds a right on ${name}, so it is not held by this address alone. Orivon ID will not move it.`)
  if ((found.roles.roles & ROLE_SET_RESOLVER) === 0n) return no('setResolver', `This address does not hold the right to change the resolver of ${name}.`)
  return { offered: true }
}

/**
 * Why a name is not offered for a sign-in, what to do, and where in this site that is done; null when it is offered.
 * The words of `whyNotOffered` are used for the clauses it words in plain prose; the address record has its own, and
 * the remedy is what this site can really do: it writes a name's records, and moves a name its holder holds alone to a
 * resolver of the holder.
 * @param {Attribution} found
 * @returns {{ reason: 'owner' | 'roles' | 'rolesUnreadable' | 'forward' | 'recordsNotHeld', name: string, words: string, remedy: string | null, link: { href: string, label: string } | null } | null}
 */
export function notOffered (found) {
  const why = whyNotOffered(found)
  if (why === null) return null
  const name = nameOf(found.label)
  const movable = moveOffer(found).offered
  const unreadable = found.records.problem === 'unreadable'
  if (why.reason === 'forward') {
    const problem = found.forward.problem
    const fixable = found.records.ok && (problem === 'noAddress' || problem === 'differentAddress')
    const later = problem === 'resolverFailed' || unreadable
    const remedy = fixable ? null : movable ? (later ? retryOrMove(name) : moveAdvice(name)) : later ? LATER : null
    return { reason: 'forward', name, words: forwardWords(problem, found.records.ok), remedy, link: fixable || movable ? MY_IDS : null }
  }
  if (why.reason === 'roles') {
    return { reason: 'roles', name, words: `Another account holds a right on ${name}, so Orivon ID will not use it to sign in.`, remedy: null, link: null }
  }
  if (why.reason !== 'recordsNotHeld') return { reason: why.reason, name, words: why.words, remedy: why.remedy, link: null }
  return { reason: why.reason, name, words: why.words, remedy: movable ? why.remedy : unreadable ? LATER : null, link: movable ? MY_IDS : null }
}
