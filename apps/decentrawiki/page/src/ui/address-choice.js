// The "Its address" part of the Publish dialog: update the wiki's address, make a new one, use another one this
// browser holds, or publish with the version's address only.

import { h } from '../dom.js'
import { formatAgo, shortCid } from '../format.js'
import { addressChoices, shownTitle } from '../names.js'

/** @typedef {import('../store.js').Wiki} Wiki @typedef {import('../names.js').NameEntry} NameEntry */
/** @typedef {{ kind: 'update', name: string } | { kind: 'new' } | { kind: 'other', name: string } | { kind: 'none' }} AddressChoice */

/**
 * @param {{ wiki: Wiki, held: NameEntry[], onImportKey: () => void }} options
 * @returns {{ el: HTMLElement, get: () => AddressChoice }}
 */
export function addressFieldset ({ wiki, held, onImportKey }) {
  const { own, lost, others, first } = addressChoices(wiki, held)
  /** @type {'update' | 'new' | 'other' | 'none'} */
  let kind = first
  const select = /** @type {HTMLSelectElement} */ (h('select', { class: 'input', 'aria-label': 'Which address' },
    others.map((entry) => h('option', { value: entry.name }, `ipns://${shortCid(entry.name)} · “${shownTitle(entry)}”`))))
  const warning = h('span', { class: 'warning small' })
  const showWarning = () => {
    const entry = others.find((candidate) => candidate.name === select.value)
    warning.textContent = kind === 'other' && entry ? `Readers of that address will see this wiki instead of “${shownTitle(entry)}”.` : ''
  }
  select.addEventListener('change', showWarning)

  /** @param {typeof kind} value @param {string} label @param {any[]} hint @param {{ disabled?: boolean, extra?: any }} [more] */
  const option = (value, label, hint, { disabled = false, extra = null } = {}) => {
    const radio = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: 'address', value, checked: !disabled && value === kind, disabled }))
    radio.addEventListener('change', () => { kind = value; showWarning() })
    return h('label', { class: disabled ? 'choice choice-disabled' : 'choice' }, radio,
      h('span', { class: 'choice-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, ...hint), extra))
  }

  const lastPublished = own?.history.at(-1)?.at
  const choices = [
    own
      ? option('update', 'Update its address', [`ipns://${shortCid(own.name)} · ${lastPublished === undefined ? 'not published yet' : `last published ${formatAgo(lastPublished)}`}`])
      : lost === null
        ? null
        : option('update', 'Update its address', [`ipns://${shortCid(lost)}. This browser does not hold its key. `, h('button', { type: 'button', class: 'link-button', onclick: onImportKey }, 'Import the key')], { disabled: true }),
    option('new', 'A new address', ['Made here when you publish. Its key stays in this browser.']),
    others.length === 0
      ? null
      : option('other', own || lost ? 'Another address you hold' : 'An address you hold', [], { extra: [select, warning] }),
    option('none', 'No address: only this version\'s address', ['Each version has an address of its own, and readers need the new one each time.'])
  ]
  showWarning()
  return {
    el: h('fieldset', { class: 'choices' }, h('legend', {}, 'Its address'), choices),
    get () {
      if (kind === 'update' && own) return { kind, name: own.name }
      if (kind === 'other' && select.value !== '') return { kind, name: select.value }
      return kind === 'none' ? { kind } : { kind: 'new' }
    }
  }
}
