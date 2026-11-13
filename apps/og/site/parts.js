// Small pieces more than one view draws: buttons, notices, the address and hash spellings and the relay's mark.

import { el } from './dom.js'
import { icon, spinner } from './icons.js'
import { RELAY, RELAY_WORDS } from './relay.js'
import { formatEth, shortAddress } from './words.js'

/**
 * @param {string} label
 * @param {{ primary?: boolean, quiet?: boolean, danger?: boolean, type?: string, disabled?: boolean, onClick?: (event: Event) => void, id?: string, describedBy?: string }} [options]
 */
export function button (label, options = {}) {
  const classes = ['button', options.primary ? 'primary' : '', options.quiet ? 'quiet' : '', options.danger ? 'danger' : ''].filter(Boolean).join(' ')
  return el('button', {
    class: classes, type: options.type ?? 'button', disabled: options.disabled === true, id: options.id, 'aria-describedby': options.describedBy,
    on: options.onClick === undefined ? undefined : { click: options.onClick }
  }, label)
}

/**
 * A boxed message. `alert` is for a failure the person has to notice at once.
 * @param {'info' | 'ok' | 'warn' | 'bad'} tone
 * @param {string | null} title
 * @param {...import('./dom.js').Child} children
 */
export function notice (tone, title, ...children) {
  const name = tone === 'ok' ? 'check' : tone === 'info' ? 'info' : 'alert'
  return el('div', { class: `notice ${tone}`, role: tone === 'bad' ? 'alert' : undefined },
    icon(name, { size: 20 }),
    el('div', { class: 'notice-body' }, title === null ? null : el('p', { class: 'notice-title', text: title }), children))
}

/** What every page says when there is no wallet and no Orivon to read Ethereum through. */
export const noWalletNotice = () => notice('warn', 'No wallet found', el('p', { text: 'Open this page in Orivon, or in a browser with an Ethereum wallet extension.' }))

/**
 * A page that needs the connected account says so, with the button that asks the wallet for it.
 * @param {{ asking: boolean, connect: () => void }} parts
 * @param {string} title
 * @param {string} words
 */
export function connectNotice (parts, title, words) {
  return notice('info', title, el('p', { text: words }),
    el('div', { class: 'actions' }, button(parts.asking ? 'Waiting for your wallet…' : 'Connect your wallet', { primary: true, disabled: parts.asking, onClick: parts.connect })))
}

/** A failure the person can answer by trying again. @param {string} title @param {string} words @param {() => void} again */
export function retryNotice (title, words, again) {
  return notice('warn', title, el('p', { text: words }), el('div', { class: 'actions' }, button('Try again', { quiet: true, onClick: again })))
}

/**
 * The relay's mark, drawn by the browser: Orivon puts its own Web3 mark where this element stands, for the server the private send
 * posts to, and the page sets nothing about how it looks. The element holds a `trust.score` grant, and a page without one gets the
 * neutral mark, so the plain word beside it carries the meaning. A press on the mark opens its card, so it must not also flip the switch
 * it sits in.
 */
export function relayMark () {
  const mark = el('orivon-mark', { of: RELAY.url, size: 's', on: { click: (event) => event.preventDefault() } })
  return el('span', { class: 'relay-kind' }, el('span', { text: RELAY_WORDS.kind }), mark)
}

/** A transaction hash or any long hexadecimal value, whole, wrapping at the edge. @param {string} value */
export const hexCode = (value) => el('code', { class: 'hex', text: value })

/** The short spelling with a button that swaps it for the whole address. @param {string} address */
export function addressChip (address) {
  const text = el('code', { class: 'hex', text: shortAddress(address) })
  const toggle = el('button', { class: 'link-button', type: 'button', 'aria-expanded': 'false' }, 'Show full')
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true'
    toggle.setAttribute('aria-expanded', String(open))
    toggle.textContent = open ? 'Show short' : 'Show full'
    text.textContent = open ? address : shortAddress(address)
  })
  return el('span', { class: 'address-chip' }, text, toggle)
}

/** A line that turns while it waits. @param {string} words */
export function working (words) {
  return el('p', { class: 'working', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', { text: words }))
}

/** @param {{ state: string }} step @param {number} index */
function stepMark (step, index) {
  if (step.state === 'done') return icon('check', { size: 16 })
  if (step.state === 'failed') return icon('x', { size: 16 })
  if (step.state === 'dropped') return icon('x', { size: 16 })
  if (step.state === 'active') return spinner()
  return el('span', { text: String(index + 1) })
}

const STATE_WORDS = Object.freeze({ pending: 'waiting', active: 'in progress', done: 'done', failed: 'failed', dropped: 'not sent' })

/** What a step is for, folded behind a button: the contract and function stay on show, the sentence about them waits to be asked for. @param {string} words */
function explain (words) {
  if (words === '') return null
  return el('details', { class: 'step-more' },
    el('summary', { 'aria-label': 'What this step does' }, icon('info', { size: 16 })),
    el('p', { class: 'step-detail', text: words }))
}

/**
 * The transactions of a registration as a numbered list: what each is for, the contract and function it calls, where it stands and its hash once it has one.
 * @param {{ title: string, contract: string, call: string, detail: string, state: string, sub?: string, hash: string | null, gasUsed?: number | null }[]} steps
 */
export function stepList (steps) {
  if (steps.length === 0) return null
  return el('ol', { class: 'steps' }, steps.map((step, index) =>
    el('li', { class: 'step', 'data-state': step.state },
      el('span', { class: 'step-mark', 'aria-hidden': 'true' }, stepMark(step, index)),
      el('div', { class: 'step-text' },
        el('p', { class: 'step-title' }, step.title, el('span', { class: 'visually-hidden', text: ` (${STATE_WORDS[/** @type {keyof typeof STATE_WORDS} */ (step.state)] ?? step.state})` })),
        el('p', { class: 'step-call' }, el('span', { text: `${step.contract}: ` }), el('code', { text: step.call })),
        step.sub === undefined || step.sub === '' ? null : el('p', { class: 'step-live', text: step.sub }),
        step.hash === null ? null : el('p', { class: 'step-hash' }, el('span', { text: 'Transaction ' }), hexCode(step.hash)),
        explain(step.detail)))))
}

/**
 * What the steps cost, line by line: the gas, the fee at today's price when the node has given one, and the tip that comes on top.
 * @param {{ gas: string, ether: string | null, tipWei: bigint }} cost
 */
export function costRows (cost) {
  const row = (/** @type {string} */ name, /** @type {string} */ value) => el('div', {}, el('dt', { text: name }), el('dd', { text: value }))
  return el('dl', { class: 'cost' },
    row('Steps', cost.gas),
    cost.ether === null ? null : row('Fee today', `about ${cost.ether}`),
    cost.tipWei > 0n ? row('Tip', `${formatEth(cost.tipWei)}, on top`) : null)
}

/**
 * How far a series has come, as a bar and as words.
 * @param {{ state: string }[]} steps
 */
export function progressLine (steps) {
  if (steps.length === 0) return null
  const done = steps.filter((step) => step.state === 'done').length
  return el('div', { class: 'progress-line' },
    el('progress', { max: steps.length, value: done, 'aria-label': 'Steps done' }), el('span', { text: `${done} of ${steps.length} done` }))
}
