// Gets a Cloudflare Turnstile token for a sitekey, the way a desktop build does: Turnstile issues a token only to a
// hostname the sitekey allows, and a packaged page has none, so the widget runs on http://localhost in a view nobody
// sees until Cloudflare asks for interaction. A classic script that sets one window value, `orivonForgeTurnstile`:
// `getToken(sitekey, { port })` resolves the token, or rejects with the text a desktop build gives.
//
// Two grants carry it. The page that asks serves the widget's page on `port` (`orivon.net.listen`, so
// tcp.listen.local names the port), and shows it in a <webview> (web.embed names http://localhost:<port> and the
// frame Cloudflare's script opens, WIDGET_ORIGINS). Nothing in this file is specific to one app.

(function () {
  'use strict'

  const SITEKEY_PATTERN = /^[0-9A-Za-z_-]{1,100}$/
  const PAGE_PATH = '/forge-turnstile'
  const WIDGET_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
  const WIDGET_ORIGINS = ['https://challenges.cloudflare.com']
  // The page's own clocks: the widget's script, a token, and a token once Cloudflare asked the person to act.
  const SCRIPT_LOAD_TIMEOUT_MS = 15_000
  const TOKEN_TIMEOUT_MS = 30_000
  const INTERACTIVE_TOKEN_TIMEOUT_MS = 120_000
  /** The backstop for a page that never answers; the page's own clocks settle first. */
  const WINDOW_TIMEOUT_MS = 180_000
  /** A view the shell never attaches (no grant) fires nothing, so this is its clock. */
  const ATTACH_TIMEOUT_MS = 30_000
  const VIEW_WIDTH = 340
  const VIEW_HEIGHT = 120
  const TITLE = 'Forge Images'
  const TITLE_BAR_HEIGHT = 28
  const MAX_REQUEST_BYTES = 8192
  const CONNECTION_TIMEOUT_MS = 5000
  const MAX_CONNECTIONS = 16
  /** How long the listener stays open after the last call. */
  const LISTENER_LINGER_MS = 10_000

  const HIDDEN_BOX_STYLE = `position:fixed;left:0;top:0;width:${String(VIEW_WIDTH)}px;border:0;opacity:0;pointer-events:none;z-index:-1`
  const SHOWN_BOX_STYLE = `position:fixed;left:calc(50% - ${String(VIEW_WIDTH / 2)}px);top:calc(50% - ${String((VIEW_HEIGHT + TITLE_BAR_HEIGHT) / 2)}px);width:${String(VIEW_WIDTH)}px;z-index:2147483647;`
    + 'color-scheme:light dark;background:Canvas;color:CanvasText;border:1px solid GrayText;box-shadow:0 4px 24px rgba(0,0,0,.4)'
  const TITLE_BAR_STYLE = `display:flex;align-items:center;justify-content:space-between;height:${String(TITLE_BAR_HEIGHT)}px;padding:0 4px 0 10px;font:13px system-ui,sans-serif`
  const CLOSE_STYLE = 'border:0;background:none;color:inherit;font:18px/1 system-ui,sans-serif;cursor:pointer;padding:0 6px'
  const VIEW_STYLE = `display:block;width:${String(VIEW_WIDTH)}px;height:${String(VIEW_HEIGHT)}px;border:0`

  // The page the widget runs in. It runs inside the shown page, so it is sent as source and may use nothing outside itself.
  // `turnstileResult` always resolves, with { token } or { error }: a rejection would reach the reader without its message.
  // `turnstileInteraction` resolves when Cloudflare asks for the person's action.
  function guestPage (config) {
    let announceInteraction
    window.turnstileInteraction = new Promise((resolve) => { announceInteraction = resolve })
    window.turnstileResult = new Promise((settle) => {
      let timer
      const finish = (result) => { clearTimeout(timer); settle(result) }
      const within = (ms, message) => { clearTimeout(timer); timer = setTimeout(() => { finish({ error: message }) }, ms) }
      within(config.scriptMs, 'Turnstile script load timed out')
      const script = document.createElement('script')
      script.src = config.scriptUrl
      script.onerror = () => { finish({ error: 'Turnstile script failed to load' }) }
      script.onload = () => {
        within(config.tokenMs, 'Turnstile check timed out')
        try {
          window.turnstile.render('#widget', {
            sitekey: new URLSearchParams(location.search).get('sitekey'),
            appearance: 'interaction-only',
            retry: 'never',
            'refresh-expired': 'never',
            'response-field': false,
            callback: (token) => { finish(token ? { token } : { error: 'Turnstile returned an empty token' }) },
            'error-callback': (code) => { finish({ error: `Turnstile error ${String(code)}` }); return true },
            'expired-callback': () => { finish({ error: 'Turnstile token expired' }) },
            'timeout-callback': () => { finish({ error: 'Turnstile challenge timed out' }) },
            'unsupported-callback': () => { finish({ error: 'Turnstile is not supported by this browser' }) },
            'before-interactive-callback': () => {
              announceInteraction()
              within(config.interactiveMs, 'Turnstile check timed out')
            }
          })
        } catch (error) {
          finish({ error: String((error && error.message) || error) })
        }
      }
      document.head.appendChild(script)
    })
  }

  const GUEST_CONFIG = { scriptUrl: WIDGET_SCRIPT_URL, scriptMs: SCRIPT_LOAD_TIMEOUT_MS, tokenMs: TOKEN_TIMEOUT_MS, interactiveMs: INTERACTIVE_TOKEN_TIMEOUT_MS }

  function base64Of (bytes) {
    let text = ''
    for (const byte of bytes) text += String.fromCharCode(byte)
    return btoa(text)
  }

  /** The script is inline, so the policy admits it by a nonce made for this response; the only other origin it names is Cloudflare's. */
  function policyFor (nonce) {
    const widget = WIDGET_ORIGINS.join(' ')
    return `default-src 'none'; script-src 'nonce-${nonce}' ${widget}; frame-src ${widget}; connect-src ${widget}; img-src ${widget} data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`
  }

  function pageHtml (nonce) {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${TITLE}</title>
<style>:root{color-scheme:light dark}html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center}</style>
</head>
<body>
<div id="widget"></div>
<script nonce="${nonce}">(${guestPage.toString()})(${JSON.stringify(GUEST_CONFIG)})</script>
</body>
</html>`
  }

  const STATUS_TEXT = { 200: 'OK', 404: 'Not Found', 405: 'Method Not Allowed' }

  /** The answer to one request head: the page for a GET or HEAD of the page's path, 404 for any other path, 405 for any other method. */
  function answerTo (head) {
    const request = /^([A-Z]+) (\S+) HTTP\/1\.[01]\r\n/.exec(head)
    const status = request === null || request[2].split('?')[0] !== PAGE_PATH ? 404 : request[1] === 'GET' || request[1] === 'HEAD' ? 200 : 405
    const headers = ['Connection: close']
    let body = ''
    if (status === 200) {
      const nonce = base64Of(crypto.getRandomValues(new Uint8Array(16)))
      body = pageHtml(nonce)
      headers.push('Content-Type: text/html; charset=utf-8', 'Cache-Control: no-store', 'X-Content-Type-Options: nosniff', `Content-Security-Policy: ${policyFor(nonce)}`)
    } else if (status === 405) {
      headers.push('Allow: GET, HEAD')
    }
    const bytes = new TextEncoder().encode(body)
    headers.push(`Content-Length: ${String(bytes.length)}`)
    const text = `HTTP/1.1 ${String(status)} ${STATUS_TEXT[status]}\r\n${headers.join('\r\n')}\r\n\r\n`
    return request !== null && request[1] === 'HEAD' ? new TextEncoder().encode(text) : new Uint8Array([...new TextEncoder().encode(text), ...bytes])
  }

  async function readHead (socket) {
    const reader = socket.readable.getReader()
    const decoder = new TextDecoder()
    let head = ''
    try {
      while (!head.includes('\r\n\r\n')) {
        const { value, done } = await reader.read()
        if (done) break
        head += decoder.decode(value, { stream: true })
        if (head.length > MAX_REQUEST_BYTES) break
      }
    } finally {
      reader.releaseLock()
    }
    return head
  }

  let connections = 0

  /** One connection: read the request head, write the answer, close. A connection that sends nothing, or too much, is closed on its own clock. */
  async function serve (socket) {
    if (connections >= MAX_CONNECTIONS) { await socket.close().catch(() => {}); return }
    connections++
    let timer
    const expired = new Promise((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('connection timed out')) }, CONNECTION_TIMEOUT_MS) })
    expired.catch(() => {})
    try {
      const head = await Promise.race([readHead(socket), expired])
      const writer = socket.writable.getWriter()
      await Promise.race([writer.write(answerTo(head)).then(() => writer.close()), expired])
    } catch (error) {
      // one connection failing is that connection's business
    } finally {
      clearTimeout(timer)
      connections--
      await socket.close().catch(() => {})
    }
  }

  async function acceptAll (server) {
    const reader = server.connections.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      void serve(value)
    }
  }

  /** One listener per port for every call in flight at once. It stays open for a short while after the last call, so calls that follow one another do not close and open the port each time. */
  const listeners = new Map()
  /** A listener that is closing holds its port until it is closed, so the next one on that port waits for it. */
  const closing = new Map()

  async function openServer (port) {
    const net = window.orivon?.net
    if (typeof net?.listen !== 'function') return null
    await closing.get(port)
    try {
      const server = await net.listen({ port, scope: 'local' })
      acceptAll(server).catch(() => {})
      return server
    } catch (error) {
      // The port is held already: by another page of this app, which then answers, or by a program that does not, and the load fails with its reason.
      return null
    }
  }

  function closeListener (port, entry) {
    if (listeners.get(port) === entry) listeners.delete(port)
    const done = entry.ready.then((server) => server?.close(), () => {}).catch(() => {})
    closing.set(port, done)
    done.finally(() => { if (closing.get(port) === done) closing.delete(port) })
  }

  function acquireListener (port) {
    let entry = listeners.get(port)
    if (entry === undefined) { entry = { users: 0, timer: undefined, ready: openServer(port) }; listeners.set(port, entry) }
    const held = entry
    clearTimeout(held.timer)
    held.users++
    let released = false
    return {
      ready: held.ready,
      release () {
        if (released) return
        released = true
        if (--held.users > 0) return
        held.timer = setTimeout(() => { closeListener(port, held) }, LISTENER_LINGER_MS)
      }
    }
  }

  /** The view and the box around it. The box is invisible and out of the way until `show`, then the size and the middle of the window a desktop build opens. */
  function openFrame () {
    const box = document.createElement('div')
    box.setAttribute('style', HIDDEN_BOX_STYLE)
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-label', TITLE)
    box.setAttribute('aria-hidden', 'true')
    const bar = document.createElement('div')
    bar.setAttribute('style', TITLE_BAR_STYLE)
    const title = document.createElement('span')
    title.textContent = TITLE
    const close = document.createElement('button')
    close.setAttribute('type', 'button')
    close.setAttribute('aria-label', 'Close')
    close.setAttribute('style', CLOSE_STYLE)
    close.textContent = '×'
    bar.appendChild(title)
    bar.appendChild(close)
    const view = document.createElement('webview')
    view.setAttribute('src', 'about:blank')
    view.setAttribute('style', VIEW_STYLE)
    view.setAttribute('tabindex', '-1')
    box.appendChild(bar)
    box.appendChild(view)
    return {
      box,
      view,
      close,
      show () {
        box.setAttribute('style', SHOWN_BOX_STYLE)
        box.removeAttribute('aria-hidden')
        view.removeAttribute('tabindex')
      }
    }
  }

  const failure = (reason) => new Error(`Turnstile page failed to load: ${String(reason)}`)

  /** Resolves when `view` has the document of `url` ready, and rejects with what a desktop build says when it cannot. The view is attached on about:blank first, which a refused origin cannot end. */
  async function showPage (frame, url, abort) {
    const { view } = frame
    let attachClock
    const attached = new Promise((resolve, reject) => {
      view.addEventListener('did-finish-load', resolve, { once: true })
      attachClock = setTimeout(() => { reject(failure('the page could not be shown')) }, ATTACH_TIMEOUT_MS)
    })
    document.body.appendChild(frame.box)
    try { await attached } finally { clearTimeout(attachClock) }
    if (typeof view.setAudioMuted === 'function') view.setAudioMuted(true)
    view.addEventListener('did-fail-load', (event) => { if (event.isMainFrame) abort(failure(`${String(event.errorCode)} ${String(event.errorDescription)}`)) })
    view.addEventListener('render-process-gone', () => { abort(new Error('Turnstile check crashed')) })
    view.addEventListener('destroyed', () => { abort(new Error('Turnstile check was closed')) })
    const ready = new Promise((resolve) => { view.addEventListener('dom-ready', resolve, { once: true }) })
    // The load is not awaited: it settles only once Cloudflare's script and frame have finished loading, past the page's own clocks.
    view.loadURL(url).catch((error) => { abort(failure(error?.message ?? error)) })
    await ready
  }

  async function getToken (sitekey, options) {
    if (typeof sitekey !== 'string' || !SITEKEY_PATTERN.test(sitekey)) throw new Error('Invalid Turnstile sitekey')
    const port = options?.port
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Turnstile page failed to load: no port to serve it on')

    let abort
    const aborted = new Promise((_resolve, reject) => { abort = reject })
    aborted.catch(() => {})
    const listener = acquireListener(port)
    const frame = openFrame()
    frame.close.addEventListener('click', () => { abort(new Error('Turnstile check was closed')) })
    const clock = setTimeout(() => { abort(new Error('Turnstile check timed out')) }, WINDOW_TIMEOUT_MS)
    try {
      await Promise.race([listener.ready, aborted])
      await Promise.race([showPage(frame, `http://localhost:${String(port)}${PAGE_PATH}?sitekey=${sitekey}`, abort), aborted])
      // A reload discards the page the reads below wait on, so they would never settle.
      frame.view.addEventListener('did-start-navigation', (event) => { if (event.isMainFrame && !event.isInPlace) abort(new Error('Turnstile check was reloaded')) })
      frame.view.executeJavaScript('window.turnstileInteraction').then(() => { frame.show() }, () => {})
      const result = await Promise.race([frame.view.executeJavaScript('window.turnstileResult'), aborted])
      if (typeof result?.token === 'string' && result.token !== '') return result.token
      throw new Error(typeof result?.error === 'string' ? result.error : 'Turnstile returned no token')
    } finally {
      clearTimeout(clock)
      frame.box.remove()
      listener.release()
    }
  }

  window.orivonForgeTurnstile = Object.freeze({ getToken })
})()
