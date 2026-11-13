// The registration panel under the search: the choices (wrapped or not, a site, the tip, a private send), the plan in steps with
// what it costs, the button, and then the series as it runs, stops or finishes. What is decided from the chain is in register-model.js
// and register-flow.js; this file draws it and passes the person's choices on.

import { el, fill } from './dom.js'
import { button, notice, relayMark, stepList, working } from './parts.js'
import { advisePrivate, RELAY_WORDS } from './relay.js'
import { costOf, optionsOf, panelOf, SITE_WORDS, siteRecordOf } from './register-model.js'
import { freezeTip, TIP, tipPlanOf } from './register-tip.js'
import { doneWords, OFFER_LABELS, outcomeWords } from './register-words.js'
import { formatEth, SUFFIX } from './words.js'

/** @typedef {import('./app.js').App} App */
/** @typedef {import('./search-model.js').NameView} NameView */

const ACTIVE = new Set(['checking', 'signing', 'running'])

let counter = 0

/** @param {{ gas: string, ether: string | null, tipWei: bigint }} cost */
function costWords (cost) {
  const fee = cost.ether === null ? '' : `, about ${cost.ether} at today's fee`
  const tip = cost.tipWei > 0n ? ` The tip, ${formatEth(cost.tipWei)}, comes on top.` : ''
  return `The name's steps: ${cost.gas}${fee}.${tip}`
}

/**
 * @param {HTMLElement} host
 * @param {App} app
 * @param {{ label: string, name: NameView, onFinished: () => void, onReset: () => void }} parts `onFinished`: a series ended, so the name is read again; `onReset`: the person wants another name
 */
export function mountPanel (host, app, parts) {
  const id = `panel${counter++}`
  let current = parts.name
  /** @type {bigint | null} */
  let priceWei = null
  /** What the tip line was shown with: the lookup of `orivonstack.eth`, null until it answers. @type {{ ok: true, address: string } | { ok: false, words: string } | null} */
  let tipLookup = null
  let message = /** @type {import('./dom.js').Child} */ (null)
  let busy = false
  let ended = false

  const wrappedBox = /** @type {HTMLInputElement} */ (el('input', { type: 'radio', name: `${id}-kind`, id: `${id}-wrapped`, checked: true }))
  const plainBox = /** @type {HTMLInputElement} */ (el('input', { type: 'radio', name: `${id}-kind`, id: `${id}-plain` }))
  const siteInput = /** @type {HTMLInputElement} */ (el('input', {
    type: 'text', id: `${id}-site`, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${id}-site-words`, placeholder: 'ipfs://…'
  }))
  const tipBox = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: `${id}-tip`, checked: panelOf(parts.name.offer).tipTicked }))
  const tipAmount = /** @type {HTMLInputElement} */ (el('input', {
    type: 'text', id: `${id}-tip-amount`, value: TIP.defaultText, inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Tip in ETH'
  }))
  const privateBox = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: `${id}-private` }))
  const review = el('div', { class: 'review', 'aria-live': 'polite' })
  const choicesHost = el('div')
  const messageHost = el('div', { 'aria-live': 'polite' })
  const titleNode = el('h2', { id: `${id}-title` })
  const tipNote = el('p', { class: 'hint' })
  const form = el('div', { class: 'panel-body' })
  const foot = el('div', { class: 'panel-foot' })
  const panel = el('section', { class: 'panel', 'aria-labelledby': `${id}-title` }, form, foot)
  host.hidden = false
  fill(host, panel)

  const chosenWrapped = () => panelOf(current.offer).wraps || (wrappedBox.checked && optionsOf(inputs()).canWrap)
  const inputs = () => {
    const site = siteRecordOf(siteInput.value)
    const tip = tipPlanOf({ ticked: tipBox.checked, amountText: tipAmount.value, lookup: tipLookup })
    return { label: parts.label, account: app.session.address ?? '0x0000000000000000000000000000000000000001', facts: current.facts, site: site.kind === 'site' ? site : null, tip: tip.tip }
  }

  function choices () {
    const options = optionsOf(inputs())
    const gas = (/** @type {{ steps: readonly any[], expected: number, limit: number }} */ plan) => costOf(plan, priceWei).gas
    const wrapWords = options.canWrap
      ? `A token (an NFT) for the name that you can send or sell. Cost: ${gas(options.wrapped)}.`
      : 'Switched off at the wrapper for now, so a name cannot be wrapped. Register it unwrapped.'
    if (!options.canWrap) { wrappedBox.checked = false; plainBox.checked = true }
    wrappedBox.disabled = !options.canWrap
    if (panelOf(current.offer).wraps) return null
    return el('fieldset', {},
      el('legend', { text: 'How to hold it' }),
      el('div', { class: 'choice' }, wrappedBox, el('label', { for: `${id}-wrapped` }, 'Wrapped', el('span', { class: 'choice-words', text: ` (default). ${wrapWords}` }))),
      el('div', { class: 'choice' }, plainBox, el('label', { for: `${id}-plain` }, 'Unwrapped',
        el('span', { class: 'choice-words', text: `. Held in the registry with no token, so it cannot be sold as one. Cost: ${gas(options.unwrapped)}.` }))))
  }

  const tipBlock = el('div', { class: 'tip' },
    el('div', { class: 'choice' }, tipBox, el('label', { for: `${id}-tip`, text: 'Support Orivon' })),
    el('div', { class: 'inline' }, tipAmount, el('span', { class: 'suffix', text: 'ETH' })),
    el('p', { class: 'hint', text: `A plain transfer of ETH to ${TIP.name}, sent last and only if every step above worked. It is at most ${formatEth(TIP.capWei)}. Untick it to send none.` }),
    tipNote)

  function refreshTipNote () {
    const plan = tipPlanOf({ ticked: tipBox.checked, amountText: tipAmount.value, lookup: tipLookup })
    tipAmount.disabled = !tipBox.checked
    tipNote.className = plan.blocks ? 'tip-problem' : 'hint'
    if (plan.blocks) tipNote.setAttribute('role', 'alert')
    else tipNote.removeAttribute('role')
    if (!tipBox.checked) tipNote.textContent = ''
    else if (plan.blocks) tipNote.textContent = plan.words
    else if (tipLookup === null) tipNote.textContent = `Looking up ${TIP.name}…`
    else tipNote.textContent = tipLookup.ok ? `${TIP.name} points to ${tipLookup.address}.` : tipLookup.words
  }

  const privateBlock = !app.sender?.canSendPrivately
    ? el('p', { class: 'hint', text: `${RELAY_WORDS.publicWarning} This wallet signs and sends in one step, so it cannot send privately.` })
    : el('div', { class: 'private' },
      el('label', { class: 'switch' }, privateBox, el('span', { class: 'track', 'aria-hidden': 'true' }), el('span', { text: RELAY_WORDS.switchLabel }), relayMark()),
      el('p', { class: 'hint', text: RELAY_WORDS.explanation }),
      el('p', { class: 'hint', text: RELAY_WORDS.publicWarning }),
      advisePrivate(parts.label) ? el('p', { class: 'advice', text: RELAY_WORDS.advice }) : null)
  const siteField = el('div', { class: 'field' },
    el('label', { for: `${id}-site`, text: 'Site (optional)' }), siteInput,
    el('p', { class: 'hint', id: `${id}-site-words`, text: `${SITE_WORDS} It is written after the name is yours, so it counts.` }))
  const idleForm = [titleNode, choicesHost, siteField, tipBlock, privateBlock, review, messageHost]
  /** @type {'idle' | 'active'} */
  let shown = 'active'

  function drawReview () {
    const options = optionsOf(inputs())
    const plan = chosenWrapped() ? options.wrapped : options.unwrapped
    const site = siteRecordOf(siteInput.value)
    const cost = costOf(plan, priceWei)
    fill(review,
      site.kind === 'problem' ? el('p', { class: 'tip-problem', role: 'alert', text: site.words }) : null,
      plan.notes.map((note) => notice('warn', null, el('p', { text: note }))),
      plan.steps.length === 0
        ? el('p', { text: 'There is nothing left to send for this name.' })
        : [el('h3', { text: 'What will be sent' }), stepList(plan.steps.map((step) => ({ ...step, state: 'pending', hash: null }))),
            el('p', { class: 'cost', text: costWords(cost) })])
  }

  function drawFoot () {
    const options = optionsOf(inputs())
    const plan = chosenWrapped() ? options.wrapped : options.unwrapped
    const tip = tipPlanOf({ ticked: tipBox.checked, amountText: tipAmount.value, lookup: tipLookup })
    const site = siteRecordOf(siteInput.value)
    if (app.session.address === null) {
      const asking = app.session.asking
      fill(foot, el('div', { class: 'actions' }, button(asking ? 'Waiting for your wallet…' : 'Connect your wallet', {
        primary: true, disabled: asking || app.chain === null, onClick: () => { void app.connect() }
      }),
        app.session.failure === null ? null : el('span', { class: 'account-failure', role: 'alert', text: app.session.failure })))
      return
    }
    const wrapOffForWrapping = panelOf(current.offer).wraps && current.facts.wrapEnabled !== true
    fill(foot, el('div', { class: 'actions' },
      button(busy ? 'Starting…' : panelOf(current.offer).button, {
        primary: true, id: `${id}-go`, disabled: busy || plan.steps.length === 0 || tip.blocks || site.kind === 'problem' || wrapOffForWrapping, onClick: () => { void start() }
      }),
      wrapOffForWrapping ? el('span', { class: 'hint', text: 'Wrapping is switched off at the wrapper right now. Come back when it is on.' }) : null))
  }

  function drawIdle () {
    if (shown !== 'idle') { fill(form, idleForm); shown = 'idle' }
    titleNode.textContent = `${panelOf(current.offer).heading} ${parts.label}.${SUFFIX}`
    fill(choicesHost, choices())
    fill(messageHost, message)
    refreshTipNote()
    drawReview()
    drawFoot()
  }

  /** The plan's own words, and what the page found about an earlier tip: said in every phase, since they explain what is not in the steps. @param {Record<string, any>} state */
  const notesOf = (state) => Array.isArray(state['notes']) ? state['notes'].map((note) => notice('warn', null, el('p', { text: note }))) : null

  /** @param {Record<string, any>} state */
  function doneNotice (state) {
    const words = doneWords(state)
    return notice('ok', words.title, words.lines.map((line) => el('p', { text: line })))
  }

  /** The panel as the series is running, stopped or done. @param {Record<string, any>} state */
  function drawActive (state) {
    shown = 'active'
    const phase = String(state['phase'])
    const stepsView = stepList(state['steps'])
    if (phase === 'done') {
      fill(form, el('h2', { id: `${id}-title`, text: `${parts.label}.${SUFFIX} is registered` }), doneNotice(state), notesOf(state), stepsView)
      fill(foot, el('div', { class: 'actions' }, button('Register another name', { primary: true, onClick: () => { app.resetRegistration(); parts.onReset() } })))
      return
    }
    if (phase === 'stopped') {
      const words = outcomeWords(state)
      const outcome = state['outcome']
      const again = app.registration.request
      // The buttons come right under the notice that explains the stop, above the steps, so the person finds them with the words.
      fill(form, el('h2', { id: `${id}-title`, text: `${parts.label}.${SUFFIX}: the series stopped` }),
        notice(words.tone, words.title, words.lines.map((line) => el('p', { text: line }))),
        el('div', { class: 'actions' },
          outcome.offer === null || again === null ? null : button(OFFER_LABELS[/** @type {'unwrapped' | 'finishWrapping' | 'retry' | 'public'} */ (outcome.offer)], {
            primary: true,
            onClick: () => { void app.register({ ...again, wrapped: outcome.offer === 'unwrapped' ? false : again['wrapped'], ...(outcome.offer === 'public' ? { private: false } : {}) }) }
          }),
          outcome.offer !== 'public' || again === null ? null : button(RELAY_WORDS.tryAgain, { quiet: true, onClick: () => { void app.register(again) } }),
          button(outcome.offer === null ? 'Search another name' : 'Cancel', { quiet: true, onClick: () => { app.resetRegistration(); parts.onReset() } })),
        notesOf(state), stepsView)
      fill(foot)
      return
    }
    const how = state['signing'] === 'series' ? 'Your wallet signed the whole series once; each step goes out after the one before it was mined.'
      : state['signing'] === 'each' ? 'Your wallet signs each step when its turn comes.' : state['signing'] === 'extension' ? 'Your wallet extension asks for each step as its turn comes.' : ''
    fill(form, el('h2', { id: `${id}-title`, text: `Registering ${parts.label}.${SUFFIX}` }),
      phase === 'checking' ? working('Reading the name…') : phase === 'signing' ? working('Waiting for your wallet…') : el('p', { class: 'hint', text: how }),
      stepsView, notesOf(state))
    fill(foot)
  }

  function draw () {
    if (ended) return
    const state = app.registration.state
    const own = state['label'] === parts.label && String(state['phase']) !== 'idle'
    if (own) drawActive(state)
    else drawIdle()
  }

  async function start () {
    if (busy || app.session.address === null) return
    busy = true
    message = null
    drawFoot()
    try {
      const site = siteRecordOf(siteInput.value)
      const frozen = await freezeTip(/** @type {import('./sdk/chain.js').Chain} */ (app.chain), {
        ticked: tipBox.checked, amountText: tipAmount.value, shown: tipLookup !== null && tipLookup.ok ? tipLookup.address : null, account: app.session.address
      })
      if (frozen.status === 'invalid') { message = notice('warn', frozen.words); return }
      if (frozen.status === 'changed') {
        tipLookup = { ok: true, address: frozen.address ?? '' }
        message = notice('warn', frozen.words)
        return
      }
      const wantsPrivate = privateBox.checked && app.sender?.canSendPrivately === true
      if (wantsPrivate && !(await app.relay.allow())) { message = notice('warn', RELAY_WORDS.notAllowed); privateBox.checked = false; return }
      busy = false
      await app.register({
        label: parts.label, account: app.session.address, wrapped: chosenWrapped(), site: site.kind === 'site' ? { key: site.key, text: site.text } : null,
        tip: frozen.tip, private: wantsPrivate, notes: frozen.status === 'none' && tipBox.checked && frozen.words !== '' ? [frozen.words] : []
      })
    } finally {
      busy = false
      if (!ended) draw()
    }
  }

  for (const node of [wrappedBox, plainBox, siteInput, tipBox, tipAmount, privateBox]) {
    node.addEventListener('input', () => { if (!ended && shown === 'idle') { refreshTipNote(); drawReview(); drawFoot() } })
  }
  const stopSession = app.onSession(() => { if (!ended) draw() })
  let lastPhase = String(app.registration.state['phase'])
  const stopRegistration = app.onRegistration(() => {
    if (ended) return
    draw()
    const phase = String(app.registration.state['phase'])
    if (phase !== lastPhase && (phase === 'done' || phase === 'stopped') && app.registration.state['label'] === parts.label) parts.onFinished()
    lastPhase = phase
  })

  const lookupFailed = { ok: /** @type {const} */ (false), words: `${TIP.name} could not be looked up right now, so no tip will be sent.` }
  void app.lookupTip().then((found) => { tipLookup = found }, () => { tipLookup = lookupFailed }).then(() => { if (!ended && !busy) draw() })
  void app.feePerGas().then((price) => { priceWei = price }).then(() => { if (!ended && !busy) draw() })
  draw()

  return {
    /** @param {NameView} name the same name read again */
    update (name) { current = name; if (!ended && !busy) draw() },
    destroy () { ended = true; stopSession(); stopRegistration(); host.hidden = true; host.replaceChildren() }
  }
}
