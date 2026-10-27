// The page: the address bar decides the view, and the header follows it.
//   #/                  Share: pick what to send
//   #/shares            what was sent from this browser
//   #/settings          where shares are kept, and what this browser remembers
//   #/about             how it works
//   #/<address>[?key=]  a share someone sent, opened (the key, a password, is read once and removed)

import * as engine from './engine.js'
import { h, icon, replace } from './dom.js'
import * as store from './store.js'
import { rememberKey } from './ui/keys.js'
import { setTitle } from './ui/title.js'
import { applyTheme, themeOf } from './ui/theme.js'
import { renderAbout } from './views/about.js'
import { renderReceive } from './views/receive.js'
import { renderSend, sharing } from './views/send.js'
import { renderSettings } from './views/settings.js'
import { renderShares } from './views/shares.js'

const view = /** @type {HTMLElement} */ (document.getElementById('view'))

/** @type {{ controller: AbortController, cleanups: (() => void)[] } | null} */
let current = null

/** @param {string} nav */
function markNav (nav) {
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.getAttribute('data-nav') === nav) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
}

/** @param {string} hash @returns {{ page: 'send' | 'shares' | 'settings' | 'about' } | { page: 'receive', cid: string }} */
function resolve (hash) {
  if (hash === '' || hash === '#' || hash === '#/') return { page: 'send' }
  if (hash === '#/shares') return { page: 'shares' }
  if (hash === '#/settings') return { page: 'settings' }
  if (hash === '#/about') return { page: 'about' }
  const share = engine.parseShareLink(hash)
  if (share === null) return { page: 'send' }
  if (share.password) {
    rememberKey(share.cid, share.password)
    history.replaceState(null, '', `#/${share.cid}`)
  }
  return { page: 'receive', cid: share.cid }
}

async function route () {
  if (current) {
    current.controller.abort()
    for (const cleanup of current.cleanups) cleanup()
  }
  const mine = { controller: new AbortController(), cleanups: /** @type {(() => void)[]} */ ([]) }
  current = mine
  const ctx = { signal: mine.controller.signal, onCleanup: (/** @type {() => void} */ fn) => { mine.cleanups.push(fn) } }
  const target = resolve(location.hash)
  markNav(target.page === 'receive' ? '' : target.page)
  setTitle({ send: '', shares: 'My shares', settings: 'Settings', about: 'About', receive: 'Opening a share' }[target.page])
  window.scrollTo(0, 0)
  try {
    if (target.page === 'send') await renderSend(view, ctx)
    else if (target.page === 'shares') await renderShares(view, ctx)
    else if (target.page === 'settings') await renderSettings(view, ctx)
    else if (target.page === 'about') await renderAbout(view, ctx)
    else await renderReceive(view, ctx, target.cid)
  } catch (error) {
    if (ctx.signal.aborted) return
    replace(view, h('section', { class: 'card centered' }, icon('alert', 'icon icon-large'), h('h1', {}, 'Something went wrong'),
      h('p', {}, error instanceof Error ? error.message : String(error)), h('a', { class: 'button button-secondary', href: '#/' }, 'Back to Share')))
  }
}

async function showBanner () {
  try {
    if (engine.environment().orivon || await store.getSetting('bannerDismissed', false)) return
  } catch {
    return
  }
  const banner = /** @type {HTMLElement} */ (document.getElementById('banner'))
  replace(banner, h('div', { class: 'banner' },
    h('p', {}, 'Orivon Share works in any browser. In Orivon it also opens protected websites in place. ',
      h('a', { href: 'https://github.com/OrivonBrowser/orivon-mvp', target: '_blank', rel: 'noopener noreferrer' }, 'Get Orivon')),
    h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Dismiss', onclick: () => {
      banner.replaceChildren()
      void store.setSetting('bannerDismissed', true).catch(() => {})
    } }, icon('close'))))
}

// A file dropped outside the drop zone must not make the browser leave the page for the file.
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => event.preventDefault())
window.addEventListener('beforeunload', (event) => {
  if (sharing()) {
    event.preventDefault()
    event.returnValue = ''
  }
})
window.addEventListener('hashchange', () => { void route() })

// Shares kept on this computer and marked online are served again from the moment the page opens.
void Promise.resolve().then(() => engine.startServing()).catch(() => {})
// Storage may be blocked: the page then follows the device's theme.
void store.getSetting('theme', 'system').then((theme) => applyTheme(themeOf(theme)), () => {})
void showBanner()
void route()
