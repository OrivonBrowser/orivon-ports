// The Orivon hint: a panel in the bottom-right corner telling a visitor whose
// browser is not Orivon that the app needs Orivon for everything to work.
// Copied beside every prepared app and loaded with `defer` (../prepare.ts);
// README.md says when it shows and why it is built this way.
//
// Not a module: a classic script the page loads, so it has nothing to import
// and puts nothing on window.

(function () {
  'use strict'

  const DOWNLOAD_URL = 'https://download.orivonstack.eth.limo'
  const DOWNLOAD_LABEL = 'download.orivonstack.eth.limo'
  const MESSAGE = 'You are using an unsupported browser, some components might not work. ' +
    'Open this website on Orivon Browser for full capabilities and permissionless access. '
  const LATER_KEY = 'orivon-hint:later'

  /** The shape apps/explore's site/orivon.js checks: every Orivon tab's main frame has it. */
  function inOrivon () {
    const api = window.orivon
    return typeof api === 'object' && api !== null && typeof api.version === 'number'
  }

  /** Storage can be absent or throw (a sandboxed frame, blocked site data); then the panel just shows again. */
  function laterChosen () {
    try { return window.sessionStorage.getItem(LATER_KEY) === '1' } catch { return false }
  }

  function rememberLater () {
    try { window.sessionStorage.setItem(LATER_KEY, '1') } catch {}
  }

  function el (tag, className, text) {
    const node = document.createElement(tag)
    if (className !== undefined) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function link (className, text) {
    const node = el('a', className, text)
    node.href = DOWNLOAD_URL
    node.target = '_blank'
    node.rel = 'noopener noreferrer'
    return node
  }

  function panel (asset, close) {
    const box = el('div', 'panel')
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'false')
    box.setAttribute('aria-label', 'Orivon Browser')

    const logo = el('img', 'logo')
    logo.src = asset('logo.png')
    logo.alt = 'Orivon'
    logo.width = 44
    logo.height = 44

    const text = el('p', 'text', MESSAGE)
    text.append(link('address', DOWNLOAD_LABEL))

    const later = el('button', 'later', 'Maybe later')
    later.type = 'button'
    later.addEventListener('click', close)
    const download = link('download', 'Download Orivon')
    // After the click has opened the tab, not during it.
    download.addEventListener('click', () => { setTimeout(close) })

    const actions = el('div', 'actions')
    actions.append(later, download)
    box.append(logo, text, actions)
    return box
  }

  if (inOrivon() || window.top !== window.self || laterChosen()) return

  // Every URL is resolved from this script's own, so the panel works wherever
  // the tree is mounted, an IPFS gateway's /ipfs/<cid>/ included.
  const script = document.currentScript
  const base = script !== null && script.src !== '' ? script.src : document.baseURI
  const asset = (name) => new URL(name, base).href

  const host = document.createElement('orivon-hint')
  const root = host.attachShadow({ mode: 'open' })
  const close = () => { rememberLater(); host.remove() }

  // Nothing renders until the stylesheet has loaded: an unstyled panel would
  // flash at the end of the page, and one whose stylesheet failed stays away.
  const style = document.createElement('link')
  style.rel = 'stylesheet'
  style.href = asset('hint.css')
  style.addEventListener('load', () => { root.append(panel(asset, close)) }, { once: true })
  root.append(style)
  // On <html>, beside <body>: an app that replaces its body's children
  // cannot take the panel with them.
  document.documentElement.append(host)
})()
