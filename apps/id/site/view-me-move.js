// The move of one ID to its holder's own resolver, as a panel inside the ID's card: what moving ends and keeps, whether to
// copy the records, the three steps as the registration lists its own, and the buttons. It draws what move-flow.js says
// and decides nothing about the move.

import { el, fill } from './dom.js'
import { copySet, copyWords, moveWords, planMove } from './move-model.js'
import { createMove } from './move-flow.js'
import { button, hexCode, notice, stepList, working } from './parts.js'
import { sendingWords } from './register-model.js'

/** @typedef {import('./app.js').App} App */

/**
 * @param {HTMLElement} host
 * @param {App} app
 * @param {object} parts
 * @param {string} parts.label
 * @param {string} parts.address the connected address, the holder
 * @param {string[]} parts.keys the text records to read from both resolvers
 * @param {() => void} parts.close
 * @param {(done: Record<string, any>) => void} parts.finished called once, with the final state, when the holder can write the records
 */
export function mountMove (host, app, { label, address, keys, close, finished }) {
  const words = moveWords(label)
  let alive = true
  let copy = true
  let lastPhase = ''
  /** @type {Record<string, any>} */
  let state = { phase: 'checking' }
  const flow = createMove({
    chain: /** @type {NonNullable<App['chain']>} */ (app.chain), broadcaster: /** @type {NonNullable<App['broadcaster']>} */ (app.broadcaster), clock: app.clock, keys,
    onState: (next) => { state = next; if (alive) draw() }
  })

  const choice = () => ({ copy: copy && copyWords(copySet(state['facts']?.old ?? null)).available })
  const start = () => { void flow.run(label, address, choice()).then((last) => { if (alive && last['phase'] === 'done') finished(last) }) }
  const check = () => { void flow.check(label, address, { copy }).then((last) => { if (alive && last['phase'] === 'done') finished(last) }) }

  /** The checkbox, its words, and why it cannot be ticked when it cannot. */
  function copyBlock () {
    const found = copyWords(copySet(state['facts'].old))
    const id = `${label}-copy`
    const box = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id, 'aria-describedby': `${id}-why`, disabled: !found.available }))
    box.checked = copy && found.available
    box.addEventListener('change', () => { copy = box.checked; draw() })
    return el('div', { class: 'copy' },
      el('div', { class: 'pick' }, box, el('label', { for: id, text: words.copyLabel })),
      el('p', { class: 'hint', id: `${id}-why`, text: found.detail }))
  }

  /** @param {Record<string, any>} shown */
  function failure (shown) {
    const maybe = shown['reason'] === 'notMined' || shown['reason'] === 'unknownOutcome'
    return notice('bad', String(shown['words'] ?? ''),
      maybe ? el('p', { text: 'This transaction may still be mined. Check your wallet or the chain before sending another.' }) : null,
      typeof shown['hash'] === 'string' ? el('p', { class: 'step-hash' }, el('span', { text: 'Transaction ' }), hexCode(shown['hash'])) : null,
      shown['detail'] === '' ? null : el('details', { class: 'detail' }, el('summary', { text: 'Technical detail' }), el('pre', { text: String(shown['detail']) })))
  }

  function draw () {
    const phase = String(state['phase'])
    const hadFocus = host.contains(document.activeElement)
    const title = el('h4', { id: `${label}-move-title`, tabindex: '-1', text: words.title })
    const frame = (/** @type {import('./dom.js').Child[]} */ ...children) => el('div', { class: 'move', role: 'group', 'aria-labelledby': `${label}-move-title` }, title, ...children)
    const show = (/** @type {import('./dom.js').Child[]} */ ...children) => {
      fill(host, frame(...children))
      if ((hadFocus || lastPhase === '') && phase !== lastPhase) title.focus()
      lastPhase = phase
    }
    if (phase === 'checking' || phase === 'idle') return show(working('Reading the chain to see where the move stands…'))
    if (phase === 'done') return show(working('Reading the ID back…'))
    if (phase === 'refused' || state['plan'] === undefined) {
      const retry = phase === 'refused' ? state['retry'] === true : true
      return show(
        phase === 'refused' ? notice('warn', String(state['words'] ?? ''), state['detail'] === undefined ? null : el('p', { class: 'hint', text: String(state['detail']) })) : failure(state),
        el('div', { class: 'actions' }, retry ? button(words.check, { primary: true, onClick: check }) : null, button(words.close, { quiet: true, onClick: close })))
    }
    const plan = phase === 'ready' ? planMove(state['facts'], choice()) : state['plan']
    const running = phase === 'running' || phase === 'verifying'
    return show(
      el('p', { text: words.intro }),
      phase === 'ready' || phase === 'failed'
        ? notice('warn', words.warnTitle, el('ul', { class: 'bullets' }, words.warnings.map((line) => el('li', { text: line }))))
        : null,
      phase === 'ready' ? copyBlock() : null,
      stepList(plan.steps),
      running ? working(phase === 'verifying' ? 'Reading the ID back to check that you can write its records…' : `${sendingWords(state['sending'])}…`) : null,
      phase === 'ready' ? el('p', { class: 'hint', text: plan.started ? words.resumeNote : words.steps }) : null,
      phase === 'failed' ? failure(state) : null,
      phase === 'ready'
        ? el('div', { class: 'actions' }, button(plan.started ? words.resume : words.start, { primary: true, onClick: start }), button(words.cancel, { quiet: true, onClick: close }))
        : null,
      phase === 'failed'
        ? el('div', { class: 'actions' }, button(words.again, { primary: true, onClick: start }), button(words.close, { quiet: true, onClick: close }))
        : null)
  }

  draw()
  check()
  return { destroy () { alive = false } }
}
