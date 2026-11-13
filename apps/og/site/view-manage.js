// The page of one of the person's names: its card, whether it is wrapped, whether its records count and why not, the Orivon ID badge,
// and the actions on it. While an action runs, stops or ends, the actions give way to its series; nothing is sent but the steps it lists.

import { el, fill } from './dom.js'
import { nameArt } from './art.js'
import { menuOf } from './manage-model.js'
import { actionPanel } from './manage-forms.js'
import { actionWords, manageDoneWords, manageOutcomeWords } from './manage-words.js'
import { chipsOf, rowOf } from './names-model.js'
import { button, connectNotice, noWalletNotice, notice, retryNotice, stepList, working } from './parts.js'
import { OFFER_LABELS } from './register-words.js'
import { RELAY_WORDS } from './relay.js'
import { describeName } from './search-model.js'
import { mountBadge } from './view-badge.js'
import { recordsNodes } from './view-records.js'
import { SUFFIX } from './words.js'

/** @typedef {import('./app.js').App} App */

/**
 * @param {HTMLElement} root
 * @param {App} app
 * @param {import('./router.js').Route} route
 */
export function mountManage (root, app, route) {
  const label = route.label ?? ''
  const name = `${label}.${SUFFIX}`
  /** @type {{ kind: 'reading' } | { kind: 'failed', words: string } | { kind: 'read', view: import('./search-model.js').NameView }} */
  let lookup = { kind: 'reading' }
  /** @type {AbortController | null} */
  let pending = null
  /** @type {bigint | null} */
  let priceWei = null
  /** @type {string | null} */
  let openAction = null
  let gone = false
  let lastPhase = String(app.managing.state['phase'])
  /** @type {ReturnType<typeof mountBadge> | null} */
  let badge = null
  let badgeFor = ''
  const badgeHost = el('div', { class: 'badge-host', hidden: true })
  const body = el('div', { class: 'manage-body' })
  root.append(el('div', { class: 'page' }, el('p', { class: 'crumbs' }, el('a', { href: '#/names', text: 'My names' })), el('h1', { text: name }), body))

  const own = () => app.managing.state['label'] === label && String(app.managing.state['phase']) !== 'idle'

  /** @param {Record<string, any>} state */
  function seriesNodes (state) {
    const phase = String(state['phase'])
    const action = /** @type {import('./manage-plan.js').Action} */ (state['action'])
    const title = actionWords(action, state['situation'] === 'wrappedMine').title
    if (phase === 'checking') return [el('h2', { text: title }), working('Reading the name…')]
    if (phase === 'refused') {
      const fix = /** @type {import('./manage-plan.js').Action | null} */ (state['fix'])
      return [el('h2', { text: title }), notice('warn', 'Nothing was sent.', el('p', { text: String(state['problem']) })),
        el('div', { class: 'actions' },
          fix === null ? null : button(`Go to: ${actionWords(fix, false).title}`, { primary: true, onClick: () => { openAction = fix; app.resetManage(); void load() } }),
          button('Back to the name', { quiet: true, onClick: () => { app.resetManage() } }))]
    }
    const stepsView = stepList(state['steps'])
    if (phase === 'done') {
      const words = manageDoneWords(state)
      return [el('h2', { text: words.title }), notice('ok', null, words.lines.map((line) => el('p', { text: line }))), stepsView,
        el('div', { class: 'actions' }, button('Back to the name', { primary: true, onClick: () => { app.resetManage() } }))]
    }
    if (phase === 'stopped') {
      const words = manageOutcomeWords(state)
      const outcome = state['outcome']
      const again = app.managing.request
      return [el('h2', { text: `${title}: stopped` }), notice(words.tone, words.title, words.lines.map((line) => el('p', { text: line }))), stepsView,
        el('div', { class: 'actions' },
          outcome.offer === null || again === null || outcome.offer === 'unwrapped'
            ? null
            : button(OFFER_LABELS[/** @type {'finishWrapping' | 'retry' | 'public'} */ (outcome.offer)], {
              primary: true, onClick: () => { void app.manageName(outcome.offer === 'public' ? { ...again, private: false } : again) }
            }),
          outcome.offer !== 'public' || again === null ? null : button(RELAY_WORDS.tryAgain, { quiet: true, onClick: () => { void app.manageName(again) } }),
          button(outcome.offer === null ? 'Back to the name' : 'Leave it as it is', { quiet: true, onClick: () => { app.resetManage() } }))]
    }
    const how = state['signing'] === 'series' ? 'Your wallet signed the whole series once; each step goes out after the one before it was mined.'
      : state['signing'] === 'each' ? 'Your wallet signs each step when its turn comes.' : state['signing'] === 'extension' ? 'Your wallet extension asks for each step as its turn comes.' : ''
    return [el('h2', { text: title }), phase === 'signing' ? working('Waiting for your wallet…') : el('p', { class: 'hint', text: how }), stepsView,
      Array.isArray(state['notes']) ? state['notes'].map((note) => notice('info', null, el('p', { text: note }))) : null]
  }

  /** @param {import('./search-model.js').NameView} view @param {string} account @param {ReturnType<typeof rowOf>} row */
  function nameNodes (view, account, row) {
    const wrapped = row.state === 'wrapped'
    const holds = row.state !== 'lost'
    const items = menuOf({ view, account })
    const head = el('header', { class: 'name-head' },
      el('div', { class: 'name-art' }, nameArt({ label, wrapped })),
      el('div', { class: 'name-summary' },
        el('ul', { class: 'chips' }, chipsOf(row, view).map((chip) => el('li', { class: `chip ${chip.tone}`, text: chip.text }))),
        el('p', { text: view.words }),
        holds && row.site.words !== '' ? el('p', { class: 'hint', text: row.site.words }) : null,
        holds && row.controller.words !== null ? el('p', { class: 'hint', text: row.controller.words }) : null))
    if (!holds) {
      return [head, notice('warn', `${name} is not held by your address.`, el('p', { text: view.headline }), el('p', {}, el('a', { href: '#/names', text: 'Back to My names' })))]
    }
    const panels = items.map((item) => actionPanel(app, {
      item, view: () => view, account, label, price: () => priceWei, open: openAction === item.action,
      onStart: (request) => { void app.manageName(request) },
      onFix: (action) => { openAction = action; draw() }
    }))
    for (const panel of panels) {
      panel.node.addEventListener('toggle', () => {
        const open = /** @type {HTMLDetailsElement} */ (panel.node).open
        const action = panel.node.dataset['action'] ?? null
        if (open) {
          openAction = action
          for (const other of panels) if (other.node !== panel.node) /** @type {HTMLDetailsElement} */ (other.node).open = false
        } else if (openAction === action) openAction = null
      })
    }
    return [head, recordsNodes(view, { title: 'Records' }), badgeHost, el('section', { class: 'actions-list', 'aria-labelledby': 'actions-title' },
      el('h2', { id: 'actions-title', text: 'What you can do' }), panels.map((panel) => panel.node))]
  }

  function draw () {
    if (gone) return
    const account = app.session.address
    if (app.chain === null) { fill(body, noWalletNotice()); return }
    if (account === null) {
      fill(body, connectNotice({ asking: app.session.asking, connect: () => { void app.connect() } }, 'Connect your wallet to manage this name.',
        'The page reads the name from Ethereum and offers only what your address can do.'))
      return
    }
    if (own()) { fill(body, seriesNodes(app.managing.state)); return }
    if (lookup.kind === 'reading') { fill(body, working(`Reading ${name} from Ethereum…`)); return }
    if (lookup.kind === 'failed') {
      fill(body, retryNotice(`${name} could not be read.`, lookup.words, () => { void load() }))
      return
    }
    const { view } = lookup
    const row = rowOf({ view, account, primary: view.facts.primary ?? null })
    fill(body, nameNodes(view, account, row))
    const { holder } = view
    if (row.state === 'lost' || holder === null) { badge?.destroy(); badge = null; badgeFor = ''; return }
    if (badgeFor !== holder) {
      badge?.destroy()
      badgeFor = holder
      badge = mountBadge(badgeHost, app, { address: holder, auto: view.mine, mine: view.mine })
    }
  }

  async function load () {
    const account = app.session.address
    if (app.chain === null || account === null) { draw(); return }
    pending?.abort()
    const mine = new AbortController()
    pending = mine
    lookup = { kind: 'reading' }
    draw()
    try {
      const found = await app.lookupName(label, mine.signal, { account, keys: app.manageKeys })
      if (mine.signal.aborted) return
      lookup = { kind: 'read', view: describeName({ label, inspection: found.inspection, facts: found.facts, account, keys: app.manageKeys }) }
    } catch (error) {
      if (mine.signal.aborted) return
      lookup = { kind: 'failed', words: error instanceof Error && error.name === 'OgRefusal' ? error.message : 'Your node did not answer. Check the connection and try again.' }
    }
    badgeFor = ''
    draw()
  }

  const stopSession = app.onSession(() => { if (app.session.address !== null && lookup.kind === 'reading') void load(); else draw() })
  const stopManage = app.onManage(() => {
    const phase = String(app.managing.state['phase'])
    if (phase !== lastPhase && own() === false && lastPhase !== 'idle') void load()
    lastPhase = phase
    draw()
  })
  void app.feePerGas().then((price) => { priceWei = price }).then(() => { if (!own()) draw() })
  draw()
  void load()

  return {
    unmount () {
      gone = true
      pending?.abort()
      badge?.destroy()
      stopSession()
      stopManage()
    }
  }
}
