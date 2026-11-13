// The Orivon ID card: whether an address holds an Orivon ID, read from the ID registry through the person's node, with the line that says
// what the badge proves and what it does not. For the connected account it is read at once; for another holder it waits to be asked.

import { el, fill } from './dom.js'
import { BADGE_WORDS, badgeOf } from './badge-model.js'
import { icon } from './icons.js'
import { isValidLabel, normalizeInput, SUFFIX } from './sdk/orivonid.js'
import { button, working } from './parts.js'

/** @typedef {import('./app.js').App} App */

/** What a typed username is, in the ID's own rules: `alice`, or `alice.v1.orivonid.eth`. @param {string} text @returns {string | null} */
export function usernameOf (text) {
  const typed = normalizeInput(text.trim().replace(new RegExp(`\\.${SUFFIX.replaceAll('.', '\\.')}$`, 'i'), ''))
  return typed.ok && isValidLabel(typed.label) ? typed.label : null
}

/** @type {Record<string, 'shield' | 'info' | 'alert'>} */
const PILL_ICONS = { verified: 'shield', idle: 'info', none: 'info' }

let counter = 0

/**
 * @param {HTMLElement} host
 * @param {App} app
 * @param {{ address: string, auto: boolean, mine: boolean }} parts `auto`: read at once; `mine`: the address is the connected account's, so a username can be typed
 */
export function mountBadge (host, app, parts) {
  const id = `id${counter++}`
  /** @type {import('./badge-model.js').IdCheck} */
  let check = { phase: 'idle' }
  let ended = false
  let problem = ''
  const input = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: `${id}-user`, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'alice' }))
  const card = el('section', { class: 'id-card', 'aria-labelledby': `${id}-title` })
  host.hidden = false
  fill(host, card)

  async function run (options = {}) {
    check = { phase: 'checking' }
    draw()
    const done = await app.idCheck(parts.address, options)
    if (ended) return
    check = done
    draw()
  }

  function draw () {
    if (ended) return
    const view = badgeOf(check)
    const learn = el('details', { class: 'detail' },
      el('summary', { text: 'What this proves, and what it does not' }),
      el('p', { class: 'hint', text: 'It proves:' }),
      el('ul', { class: 'plain' }, BADGE_WORDS.proves.map((line) => el('li', { text: line }))),
      el('p', { class: 'hint', text: 'It does not prove:' }),
      el('ul', { class: 'plain' }, BADGE_WORDS.doesNot.map((line) => el('li', { text: line }))))
    const add = !parts.mine || check.phase === 'idle' || check.phase === 'checking'
      ? null
      : el('form', { class: 'id-add', novalidate: true },
        el('label', { for: `${id}-user`, text: 'Check an Orivon ID username' }),
        el('div', { class: 'inline' }, input, el('span', { class: 'suffix', text: `.${SUFFIX}` }), button('Check it', { quiet: true, type: 'submit' })),
        problem === '' ? null : el('p', { class: 'tip-problem', role: 'alert', text: problem }))
    fill(card,
      el('h2', { id: `${id}-title`, text: 'Orivon ID' }),
      view.state === 'checking'
        ? working(view.headline)
        : el('div', { class: 'id-line' },
          el('span', { class: 'id-pill', 'data-state': view.state }, icon(PILL_ICONS[view.state] ?? 'alert', { size: 16 }), el('span', { text: view.headline })),
          view.words === null ? null : el('p', { class: 'hint', text: view.words })),
      view.state === 'idle' ? el('div', { class: 'actions' }, button('Check Orivon ID', { quiet: true, onClick: () => { void run() } })) : null,
      add, learn)
  }

  card.addEventListener('submit', (event) => {
    event.preventDefault()
    const label = usernameOf(input.value)
    if (label === null) { problem = 'Type a username as the Orivon ID site spells it, such as alice.'; draw(); return }
    problem = ''
    void run({ extra: [label], again: true })
  })

  draw()
  if (parts.auto) void run()
  return { destroy () { ended = true; host.hidden = true; host.replaceChildren() } }
}
