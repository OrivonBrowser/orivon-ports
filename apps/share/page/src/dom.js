// Element building with no innerHTML anywhere: every string a share or a service
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
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue
    if (name.startsWith('on') && typeof value === 'function') el.addEventListener(name.slice(2), value)
    else el.setAttribute(name, value === true ? '' : String(value))
  }
  return append(el, children)
}

/** @param {Element} el @param {any[]} children */
export function append (el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === false || child === null || child === undefined) continue
    el.append(child instanceof Node ? child : String(child))
  }
  return /** @type {HTMLElement} */ (el)
}

/** @param {Element} el @param {...any} children */
export function replace (el, ...children) {
  el.replaceChildren()
  return append(el, children)
}

/**
 * A box for a password that is an encryption key, never a login. It is a text input drawn as dots, so no browser
 * offers to save it as a login or fills it in, and `setSecretShown` swaps the dots for the text without changing the
 * input's type. Pass `masked: false` to start with the text showing.
 * @param {Record<string, any>} [attrs]
 * @returns {HTMLInputElement}
 */
export function secretInput (attrs = {}) {
  const { masked = true, class: cls = '', ...rest } = attrs
  const input = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
    'data-lpignore': 'true', 'data-1p-ignore': 'true', 'data-form-type': 'other', ...rest, class: `${cls} secret`.trim()
  }))
  setSecretShown(input, !masked)
  return input
}

/** @param {HTMLInputElement} input @param {boolean} shown */
export function setSecretShown (input, shown) {
  input.classList.toggle('secret-masked', !shown)
}

/** 24-unit stroke icons drawn here: each is a list of `[tag, attributes]` parts. */
const ICONS = {
  upload: [['path', 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3']],
  download: [['path', 'M12 4v12M7 11l5 5 5-5M4 20h16']],
  file: [['path', 'M6 3h8l4 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1zM14 3v5h4']],
  files: [['path', 'M8 7V4a1 1 0 011-1h6l4 4v9a1 1 0 01-1 1h-3M5 7h7l3 3v10a1 1 0 01-1 1H5a1 1 0 01-1-1V8a1 1 0 011-1z']],
  folder: [['path', 'M3 7a1 1 0 011-1h5l2 2h8a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V7z']],
  globe: [['circle', 12, 12, 9], ['path', 'M3 12h18M12 3c3.2 3.2 3.2 14.8 0 18M12 3c-3.2 3.2-3.2 14.8 0 18']],
  lock: [['rect', 5, 11, 14, 9, 2], ['path', 'M8 11V8a4 4 0 018 0v3']],
  unlock: [['rect', 5, 11, 14, 9, 2], ['path', 'M8 11V8a4 4 0 017.6-1.7']],
  copy: [['rect', 9, 9, 11, 11, 2], ['path', 'M5 15V6a2 2 0 012-2h9']],
  check: [['path', 'M5 12.5l4.5 4.5L19 7.5']],
  close: [['path', 'M6 6l12 12M18 6L6 18']],
  plus: [['path', 'M12 5v14M5 12h14']],
  trash: [['path', 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5']],
  link: [['path', 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1']],
  open: [['path', 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5']],
  eye: [['path', 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z'], ['circle', 12, 12, 3]],
  eyeOff: [['path', 'M2 12s3.6-7 10-7c2 0 3.7.6 5.2 1.5M22 12s-3.6 7-10 7c-2 0-3.7-.6-5.2-1.5M4 4l16 16']],
  key: [['circle', 8, 15, 4], ['path', 'M11 12l9-9M16 7l3 3']],
  shield: [['path', 'M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3zM8.5 12l2.5 2.5 4.5-5']],
  alert: [['path', 'M12 4l9 16H3L12 4zM12 10v4M12 17.2v.1']],
  info: [['circle', 12, 12, 9], ['path', 'M12 11v5M12 8v.1']],
  back: [['path', 'M15 5l-7 7 7 7']],
  forward: [['path', 'M9 5l7 7-7 7']],
  reload: [['path', 'M20 12a8 8 0 11-2.5-5.8M20 4v5h-5']],
  clock: [['circle', 12, 12, 9], ['path', 'M12 7v5l3 2']],
  zip: [['path', 'M6 3h8l4 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1zM11 5h2M11 8h2M11 11h2'], ['rect', 10, 14, 4, 4, 1]]
}

/** @typedef {keyof typeof ICONS} IconName */

/** @param {IconName} name @param {string} [cls] */
export function icon (name, cls = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', cls)
  svg.setAttribute('aria-hidden', 'true')
  for (const [tag, ...args] of ICONS[name]) {
    const part = document.createElementNS(SVG_NS, tag)
    if (tag === 'path') part.setAttribute('d', String(args[0]))
    else if (tag === 'circle') for (const [key, value] of [['cx', args[0]], ['cy', args[1]], ['r', args[2]]]) part.setAttribute(String(key), String(value))
    else for (const [key, value] of [['x', args[0]], ['y', args[1]], ['width', args[2]], ['height', args[3]], ['rx', args[4]]]) part.setAttribute(String(key), String(value))
    svg.append(part)
  }
  return svg
}

/** The mark's ring and arrow, large, for the drop zone. */
export function dropArt () {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 64 64')
  svg.setAttribute('class', 'dropzone-art')
  svg.setAttribute('aria-hidden', 'true')
  const ring = document.createElementNS(SVG_NS, 'path')
  ring.setAttribute('class', 'ring')
  ring.setAttribute('d', 'M48.94 30.52A17 17 0 1 1 33.48 15.06')
  const arrow = document.createElementNS(SVG_NS, 'path')
  arrow.setAttribute('class', 'arrow')
  arrow.setAttribute('d', 'M29 35L50 14M41 14H50V23')
  svg.append(ring, arrow)
  return svg
}
