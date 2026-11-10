// Small pieces more than one view draws: buttons, notices, the address and hash spellings and the Web2 mark.

import { el } from './dom.js'
import { icon, spinner } from './icons.js'
import { RELAY_WORDS } from './relay.js'
import { shortAddress } from './words.js'

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

/** The Web2 mark, drawn as Orivon draws its own beside a site's level: a pill, a dot and the word. */
export const web2Mark = () => el('span', { class: 'web2-mark', 'data-mark': RELAY_WORDS.mark, text: RELAY_WORDS.mark })

/** A transaction hash or any long hexadecimal value, whole, wrapping at the edge. @param {string} value */
export const hexCode = (value) => el('code', { class: 'hex', text: value })

/**
 * An address in full, selectable. Where the page is short of room it may use `addressChip` instead.
 * @param {string} address
 */
export const addressCode = (address) => el('code', { class: 'hex address', text: address })

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

/** A button that copies `text`, and says so for a moment. @param {string} text @param {string} label what the button is for, for a screen reader */
export function copyButton (text, label) {
  const trigger = el('button', { class: 'link-button', type: 'button', 'aria-label': label }, 'Copy')
  trigger.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text)
      trigger.textContent = 'Copied'
    } catch {
      trigger.textContent = 'Select and copy'
    }
    setTimeout(() => { trigger.textContent = 'Copy' }, 2000)
  })
  return trigger
}

/** A line that turns while it waits. @param {string} words */
export function working (words) {
  return el('p', { class: 'working', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', { text: words }))
}

const GROUP_TITLES = Object.freeze({ wait: 'While the commitment matures, about a minute' })

/** @param {{ state: string }} step @param {number} index */
function stepMark (step, index) {
  if (step.state === 'done') return icon('check', { size: 16 })
  if (step.state === 'failed') return icon('x', { size: 16 })
  if (step.state === 'active') return spinner()
  return el('span', { text: String(index + 1) })
}

/**
 * The transactions of a flow as a numbered list, each with what it is for, where it stands and its hash once it has one.
 * @param {{ title: string, detail: string, group: string, state: string, hash: string | null }[]} steps
 */
export function stepList (steps) {
  if (steps.length === 0) return null
  /** @type {import('./dom.js').Child[]} */
  const items = []
  let group = ''
  steps.forEach((step, index) => {
    if (step.group !== group) {
      group = step.group
      const title = /** @type {Record<string, string>} */ (GROUP_TITLES)[group]
      if (title !== undefined) items.push(el('li', { class: 'step-group', 'aria-hidden': 'true', text: title }))
    }
    items.push(el('li', { class: `step ${step.group}`, 'data-state': step.state },
      el('span', { class: 'step-mark', 'aria-hidden': 'true' }, stepMark(step, index)),
      el('div', { class: 'step-text' },
        el('p', { class: 'step-title' }, step.title, el('span', { class: 'visually-hidden', text: ` (${step.state})` })),
        el('p', { class: 'step-detail', text: step.detail }),
        step.hash === null ? null : el('p', { class: 'step-hash' }, el('span', { text: 'Transaction ' }), hexCode(step.hash)))))
  })
  return el('ol', { class: 'steps' }, items)
}
