// The form of one exclude rule of a challenge: who it lets through without being asked. The people it names come first (roles, keys, names) and the
// rest of the conditions sit under "More conditions", open when the rule uses one. A rule holds when every condition it sets holds. What a field
// holds is kept as text in the rule's `texts` (`challenge-excludes.js`), so a half-typed number is never a wrong rule.

import { ROLES, TYPES } from './challenge-excludes.js'
import { titleOf } from './challenge-model.js'
import { h } from './dom.js'
import { UNITS } from './format.js'

const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', moderator: 'Moderator' }
const TYPE_LABELS = { post: 'a post', reply: 'a reply', vote: 'a vote', commentEdit: 'a comment edit', commentModeration: 'a moderator action' }

/**
 * @param {{
 *   doc: Document, classes: Record<string, string>, term: import('./terms.js').Term, rows: import('./challenge-model.js').Row[],
 *   row: import('./challenge-model.js').Row, rule: import('./challenge-model.js').Rule, index: number, errors: Record<string, string>,
 *   changed: () => void, action: (name: string) => void
 * }} context `errors` is what the last apply refused in this rule, by field (an object the card keeps, and fills again when an apply is refused);
 * a field's message goes when the field is typed in
 * @returns {{ element: any, sync: () => void }} `sync` draws the messages in `errors` again
 */
export function buildRule ({ doc, classes, term, rows, row, rule, index, errors, changed, action }) {
  const at = (/** @type {string} */ name) => classes[name] ?? ''
  const texts = /** @type {Record<string, any>} */ (rule.texts)
  /** @type {Array<() => void>} */
  const syncs = []
  const ruleError = h(doc, 'p', { class: at('fieldError'), role: 'alert', 'data-nd-part': 'rule-error', text: errors['rule'] ?? '' })
  syncs.push(() => { ruleError.textContent = errors['rule'] ?? '' })
  const edit = () => { ruleError.textContent = ''; delete errors['rule']; changed() }

  /** @param {string} name the field @param {string} label @param {any[]} controls @param {string} [hint] */
  function field (name, label, controls, hint = '') {
    const error = h(doc, 'span', { class: at('fieldError'), role: 'alert', 'data-nd-error': '', text: errors[name] ?? '' })
    const clear = () => { error.textContent = ''; delete errors[name] }
    syncs.push(() => { error.textContent = errors[name] ?? '' })
    for (const control of controls) if (control.getAttribute('data-nd-input') !== null) { control.addEventListener('input', clear); control.addEventListener('change', clear) }
    return h(doc, 'div', { class: at('field'), 'data-nd-field': name },
      h(doc, 'span', { class: at('label'), text: label }),
      h(doc, 'span', { class: at('control') }, ...controls, hint === '' ? null : h(doc, 'span', { class: at('hint'), text: hint })), error)
  }

  /** A text input or box for `key` of the texts. @param {string} key @param {{ box?: boolean, numeric?: boolean, label: string }} options */
  function text (key, { box = false, numeric = false, label }) {
    const input = h(doc, box ? 'textarea' : 'input', { class: at('input'), ...(box ? { rows: 2 } : { type: 'text' }), ...(numeric ? { inputmode: 'numeric' } : {}), autocomplete: 'off', spellcheck: 'false', 'aria-label': label, 'data-nd-input': 'value' })
    input.value = String(texts[key] ?? '')
    input.addEventListener('input', () => { texts[key] = input.value; edit() })
    return input
  }

  /** One tick box for each choice of the list `key` holds. @param {string} key @param {Array<[string, string]>} choices value and label */
  function ticks (key, choices) {
    return choices.map(([value, label]) => {
      const box = h(doc, 'input', { type: 'checkbox', 'data-nd-value': value, 'data-nd-input': 'value' })
      box.checked = texts[key].includes(value)
      box.addEventListener('change', () => { texts[key] = box.checked ? [...texts[key].filter((/** @type {string} */ one) => one !== value), value] : texts[key].filter((/** @type {string} */ one) => one !== value); edit() })
      return h(doc, 'label', { class: at('choice') }, box, h(doc, 'span', { text: label }))
    })
  }

  /** @param {string} key @param {string[]} choices */
  function unit (key, choices = UNITS.map((one) => one.name)) {
    const select = h(doc, 'select', { class: at('input'), 'aria-label': 'Unit', 'data-nd-input': 'unit' }, ...choices.map((one) => h(doc, 'option', { value: one, text: one })))
    select.value = String(texts[key])
    select.addEventListener('change', () => { texts[key] = select.value; edit() })
    return select
  }

  const others = rows.filter((one) => one.key !== row.key)
  const passed = ticks('after', others.map((one) => [one.key, `${String(rows.indexOf(one) + 1)}. ${titleOf(one)}`]))
  const rateCounts = h(doc, 'select', { class: at('input'), 'aria-label': 'What counts', 'data-nd-input': 'rateCounts' }, h(doc, 'option', { value: 'passed', text: 'publications that passed their challenges' }), h(doc, 'option', { value: 'failed', text: 'publications that failed their challenges' }))
  rateCounts.value = texts['rateCounts']
  rateCounts.addEventListener('change', () => { texts['rateCounts'] = rateCounts.value; edit() })

  const more = h(doc, 'details', { class: at('more'), ...(['postScore', 'replyScore', 'postCount', 'replyCount', 'ageValue', 'rateLimit', 'communityAddresses'].some((key) => texts[key] !== '') || texts['types'].length + texts['after'].length > 0 ? { open: true } : {}) },
    h(doc, 'summary', { text: 'More conditions' }),
    field('postScore', 'Post score at least', [text('postScore', { numeric: true, label: 'Post score' })], 'The author\'s score for posts in this ' + term.board),
    field('replyScore', 'Reply score at least', [text('replyScore', { numeric: true, label: 'Reply score' })]),
    field('postCount', 'Posts at least', [text('postCount', { numeric: true, label: 'Posts' })]),
    field('replyCount', 'Replies at least', [text('replyCount', { numeric: true, label: 'Replies' })]),
    field('ageValue', 'First comment at least', [text('ageValue', { numeric: true, label: 'Age' }), unit('ageUnit'), h(doc, 'span', { class: at('unit'), text: 'old' })]),
    field('types', 'The publication is', ticks('types', [...TYPES.map((type) => /** @type {[string, string]} */ ([type, type === 'communityEdit' ? `a change to the ${term.board}` : TYPE_LABELS[/** @type {keyof typeof TYPE_LABELS} */ (type)]]))])),
    field('rateLimit', 'Up to this many publications an hour', [text('rateLimit', { numeric: true, label: 'Publications an hour' }), h(doc, 'span', { class: at('unit'), text: 'counting' }), rateCounts]),
    others.length === 0 ? null : field('after', 'The author passed the challenge', passed),
    field('communityAddresses', `Reputation in other ${term.boards}`, [text('communityAddresses', { box: true, label: 'Addresses' })], `The addresses of ${term.boards} to check, one per line`),
    field('communityMax', 'Check up to this many of the author\'s comments there', [text('communityMax', { numeric: true, label: 'Comments to check' })], 'Empty: 3'),
    field('communityPostScore', 'Post score there at least', [text('communityPostScore', { numeric: true, label: 'Post score there' })]),
    field('communityReplyScore', 'Reply score there at least', [text('communityReplyScore', { numeric: true, label: 'Reply score there' })]),
    field('communityAgeValue', 'First comment there at least', [text('communityAgeValue', { numeric: true, label: 'Age there' }), unit('communityAgeUnit'), h(doc, 'span', { class: at('unit'), text: 'old' })]))

  const element = h(doc, 'div', { class: at('rule'), 'data-nd-rule': String(index) },
    h(doc, 'div', { class: at('ruleHead') },
      h(doc, 'strong', { text: `Rule ${String(index + 1)}` }), h(doc, 'span', { class: at('hint'), text: 'Not asked of an author who matches everything set here.' }),
      h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'remove-rule', text: 'Remove rule', on: { click: () => { action('remove-rule') } } })),
    field('roles', 'The author is', ticks('roles', ROLES.map((role) => /** @type {[string, string]} */ ([role, ROLE_LABELS[role]])))),
    field('publicKeys', 'Author keys', [text('publicKeys', { box: true, label: 'Author keys' })], 'One public key per line'),
    field('names', 'Author names', [text('names', { box: true, label: 'Author names' })], 'One name per line, such as alice.eth'),
    more, ruleError)
  return { element, sync: () => { for (const sync of syncs) sync() } }
}
