// One challenge of a board, drawn as a card: in words what it asks of a poster, the host it reaches, the board's own description and the hold for
// approval, and who it does not ask; and, opened with Edit, the form of its options, its description and its rules. A challenge this node does
// not have (a package it left out, a file path) is shown and kept, and can be moved or removed, but not edited. The form writes into the row
// (`challenge-model.js`) and nothing is sent until the card's apply.

import { buildRule } from './challenge-rule.js'
import { excludeWords, optionFields, titleOf } from './challenge-model.js'
import { asksOf, hostLine, inTerm } from './challenge-words.js'
import { h } from './dom.js'

let inputCount = 0

/**
 * @param {{
 *   doc: Document, classes: Record<string, string>, term: import('./terms.js').Term, rows: import('./challenge-model.js').Row[], row: import('./challenge-model.js').Row,
 *   info: any, why: string | undefined, open: boolean, errors: import('./challenge-model.js').RowErrors & { row: string },
 *   reads: () => import('./ethereum-words.js').Reads | null, changed: () => void, action: (name: string, extra?: number) => void
 * }} context `info` is what the node says of the challenge (undefined when it has no such challenge) and `why` the reason it left one out;
 * `errors` is what the last apply refused in this row (an object the card keeps, and fills again when an apply is refused), and a message goes when
 * its field is typed in; `reads` is how the node reads Ethereum now, which the host line of a challenge that reads it follows
 * @returns {{ element: any, refresh: () => void, showErrors: () => void, setOpen: (on: boolean) => void }}
 */
export function buildRow ({ doc, classes, term, rows, row, info, why, open, errors, reads, changed, action }) {
  const at = (/** @type {string} */ name) => classes[name] ?? ''
  const place = rows.indexOf(row)
  const mine = errors
  /** @type {Array<() => void>} */
  const syncs = []
  const part = (/** @type {string} */ name, /** @type {Record<string, any>} */ props = {}) => h(doc, 'p', { class: at('note'), 'data-nd-part': name, ...props })
  const title = h(doc, 'h4', { class: at('challengeTitle'), 'data-nd-part': 'title', text: `${String(place + 1)}. ${titleOf(row)}` })
  const asks = part('asks')
  const hosts = part('hosts')
  const description = part('description')
  const pending = part('pending')
  const excludes = part('excludes')
  const failure = h(doc, 'p', { class: at('fieldError'), role: 'alert', 'data-nd-part': 'error', text: mine.row })
  syncs.push(() => { failure.textContent = mine.row })

  const button = (/** @type {string} */ name, /** @type {string} */ label, /** @type {boolean} */ disabled = false) =>
    h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': name, text: label, disabled, on: { click: () => { action(name) } } })
  const editButton = info === undefined ? null : button('edit', open ? 'Close' : 'Edit')

  /** The words the card says of the row as it is now. */
  function refresh () {
    const asked = info === undefined ? '' : inTerm(asksOf(info), term)
    asks.textContent = info !== undefined ? asked
      : row.path !== undefined ? `Loaded from a file on the computer that runs the node (${row.path}): this page keeps it as it is.`
        : `This challenge is not available on this node${why === undefined ? '' : `: ${why}`}. It stays as it is until you remove it.`
    const host = hostLine(info, row.options, reads())
    hosts.textContent = host
    hosts.hidden = host === ''
    description.textContent = row.description.trim() === '' ? '' : `Shown to posters: ${row.description}`
    description.hidden = row.description.trim() === ''
    pending.textContent = row.pendingApproval ? 'A moderator must approve each publication that passes this challenge before it is shown.' : ''
    pending.hidden = !row.pendingApproval
    const lines = excludeWords(row, rows, term)
    excludes.textContent = lines.length === 0 ? '' : `Not asked of: ${lines.join('; or ')}.`
    excludes.hidden = lines.length === 0
  }

  const touched = () => { failure.textContent = ''; mine.row = ''; changed() }

  /** @param {import('./challenge-model.js').Field} one */
  function optionField (one) {
    const error = h(doc, 'span', { class: at('fieldError'), role: 'alert', 'data-nd-error': '', text: mine.options[one.option] ?? '' })
    syncs.push(() => { error.textContent = mine.options[one.option] ?? '' })
    const write = (/** @type {string} */ value) => {
      if (value === '') delete row.options[one.option]
      else row.options[one.option] = value
      error.textContent = ''
      delete mine.options[one.option]
      touched()
    }
    /** @type {any} */
    let input
    if (one.kind === 'boolean') {
      input = h(doc, 'select', { class: at('input'), 'data-nd-input': 'value' },
        ...(one.required ? [] : [h(doc, 'option', { value: '', text: `Not set (${one.default})` })]), h(doc, 'option', { value: 'true', text: 'Yes' }), h(doc, 'option', { value: 'false', text: 'No' }))
      input.addEventListener('change', () => { write(input.value) })
    } else {
      input = h(doc, one.kind === 'multiline' ? 'textarea' : 'input', { class: at('input'), ...(one.kind === 'multiline' ? { rows: 4 } : { type: one.kind === 'secret' ? 'password' : 'text' }), autocomplete: 'off', spellcheck: 'false', placeholder: inTerm(one.placeholder === '' ? one.default : one.placeholder, term), 'data-nd-input': 'value' })
      input.addEventListener('input', () => { write(input.value) })
    }
    input.value = one.value
    input.setAttribute('id', `nd-ch-${String(++inputCount)}`)
    const publish = !one.publishable ? null : h(doc, 'input', { type: 'checkbox', 'data-nd-input': 'publish' })
    if (publish !== null) {
      publish.checked = one.publish
      publish.addEventListener('change', () => { row.publish = publish.checked ? [...row.publish.filter((option) => option !== one.option), one.option] : row.publish.filter((option) => option !== one.option); touched() })
    }
    const help = [one.description === '' ? '' : inTerm(one.description, term), one.default === '' || one.required ? '' : `Default: ${inTerm(one.default, term)}`].filter((line) => line !== '').join(' ')
    return h(doc, 'div', { class: at('field'), 'data-nd-field': one.option },
      h(doc, 'label', { class: at('label'), for: input.id, text: `${one.label}${one.required ? ' (required)' : ''}` }),
      h(doc, 'span', { class: at('control') }, input, publish === null ? null : h(doc, 'label', { class: at('choice') }, publish, h(doc, 'span', { text: `Publish: apps read it from the ${term.board}` }))),
      help === '' ? null : h(doc, 'span', { class: at('hint'), text: help }), error)
  }

  const fields = info === undefined ? [] : optionFields(row, info).map(optionField)
  const descriptionInput = h(doc, 'input', { id: `nd-ch-${String(++inputCount)}`, class: at('input'), type: 'text', autocomplete: 'off', 'data-nd-input': 'value' })
  descriptionInput.value = row.description
  descriptionInput.addEventListener('input', () => { row.description = descriptionInput.value; touched() })
  const pendingInput = h(doc, 'input', { type: 'checkbox', 'data-nd-input': 'value' })
  pendingInput.checked = row.pendingApproval
  pendingInput.addEventListener('change', () => { row.pendingApproval = pendingInput.checked; touched() })

  const rules = info === undefined ? [] : row.excludes.map((rule, index) => buildRule({
    doc, classes, term, rows, row, rule, index, errors: (mine.excludes[index] ??= {}), changed: touched,
    action: (name) => { action(name, index) }
  }))
  syncs.push(...rules.map((one) => one.sync))
  const editor = info === undefined ? null : h(doc, 'div', { class: at('challengeBody'), 'data-nd-part': 'editor', hidden: !open },
    ...fields,
    h(doc, 'div', { class: at('field'), 'data-nd-row-field': 'description' }, h(doc, 'label', { class: at('label'), for: descriptionInput.id, text: 'Description shown to posters' }), h(doc, 'span', { class: at('control') }, descriptionInput), h(doc, 'span', { class: at('hint'), text: `Empty: the challenge's own description.` })),
    h(doc, 'div', { class: at('field'), 'data-nd-row-field': 'pending' }, h(doc, 'label', { class: at('choice') }, pendingInput, h(doc, 'span', { text: `A moderator approves each publication that passes this challenge` }))),
    h(doc, 'h5', { class: at('challengeTitle'), text: 'Who is not asked' }),
    h(doc, 'p', { class: at('hint'), text: 'A rule lets an author past this challenge. One rule is enough, and an author must match everything a rule sets.' }),
    ...rules.map((one) => one.element),
    button('add-rule', 'Add a rule'))

  /** @param {boolean} on */
  function setOpen (on) {
    if (editor !== null) editor.hidden = !on
    if (editButton !== null) editButton.textContent = on ? 'Close' : 'Edit'
  }

  const element = h(doc, 'article', { class: at('challenge'), 'data-nd-challenge-row': row.key },
    h(doc, 'header', { class: at('challengeHead') }, title, h(doc, 'span', { class: at('actions') }, button('up', 'Move up', place === 0), button('down', 'Move down', place === rows.length - 1), editButton, button('remove', 'Remove'))),
    asks, hosts, description, pending, excludes, failure, editor)
  refresh()
  return { element, refresh, showErrors: () => { for (const sync of syncs) sync() }, setOpen }
}
