// The first page: type a name, see in words what it costs, press the button to ask whether it is free, and start the
// registration. Typing is judged here and asks the node nothing; the button is the one question (askAboutName).

import { parseRequest } from './connect-request.js'
import { el } from './dom.js'
import { icon } from './icons.js'
import { button, notice, working } from './parts.js'
import { SEARCH_WORDS } from './register-decoys.js'
import { salesStatus, SUFFIX } from './sdk/orivonid.js'
import { askAboutName, readingOf, SALES_RETRY, salesLine, salesUnknown, searchView, TYPING_WORDS } from './search-model.js'
import { mountPanel } from './view-register.js'
import { formatDai, priceTable, readName } from './words.js'

/** @typedef {import('./app.js').App} App */

const BUSY = new Set(['checking', 'committing', 'maturing', 'revealing', 'recording', 'verifying'])

const STEPS = Object.freeze([
  { title: 'Choose a name', words: 'Three to 63 letters, digits or hyphens. Shorter names cost more.' },
  { title: 'Register in about two minutes', words: 'Commit, wait one minute, reveal: nobody can take the name in between. Your wallet asks you to sign each transaction.' },
  { title: 'Sign in anywhere', words: 'Web3sites can ask for your ID instead of a password. You choose which IDs each site sees.' }
])

/** The chip beside a verdict, as the state of the name in a word. @type {Record<string, { tone: string, label: string }>} */
const CHIPS = Object.freeze({
  available: { tone: 'ok', label: 'Available' }, mine: { tone: 'ok', label: 'Yours' }, taken: { tone: 'danger', label: 'Taken' },
  closed: { tone: 'warn', label: 'Paused' }, unreadable: { tone: 'warn', label: 'Unknown' }
})

/**
 * @param {HTMLElement} root
 * @param {App} app
 * @param {import('./router.js').Route} route
 */
export function mountSearch (root, app, route) {
  /** @type {import('./search-model.js').SalesRead} */
  let salesRead = { kind: 'reading' }
  /** The name last asked about: what the node said is shown only for it. @type {string | null} */
  let asked = typeof app.registration.state['label'] === 'string' ? app.registration.state['label'] : null
  let shown = ''

  const nextRequest = route.next === null ? null : parseRequest(route.next)
  const next = nextRequest?.ok === true ? { hash: route.next ?? '', origin: nextRequest.request.origin } : null

  const input = /** @type {HTMLInputElement} */ (el('input', {
    id: 'name', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-describedby': 'verdict search-privacy', enterkeyhint: 'go'
  }))
  input.value = typeof app.registration.state['label'] === 'string' ? app.registration.state['label'] : ''
  const verdict = el('div', { id: 'verdict', class: 'verdict', 'aria-live': 'polite' })
  const salesNode = el('span', { id: 'sales' })
  const salesRetry = button(SALES_RETRY, { quiet: true, onClick: () => { readSales() } })
  salesRetry.hidden = true
  const salesRow = el('p', { class: 'sales', 'aria-live': 'polite' }, salesNode, salesRetry)
  const submit = /** @type {HTMLButtonElement} */ (button('Check availability', { primary: true, type: 'submit', describedBy: 'verdict' }))
  const form = el('form', { class: 'search', novalidate: true },
    el('label', { for: 'name', text: 'Username' }),
    el('div', { class: 'name-row' },
      el('div', { class: 'name-field' }, input, el('span', { class: 'suffix', text: `.${SUFFIX}` })),
      submit),
    verdict,
    app.chain === null
      ? null
      : el('details', { class: 'more' },
        el('summary', { text: 'Who can see the names you check' }),
        el('p', { class: 'hint', id: 'search-privacy', text: `${TYPING_WORDS} ${SEARCH_WORDS}` })),
    el('dl', { class: 'prices', 'aria-label': 'Prices' },
      priceTable().map((row) => el('div', {}, el('dt', { text: row.lengths }), el('dd', { text: formatDai(row.wei) })))),
    salesRow)
  const panelHost = el('div', { class: 'panel-host', hidden: true })

  const page = el('div', { class: 'page search-page' },
    el('h1', { text: 'Register an ID' }),
    el('p', { class: 'lede', text: `A username you own on Ethereum, such as alice.${SUFFIX}. Websites use it instead of a password and an account.` }),
    next === null ? null : notice('info', `You are here to sign in to ${next.origin}.`, el('p', { text: 'Register an ID first. When it is done you come back to that sign-in.' })),
    app.chain === null ? notice('warn', 'No wallet found', el('p', { text: 'Open this page in Orivon, or in a browser with an Ethereum wallet extension.' })) : null,
    el('div', { class: 'search-grid' },
      el('div', { class: 'search-main' }, form, panelHost),
      el('section', { class: 'how', 'aria-labelledby': 'how-title' },
        el('h2', { id: 'how-title', text: 'How it works' }),
        el('ol', {}, STEPS.map((step) => el('li', {}, el('strong', { text: step.title }), el('span', { text: step.words })))))))
  root.append(page)

  const panel = mountPanel(panelHost, app, {
    label: () => { const typed = readName(input.value); return typed.kind === 'name' ? typed.label : input.value },
    edit: () => { input.focus(); input.select() },
    reset: () => { input.value = ''; input.focus(); draw() },
    next
  })

  function draw () {
    const phase = String(app.registration.state['phase'])
    const busy = BUSY.has(phase)
    const view = searchView({ input: input.value, reading: readingOf(app.registration.state), asked, account: app.session.address })
    const key = `${view.state}|${view.headline}|${view.words}`
    const failedMidway = phase === 'failed' && app.registration.state['during'] !== 'checking'
    form.dataset['locked'] = String(busy || phase === 'done' || failedMidway)
    form.dataset['compact'] = String(phase === 'ready')
    page.dataset['panel'] = String(form.dataset['compact'] === 'true' || form.dataset['locked'] === 'true')
    input.disabled = busy
    input.setAttribute('aria-invalid', String(view.state === 'problem'))
    submit.disabled = !view.canCheck || busy || phase === 'done' || failedMidway || app.chain === null
    const sales = app.chain === null || view.state === 'closed' ? { words: '', retry: false } : salesLine(salesRead)
    salesNode.textContent = sales.words
    salesRetry.hidden = !sales.retry
    if (key === shown) return
    shown = key
    verdict.dataset['tone'] = view.tone
    verdict.replaceChildren(...verdictNodes(view))
  }

  /** @param {import('./search-model.js').SearchView} view */
  function chipOf (view) {
    if (view.state === 'problem') {
      const typed = readName(input.value)
      return typed.kind === 'problem' && typed.reason === 'reserved' ? { tone: 'warn', label: 'Reserved' } : null
    }
    return CHIPS[view.state] ?? null
  }

  /** @param {import('./search-model.js').SearchView} view */
  function verdictNodes (view) {
    if (view.state === 'reading') return [working(view.headline)]
    if (view.headline === '' && view.words === '') return []
    const mark = view.tone === 'ok' ? 'check' : view.tone === 'neutral' ? 'info' : 'alert'
    const chip = chipOf(view)
    return [
      view.state === 'empty' ? null : el('span', { class: 'verdict-mark', 'aria-hidden': 'true' }, icon(mark, { size: 16 })),
      el('div', { class: 'verdict-text' },
        view.headline === '' ? null : el('p', { class: 'verdict-title', text: view.headline }),
        view.words === '' ? null : el('p', { class: 'verdict-words', text: view.words }),
        view.state === 'mine' ? el('a', { href: '#/me', text: 'Open My IDs' }) : null),
      chip === null ? null : el('span', { class: `badge ${chip.tone}`, text: chip.label })
    ].filter((node) => node !== null)
  }

  input.addEventListener('input', () => {
    const state = app.registration.state
    if (state['phase'] === 'ready' || state['phase'] === 'failed') app.resetRegistration()
    draw()
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const flow = app.flow
    const view = searchView({ input: input.value, reading: readingOf(app.registration.state), asked, account: app.session.address })
    if (!view.canCheck || flow === null) return
    submit.disabled = true
    const answer = await askAboutName({ input: input.value, connect: () => app.connect(), check: (label) => { asked = label; return flow.check(label) } })
    if (answer.asked) return
    submit.disabled = false
    if (answer.why === 'noAddress') {
      verdict.replaceChildren(notice('warn', app.session.failure ?? 'Orivon ID needs to see your address to check a name.'))
      shown = ''
    }
  })

  let gone = false
  const stopSession = app.onSession(draw)
  const stopRegistration = app.onRegistration(draw)

  /** Asks whether the registrar sells; a read that fails is shown as unknown, never as a sale that is open or shut. */
  function readSales () {
    const chain = app.chain
    if (chain === null) return
    salesRead = { kind: 'reading' }
    draw()
    void salesStatus(chain).then((sales) => { salesRead = { kind: 'read', sales } }, (error) => { salesRead = salesUnknown(error) }).then(() => { if (!gone) draw() })
  }

  draw()
  readSales()
  if (input.value === '') input.focus()

  return {
    unmount () {
      gone = true
      panel.destroy()
      stopSession()
      stopRegistration()
    }
  }
}
