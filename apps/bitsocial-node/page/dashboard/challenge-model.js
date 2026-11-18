// A board's challenges as the dashboard edits them. A `Row` is one challenge entry as a form holds it: the options and the ones to publish, the
// board's description and the hold for approval, the rules that let some people past it (`challenge-excludes.js`), and the entry as the board had it
// (`raw`), so what a person did not touch is written back as it was and an option or field this page does not know is never dropped. `entriesOf`
// writes the rows as the list pkc-js 0.0.132 parses and says which field of which row is refused; `changesOf` says in words what an apply changes.

import { emptyTexts, excludeOf, legacyOf, textsOf, wordsOfExclude } from './challenge-excludes.js'
import { shortName } from './challenge-words.js'

/**
 * @typedef {{ raw: Record<string, any> | undefined, texts: import('./challenge-excludes.js').Texts }} Rule
 * @typedef {{
 *   key: string, name?: string, path?: string, options: Record<string, string>, publish: string[], description: string, pendingApproval: boolean,
 *   excludes: Rule[], raw?: Record<string, any>
 * }} Row `key` is `b<i>` for the entry a board had at place i and `n<k>` for one added here: an exclude names a challenge by its key
 * @typedef {{ option: string, label: string, description: string, placeholder: string, default: string, suggested: string | undefined, required: boolean,
 *   kind: 'boolean' | 'secret' | 'multiline' | 'text', json: boolean, value: string, publish: boolean, publishable: boolean }} Field
 * @typedef {{ options: Record<string, string>, excludes: Record<number, Record<string, string>> }} RowErrors
 */

const KNOWN = ['name', 'path', 'options', 'publicOptions', 'exclude', 'description', 'pendingApproval']
const SECRET = /api[-_]?key|token|secret|password/i
const MULTILINE = ['prompt']
const NOT_PUBLISHABLE = ['rpcUrls']
const JSONISH = /^\s*[[{]/

/** @param {any} info @returns {any[]} */
const inputsOf = (info) => (Array.isArray(info?.optionInputs) ? info.optionInputs : [])

/** What the entry says of itself as a row. @param {Record<string, any>} entry @param {string} key @returns {Row} */
export function rowOf (entry, key) {
  const keyOfIndex = (/** @type {number} */ index) => `b${String(index)}`
  return {
    key,
    ...(typeof entry['name'] === 'string' ? { name: entry['name'] } : {}),
    ...(typeof entry['path'] === 'string' ? { path: entry['path'] } : {}),
    options: Object.fromEntries(Object.entries(entry['options'] ?? {}).map(([option, value]) => [option, String(value)])),
    publish: Array.isArray(entry['publicOptions']) ? [...entry['publicOptions']] : [],
    description: typeof entry['description'] === 'string' ? entry['description'] : '',
    pendingApproval: entry['pendingApproval'] === true,
    excludes: (Array.isArray(entry['exclude']) ? entry['exclude'] : []).map((/** @type {Record<string, any>} */ raw) => ({ raw: structuredClone(raw), texts: textsOf(raw, keyOfIndex) })),
    raw: structuredClone(entry)
  }
}

/** One option's form: published by default when it is a contract key such as `wordfilter/v1/rules`, never when it is a credential. @param {any} input */
const publishableOf = (input) => !SECRET.test(input.option) && !NOT_PUBLISHABLE.includes(input.option)

/**
 * A challenge just chosen: the options marked required hold their defaults (or the path the Worker suggests under the app's files), the others are
 * empty and the default is shown beside them.
 * @param {any} info what `challenges('list')` says of the challenge @param {string} key @returns {Row}
 */
export function newRow (info, key) {
  /** @type {Record<string, string>} */
  const options = {}
  for (const input of inputsOf(info)) {
    const value = info.suggested?.[input.option] ?? input.default ?? ''
    if (input.required === true && value !== '') options[input.option] = String(value)
  }
  return {
    key, name: info.name, options,
    publish: inputsOf(info).filter((input) => input.option.includes('/') && publishableOf(input)).map((input) => input.option),
    description: '', pendingApproval: false, excludes: []
  }
}

/** The form fields of a row's options, one for each option the challenge declares, in its order. @param {Row} row @param {any} info @returns {Field[]} */
export function optionFields (row, info) {
  return inputsOf(info).map((input) => {
    const given = String(input.default ?? '')
    const json = JSONISH.test(given) || JSONISH.test(String(input.placeholder ?? ''))
    const kind = SECRET.test(input.option) ? 'secret' : given === 'true' || given === 'false' ? 'boolean' : json || MULTILINE.includes(input.option) ? 'multiline' : 'text'
    return {
      option: input.option, label: String(input.label ?? input.option), description: String(input.description ?? ''), placeholder: String(input.placeholder ?? ''),
      default: given, suggested: info.suggested?.[input.option], required: input.required === true, kind, json,
      value: row.options[input.option] ?? '', publish: row.publish.includes(input.option), publishable: publishableOf(input)
    }
  })
}

/** @param {Row[]} rows @param {string} key @param {-1 | 1} step a copy of the rows with that one moved a place, and never past either end */
export function moveRow (rows, key, step) {
  const at = rows.findIndex((row) => row.key === key)
  const to = at + step
  if (at < 0 || to < 0 || to >= rows.length) return [...rows]
  const next = [...rows]
  const [one] = next.splice(at, 1)
  next.splice(to, 0, /** @type {Row} */ (one))
  return next
}

/** @param {Row[]} rows @param {string} key */
export const removeRow = (rows, key) => rows.filter((row) => row.key !== key)

/** @param {Row} row */
export const titleOf = (row) => (row.name !== undefined ? shortName(row.name) : (row.path ?? '').split(/[\\/]/).pop() ?? '')

/**
 * The rows as the list of entries a board takes, with a message for each field refused and the rows that lost a rule because the only challenge it
 * named is gone. An entry keeps what the row's `raw` held beyond the fields this page edits.
 * @param {Row[]} rows @param {Map<string, any>} infos what the node offers, by name
 * @returns {{ entries: Array<Record<string, any>>, errors: Record<string, RowErrors>, dropped: Array<{ key: string, count: number }> }}
 */
export function entriesOf (rows, infos) {
  const places = new Map(rows.map((row, index) => [row.key, index]))
  const indexOfKey = (/** @type {string} */ key) => places.get(key) ?? -1
  /** @type {Record<string, RowErrors>} */
  const errors = {}
  /** @type {Array<{ key: string, count: number }>} */
  const dropped = []
  const entries = rows.map((row) => {
    /** @type {RowErrors} */
    const mine = { options: {}, excludes: {} }
    const info = row.name === undefined ? undefined : infos.get(row.name)
    for (const field of optionFields(row, info)) {
      if (field.required && field.value.trim() === '') mine.options[field.option] = 'This option is required.'
      else if (field.json && field.value.trim() !== '') { try { JSON.parse(field.value) } catch { mine.options[field.option] = 'This must be valid JSON.' } }
    }
    /** @type {Array<Record<string, any>>} */
    const rules = []
    let lost = 0
    for (const [index, rule] of row.excludes.entries()) {
      const made = excludeOf(rule.texts, rule.raw, indexOfKey)
      if (made.exclude !== undefined) rules.push(made.exclude)
      else if (made.dropped === true) lost++
      else mine.excludes[index] = made.errors
    }
    if (lost > 0) dropped.push({ key: row.key, count: lost })
    if (Object.keys(mine.options).length > 0 || Object.keys(mine.excludes).length > 0) errors[row.key] = mine

    const entry = Object.fromEntries(Object.entries(row.raw ?? {}).filter(([key]) => !KNOWN.includes(key)))
    if (row.name !== undefined) entry['name'] = row.name
    if (row.path !== undefined) entry['path'] = row.path
    if (Object.keys(row.options).length > 0) entry['options'] = { ...row.options }
    const published = row.publish.filter((option) => Object.hasOwn(row.options, option))
    if (published.length > 0) entry['publicOptions'] = published
    if (rules.length > 0) entry['exclude'] = rules
    if (row.description.trim() !== '') entry['description'] = row.description
    if (row.pendingApproval) entry['pendingApproval'] = true
    return entry
  })
  return { entries, errors, dropped }
}

/** @param {unknown} value @returns {string} the value as JSON with the keys of every object in order, so two spellings of one thing compare equal */
function canon (value) {
  return JSON.stringify(value, (_key, one) => (one !== null && typeof one === 'object' && !Array.isArray(one) ? Object.fromEntries(Object.keys(one).sort().map((key) => [key, one[key]])) : one))
}

/** The rules of an entry with each challenge they name by its key, so a move that renumbers the challenges changes no rule. @param {Record<string, any>} entry @param {Row[]} rows */
const keyedExcludes = (entry, rows) => (Array.isArray(entry['exclude']) ? entry['exclude'] : []).map((/** @type {Record<string, any>} */ rule) => (Array.isArray(rule['challenges']) ? { ...rule, challenges: rule['challenges'].map((/** @type {number} */ index) => rows[index]?.key ?? index) } : rule))

/** The places of a longest run of `sequence` that only goes up: what did not move when the others did. @param {number[]} sequence */
function keptOf (sequence) {
  /** @type {number[]} */
  const tails = []
  const before = sequence.map(() => -1)
  for (const [at, value] of sequence.entries()) {
    let low = 0
    let high = tails.length
    while (low < high) { const middle = (low + high) >> 1; if (/** @type {number} */ (sequence[/** @type {number} */ (tails[middle])]) < value) low = middle + 1; else high = middle }
    before[at] = low > 0 ? /** @type {number} */ (tails[low - 1]) : -1
    tails[low] = at
  }
  const kept = new Set()
  for (let at = tails.at(-1) ?? -1; at >= 0; at = /** @type {number} */ (before[at])) kept.add(at)
  return kept
}

/**
 * What an apply changes, one line each and never an option's value: removed challenges, moved ones, changed ones, then added ones.
 * @param {Row[]} before the rows as the board had them @param {Row[]} after the rows as they are now
 * @param {Map<string, any>} infos @param {import('./terms.js').Term} _term the app's word for a board (the lines name no board)
 * @returns {string[]}
 */
export function changesOf (before, after, infos, _term) {
  const was = entriesOf(before, infos).entries
  const now = entriesOf(after, infos).entries
  const beforeAt = new Map(before.map((row, index) => [row.key, index]))
  const afterAt = new Map(after.map((row, index) => [row.key, index]))
  const common = after.filter((row) => beforeAt.has(row.key))
  const kept = keptOf(common.map((row) => /** @type {number} */ (beforeAt.get(row.key))))

  const removed = before.filter((row) => !afterAt.has(row.key)).map((row) => `Removed ${titleOf(row)} (it was number ${String((beforeAt.get(row.key) ?? 0) + 1)}).`)
  const moved = common.filter((_row, place) => !kept.has(place)).map((row) => `Moved ${titleOf(row)} from number ${String((beforeAt.get(row.key) ?? 0) + 1)} to number ${String((afterAt.get(row.key) ?? 0) + 1)}.`)
  const changed = after.flatMap((row, index) => {
    const place = beforeAt.get(row.key)
    if (place === undefined) return []
    const a = /** @type {Record<string, any>} */ (was[place])
    const b = /** @type {Record<string, any>} */ (now[index])
    const names = [...new Set([...Object.keys(a['options'] ?? {}), ...Object.keys(b['options'] ?? {})])].filter((option) => a['options']?.[option] !== b['options']?.[option])
    const pieces = [
      names.length > 0 ? `the options ${names.join(', ')}` : '',
      canon(a['publicOptions'] ?? []) === canon(b['publicOptions'] ?? []) ? '' : 'the options it publishes',
      a['description'] === b['description'] ? '' : 'the description shown to posters',
      a['pendingApproval'] === b['pendingApproval'] ? '' : 'the approval it asks of a moderator',
      canon(keyedExcludes(a, before)) === canon(keyedExcludes(b, after)) ? '' : 'who it lets through',
      row.excludes.some((rule) => rule.raw !== undefined && legacyOf(rule.raw)) ? 'the old role and address fields, now written as roles, publicKeys and names' : ''
    ].filter((piece) => piece !== '')
    return pieces.length > 0 ? [`Changed ${titleOf(row)}: ${pieces.join(', ')}.`] : []
  })
  const added = after.flatMap((row, index) => (beforeAt.has(row.key) ? [] : [`Added ${titleOf(row)} as number ${String(index + 1)}.`]))
  return [...removed, ...moved, ...changed, ...added]
}

/** The sentence for a rule, with each challenge it names by its name. @param {Row} row @param {Row[]} rows @param {import('./terms.js').Term} term @returns {string[]} */
export function excludeWords (row, rows, term) {
  const places = new Map(rows.map((one, index) => [one.key, index]))
  const nameOfChallenge = (/** @type {number} */ index) => (rows[index] === undefined ? `challenge ${String(index + 1)}` : titleOf(rows[index]))
  return row.excludes.flatMap((rule) => {
    const made = excludeOf(rule.texts, rule.raw, (key) => places.get(key) ?? -1)
    return made.exclude === undefined ? [] : [wordsOfExclude(made.exclude, { term, nameOfChallenge })]
  })
}

/** A rule with no condition set, the shape a new rule starts as. @returns {Rule} */
export const newRule = () => ({ raw: undefined, texts: emptyTexts() })
