// What the board manager's settings form asks, and how what a person typed becomes the patch the control channel takes.
// A field left empty uses the default; a field that had a value and is now empty goes back to the default (`null`);
// a field nobody touched is not sent.

/** What a form shows of a board, or of the node-wide defaults. @typedef {{ perPage: number, pages: number, bumpLimit: number, archivePurgeSeconds: number }} Effective */
/** What a person typed: the three texts and the unit of the purge delay. @typedef {{ capacity: string, bumpLimit: string, purge: string, purgeUnit: string }} Values */

import { splitDuration, toSeconds } from './format.js'

/** @typedef {import('./terms.js').Term} Term */

/** The board manager's four numbers as a person meets them: the capacity is `perPage * pages`, so one field sets both. */
export const FIELDS = [
  { id: 'capacity', keys: ['perPage', 'pages'], label: (/** @type {Term} */ term) => `Archive the oldest thread when the ${term.board} has more than`, unit: 'threads' },
  { id: 'bumpLimit', keys: ['bumpLimit'], label: (/** @type {Term} */ term) => `Stop a thread moving up the ${term.board} after`, unit: 'replies' },
  { id: 'purge', keys: ['archivePurgeSeconds'], label: () => 'Delete an archived thread after', unit: null }
]

export const NOT_A_NUMBER = 'Enter a whole number above 0.'

const WHOLE = /^\d+$/

/** @param {string} text @returns {number} the whole number above 0 the text is, or NaN */
function numberOf (text) {
  const trimmed = text.trim()
  const value = WHOLE.test(trimmed) ? Number(trimmed) : NaN
  return Number.isSafeInteger(value) && value > 0 ? value : NaN
}

/** @param {Effective} effective */
export const capacityOf = (effective) => effective.perPage * effective.pages

/** What the page layout of a board's capacity is, when it is not a single page. @param {Effective} effective */
export const layoutOf = (effective) => (effective.pages === 1 ? '' : `${String(effective.perPage)} a page, ${String(effective.pages)} pages`)

/**
 * The form's texts for what a board sets (`config`): a field it does not set is empty. The unit of the purge delay
 * follows the value shown, or the effective one when the field is empty, so the empty field reads "2 days" as its default.
 * @param {Record<string, any>} config @param {Effective} effective @returns {Values}
 */
export function valuesOf (config, effective) {
  const purgeSet = config['archivePurgeSeconds'] != null
  const purge = splitDuration(purgeSet ? config['archivePurgeSeconds'] : effective.archivePurgeSeconds)
  return {
    capacity: config['perPage'] != null || config['pages'] != null ? String(capacityOf(effective)) : '',
    bumpLimit: config['bumpLimit'] != null ? String(config['bumpLimit']) : '',
    purge: purgeSet ? purge.value : '',
    purgeUnit: purge.unit
  }
}

/** The values a field takes when it is left empty: what the placeholder shows. @param {Effective} effective @returns {Values} */
export function defaultsOf (effective) {
  const purge = splitDuration(effective.archivePurgeSeconds)
  return { capacity: String(capacityOf(effective)), bumpLimit: String(effective.bumpLimit), purge: purge.value, purgeUnit: purge.unit }
}

/**
 * The patch that takes the form from `initial` to `values`, and a message for each field that is not a number.
 * @param {Values} values @param {Values} initial
 * @returns {{ patch: Record<string, number | null>, errors: Record<string, string> }}
 */
export function patchOf (values, initial) {
  /** @type {Record<string, number | null>} */
  const patch = {}
  /** @type {Record<string, string>} */
  const errors = {}
  for (const field of FIELDS) {
    const id = /** @type {'capacity' | 'bumpLimit' | 'purge'} */ (field.id)
    const text = values[id].trim()
    const before = initial[id].trim()
    if (text === '') {
      if (before !== '') for (const key of field.keys) patch[key] = null
      continue
    }
    const now = numberOf(text)
    if (Number.isNaN(now)) { errors[id] = NOT_A_NUMBER; continue }
    if (id === 'capacity') {
      if (now !== numberOf(before)) Object.assign(patch, { perPage: now, pages: 1 })
    } else if (id === 'bumpLimit') {
      if (now !== numberOf(before)) patch['bumpLimit'] = now
    } else {
      const seconds = toSeconds(text, values.purgeUnit)
      if (before === '' || seconds !== toSeconds(before, initial.purgeUnit)) patch['archivePurgeSeconds'] = seconds
    }
  }
  return { patch, errors }
}

/** The field a Worker's refusal is about, by the setting it names: "bumpLimit must be a positive integer". @param {string} message @returns {string | null} */
export function fieldOfError (message) {
  const key = /\b(perPage|pages|bumpLimit|archivePurgeSeconds)\b/.exec(message)?.[1]
  return key === undefined ? null : FIELDS.find((field) => field.keys.includes(key))?.id ?? null
}

/** What to say next to a field the Worker refused. @param {string} message */
export const fieldWords = (message) => (/positive integer/.test(message) ? NOT_A_NUMBER : message)
