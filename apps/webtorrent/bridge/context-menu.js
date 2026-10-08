// The menu `remote.Menu#popup` shows: drawn in the page at the pointer, since
// the native one belongs to main. Items are Electron's MenuItem options that
// upstream uses: `label`, `click`, `enabled` and `type: 'separator'`.

const STYLE = `
.orivon-menu { position: fixed; z-index: 2147483647; min-width: 200px; padding: 4px 0; margin: 0;
  background: #2e2e2e; color: #eee; border: 1px solid #444; border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0,0,0,.5); font: 13px system-ui, sans-serif; list-style: none; }
.orivon-menu li { padding: 6px 16px; cursor: default; white-space: nowrap; }
.orivon-menu li:hover:not(.disabled):not(.separator) { background: #4a90d9; color: #fff; }
.orivon-menu li.disabled { color: #777; }
.orivon-menu li.separator { padding: 0; margin: 4px 0; border-top: 1px solid #444; }
`

let open = null
let unlisten = () => {}

function close () {
  open?.remove()
  open = null
  unlisten()
  unlisten = () => {}
}

/** Shows `items` at the pointer of the contextmenu event being handled, or at (x, y). */
export function popupMenu (items, { x, y } = {}) {
  close()
  const event = globalThis.event
  if (event?.type === 'contextmenu') event.preventDefault()
  if (document.getElementById('orivon-menu-style') === null) {
    const style = document.createElement('style')
    style.id = 'orivon-menu-style'
    style.textContent = STYLE
    document.head.append(style)
  }
  const list = document.createElement('ul')
  list.className = 'orivon-menu'
  list.setAttribute('role', 'menu')
  for (const item of items) {
    const row = document.createElement('li')
    if (item.type === 'separator') {
      row.className = 'separator'
      row.setAttribute('role', 'separator')
    } else {
      row.textContent = item.label ?? ''
      row.setAttribute('role', 'menuitem')
      if (item.enabled === false) row.className = 'disabled'
      else row.addEventListener('click', () => { close(); item.click?.(item) })
    }
    list.append(row)
  }
  document.body.append(list)
  const left = x ?? event?.clientX ?? 0
  const top = y ?? event?.clientY ?? 0
  list.style.left = `${Math.min(left, innerWidth - list.offsetWidth - 4)}px`
  list.style.top = `${Math.min(top, innerHeight - list.offsetHeight - 4)}px`
  open = list
  // The press that opened the menu is still dispatching; listen from the next turn.
  const onPress = (e) => { if (!list.contains(e.target)) close() }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  const timer = setTimeout(() => {
    addEventListener('mousedown', onPress, true)
    addEventListener('keydown', onKey, true)
    addEventListener('blur', close)
  }, 0)
  unlisten = () => {
    clearTimeout(timer)
    removeEventListener('mousedown', onPress, true)
    removeEventListener('keydown', onKey, true)
    removeEventListener('blur', close)
  }
}
