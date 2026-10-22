// Element building with no innerHTML anywhere: every string a wiki or a service
// supplies reaches the page as text, never as markup.

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * `h('button', { class: 'x', onclick }, 'text', child)`. Attributes named `on…`
 * are listeners; `false`, `null` and `undefined` attributes and children are skipped.
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h (tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  setAttributes(el, attrs)
  append(el, children)
  return el
}

/** @param {Element} el @param {Record<string, any>} attrs */
function setAttributes (el, attrs) {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue
    if (name.startsWith('on') && typeof value === 'function') el.addEventListener(name.slice(2), value)
    else if (name === 'dataset') Object.assign(/** @type {HTMLElement} */ (el).dataset, value)
    else el.setAttribute(name, value === true ? '' : String(value))
  }
}

/** @param {Element} el @param {any[]} children */
export function append (el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === false || child === null || child === undefined) continue
    el.append(child instanceof Node ? child : String(child))
  }
  return el
}

/** @param {Element} el @param {...any} children */
export function replace (el, ...children) {
  el.replaceChildren()
  return append(el, children)
}

/** Paths are 24-unit icons drawn here; `d` may hold several subpaths. */
const ICONS = {
  pen: 'M15.2 4.3l4.5 4.5L8.6 19.9 3.5 21l1.1-5.1L15.2 4.3zm1.4-1.4l1.6-1.6a1.6 1.6 0 012.3 0l2.2 2.2a1.6 1.6 0 010 2.3l-1.6 1.6-4.5-4.5z',
  plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z',
  upload: 'M12 3l5 5-1.4 1.4L13 6.8V16h-2V6.8L8.4 9.4 7 8l5-5zM4 18h16v2H4z',
  download: 'M11 4h2v9.2l2.6-2.6L17 12l-5 5-5-5 1.4-1.4 2.6 2.6V4zM4 18h16v2H4z',
  cloud: 'M7 19a5 5 0 01-.6-10A6.5 6.5 0 0119 9.5 4.8 4.8 0 0118.5 19H7zm5-11.2l-3.5 3.5 1.4 1.4 1.1-1.1V16h2v-4.4l1.1 1.1 1.4-1.4L12 7.8z',
  back: 'M10.6 5.4L12 6.8 7.8 11H20v2H7.8l4.2 4.2-1.4 1.4L4 12z',
  more: 'M5 10a2 2 0 110 4 2 2 0 010-4zm7 0a2 2 0 110 4 2 2 0 010-4zm7 0a2 2 0 110 4 2 2 0 010-4z',
  copy: 'M8 3h10a2 2 0 012 2v12h-2V5H8V3zM4 7h10a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V9a2 2 0 012-2zm0 2v10h10V9H4z',
  open: 'M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3zM5 5h6v2H5v12h12v-6h2v6a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z',
  check: 'M9.5 16.2L5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z',
  alert: 'M12 2L1 21h22L12 2zm-1 7h2v6h-2V9zm0 8h2v2h-2v-2z',
  trash: 'M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 11a2 2 0 01-2 2H9a2 2 0 01-2-2L6 9z',
  settings: 'M19.4 13a7.5 7.5 0 000-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 00-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 00-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 000 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 001.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 001.7-1l2.5 1 2-3.5-2.2-1.6zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z',
  history: 'M13 3a9 9 0 00-9 9H1l4 4 4-4H6a7 7 0 112.1 5l-1.4 1.4A9 9 0 1013 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8H12z',
  file: 'M6 2h8l6 6v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2zm7 1.5V9h5.5L13 3.5z',
  link: 'M10.6 13.4a1 1 0 001.4 1.4l4.9-4.9a3 3 0 00-4.2-4.2l-2.1 2.1 1.4 1.4 2.1-2.1a1 1 0 011.4 1.4l-4.9 4.9zm2.8-2.8a1 1 0 00-1.4-1.4l-4.9 4.9a3 3 0 004.2 4.2l2.1-2.1-1.4-1.4-2.1 2.1a1 1 0 01-1.4-1.4l4.9-4.9z',
  close: 'M6.4 5L12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z'
}

/** @param {keyof typeof ICONS} name @param {string} [cls] */
export function icon (name, cls = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', cls)
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', ICONS[name])
  svg.append(path)
  return svg
}

/** The DecentraWiki mark: a page with a pen across it, on the accent colour. */
export function logo (cls = 'logo') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('class', cls)
  svg.setAttribute('aria-hidden', 'true')
  const parts = [
    ['rect', { x: '1', y: '1', width: '30', height: '30', rx: '8', class: 'logo-plate' }],
    ['path', { d: 'M9 7h9l5 5v13a1 1 0 01-1 1H9a1 1 0 01-1-1V8a1 1 0 011-1z', class: 'logo-page' }],
    ['path', { d: 'M18 7v5h5', class: 'logo-fold' }],
    ['path', { d: 'M12 21.5l.6-2.8 6.6-6.6 2.2 2.2-6.6 6.6-2.8.6z', class: 'logo-pen' }]
  ]
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    svg.append(el)
  }
  return svg
}
