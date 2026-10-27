// A read-only value in a monospace box with a Copy button that says "Copied".

import { h, icon } from '../dom.js'
import { copyToClipboard, toast } from './dialog.js'

/** @param {{ value: string, label: string, secret?: boolean }} options */
export function copyField ({ value, label, secret = false }) {
  const text = h('span', { class: secret ? 'copy-value copy-value-secret' : 'copy-value' }, value)
  const button = h('button', { type: 'button', class: 'button button-secondary button-small', 'aria-label': `Copy ${label}` }, icon('copy'), h('span', {}, 'Copy'))
  let timer = 0
  button.addEventListener('click', async () => {
    const copied = await copyToClipboard(value)
    if (!copied) {
      toast(`This browser did not allow copying. Select the ${label} and copy it by hand.`, { kind: 'error', timeout: 7000 })
      return
    }
    button.replaceChildren(icon('check'), h('span', {}, 'Copied'))
    clearTimeout(timer)
    timer = window.setTimeout(() => button.replaceChildren(icon('copy'), h('span', {}, 'Copy')), 2200)
  })
  return h('div', { class: 'copy-field' }, text, button)
}
