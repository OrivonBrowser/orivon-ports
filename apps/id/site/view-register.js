// The registration panel: it draws whichever state the flow is in (register-model.js decides what that means) and
// turns the buttons into calls on the flow. It owns no registration logic of its own.

import { storedAccount } from './app.js'
import { el, fill, setText } from './dom.js'
import { icon, spinner } from './icons.js'
import { button, hexCode, notice, stepList, web2Mark } from './parts.js'
import { panelView } from './register-model.js'
import { RELAY_WORDS } from './relay.js'

/** @typedef {import('./app.js').App} App */
/** @typedef {import('./register-model.js').PanelView} PanelView */
/** @typedef {{ label: () => string, edit: () => void, reset: () => void, next: { hash: string, origin: string } | null }} Hooks */

/** @param {boolean} waits whether an approval or a resolver is part of the plan */
const readyHint = (waits) => waits
  ? 'Your wallet asks you to sign each transaction. The minute of waiting is not idle: the DAI approval and your resolver are sent while it runs.'
  : 'Your wallet asks you to sign each transaction. After the commit there is a wait of about a minute.'

/**
 * @param {HTMLElement} host
 * @param {App} app
 * @param {Hooks} hooks
 */
export function mountPanel (host, app, hooks) {
  let privateOn = false
  let switchNote = ''
  let confirming = false
  let planOpen = false
  let problem = ''
  /** @type {ReturnType<typeof setInterval> | null} */
  let ticker = null
  /** @type {{ bar: HTMLProgressElement, text: HTMLElement, caption: HTMLElement } | null} */
  let clock = null

  const heading = el('h2', { id: 'panel-heading' })
  const status = el('p', { class: 'panel-status', role: 'status', 'aria-live': 'polite' })
  const body = el('div', { class: 'panel-body' })
  const foot = el('div', { class: 'panel-foot' })
  const section = el('section', { class: 'panel', 'aria-labelledby': 'panel-heading' }, heading, status, body, foot)
  host.append(section)

  const context = () => ({ plan: app.registration.plan, timing: app.registration.timing, hashes: app.registration.hashes, name: app.registration.name, nowMs: Date.now() })

  /** @param {PanelView} view */
  function timerBlock (view) {
    if (view.timer === null) { clock = null; return null }
    const bar = /** @type {HTMLProgressElement} */ (el('progress', { max: view.timer.total, value: view.timer.total - view.timer.remaining, 'aria-label': 'Commitment maturity' }))
    const text = el('span', { class: 'timer-text', text: view.timer.text })
    const caption = el('span', { class: 'timer-caption' })
    clock = { bar, text, caption }
    tick()
    return el('div', { class: 'timer', role: 'timer', 'aria-live': 'off' },
      el('div', { class: 'timer-row' }, icon('clock', { size: 18 }), text, caption), bar,
      el('p', {
        class: 'hint',
        text: 'The wait is counted in block time, as the chain counts it, not by your clock. ' +
          'The registration is sent at the first block that shows the commitment is a minute old.'
      }))
  }

  function tick () {
    const timer = clock === null ? null : panelView(app.registration.state, context()).timer
    if (clock === null || timer === null) return
    clock.bar.value = timer.total - timer.remaining
    setText(clock.text, timer.text)
    setText(clock.caption, timer.done ? 'Waiting for the next block' : 'left')
  }

  /** @param {boolean} advised */
  function privateChoice (advised) {
    const box = el('input', { type: 'checkbox', role: 'switch', id: 'private-switch', 'aria-describedby': 'private-why' })
    const input = /** @type {HTMLInputElement} */ (box)
    input.checked = privateOn
    const note = el('p', { class: 'hint', id: 'private-note', role: 'status', 'aria-live': 'polite', text: switchNote })
    input.addEventListener('change', async () => {
      if (!input.checked) { privateOn = false; switchNote = ''; setText(note, ''); return }
      input.disabled = true
      setText(note, RELAY_WORDS.asking)
      const allowed = await app.relay.allow()
      privateOn = allowed
      input.checked = allowed
      input.disabled = false
      switchNote = allowed ? '' : RELAY_WORDS.notAllowed
      setText(note, switchNote)
    })
    return el('div', { class: 'private' },
      el('label', { class: 'switch', for: 'private-switch' },
        box, el('span', { class: 'track', 'aria-hidden': 'true' }), el('span', { class: 'switch-text', text: RELAY_WORDS.switchLabel }), web2Mark()),
      el('p', { class: 'hint', id: 'private-why', text: RELAY_WORDS.explanation }),
      advised ? el('p', { class: 'advice' }, icon('info', { size: 16 }), el('span', { text: `${RELAY_WORDS.advice} A short name is the one a sniper hunts.` })) : null,
      note)
  }

  /**
   * The transactions to come, folded to one line while the person decides, so the button that starts them is in sight: the
   * line names each one, and opening it gives the full list with what each is for.
   * @param {PanelView['steps']} steps
   */
  function planSummary (steps) {
    const list = stepList(steps)
    if (list === null) return null
    const details = el('details', { class: 'plan' },
      el('summary', {},
        el('span', { class: 'plan-title', text: `${steps.length} transactions` }),
        el('span', { class: 'plan-names', text: steps.map((step) => step.title).join(', ') }),
        el('span', { class: 'plan-open', text: 'What each one does' })),
      list)
    details.open = planOpen
    details.addEventListener('toggle', () => { planOpen = details.open })
    return details
  }

  /** @param {PanelView} view */
  function failureBlock (view) {
    const failure = view.failure
    if (failure === null) return null
    return notice('bad', failure.words,
      failure.note === null ? null : el('p', { text: failure.note }),
      failure.hashNote === null ? null : el('p', { text: failure.hashNote }),
      failure.hash === null ? null : el('p', { class: 'step-hash' }, el('span', { text: 'Transaction ' }), hexCode(failure.hash)),
      failure.detail === '' ? null : el('details', { class: 'detail' }, el('summary', { text: 'Technical detail' }), el('pre', { text: failure.detail })))
  }

  /** @param {string} id */
  async function act (id) {
    const { flow } = app
    problem = ''
    try {
      if (flow === null) return
      if (id === 'register') await flow.start({ private: privateOn })
      else if (id === 'check') await flow.check(hooks.label())
      else if (id === 'retry') await flow.retry()
      else if (id === 'public') await flow.retry({ private: false })
      else if (id === 'private') await flow.retry({ private: true })
      else if (id === 'continue') await flow.resume(storedAccount(app.storage) ?? undefined)
      else if (id === 'forget') await forget(flow)
      else if (id === 'connect') await app.connect()
      else if (id === 'edit') { app.resetRegistration(); hooks.edit() }
      else if (id === 'another') { app.resetRegistration(); hooks.reset() }
      else if (id === 'mine') app.go('#/me')
      else if (id === 'signin' && hooks.next !== null) app.go(hooks.next.hash)
    } catch (error) {
      problem = error instanceof Error ? error.message : 'Something went wrong.'
      render()
    }
  }

  /** @param {NonNullable<App['flow']>} flow */
  async function forget (flow) {
    if (!confirming) { confirming = true; render(); return }
    confirming = false
    await flow.forget()
    app.resetRegistration()
  }

  /** @param {PanelView} view */
  function actionRow (view) {
    const done = view.phase === 'done' && hooks.next !== null
    const actions = done
      ? [{ id: /** @type {const} */ ('signin'), label: `Continue to sign in to ${hooks.next?.origin}`, primary: true }, ...view.actions.map((one) => ({ ...one, primary: false }))]
      : view.actions
    if (actions.length === 0) return null
    return el('div', { class: 'actions' },
      actions.map((action) => action.id === 'forget' && confirming
        ? button('Yes, forget it', { danger: true, onClick: () => act('forget') })
        : button(action.label, { primary: action.primary === true, quiet: action.primary !== true, onClick: () => act(action.id) })),
      confirming
        ? el('p', {
          class: 'hint',
          text: 'Forgetting is safe until the name has been registered: only the gas of the commit is lost. ' +
            'If the name was already registered it is yours, and you can set its records from My IDs.'
        })
        : null)
  }

  function render () {
    const state = app.registration.state
    if (state['phase'] === 'idle') {
      host.hidden = true
      if (ticker !== null) { clearInterval(ticker); ticker = null }
      return
    }
    host.hidden = false
    const view = panelView(state, context())
    section.dataset['tone'] = view.tone
    setText(heading, view.heading)
    setText(status, view.status)
    const summary = view.summary === null
      ? null
      : el('dl', { class: 'facts' },
        el('div', {}, el('dt', { text: 'Price' }), el('dd', { text: view.summary.price })),
        el('div', {}, el('dt', { text: 'Your DAI' }), el('dd', { text: view.summary.balance })),
        el('div', {}, el('dt', { text: 'Transactions' }), el('dd', { text: String(view.summary.transactions) })))
    const waits = view.phase === 'ready' && view.steps.some((step) => step.group === 'wait')
    fill(body,
      view.busy ? el('p', { class: 'working-line', 'aria-hidden': 'true' }, spinner(), el('span', { text: 'Working' })) : null,
      summary,
      view.phase === 'ready' ? el('p', { class: 'hint', text: readyHint(waits) }) : null,
      view.phase === 'ready' ? planSummary(view.steps) : stepList(view.steps),
      timerBlock(view), failureBlock(view),
      view.privateChoice === null ? null : privateChoice(view.privateChoice.advised),
      problem === '' ? null : notice('bad', problem))
    fill(foot, actionRow(view))
    if (clock !== null && ticker === null) ticker = setInterval(tick, 1000)
    if (clock === null && ticker !== null) { clearInterval(ticker); ticker = null }
  }

  const stop = app.onRegistration(render)
  render()
  return {
    destroy () {
      stop()
      if (ticker !== null) clearInterval(ticker)
    }
  }
}
