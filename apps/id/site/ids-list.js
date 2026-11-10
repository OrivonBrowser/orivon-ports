// The list of IDs an address holds, as My IDs and the sign-in screen both draw it: what this device remembers, what the
// registry's recent activity shows, and what the person adds by name. Each is checked on chain before it is listed.

import { forgetId, readIdName, readKnown, rememberIds } from './known-ids.js'
import { readCache, writeCache } from './me-model.js'
import { REASONS, reasonOfError } from './register-reasons.js'
import { attribution, namesOf, nameOf } from './sdk/orivonid.js'
import { shortAddress } from './words.js'

/** @typedef {import('./app.js').App} App */
/** @typedef {{ label: string, attribution: import('./sdk/orivonid.js').Attribution }} Listed */
/** @typedef {{ names: Listed[], lapsed: Listed[], coverage: import('./sdk/orivonid.js').Coverage }} Found */

/** Seconds a block takes. */
const BLOCK_SECONDS = 12

/**
 * Reads the list and keeps what it learned: the scan so the next visit reads less, and the IDs held so they are
 * remembered on this device. A failure to read the chain is thrown; a scan that could not read some of the registry's
 * history is not one, and `coverage` says so.
 * @param {App} app
 * @param {string} address
 * @returns {Promise<Found>}
 */
export async function listIds (app, address) {
  if (app.chain === null) throw new TypeError('no chain')
  const found = await namesOf(app.chain, address, { cache: readCache(app.store, address), known: readKnown(app.store, address) })
  writeCache(app.store, address, found.cache)
  rememberIds(app.store, address, found.names.map((one) => one.label))
  return { names: found.names, lapsed: found.lapsed, coverage: found.coverage }
}

/**
 * Adds the ID a person typed, once the chain agrees the address holds it. An ID held without being able to sign in
 * is still added: the list says why it cannot.
 * @param {App} app
 * @param {string} address
 * @param {unknown} input
 * @param {ReadonlySet<string>} listed labels already on screen
 * @returns {Promise<{ kind: 'empty' | 'problem' | 'already' | 'notHeld' | 'unreadable', words: string } | { kind: 'added', words: string, label: string }>}
 */
export async function addId (app, address, input, listed) {
  const read = readIdName(input)
  if (read.kind === 'empty') return { kind: 'empty', words: 'Type the name of the ID.' }
  if (read.kind === 'problem') return { kind: 'problem', words: read.words }
  const name = nameOf(read.label)
  if (listed.has(read.label)) return { kind: 'already', words: `${name} is already in the list.` }
  if (app.chain === null) return { kind: 'unreadable', words: REASONS['noWallet']?.words ?? '' }
  try {
    const found = await attribution(app.chain, read.label, address)
    if (!found.owner.ok) {
      const holder = found.owner.owner
      return { kind: 'notHeld', words: holder === null ? `${name} has no holder now, so this address does not hold it.` : `${name} is held by ${shortAddress(holder)}, not by this address.` }
    }
    rememberIds(app.store, address, [read.label])
    return { kind: 'added', label: read.label, words: `${name} is in the list. This device remembers it until you forget it.` }
  } catch (error) {
    return { kind: 'unreadable', words: `${REASONS[reasonOfError(error).reason]?.words ?? 'The registry could not be read.'} Nothing was added.` }
  }
}

/** @param {App} app @param {string} address @param {string} label */
export const forget = (app, address, label) => forgetId(app.store, address, label)

/**
 * What the person is told about the part of the registry's history the page could not see, or null when it saw all of it.
 * @param {import('./sdk/orivonid.js').Coverage} coverage
 * @returns {{ tone: 'info' | 'warn', title: string, lines: string[] } | null}
 */
export function coverageWords (coverage) {
  const lines = []
  if (coverage.unnamed > 0) {
    const one = coverage.unnamed === 1
    lines.push(`${one ? 'An ID was' : `${coverage.unnamed} IDs were`} sent to this address that this page cannot name. Add ${one ? 'it' : 'them'} by name to list ${one ? 'it' : 'them'}.`)
  }
  if (coverage.failed) {
    return {
      tone: 'warn', title: 'Your node could not show the registry’s recent activity.',
      lines: ['The list has the IDs this device remembers, each checked on chain just now. An ID sent to you lately may be missing: add it by name.', ...lines]
    }
  }
  if (coverage.complete) return lines.length === 0 ? null : { tone: 'info', title: 'Some IDs sent to this address are not listed.', lines }
  return {
    tone: 'info', title: `This page looked back ${roughTime(coverage.blocks * BLOCK_SECONDS)} in the registry.`,
    lines: ['Your node proves only recent activity, so an ID sent to you before that is listed only if this device has seen it. Add it by name to list it.', ...lines]
  }
}

/** @param {number} seconds */
function roughTime (seconds) {
  const hours = Math.max(1, Math.round(seconds / 3600))
  return hours < 48 ? `about ${hours} ${hours === 1 ? 'hour' : 'hours'}` : `about ${Math.round(hours / 24)} days`
}
