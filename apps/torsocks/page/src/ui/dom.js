const SVG_NS = 'http://www.w3.org/2000/svg'

function applyProps (el, props) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (key === 'value' || key === 'checked') {
      el[key] = value
    } else if (key === 'text') {
      el.textContent = value
    } else if (value === true) {
      el.setAttribute(key, '')
    } else {
      el.setAttribute(key, String(value))
    }
  }
}

function appendAll (el, children) {
  for (const child of children) {
    if (child == null || child === false) continue
    if (Array.isArray(child)) appendAll(el, child)
    else if (child instanceof Node) el.append(child)
    else el.append(document.createTextNode(String(child)))
  }
}

/** Strings become text nodes, never markup. */
export function h (tag, props, ...children) {
  const el = document.createElement(tag)
  applyProps(el, props)
  appendAll(el, children)
  return el
}

export function s (tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag)
  applyProps(el, props)
  appendAll(el, children)
  return el
}

// Updates touch the DOM only when something changed, so a screen reader is not
// re-announcing a live region that says the same thing.
export function setText (node, text) {
  if (node.textContent !== text) node.textContent = text
}

export function setAttr (node, name, value) {
  if (value == null || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name)
    return
  }
  const text = value === true ? '' : String(value)
  if (node.getAttribute(name) !== text) node.setAttribute(name, text)
}

export function setTone (node, prefix, tone) {
  const next = tone ? `${prefix}-${tone}` : ''
  const previous = node.dataset.tone || ''
  if (previous === next) return
  if (previous) node.classList.remove(previous)
  if (next) node.classList.add(next)
  node.dataset.tone = next
}

export function prefersReducedMotion () {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function scrollToNode (node) {
  node.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' })
}

/** Resolves true when the text reached the clipboard. */
export async function copyText (text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Falls through to the selection route below.
  }
  const area = h('textarea', { value: text, readonly: true, 'aria-hidden': 'true', class: 'sr-only' })
  document.body.append(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

/** A button that copies `getText()` and says so for a moment. */
export function copyButton (label, getText, announce) {
  const button = h('button', { type: 'button', class: 'btn btn-ghost btn-small' }, label)
  let timer = 0
  button.addEventListener('click', async () => {
    const text = getText()
    if (!text) return
    const ok = await copyText(text)
    button.textContent = ok ? 'Copied' : 'Copy failed'
    if (announce) announce(ok ? 'Copied to the clipboard.' : 'Could not copy. Select the text and copy it by hand.')
    clearTimeout(timer)
    timer = setTimeout(() => {
      button.textContent = label
      if (announce) announce('')
    }, 1800)
  })
  return button
}
