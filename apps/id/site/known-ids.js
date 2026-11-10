// The IDs this device remembers for an address, and how a person names one to add. A remembered ID is only a candidate:
// the page asks the chain about it every time before it lists it as able to sign in. Pure, except for the store it is given.

import { isValidLabel, labelProblem, normalizeInput, SUFFIX } from './sdk/orivonid.js'
import { REASONS } from './register-reasons.js'
import { LABEL_WORDS } from './words.js'

const KNOWN_PREFIX = 'orivonid.known.v1.'

/** The most IDs kept for one address; adding more drops the oldest. */
export const MAX_KNOWN = 64

/** @typedef {{ get: (key: string) => unknown, set: (key: string, value: string) => unknown }} Store */

/** @param {string} address */
const keyOf = (address) => KNOWN_PREFIX + address.toLowerCase()

/** The labels remembered for the address, oldest first; whatever else is in the store's place is no list. @param {Store} store @param {string} address @returns {string[]} */
export function readKnown (store, address) {
  try {
    const raw = store.get(keyOf(address))
    if (raw === null || raw === undefined) return []
    const stored = JSON.parse(String(raw))
    if (stored?.version !== 1 || !Array.isArray(stored.labels)) return []
    return [...new Set(stored.labels.filter((/** @type {unknown} */ label) => typeof label === 'string' && isValidLabel(label)))].slice(-MAX_KNOWN)
  } catch {
    return []
  }
}

/** Adds the labels to the address's list and answers the list now. A store that cannot write loses only the memory. @param {Store} store @param {string} address @param {readonly string[]} labels */
export function rememberIds (store, address, labels) {
  const kept = readKnown(store, address)
  const merged = [...new Set([...kept, ...labels.filter(isValidLabel)])].slice(-MAX_KNOWN)
  if (merged.length !== kept.length) writeKnown(store, address, merged)
  return merged
}

/**
 * Remembers the ID a finished registration made, from the state the registration reported; any other state is left alone.
 * @param {Store} store
 * @param {Record<string, unknown>} state
 */
export function rememberFinished (store, state) {
  if (state['phase'] === 'done' && typeof state['owner'] === 'string' && typeof state['label'] === 'string') rememberIds(store, state['owner'], [state['label']])
}

/** @param {Store} store @param {string} address @param {string} label */
export function forgetId (store, address, label) {
  const rest = readKnown(store, address).filter((one) => one !== label)
  writeKnown(store, address, rest)
  return rest
}

/** @param {Store} store @param {string} address @param {string[]} labels */
function writeKnown (store, address, labels) {
  try {
    store.set(keyOf(address), JSON.stringify({ version: 1, labels }))
  } catch {
    // The list only saves the person typing a name again; the chain stays the truth.
  }
}

/** What follows a label when a person writes the whole name. */
const SUFFIXES = Object.freeze([`.${SUFFIX}`, '.orv'])

/**
 * The label a person typed to add an ID: `alice`, `alice.v1.orivonid.eth` or `alice.orv`, in any case. A reserved label is
 * accepted, because the Safe may have given one away; whether the address holds it is the chain's to say.
 * @param {unknown} input
 * @returns {{ kind: 'empty' } | { kind: 'problem', words: string } | { kind: 'label', label: string }}
 */
export function readIdName (input) {
  const normal = normalizeInput(input)
  if (!normal.ok) return normal.reason === 'empty' ? { kind: 'empty' } : { kind: 'problem', words: REASONS['notAscii']?.words ?? '' }
  const suffix = SUFFIXES.find((one) => normal.label.endsWith(one))
  const label = suffix === undefined ? normal.label : normal.label.slice(0, -suffix.length)
  if (label.includes('.')) return { kind: 'problem', words: `Write the name as alice, alice.${SUFFIX} or alice.orv.` }
  const problem = labelProblem(label)
  return problem === null ? { kind: 'label', label } : { kind: 'problem', words: LABEL_WORDS[problem] }
}
