// The board manager's settings as a form: three fields, each with the default it uses when left empty, and a message next to
// the field a value was refused for. One form serves a board and the node-wide defaults.

import { capacityOf, defaultsOf, FIELDS, layoutOf, patchOf, valuesOf } from './board-form.js'
import { h } from './dom.js'
import { UNITS } from './format.js'
import { BOARD } from './terms.js'

let formCount = 0

/**
 * @param {{ doc: Document, classes: Record<string, string>, onSubmit: () => void, owner: string, term?: import('./terms.js').Term }} options
 * `owner` names what the form is for (a board's address, or `defaults`) in the attributes a test reaches the fields by; `term` is the app's word for a board.
 */
export function createSettingsForm ({ doc, classes, onSubmit, owner, term = BOARD }) {
  const prefix = `nd-form-${String(++formCount)}`
  /** @type {import('./board-form.js').Values} */
  let initial = { capacity: '', bumpLimit: '', purge: '', purgeUnit: 'days' }
  /** @type {import('./board-form.js').Effective | null} */
  let effective = null
  let dirty = false

  const inputs = {}
  const hints = {}
  const errors = {}
  const select = h(doc, 'select', { id: `${prefix}-purge-unit`, class: classes['input'] ?? '', 'data-nd-input': 'purgeUnit', 'aria-label': 'Unit of time' }, ...UNITS.map((unit) => h(doc, 'option', { value: unit.name, text: unit.name })))
  select.value = initial.purgeUnit

  const fields = FIELDS.map((field) => {
    const input = h(doc, 'input', { id: `${prefix}-${field.id}`, class: classes['input'] ?? '', type: 'text', inputmode: 'numeric', autocomplete: 'off', 'data-nd-input': field.id })
    const hint = h(doc, 'span', { class: classes['hint'] ?? '' })
    const error = h(doc, 'span', { class: classes['fieldError'] ?? '', role: 'alert' })
    inputs[field.id] = input
    hints[field.id] = hint
    errors[field.id] = error
    return h(doc, 'div', { class: classes['field'] ?? '', 'data-nd-field': field.id, 'data-nd-owner': owner },
      h(doc, 'label', { class: classes['label'] ?? '', for: input.id, text: field.label(term) }),
      h(doc, 'span', { class: classes['control'] ?? '' }, input, field.id === 'purge' ? select : h(doc, 'span', { class: classes['unit'] ?? '', text: field.unit }), hint),
      error)
  })
  const message = h(doc, 'p', { class: classes['formMessage'] ?? '', role: 'status' })
  const actions = h(doc, 'div', { class: classes['actions'] ?? '' })
  const form = h(doc, 'form', { class: classes['form'] ?? '', novalidate: true, 'data-nd-form': owner, on: { submit: (event) => { event.preventDefault(); onSubmit() } } }, ...fields, message, actions)

  const read = () => ({ capacity: inputs['capacity'].value, bumpLimit: inputs['bumpLimit'].value, purge: inputs['purge'].value, purgeUnit: select.value })

  /** What each field says beside it: the default it takes while empty, and a board's page layout when it is not one page. */
  function drawHints () {
    if (effective === null) return
    const values = read()
    const shown = defaultsOf(effective)
    const layout = layoutOf(effective)
    hints['capacity'].textContent = values.capacity.trim() === '' ? `Using the default: ${shown.capacity} threads${layout === '' ? '' : ` (${layout})`}` : layout === '' ? '' : `(${layout})`
    hints['bumpLimit'].textContent = values.bumpLimit.trim() === '' ? `Using the default: ${shown.bumpLimit} replies` : ''
    hints['purge'].textContent = values.purge.trim() === '' ? `Using the default: ${shown.purge} ${shown.purgeUnit}` : ''
    inputs['capacity'].setAttribute('placeholder', shown.capacity)
    inputs['bumpLimit'].setAttribute('placeholder', shown.bumpLimit)
    inputs['purge'].setAttribute('placeholder', shown.purge)
  }

  function showErrors (/** @type {Record<string, string>} */ found) {
    for (const field of FIELDS) errors[field.id].textContent = found[field.id] ?? ''
  }

  for (const element of [...Object.values(inputs), select]) {
    element.addEventListener('input', () => { dirty = true; showErrors({}); message.textContent = ''; drawHints() })
    element.addEventListener('change', () => { dirty = true; drawHints() })
  }

  return {
    element: form,
    actions,
    get dirty () { return dirty },
    read,
    /** What the form changes: the patch to send and the messages for what is not a number. */
    changes () { return patchOf(read(), initial) },
    showErrors,
    /** @param {string} text @param {boolean} [failed] */
    say (text, failed = false) { message.textContent = text; message.setAttribute('data-nd-failed', failed ? 'true' : 'false') },
    /**
     * What the node says a board sets and runs with. The fields take it unless a person is typing in them (`force` takes it
     * anyway, after a save); the defaults beside them always follow the node.
     * @param {Record<string, any>} config @param {import('./board-form.js').Effective} next @param {boolean} [force]
     */
    fill (config, next, force = false) {
      effective = next
      initial = valuesOf(config, next)
      if (force || !dirty) {
        inputs['capacity'].value = initial.capacity
        inputs['bumpLimit'].value = initial.bumpLimit
        inputs['purge'].value = initial.purge
        select.value = initial.purgeUnit
        dirty = false
      }
      drawHints()
    },
    capacity: () => (effective === null ? null : capacityOf(effective))
  }
}
