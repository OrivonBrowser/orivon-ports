// The first page: type a name and see what the chain says about it, as one of four states, with its records and why each does or does
// not count. A name that can be registered, continued or finished opens the registration panel under it.

import { el, fill } from './dom.js'
import { icon } from './icons.js'
import { notice, working } from './parts.js'
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
    id: 'name', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-describedby': 'verdict search-privacy', enterkeyhint: 'go', placeholder: 'your-name'
  }))
  input.value = startLabel
  const verdict = el('div', { id: 'verdict', class: 'verdict', 'aria-live': 'polite' })
  const submit = /** @type {HTMLButtonElement} */ (el('button', { class: 'finder-go', type: 'submit', 'aria-describedby': 'verdict' },
    icon('search', { size: 20 }), el('span', { class: 'go-label', text: CHECK_WORDS })))
  const form = el('form', { class: 'finder', novalidate: true },
    el('label', { for: 'name', class: 'visually-hidden', text: 'Name' }),
    el('div', { class: 'finder-field' }, input, el('span', { class: 'suffix', text: `.${SUFFIX}` }), submit),
    app.chain === null ? null : el('p', { class: 'finder-hint', id: 'search-privacy', text: typingWords(app.kind) }))
  const recordsHost = el('div', { class: 'records-host' })
  const panelHost = el('div', { class: 'panel-host', hidden: true })
  const result = el('section', { class: 'result', 'aria-label': 'Result' }, verdict, recordsHost, panelHost)
  const how = el('section', { class: 'how', 'aria-labelledby': 'how-title' },
    el('h2', { id: 'how-title', class: 'visually-hidden', text: 'How it works' }),
    el('ol', { class: 'how-list' }, HOW_STEPS.map((step) => el('li', { class: 'how-step' },
      el('strong', { text: step.title }), el('span', { text: step.short })))),
    el('details', { class: 'detail how-more' }, el('summary', { text: 'The whole story' }),
      el('ul', { class: 'plain' }, HOW_STEPS.map((step) => el('li', {}, el('strong', { text: `${step.title}. ` }), step.words)))))
  const page = el('div', { class: 'home' },
    el('section', { class: 'hero', 'aria-labelledby': 'hero-title' },
      el('div', { class: 'hero-art', 'aria-hidden': 'true' }, el('img', {
        src: 'assets/img/meadow-art-1000.webp', srcset: 'assets/img/meadow-art-1000.webp 1000w, assets/img/meadow-art-1600.webp 1600w',
        sizes: '100vw', width: 1600, height: 896, alt: '', decoding: 'async'
      })),
      el('div', { class: 'hero-in' },
        el('h1', { id: 'hero-title' }, 'Own a ', el('span', { class: 'own', text: `.${SUFFIX}` }), ' name.'),
        el('p', { class: 'sub', text: 'Yours on Ethereum. No expiry and no registry fee.' }),
        app.chain === null ? notice('warn', 'No wallet found', el('p', { text: 'Open this page in Orivon, or in a browser with an Ethereum wallet extension.' })) : null,
        form)),
    el('div', { class: 'stage' }, result, how))
  root.append(page)

  const running = () => ['checking', 'signing', 'running'].includes(String(app.registration.state['phase']))
  const ownRegistration = () => typeof app.registration.state['label'] === 'string' && String(app.registration.state['phase']) !== 'idle'

  /** The one word a card wears at the top: what the chain says about the name for this person. @param {import('./search-model.js').SearchView} view */
  function chipOf (view) {
    const found = view.name
    if (found === null) return view.state === 'problem' ? 'Not valid' : 'Not read'
    if (found.state === 'free' || found.state === 'reReserved') return 'Free'
    if (found.state === 'stranded') return 'Stuck'
    return found.mine ? 'Yours' : 'Taken'
  }

  /** @param {import('./search-model.js').SearchView} view */
  function verdictNodes (view) {
    if (view.state === 'reading') return [working(view.headline)]
    if (view.state === 'typed' || (view.headline === '' && view.words === '')) return []
    const mark = view.tone === 'ok' ? 'check' : view.tone === 'neutral' ? 'info' : 'alert'
    return [
      el('span', { class: 'v-mark', 'aria-hidden': 'true' }, icon(mark, { size: 22 })),
      el('div', { class: 'v-text' },
        el('p', { class: 'v-chip', text: chipOf(view) }),
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
    result.classList.toggle('open', verdict.hasChildNodes() || recordsHost.hasChildNodes() || !panelHost.hidden)
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
  form.querySelector('.finder-field')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) input.focus() })

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
