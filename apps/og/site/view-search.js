// The first page: type a name and see what the chain says about it, as one of four states, with its records and why each does or does
// not count. A name that can be registered, continued or finished opens the registration panel under it.

import { el, fill } from './dom.js'
import { icon } from './icons.js'
import { button, notice, working } from './parts.js'
import { failureWords, searchView, typingWords, CHECK_WORDS } from './search-model.js'
import { mountPanel } from './view-register.js'
import { recordsNodes } from './view-records.js'
import { HOW_STEPS, SUFFIX } from './words.js'

/** @typedef {import('./app.js').App} App */

const TYPING_PAUSE_MS = 600

/**
 * @param {HTMLElement} root
 * @param {App} app
 * @param {import('./router.js').Route} route
 */
export function mountSearch (root, app, route) {
  /** @type {import('./search-model.js').Lookup | null} */
  let lookup = null
  /** @type {AbortController | null} */
  let pending = null
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  let gone = false
  /** @type {{ label: string, offer: string | null, panel: ReturnType<typeof mountPanel> } | null} */
  let open = null

  const startLabel = route.label ?? (typeof app.registration.state['label'] === 'string' ? app.registration.state['label'] : '')
  const input = /** @type {HTMLInputElement} */ (el('input', {
    id: 'name', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-describedby': 'verdict search-privacy', enterkeyhint: 'go'
  }))
  input.value = startLabel
  const verdict = el('div', { id: 'verdict', class: 'verdict', 'aria-live': 'polite' })
  const submit = /** @type {HTMLButtonElement} */ (button(CHECK_WORDS, { quiet: true, type: 'submit', describedBy: 'verdict' }))
  const form = el('form', { class: 'search', novalidate: true },
    el('label', { for: 'name', text: 'Name' }),
    el('div', { class: 'name-field' }, input, el('span', { class: 'suffix', text: `.${SUFFIX}` })),
    app.chain === null ? null : el('p', { class: 'hint', id: 'search-privacy', text: typingWords(app.kind) }),
    verdict,
    el('div', { class: 'actions' }, submit))
  const recordsHost = el('div', { class: 'records-host' })
  const panelHost = el('div', { class: 'panel-host', hidden: true })
  const page = el('div', { class: 'page narrow' },
    el('h1', { text: 'Find and register a .og name' }),
    el('p', { class: 'lede', text: `A name you own on Ethereum, such as harbor.${SUFFIX}. Type one to see whether it is free, who holds it and what it points to.` }),
    app.chain === null ? notice('warn', 'No wallet found', el('p', { text: 'Open this page in Orivon, or in a browser with an Ethereum wallet extension.' })) : null,
    form, recordsHost, panelHost,
    el('section', { class: 'how', 'aria-labelledby': 'how-title' },
      el('h2', { id: 'how-title', text: 'How it works' }),
      el('ol', {}, HOW_STEPS.map((step) => el('li', {}, el('strong', { text: step.title }), el('span', { text: step.words }))))))
  root.append(page)

  const running = () => ['checking', 'signing', 'running'].includes(String(app.registration.state['phase']))
  const ownRegistration = () => typeof app.registration.state['label'] === 'string' && String(app.registration.state['phase']) !== 'idle'

  /** @param {import('./search-model.js').SearchView} view */
  function verdictNodes (view) {
    if (view.state === 'reading') return [working(view.headline)]
    if (view.headline === '' && view.words === '') return []
    const mark = view.tone === 'ok' ? 'check' : view.tone === 'neutral' ? 'info' : 'alert'
    return [
      icon(mark, { size: 20 }),
      el('div', {},
        el('p', { class: 'verdict-title', text: view.headline }),
        view.words === '' ? null : el('p', { class: 'verdict-words', text: view.words }),
        view.name === null || view.name.controller === null ? null : el('p', { class: 'verdict-words', text: view.name.controller }))
    ]
  }

  function draw () {
    if (gone) return
    const view = searchView({ input: input.value, lookup, account: app.session.address, kind: app.kind })
    const locked = running()
    input.disabled = locked
    input.setAttribute('aria-invalid', String(view.state === 'problem'))
    submit.disabled = !view.canCheck || locked || app.chain === null
    verdict.dataset['tone'] = view.tone
    fill(verdict, verdictNodes(view))
    fill(recordsHost, recordsNodes(view.name))
    drawPanel(view)
  }

  /** @param {import('./search-model.js').SearchView} view */
  function drawPanel (view) {
    const { label, name } = view
    const own = label !== null && ownRegistration() && app.registration.state['label'] === label
    if (open !== null && open.label === label && view.state === 'reading') return
    if (open !== null && (label === null || open.label !== label || (!own && (name === null || name.offer !== open.offer)))) {
      open.panel.destroy()
      open = null
    }
    if (open === null) {
      if (label === null || name === null || (name.offer === null && !own)) return
      open = { label, offer: name.offer, panel: mountPanel(panelHost, app, { label, name, onFinished: () => { void check() }, onReset }) }
    } else if (name !== null) {
      open.panel.update(name)
    }
  }

  function onReset () {
    input.value = ''
    lookup = null
    draw()
    input.focus()
  }

  async function check () {
    clearTimeout(timer)
    pending?.abort()
    const view = searchView({ input: input.value, lookup: null, account: null })
    if (view.label === null || app.chain === null) return
    const { label } = view
    const mine = new AbortController()
    pending = mine
    lookup = { kind: 'reading', label }
    draw()
    try {
      const found = await app.lookupName(label, mine.signal)
      if (mine.signal.aborted) return
      lookup = { kind: 'read', label, ...found }
    } catch (error) {
      if (mine.signal.aborted) return
      lookup = { kind: 'failed', label, words: failureWords(error) }
    }
    draw()
  }

  input.addEventListener('input', () => {
    clearTimeout(timer)
    pending?.abort()
    lookup = null
    draw()
    if (searchView({ input: input.value, lookup: null, account: null }).label !== null) timer = setTimeout(() => { void check() }, TYPING_PAUSE_MS)
  })
  form.addEventListener('submit', (event) => { event.preventDefault(); void check() })

  const stopSession = app.onSession(draw)
  const stopRegistration = app.onRegistration(draw)
  draw()
  if (searchView({ input: input.value, lookup: null, account: null }).label !== null) void check()
  if (input.value === '') input.focus()

  return {
    unmount () {
      gone = true
      clearTimeout(timer)
      pending?.abort()
      open?.panel.destroy()
      stopSession()
      stopRegistration()
    }
  }
}
