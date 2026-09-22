// Every glyph the offer book draws, as inline SVG in `currentColor`, so a
// dimmed row dims its icons the same way it dims its text.
'use strict'

;(function () {
  let unique = 0

  // A shape with a hole cut through it needs a mask, and a mask needs an id
  // that no other copy of the same icon on the page already uses.
  function masked (viewBox, shape, holes) {
    const id = `bq-mask-${String(++unique)}`
    return `<svg viewBox="${viewBox}"><mask id="${id}"><rect width="100%" height="100%" fill="#fff"/>${holes}</mask><g mask="url(#${id})" fill="currentColor">${shape}</g></svg>`
  }

  const STROKE = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"'

  const ICONS = {
    chevron: () => `<svg viewBox="0 0 12 12"><path d="M2.5 4.5 6 8l3.5-3.5" ${STROKE} stroke-width="1.3"/></svg>`,
    sortUp: () => '<svg viewBox="0 0 8 7"><path d="M4 0 8 7H0z" fill="#fff"/></svg>',
    help: () => masked('0 0 16 16', '<circle cx="8" cy="8" r="8"/>',
      '<path d="M5.7 6.1a2.3 2.3 0 1 1 3.3 2.1c-.7.35-1 .8-1 1.5v.3" fill="none" stroke="#000" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="12.3" r="1.05" fill="#000"/>'),
    helpOutline: () => `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7.1" ${STROKE} stroke-width="1.3"/><path d="M5.9 6.2a2.1 2.1 0 1 1 3 1.9c-.6.3-.9.7-.9 1.3v.3" ${STROKE} stroke-width="1.3"/><circle cx="8" cy="11.9" r=".85" fill="currentColor"/></svg>`,
    info: () => masked('0 0 16 16', '<circle cx="8" cy="8" r="8"/>',
      '<circle cx="8" cy="4.4" r="1.25" fill="#000"/><rect x="6.9" y="6.6" width="2.2" height="6" rx=".3" fill="#000"/>'),
    chart: () => `<svg viewBox="0 0 16 16"><path d="M1.5 1.5v13h13" ${STROKE} stroke-width="1.3"/><path d="m4 11 3-3.6 2.4 2.1L14 4.2" ${STROKE} stroke-width="1.3"/></svg>`,
    lock: () => `<svg viewBox="0 0 16 16"><path d="M4.6 7V5.2a3.4 3.4 0 0 1 6.8 0V7" ${STROKE} stroke-width="1.6"/><rect x="2.6" y="7" width="10.8" height="8" rx="1.2" fill="currentColor"/></svg>`,
    // Account age on a payment method that needs no signing.
    age: () => `<svg viewBox="0 0 16 16"><rect x="1.8" y="1.8" width="12.4" height="12.4" rx="1" ${STROKE} stroke-width="1.2"/><path d="m4.8 8.2 2.3 2.3 4.4-5" ${STROKE} stroke-width="1.2"/></svg>`,
    unsigned: () => `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" ${STROKE} stroke-width="1.2"/><path d="M8 4.3v4.6" ${STROKE} stroke-width="1.4"/><circle cx="8" cy="11.4" r=".85" fill="currentColor"/></svg>`,
    signed: () => masked('0 0 16 16', '<circle cx="8" cy="8" r="7.4"/>',
      '<path d="m4.7 8.2 2.3 2.3 4.3-4.8" fill="none" stroke="#000" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'),
    buyTray: () => `<svg viewBox="0 0 18 18"><path d="M9 1.5v8M5.6 6.4 9 9.8l3.4-3.4" ${STROKE} stroke-width="1.5"/><path d="M5.6 5.5H3.8L1.5 10.6v5.4h15v-5.4l-2.3-5.1h-1.8" ${STROKE} stroke-width="1.5"/><path d="M1.5 10.6h4.2l1.2 1.9h4.2l1.2-1.9h4.2" ${STROKE} stroke-width="1.5"/></svg>`,
    tor: () => '<svg viewBox="0 0 14 19"><path d="M7.2 4.6c.1-1.5.8-2.8 2.2-3.8" fill="none" stroke="#bdbdbd" stroke-width="1.1" stroke-linecap="round"/>' +
      '<path d="M7 4.2C3.4 6.3 1 8.9 1 12.6 1 15.9 3.7 18.2 7 18.2s6-2.3 6-5.6c0-3.7-2.4-6.3-6-8.4z" fill="#e8e8e8"/>' +
      '<path d="M7 4.2c3.6 2.1 6 4.7 6 8.4 0 3.3-2.7 5.6-6 5.6z" fill="#3a3a3a"/>' +
      '<path d="M7 6.4c-2 1.6-3.3 3.6-3.3 6.1 0 2.3 1.4 4 3.3 4.4M7 6.4c2 1.6 3.3 3.6 3.3 6.1 0 2.3-1.4 4-3.3 4.4M7 8.6c-.9 1.1-1.4 2.4-1.4 3.9s.6 2.6 1.4 3" fill="none" stroke="#9b9b9b" stroke-width=".7"/></svg>'
  }

  function icon (name) {
    const make = ICONS[name]
    if (make === undefined) throw new Error(`no icon "${name}"`)
    return make()
  }

  function fill (root) {
    for (const element of root.querySelectorAll('[data-icon]')) element.innerHTML = icon(element.dataset.icon)
  }

  window.BisqIcons = { icon, fill }
})()
