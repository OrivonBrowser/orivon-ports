// What the page of one name offers, and what each action would send, from what the chain shows. Pure: the menu is a function of the name
// as the search reads it, a request is a function of the form's text, and the preview is the plan the flow would run for it.

import { isAddress, sameAddress, ZERO_ADDRESS } from './sdk/abi.js'
import { CONTRACT_KEY } from './resolver/og-pins.js'
import { actionWords } from './manage-words.js'
import { planManage } from './manage-plan.js'
import { controllerState } from './names-model.js'
import { expectedGas, situationOf, totalGas } from './register-plan.js'
import { siteRecordOf } from './register-model.js'

/** @typedef {import('./manage-plan.js').Action} Action */
/** @typedef {import('./manage-plan.js').ManageRequest} ManageRequest */
/** @typedef {import('./search-model.js').NameView} NameView */

/** The order the actions are offered in. */
export const ORDER = Object.freeze(/** @type {Action[]} */ (['setSite', 'reconfirm', 'clear', 'setPrimary', 'fixController', 'transfer', 'cleanUp', 'wrap', 'unwrap']))

/**
 * What the person typed in an action's form.
 * @typedef {object} Inputs
 * @property {string} [site] the site address
 * @property {string} [contract] the web3:// contract
 * @property {readonly string[]} [keys] the records ticked
 * @property {string} [to] who receives the name
 * @property {boolean} [unsetController] transfer: remove the controller first
 * @property {boolean} [unsetPrimary] transfer: end the primary name first
 * @property {boolean} [private] send through the private relay
 */

/**
 * The actions this account can take on the name, each with whether something needs doing.
 * @param {{ view: NameView, account: string }} parts
 * @returns {{ action: Action, title: string, words: string, calls: string, attention: string | null }[]}
 */
export function menuOf ({ view, account }) {
  const { facts, rows } = view
  const situation = situationOf(facts, account)
  const wrapped = situation === 'wrappedMine'
  /** @type {Action[]} */
  let offered
  if (situation === 'stranded') offered = ['wrap']
  else if (situation === 'mine') offered = ['setSite', 'reconfirm', 'clear', 'setPrimary', 'fixController', 'transfer', 'wrap']
  else if (wrapped) offered = ['setSite', 'reconfirm', 'clear', 'setPrimary', 'fixController', 'transfer', 'cleanUp', 'unwrap']
  else return []
  // A name in another spelling than the standard one is never opened, so no record or controller of it is worth changing: it can only be
  // given away, or unwrapped, and the wrapper's own half-finished wrap is still finished.
  if (!view.openable && situation !== 'stranded') offered = offered.filter((action) => action === 'transfer' || action === 'unwrap')
  const controller = controllerState(facts, account, wrapped)
  const stale = rows.filter((row) => !row.counts)
  const none = facts.controller !== null && sameAddress(facts.controller, ZERO_ADDRESS)
  /** @type {Record<string, string | null>} */
  const attention = {
    wrap: situation === 'stranded' ? 'The wrapper is waiting for you to finish wrapping it.' : null,
    fixController: controller.ok ? null : controller.words,
    reconfirm: stale.length === 0 ? null : `${stale.length === 1 ? 'A record does' : `${stale.length} records do`} not count right now.`,
    clear: null,
    setSite: rows.length === 0 && (situation === 'mine' || controller.ok) ? 'No site is set yet.' : null,
    setPrimary: facts.primary !== null && facts.primary !== undefined && facts.primary.toLowerCase() === facts.key.toLowerCase() ? 'It is your primary name already.' : null,
    cleanUp: wrapped && !none ? 'Its controller would move with the token.' : null
  }
  return offered
    .filter((action) => !(action === 'reconfirm' || action === 'clear') || rows.length > 0)
    .map((action) => ({ action, ...actionWords(action, wrapped), attention: attention[action] ?? null }))
}

/** @param {string} text @returns {{ kind: 'none' } | { kind: 'contract', address: string } | { kind: 'problem', words: string }} */
export function contractOf (text) {
  const typed = text.trim()
  if (typed === '') return { kind: 'none' }
  if (!isAddress(typed) || sameAddress(typed, ZERO_ADDRESS)) {
    return { kind: 'problem', words: 'Not an Ethereum address: 0x and 40 letters or digits. If it mixes capitals and small letters, they have to be right.' }
  }
  return { kind: 'contract', address: typed }
}

/**
 * The request an action's form describes, and why it cannot be made yet.
 * @param {Action} action
 * @param {Inputs} inputs
 * @param {{ view: NameView, account: string, label: string }} parts
 * @returns {{ request: ManageRequest, problem: string | null }}
 */
export function requestOf (action, inputs, { view, account, label }) {
  const base = { action, label, account, private: inputs.private === true }
  const { facts, rows } = view
  switch (action) {
    case 'setSite': {
      const site = siteRecordOf(inputs.site ?? '')
      const contract = contractOf(inputs.contract ?? '')
      const problem = site.kind === 'problem' ? site.words : contract.kind === 'problem' ? contract.words : null
      return {
        request: { ...base, site: site.kind === 'site' ? { key: site.key, text: site.text } : null, contract: contract.kind === 'contract' ? contract.address : null },
        problem
      }
    }
    case 'reconfirm':
    case 'clear': {
      const keys = (inputs.keys ?? []).filter((key) => rows.some((row) => row.key === key))
      return { request: { ...base, keys }, problem: keys.length === 0 ? 'Tick at least one record.' : null }
    }
    case 'transfer':
      return {
        request: {
          ...base, to: inputs.to ?? '', unsetController: inputs.unsetController === true,
          unsetPrimary: inputs.unsetPrimary === true && facts.primary !== null && facts.primary !== undefined && facts.primary.toLowerCase() === facts.key.toLowerCase()
        },
        problem: null
      }
    case 'wrap':
    case 'unwrap':
    case 'fixController':
    case 'cleanUp':
      return { request: { ...base, keep: rows.filter((row) => row.counts).map((row) => ({ key: row.key, text: row.value })) }, problem: null }
    default:
      return { request: base, problem: null }
  }
}

/**
 * What the request would send, and what it would cost at most.
 * @param {ManageRequest} request
 * @param {NameView} view
 */
export function previewOf (request, view) {
  const plan = planManage(request, view.facts)
  return { ...plan, expected: expectedGas(plan.steps), limit: totalGas(plan.steps) }
}

/** The records of a name a form lists: each with its label and whether it counts. @param {NameView} view */
export const recordChoices = (view) => view.rows.map((row) => ({ key: row.key, label: row.label, value: row.value, counts: row.counts, web3: row.key === CONTRACT_KEY }))
