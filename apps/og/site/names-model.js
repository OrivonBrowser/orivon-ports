// What the pages about a person's names know without asking a chain: which label a registry key spells, which names to list and where
// each came from, how a name added by hand is classified, and what a row of the list says. Pure.

import { isAddress, sameAddress, ZERO_ADDRESS } from './sdk/abi.js'
import { fromHex, toHex, utf8 } from './sdk/bytes.js'
import { situationOf } from './register-plan.js'
import { shortAddress, SPELLING_CHIP, SPELLING_WORDS, SUFFIX } from './words.js'

/** @typedef {import('./search-model.js').NameView} NameView */
/** @typedef {import('./register-plan.js').Facts} Facts */

/** The registry key of no name. */
export const ZERO_KEY = `0x${'0'.repeat(64)}`

/**
 * The label a registry key spells: its bytes without the zeros that pad it, read as UTF-8. A key that is not the padded spelling of text
 * (bytes that are not UTF-8, a zero inside) has no label this page can show or manage.
 * @param {unknown} key
 * @returns {string | null}
 */
export function labelOfKey (key) {
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null
  const bytes = fromHex(key)
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  if (end === 0 || bytes.subarray(0, end).includes(0)) return null
  let label
  try {
    label = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))
  } catch {
    return null
  }
  return `0x${toHex(utf8(label)).padEnd(64, '0')}` === key.toLowerCase() ? label : null
}

/** @typedef {{ label: string, source: 'token' | 'added' | 'hint', tokenId: string | null }} Listed */

/**
 * The names to list: the tokens the account holds, then the names this device remembers, then the names the contracts hint at, each once.
 * @param {{ tokens: readonly { label: string, tokenId: string }[], remembered: readonly string[], hints: readonly string[] }} parts
 * @returns {Listed[]}
 */
export function mergeNames ({ tokens, remembered, hints }) {
  /** @type {Map<string, Listed>} */
  const out = new Map()
  for (const one of tokens) if (!out.has(one.label)) out.set(one.label, { label: one.label, source: 'token', tokenId: one.tokenId })
  for (const label of remembered) if (!out.has(label)) out.set(label, { label, source: 'added', tokenId: null })
  for (const label of hints) if (!out.has(label)) out.set(label, { label, source: 'hint', tokenId: null })
  return [...out.values()]
}

/**
 * What the chain says about a name the person typed to add, for the account.
 * @param {string} label
 * @param {Facts} facts
 * @param {string} account
 * @returns {{ kind: 'added' | 'finish' | 'listed' | 'free' | 'theirs', words: string }}
 */
export function classifyAdded (label, facts, account) {
  const name = `${label}.${SUFFIX}`
  switch (situationOf(facts, account)) {
    case 'mine': return { kind: 'added', words: `${name} is yours in the registry. It is in the list, and this device remembers it until you forget it.` }
    case 'stranded': return { kind: 'finish', words: `The wrapper holds ${name} and is waiting for your address to finish wrapping it. It is in the list, with the button to finish.` }
    case 'wrappedMine': return { kind: 'listed', words: `You hold the token of ${name}, so it is in the list already.` }
    case 'free': return { kind: 'free', words: `${name} is not registered, so there is nothing to add. Register it from the search.` }
    default: {
      const holder = facts.ownerOf ?? facts.registryOwner
      return { kind: 'theirs', words: `${name} is held by ${isAddress(holder) ? shortAddress(holder) : 'another account'}, not by your address.` }
    }
  }
}

/** How the controller of a name stands for the account that holds it. @param {Facts} facts @param {string} account @param {boolean} wrapped */
export function controllerState (facts, account, wrapped) {
  const { controller } = facts
  if (controller === null) return { ok: false, words: 'The controller could not be read.' }
  const none = sameAddress(controller, ZERO_ADDRESS)
  const self = sameAddress(controller, account)
  if (wrapped) {
    if (self) return { ok: true, words: null }
    return {
      ok: false,
      words: none
        ? 'It has no controller, and while it is wrapped only a controller can write its records. Fix the controller to manage them.'
        : `Its controller is ${shortAddress(controller)}, not your address. Fix the controller to manage its records.`
    }
  }
  if (none || self) return { ok: true, words: null }
  return { ok: false, words: `Its controller is ${shortAddress(controller)}, which can write its records and keeps them from counting. Fix the controller.` }
}

/** The text as a sentence of its own: the reasons are written to follow "Does not count:", so they start in lower case. @param {string} text */
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * One line of the list: what the name is for this account, whether its site counts, and what needs doing.
 * @param {object} parts
 * @param {NameView} parts.view the name as the search reads it
 * @param {string} parts.account
 * @param {string | null} parts.primary the account's primary name as a registry key
 * @returns {{ state: 'wrapped' | 'held' | 'stranded' | 'lost', primary: boolean, site: { tone: 'ok' | 'warn' | 'neutral', words: string },
 *   controller: { ok: boolean, words: string | null }, finish: boolean }}
 */
export function rowOf ({ view, account, primary }) {
  const { facts } = view
  const holds = view.mine && (view.state === 'wrapped' || view.state === 'held')
  /** @type {'wrapped' | 'held' | 'stranded' | 'lost'} */
  const state = view.state === 'stranded' ? 'stranded' : holds ? (view.state === 'wrapped' ? 'wrapped' : 'held') : 'lost'
  const failing = view.rows.find((row) => !row.counts)
  const site = view.rows.length === 0
    ? { tone: /** @type {const} */ ('neutral'), words: 'No site set.' }
    : failing === undefined
      ? { tone: /** @type {const} */ ('ok'), words: 'Its site counts: Orivon opens it.' }
      : { tone: /** @type {const} */ ('warn'), words: `${failing.label} does not count. ${sentence(failing.words.replace(/^Does not count: /, ''))}` }
  return {
    state,
    primary: primary !== null && primary.toLowerCase() === facts.key.toLowerCase(),
    site: state === 'lost' || state === 'stranded' ? { tone: 'neutral', words: '' } : view.openable ? site : { tone: 'warn', words: SPELLING_WORDS },
    controller: holds && view.openable ? controllerState(facts, account, view.state === 'wrapped') : { ok: true, words: null },
    finish: view.offer === 'finish'
  }
}

/** The chips under the name: where it stands and what needs a look. @param {ReturnType<typeof rowOf>} row @param {NameView} view */
export function chipsOf (row, view) {
  /** @type {{ tone: 'ok' | 'warn' | 'neutral', text: string }[]} */
  const chips = []
  if (row.state === 'wrapped') chips.push({ tone: 'neutral', text: `Wrapped, token ${String(view.facts.nameToId)}` })
  else if (row.state === 'held') chips.push({ tone: 'neutral', text: 'Not wrapped' })
  else if (row.state === 'stranded') chips.push({ tone: 'warn', text: 'Stuck in the wrapper' })
  else chips.push({ tone: 'warn', text: 'Not yours' })
  if (row.primary) chips.push({ tone: 'ok', text: 'Your primary name' })
  if ((row.state === 'wrapped' || row.state === 'held') && !view.openable) chips.push({ tone: 'warn', text: SPELLING_CHIP })
  else if (row.state === 'wrapped' || row.state === 'held') {
    chips.push(row.site.tone === 'ok' ? { tone: 'ok', text: 'Site counts' } : row.site.tone === 'warn' ? { tone: 'warn', text: 'A record does not count' } : { tone: 'neutral', text: 'No site' })
    if (!row.controller.ok) chips.push({ tone: 'warn', text: 'Controller needs fixing' })
  }
  return chips
}
