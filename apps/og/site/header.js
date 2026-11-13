// The bar at the top of every view: the name of the site, the way between views, who is connected, and the line that
// says how Ethereum is read. It is rebuilt from the session whenever the session changes.

import { el, fill } from './dom.js'
import { stripOf } from './header-model.js'
import { icon } from './icons.js'
import { addressChip, button } from './parts.js'
import { ROUTES } from './router.js'

/** @param {import('./app.js').App} app */
function accountArea (app) {
  const { session } = app
  if (session.address !== null) {
    return el('div', { class: 'account', role: 'group', 'aria-label': 'Connected address' },
      el('span', { class: 'account-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'account-label', text: 'Connected' }),
      addressChip(session.address))
  }
  if (app.chain === null) return el('div', { class: 'account' }, el('span', { class: 'account-label', text: 'No wallet' }))
  return el('div', { class: 'account' },
    button(session.asking ? 'Waiting for your wallet…' : 'Connect', { primary: true, disabled: session.asking, onClick: () => { void app.connect() } }),
    session.failure === null ? null : el('span', { class: 'account-failure', role: 'alert', text: session.failure }))
}

/** The line under the bar: how Ethereum is read, with the shield only when the person's own light client answers. @param {import('./app.js').App} app */
function readingStrip (app) {
  const strip = stripOf({ kind: app.kind, reading: app.session.reading })
  return el('p', { class: 'reading', 'data-tone': strip.tone },
    icon(strip.shield ? 'shield' : strip.tone === 'warn' ? 'alert' : 'info', { size: 16 }), el('span', { text: strip.words }))
}

/**
 * @param {HTMLElement} root
 * @param {import('./app.js').App} app
 */
export function mountHeader (root, app) {
  let active = 'search'
  const render = () => {
    fill(root,
      el('div', { class: 'top-inner' },
        el('a', { class: 'brand', href: '#/' }, el('img', { class: 'brand-mark', src: 'icon.svg', alt: '', width: 34, height: 34 }), el('span', { class: 'brand-name', text: 'OG names' })),
        el('nav', { 'aria-label': 'Pages' },
          ROUTES.map((route) => el('a', { href: `#${route.path}`, 'aria-current': route.name === active ? 'page' : undefined, text: route.label }))),
        accountArea(app)),
      readingStrip(app))
  }
  app.onSession(render)
  render()
  return {
    /** @param {string} name */
    setActive (name) { active = name; render() }
  }
}
