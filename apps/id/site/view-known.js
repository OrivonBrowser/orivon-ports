// The parts of My IDs and the sign-in screen that deal with an ID the page may not have found by itself: what it could not
// see, the IDs this device remembers that the chain no longer gives to the address, and the form to add one by name.

import { el, fill } from './dom.js'
import { addId, coverageWords, forget } from './ids-list.js'
import { addressCode, button, notice } from './parts.js'
import { nameOf, SUFFIX } from './sdk/orivonid.js'

/** @typedef {import('./app.js').App} App */

/** Says what the scan could not see, or draws nothing. @param {import('./sdk/orivonid.js').Coverage} coverage */
export function coverageNotice (coverage) {
  const said = coverageWords(coverage)
  return said === null ? null : notice(said.tone, said.title, said.lines.map((line) => el('p', { text: line })))
}

/**
 * The IDs this device remembers that R1 no longer gives to the address, each with why and a way to forget it.
 * @param {App} app
 * @param {string} address
 * @param {{ label: string, attribution: import('./sdk/orivonid.js').Attribution }[]} lapsed
 * @param {(label: string) => void} [forgotten] called after one is forgotten, which also takes it off the screen
 */
export function lapsedSection (app, address, lapsed, forgotten = () => {}) {
  if (lapsed.length === 0) return null
  const list = el('ul')
  const section = el('section', { class: 'not-offered', 'aria-labelledby': 'lapsed-title' },
    el('h2', { id: 'lapsed-title', text: 'Remembered on this device, not held by this address' }), list)
  for (const one of lapsed) {
    const holder = one.attribution.owner.owner
    const item = el('li', {},
      el('p', { class: 'name-off', text: nameOf(one.label) }),
      el('p', { class: 'muted', text: holder === null ? 'The registry names no holder for it now.' : 'The registry names another address as its holder:' }),
      holder === null ? null : addressCode(holder),
      button('Forget it', {
        quiet: true,
        onClick: () => {
          forget(app, address, one.label)
          item.remove()
          if (list.children.length === 0) section.remove()
          forgotten(one.label)
        }
      }))
    list.append(item)
  }
  return section
}

/**
 * "Add an ID you hold": the form, and what the check said. The page lists every ID the registry's recent activity and this
 * device show; this is for one that neither does.
 * @param {App} app
 * @param {string} address
 * @param {{ listed: () => ReadonlySet<string>, added: (label: string, words: string) => void | Promise<void> }} hooks
 */
export function addIdSection (app, address, hooks) {
  const input = /** @type {HTMLInputElement} */ (el('input', {
    id: 'add-id-name', type: 'text', name: 'add-id', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    placeholder: 'alice', 'aria-describedby': 'add-id-forms add-id-why add-id-result'
  }))
  const submit = /** @type {HTMLButtonElement} */ (button('Add', { primary: true, type: 'submit' }))
  const result = el('p', { id: 'add-id-result', class: 'hint', role: 'status' })
  const form = el('form', { class: 'add-id', novalidate: true },
    el('label', { for: 'add-id-name', text: 'Name of the ID' }),
    el('div', { class: 'actions' }, input, submit),
    result)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void (async () => {
      submit.disabled = true
      fill(result, 'Checking the registry…')
      const found = await addId(app, address, input.value, hooks.listed())
      submit.disabled = false
      fill(result, found.words)
      const refused = found.kind === 'problem' || found.kind === 'notHeld' || found.kind === 'unreadable'
      result.dataset['tone'] = refused ? 'bad' : ''
      input.setAttribute('aria-invalid', String(refused))
      if (found.kind === 'added') {
        input.value = ''
        await hooks.added(found.label, found.words)
      }
    })()
  })
  return el('section', { class: 'add-id-section', 'aria-labelledby': 'add-id-title' },
    el('h2', { id: 'add-id-title', text: 'Add an ID you hold' }),
    el('p', { id: 'add-id-forms', class: 'muted', text: `If an ID you hold is not above, type its name (alice, alice.${SUFFIX} or alice.orv).` }),
    form,
    el('details', { class: 'more' },
      el('summary', { text: 'Why can an ID be missing?' }),
      el('p', {
        id: 'add-id-why', class: 'hint',
        text: 'This page cannot list every ID an address ever received: that needs a server that keeps the registry’s whole history, and Orivon ID uses none.'
      })))
}
