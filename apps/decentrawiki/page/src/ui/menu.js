// A small pop-up menu anchored to the button that opened it.

import { h, icon } from '../dom.js'

/** @typedef {{ label: string, icon?: Parameters<typeof icon>[0], danger?: boolean, onSelect: () => unknown }} MenuItem */

/** @type {(() => void) | null} */
let closeOpen = null

/** @param {HTMLElement} anchor @param {MenuItem[]} items */
export function openMenu (anchor, items) {
  closeOpen?.()
  const menu = h('div', { class: 'menu', role: 'menu' }, items.map((item) => h('button', {
    type: 'button',
    role: 'menuitem',
    class: item.danger ? 'menu-item menu-item-danger' : 'menu-item',
    onclick: () => {
      close()
      void item.onSelect()
    }
  }, item.icon ? icon(item.icon) : null, h('span', {}, item.label))))
  document.body.append(menu)
  const box = anchor.getBoundingClientRect()
  const width = menu.offsetWidth
  menu.style.top = `${Math.round(box.bottom + window.scrollY + 6)}px`
  menu.style.left = `${Math.round(Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8)) + window.scrollX)}px`
  anchor.setAttribute('aria-expanded', 'true')
  /** @type {HTMLElement | null} */ (menu.querySelector('.menu-item'))?.focus()

  /** @param {Event} event */
  const outside = (event) => {
    if (!menu.contains(/** @type {Node} */ (event.target)) && event.target !== anchor && !anchor.contains(/** @type {Node} */ (event.target))) close()
  }
  /** @param {KeyboardEvent} event */
  const keys = (event) => {
    if (event.key === 'Escape') {
      close()
      anchor.focus()
    }
  }
  function close () {
    menu.remove()
    anchor.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('keydown', keys, true)
    window.removeEventListener('resize', close)
    if (closeOpen === close) closeOpen = null
  }
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', keys, true)
  window.addEventListener('resize', close)
  closeOpen = close
}
