// Modal dialogs on the native <dialog> element (focus, Escape and the
// backdrop come with it), and the short notices at the bottom of the page.

import { h, icon, replace } from '../dom.js'

/**
 * @typedef {{ label: string, kind?: 'primary' | 'secondary' | 'danger' | 'ghost', onClick?: () => unknown, autofocus?: boolean, disabled?: boolean }} Action
 * @typedef {{ el: HTMLDialogElement, close: () => void, setBody: (...nodes: any[]) => void, setActions: (actions: Action[]) => void, setBusy: (busy: boolean) => void }} DialogHandle
 */

/**
 * @param {{ title: string, body?: any[], actions?: Action[], wide?: boolean, dismissable?: boolean, onClose?: () => void }} options
 * @returns {DialogHandle}
 */
export function openDialog ({ title, body = [], actions = [], wide = false, dismissable = true, onClose }) {
  const bodyEl = h('div', { class: 'dialog-body' })
  const footer = h('footer', { class: 'dialog-actions' })
  const closeButton = h('button', { class: 'icon-button dialog-close', type: 'button', 'aria-label': 'Close', onclick: () => handle.close() }, icon('close'))
  const el = /** @type {HTMLDialogElement} */ (h('dialog', { class: wide ? 'dialog dialog-wide' : 'dialog', 'aria-labelledby': 'dialog-title' },
    h('header', { class: 'dialog-header' }, h('h2', { id: 'dialog-title' }, title), dismissable ? closeButton : null),
    bodyEl,
    footer))
  let busy = false
  let closed = false
  el.addEventListener('cancel', (event) => {
    if (!dismissable || busy) event.preventDefault()
  })
  el.addEventListener('close', () => {
    if (closed) return
    closed = true
    el.remove()
    onClose?.()
  })
  el.addEventListener('click', (event) => {
    if (event.target === el && dismissable && !busy) handle.close()
  })

  /** @param {Action[]} list */
  function renderActions (list) {
    replace(footer, list.map((action) => h('button', {
      type: 'button',
      class: `button button-${action.kind ?? 'secondary'}`,
      autofocus: action.autofocus,
      disabled: action.disabled || busy,
      onclick: () => { void action.onClick?.() }
    }, action.label)))
  }

  /** @type {DialogHandle} */
  const handle = {
    el,
    close () {
      if (!closed) el.close()
    },
    setBody (...nodes) {
      replace(bodyEl, ...nodes)
    },
    setActions (list) {
      actions = list
      renderActions(list)
    },
    setBusy (value) {
      busy = value
      closeButton.toggleAttribute('disabled', value)
      renderActions(actions)
    }
  }
  handle.setBody(...body)
  renderActions(actions)
  document.body.append(el)
  el.showModal()
  // The first field, else the action marked for it; never the close button, which only Escape and a click need.
  const first = /** @type {HTMLElement | null} */ (bodyEl.querySelector('input:not([type=hidden]):not(.hidden), textarea, select') ?? footer.querySelector('[autofocus]'))
  first?.focus()
  return handle
}

/** @param {{ title: string, message: string, confirm: string, danger?: boolean }} options @returns {Promise<boolean>} */
export function confirmDialog ({ title, message, confirm, danger = false }) {
  return new Promise((resolve) => {
    let answered = false
    const dialog = openDialog({
      title,
      body: [h('p', {}, message)],
      onClose: () => { if (!answered) resolve(false) },
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() },
        { label: confirm, kind: danger ? 'danger' : 'primary', autofocus: true, onClick: () => { answered = true; resolve(true); dialog.close() } }
      ]
    })
  })
}

/** @param {string} message @param {{ kind?: 'info' | 'success' | 'error', timeout?: number }} [options] */
export function toast (message, { kind = 'info', timeout = 4000 } = {}) {
  let host = document.getElementById('toasts')
  if (host === null) {
    host = h('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' })
    document.body.append(host)
  }
  const item = h('div', { class: `toast toast-${kind}` }, icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'pen'), h('span', {}, message))
  host.append(item)
  setTimeout(() => {
    item.classList.add('toast-leaving')
    setTimeout(() => item.remove(), 300)
  }, timeout)
}

/** Copies text and says so. @param {string} text @param {string} what */
export async function copyText (text, what) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${what} copied`, { kind: 'success', timeout: 2500 })
  } catch {
    toast(`This browser did not allow copying. Select the ${what.toLowerCase()} and copy it by hand.`, { kind: 'error' })
  }
}

/** Saves bytes or text as a file in the person's downloads. @param {BlobPart | Uint8Array} data @param {string} name @param {string} type */
export function downloadFile (data, name, type) {
  const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (data)], { type }))
  const link = h('a', { href: url, download: name, class: 'hidden' })
  document.body.append(link)
  link.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
    link.remove()
  }, 1000)
}
