// The Orivon hint: what a visitor whose browser is not Orivon is told about an
// app. Copied beside every prepared app (../prepare.ts), which writes the
// app's data onto the script tag as data-* attributes. README.md says when
// each of the three things shows and why it is built this way.
//
// Not a module: a classic script the page loads, so it has nothing to import
// and puts nothing on window.

(function () {
  'use strict'

  /** Flip to true once a released Orivon handles orivon: links; until then the button is never built. */
  const OPEN_IN_ORIVON = false

  const DOWNLOAD_URL = 'https://download.orivonstack.eth.limo/'
  const STATE_KEY = 'orivon-hint:state'
  const CONTINUE = 'continue'
  const CLOSED = 'closed'

  /** The shape apps/explore's site/orivon.js checks: every Orivon tab's main frame has it. */
  function inOrivon () {
    const api = window.orivon
    return typeof api === 'object' && api !== null && typeof api.version === 'number'
  }

  /** What shows. `state` is what this tab's session remembers: nothing, CONTINUE (tier 2 went on to the app) or CLOSED. */
  function decide (facts) {
    if (facts.framed || facts.state === CLOSED) return 'none'
    if (facts.inOrivon) return facts.hasNotice ? 'notice' : 'none'
    if (facts.tier === 2) return facts.state === CONTINUE ? 'pill' : 'landing'
    return 'pill'
  }

  /** Storage can be absent or throw (a sandboxed frame, blocked site data); then nothing is remembered. */
  function readState () {
    try { return window.sessionStorage.getItem(STATE_KEY) } catch { return null }
  }

  function writeState (value) {
    try { window.sessionStorage.setItem(STATE_KEY, value) } catch {}
  }

  /** Whether a choice made now will still be there after a reload: the landing's way on needs it. */
  function canRemember () {
    try {
      const key = `${STATE_KEY}:probe`
      window.sessionStorage.setItem(key, '1')
      window.sessionStorage.removeItem(key)
      return true
    } catch { return false }
  }

  function secure (value) {
    try { return new URL(value).protocol === 'https:' } catch { return false }
  }

  function read (script) {
    const data = script !== null && script.dataset !== undefined ? script.dataset : {}
    return {
      tier: data.tier === '2' ? 2 : 1,
      app: data.app ?? '',
      name: data.name !== undefined && data.name !== '' ? data.name : 'This app',
      eth: data.eth ?? '',
      text: data.text ?? '',
      notice: data.notice ?? '',
      officialUrl: data.officialUrl !== undefined && secure(data.officialUrl) ? data.officialUrl : '',
      reportUrl: data.reportUrl !== undefined && secure(data.reportUrl) ? data.reportUrl : ''
    }
  }

  function el (tag, className, text) {
    const node = document.createElement(tag)
    if (className !== undefined) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function link (className, text, href, external) {
    const node = el('a', className, text)
    node.href = href
    if (external) { node.target = '_blank'; node.rel = 'noopener noreferrer' }
    return node
  }

  function button (className, text, onClick) {
    const node = el('button', className, text)
    node.type = 'button'
    node.addEventListener('click', onClick)
    return node
  }

  function closeButton (onClose) {
    const close = button('close', '×', onClose)
    close.setAttribute('aria-label', 'Close')
    return close
  }

  function downloadUrl (config) {
    return config.app === '' ? DOWNLOAD_URL : `${DOWNLOAD_URL}?app=${encodeURIComponent(config.app)}`
  }

  /** The address comes from prepare.ts, the one place that builds it, and is the same one the manifest names. */
  function reportLink (config) {
    return config.reportUrl === '' ? '' : link('report', 'Report a problem with this build', config.reportUrl, true)
  }

  /** Only a port has an official build to name, so only a port is called a community build. */
  function communityLine (config) {
    return config.officialUrl === '' ? null : el('p', 'community', `A community build by Orivon, not the official ${config.name}.`)
  }

  function logo (asset, size) {
    const image = el('img', 'logo')
    image.src = asset('logo.png')
    image.alt = ''
    image.width = size
    image.height = size
    return image
  }

  function landing (config, asset, goOn, canGoOn) {
    const box = el('main', 'landing')
    box.setAttribute('aria-labelledby', 'title')
    const title = el('h1', 'title', config.name)
    title.id = 'title'
    box.append(logo(asset, 48), title)
    box.append(el('p', 'text', `${config.name} runs inside Orivon, an open-source browser that provides the desktop parts this app needs.`))
    if (config.text !== '') box.append(el('p', 'text', config.text))

    const actions = el('div', 'actions')
    const get = link('primary', 'Get Orivon', downloadUrl(config), true)
    actions.append(get)
    if (config.officialUrl !== '') actions.append(link('secondary', `Official ${config.name} downloads`, config.officialUrl, true))
    if (OPEN_IN_ORIVON && config.eth !== '') actions.append(link('secondary', 'Open in Orivon', `orivon:open?u=${encodeURIComponent(config.eth)}`, false))
    box.append(actions)

    const community = communityLine(config)
    if (community !== null) box.append(community)
    const report = el('p', 'foot')
    report.append(reportLink(config))
    box.append(report)

    if (canGoOn) {
      const more = el('p', 'foot')
      more.append(button('again', 'Continue anyway', goOn), ' The app may not work without Orivon.')
      box.append(more, closeButton(goOn))
    }
    return { box, focus: get }
  }

  function pill (config, mode, asset, close) {
    const box = el('aside', 'pill')
    box.setAttribute('aria-label', 'Orivon')
    const sentence = config.tier === 2
      ? `${config.name} may not work in this browser. It runs inside Orivon, an open-source browser.`
      : `${config.name} works in this browser. It also runs inside Orivon, an open-source browser.`
    const body = el('div', 'body')
    body.append(el('p', 'text', mode === 'notice' ? config.notice : sentence))
    if (mode !== 'notice' && config.text !== '') body.append(el('p', 'text', config.text))
    const community = communityLine(config)
    if (community !== null) body.append(community)

    const actions = el('div', 'actions')
    if (mode !== 'notice') actions.append(link('primary', 'Get Orivon', downloadUrl(config), true))
    actions.append(reportLink(config))
    body.append(actions)
    box.append(logo(asset, 32), body, closeButton(close))
    return { box, focus: null }
  }

  /**
   * The app has not started: this script is the first in <head>. A <plaintext>
   * start tag makes the parser read the rest of the document as text, so
   * nothing after this script is ever run, and the document still finishes
   * and fires its load events. window.stop() would also keep the app away but
   * leaves the page unpainted and its load event unfired; it is the fallback
   * for a page that refuses document.write (a Trusted Types policy).
   */
  function holdTheApp () {
    try {
      document.write('<plaintext>')
      document.addEventListener('DOMContentLoaded', () => {
        const rest = document.querySelector('plaintext')
        if (rest !== null) rest.remove()
      }, { once: true })
    } catch {
      try { window.stop() } catch {}
    }
  }

  const script = document.currentScript
  const config = read(script)
  const mode = decide({
    framed: window.top !== window.self,
    inOrivon: inOrivon(),
    tier: config.tier,
    state: readState(),
    hasNotice: config.notice !== ''
  })
  if (mode === 'none') return

  // Every URL is resolved from this script's own, so the panel works wherever
  // the tree is mounted, an IPFS path gateway's /ipfs/<cid>/ included.
  const base = script !== null && script.src !== '' ? script.src : document.baseURI
  const asset = (name) => new URL(name, base).href

  const host = document.createElement('orivon-hint')
  host.setAttribute('data-mode', mode)
  const root = host.attachShadow({ mode: 'open' })

  function dismiss () {
    host.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  function close () {
    writeState(CLOSED)
    dismiss()
  }
  /** The landing's way out. The app starts on a reload, because its markup was never parsed. */
  function goOn () {
    writeState(CONTINUE)
    window.location.reload()
  }
  function onKey (event) {
    if (event.key !== 'Escape') return
    if (mode === 'landing') { if (canGoOn) goOn() } else close()
  }

  const canGoOn = mode === 'landing' && canRemember()
  if (mode === 'landing') {
    holdTheApp()
    document.title = config.name
    const viewport = document.createElement('meta')
    viewport.name = 'viewport'
    viewport.content = 'width=device-width, initial-scale=1'
    ;(document.head ?? document.documentElement).append(viewport)
  }

  const view = mode === 'landing' ? landing(config, asset, goOn, canGoOn) : pill(config, mode, asset, close)

  // Nothing renders until the stylesheet has loaded: an unstyled panel would
  // flash, and one whose stylesheet failed stays away. The landing is all
  // there is to see, so it shows unstyled rather than leave a blank page.
  const style = document.createElement('link')
  style.rel = 'stylesheet'
  style.href = asset('hint.css')
  const show = () => {
    root.append(view.box)
    if (view.focus !== null) view.focus.focus()
  }
  style.addEventListener('load', show, { once: true })
  if (mode === 'landing') style.addEventListener('error', show, { once: true })
  root.append(style)
  document.addEventListener('keydown', onKey, true)
  // On <html>, beside <body>: an app that replaces its body's children
  // cannot take the panel with them.
  document.documentElement.append(host)
})()
