// The six window.ea members that carry a decision rather than a shape, and the
// two document-level edits that are not members: telling the renderer it runs in
// Electron, and keeping a second tab of the app out.
//
// The other 74 are declared in ./members.json and generated -- see ../README.md
// for the table. This file is spliced into the composed bridge, so it is not a
// module: it declares `appMembers`, which the installer calls with the kit.

/**
 * Super Productivity decides it is the desktop app at module load: the user
 * agent contains ' electron/' AND window.ea exists (src/app/app.constants.ts).
 * Orivon's user agent is Chrome's, so without the token the renderer would take
 * its browser branches -- a service worker, the 'calendar will likely fail in
 * the browser' warning -- and never call the bridge. The token is added only
 * inside Orivon, where the bridge stands behind window.ea; any other browser
 * keeps its own user agent and runs upstream's web app, because a bridge with
 * no Orivon behind it could not answer for the desktop one.
 */
const ELECTRON_TOKEN = ' Electron/0.0.0'

function declareElectronRenderer (kit) {
  if (kit.getOrivon() === undefined) return
  const real = navigator.userAgent ?? ''
  if (real.toLowerCase().includes(' electron/')) return
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => real + ELECTRON_TOKEN })
}

/**
 * The desktop app is one window by construction: Electron's main process takes
 * the single-instance lock, and the renderer skips the BroadcastChannel check
 * the web app runs (src/app/core/startup/startup.service.ts: 'Skip single
 * instance check for ... Electron'). A browser tab has no such lock, and two
 * copies of the app would write one IndexedDB. The first copy takes a Web Lock
 * for the life of its document; a second finds it taken and is sent to a static
 * page that says why (hooks.mjs writes it), which ends its scripts.
 */
const SINGLE_INSTANCE_LOCK = 'orivon.super-productivity.single-instance'

function guardSingleInstance (kit) {
  if (kit.getOrivon() === undefined || navigator.locks === undefined) return
  navigator.locks.request(SINGLE_INSTANCE_LOCK, { ifAvailable: true }, (lock) => {
    if (lock !== null) return new Promise(() => {})
    window.location.replace(new URL('orivon/already-open.html', document.baseURI).href)
    return undefined
  })
}

/**
 * A plugin's page is a srcdoc frame (`<iframe data-plugin-iframe>`) of the app, built from the
 * plugin's index.html plus an inline script that is the plugin API bridge. A srcdoc frame is
 * under the app's policy, which admits no inline script and no inline event handler, so in
 * Orivon that page stays blank. The policy does admit this app's own files and string
 * evaluation, so the frame's document is rewritten as it is set: each inline script becomes an
 * inert text block followed by `<script src>` of plugin-frame.js (hooks.mjs serves it), which
 * evaluates the block where it stood and adopts event-handler attributes. The code is the
 * plugin's own, running with the app's permissions as it does in the desktop app (same-origin
 * frame, `allow-same-origin`); the policy itself is not changed. Reasoning: ../README.md.
 */
const PLUGIN_FRAME_RUNNER = 'orivon/plugin-frame.js'

// The MIME types HTML runs as classic scripts, with the empty one a script without `type` has.
const CLASSIC_SCRIPT_TYPES = new Set([
  '', 'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript'
])

// Elements whose content is text, not markup: a `<script` inside one is not a script.
const TEXT_ELEMENTS = new Set(['iframe', 'noembed', 'noframes', 'noscript', 'style', 'textarea', 'title', 'xmp'])

const isSpace = (char) => char === ' ' || char === '\n' || char === '\t' || char === '\f' || char === '\r'

/** The start tag at `from` (a `<` and a letter): its name, its attributes with their offsets, and where it ends. Undefined when the document ends inside it. */
function readStartTag (html, from) {
  let i = from + 1
  while (i < html.length && !isSpace(html[i]) && html[i] !== '/' && html[i] !== '>') i++
  const name = html.slice(from + 1, i).toLowerCase()
  const attrs = []
  for (;;) {
    while (i < html.length && (isSpace(html[i]) || html[i] === '/')) i++
    if (i >= html.length) return undefined
    if (html[i] === '>') return { name, attrs, end: i + 1 }
    const start = i++
    while (i < html.length && !isSpace(html[i]) && html[i] !== '/' && html[i] !== '>' && html[i] !== '=') i++
    const attr = { name: html.slice(start, i).toLowerCase(), value: '', start, end: i }
    let j = i
    while (isSpace(html[j])) j++
    if (html[j] === '=') {
      j++
      while (isSpace(html[j])) j++
      const quote = html[j]
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, j + 1)
        if (close === -1) return undefined
        attr.value = html.slice(j + 1, close)
        attr.end = close + 1
      } else {
        const valueStart = j
        while (j < html.length && !isSpace(html[j]) && html[j] !== '>') j++
        attr.value = html.slice(valueStart, j)
        attr.end = j
      }
      i = attr.end
    }
    attrs.push(attr)
  }
}

/** Where the `</script` that ends the script whose text starts at `from` begins, by the parser's script-data rules (`<!--` and `<script` inside make the first `</script` not the end). -1 when none does. */
function scriptTextEnd (html, from) {
  let state = 'text'
  const tagAt = (at, name) => html.slice(at, at + name.length).toLowerCase() === name && (isSpace(html[at + name.length]) || html[at + name.length] === '/' || html[at + name.length] === '>')
  for (let i = from; i < html.length; i++) {
    if (state !== 'text' && html.startsWith('-->', i)) { state = 'text'; i += 2; continue }
    if (html[i] !== '<') continue
    if (state === 'text' && html.startsWith('<!--', i)) { state = 'escaped'; i += 1; continue }
    if (tagAt(i + 1, '/script')) {
      if (state !== 'double') return i
      state = 'escaped'
    } else if (state === 'escaped' && tagAt(i + 1, 'script')) {
      state = 'double'
    }
  }
  return -1
}

/** The index after the comment that starts at `from` (a `<!--`). */
function commentEnd (html, from) {
  if (html.startsWith('>', from + 4)) return from + 5
  if (html.startsWith('->', from + 4)) return from + 6
  const close = /--!?>/g
  close.lastIndex = from + 4
  const found = close.exec(html)
  return found === null ? html.length : found.index + found[0].length
}

/**
 * `html` with each inline script that would run (classic or module, no `src`) held inert and followed
 * by the runner that evaluates it: `<script type="text/plain" data-orivon-inline>` keeps the script's
 * other attributes and its text, `<script src data-orivon-run>` runs it. A module's runner is deferred,
 * as a module is. Scripts with a `src`, other types and `nomodule` are left as they are, and so is a
 * document already rewritten.
 */
function preparePluginFrameHtml (html, runnerUrl) {
  const runnerSrc = runnerUrl.replace(/"/g, '%22')
  let out = ''
  let copied = 0
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break
    const next = html[lt + 1] ?? ''
    if (html.startsWith('<!--', lt)) { i = commentEnd(html, lt); continue }
    if (next === '/' || next === '!' || next === '?') {
      const gt = html.indexOf('>', lt)
      i = gt === -1 ? html.length : gt + 1
      continue
    }
    if (!/[A-Za-z]/.test(next)) { i = lt + 1; continue }
    const tag = readStartTag(html, lt)
    if (tag === undefined) break
    i = tag.end
    if (TEXT_ELEMENTS.has(tag.name)) {
      const close = new RegExp('</' + tag.name + '(?=[\\t\\n\\f\\r />])', 'gi')
      close.lastIndex = i
      const found = close.exec(html)
      if (found === null) break
      i = found.index
      continue
    }
    if (tag.name !== 'script') continue

    const textEnd = scriptTextEnd(html, tag.end)
    if (textEnd === -1) break
    const closeEnd = html.indexOf('>', textEnd) + 1 || html.length
    i = closeEnd
    const typeAttr = tag.attrs.find((attr) => attr.name === 'type')
    const type = typeAttr === undefined ? '' : typeAttr.value.trim().toLowerCase()
    const kind = type === 'module' ? 'module' : CLASSIC_SCRIPT_TYPES.has(type) ? 'classic' : undefined
    if (kind === undefined || tag.attrs.some((attr) => attr.name === 'src' || attr.name === 'nomodule')) continue

    const open = html.slice(lt, tag.end - 1)
    let typeFrom = typeAttr === undefined ? 0 : typeAttr.start - lt
    while (typeFrom > 0 && isSpace(open[typeFrom - 1])) typeFrom--
    const withoutType = typeAttr === undefined ? open : open.slice(0, typeFrom) + open.slice(typeAttr.end - lt)
    out += html.slice(copied, lt) + withoutType + ' type="text/plain" data-orivon-inline>' + html.slice(tag.end, textEnd) + html.slice(textEnd, closeEnd) +
      '<script src="' + runnerSrc + '" data-orivon-run="' + kind + '"' + (kind === 'module' ? ' defer' : '') + '></script>'
    copied = closeEnd
  }
  return out + html.slice(copied)
}

function preparePluginFrames (kit) {
  kit.expose('preparePluginFrameHtml', preparePluginFrameHtml)
  if (kit.getOrivon() === undefined || typeof HTMLIFrameElement === 'undefined') return
  const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')
  if (descriptor === undefined || descriptor.set === undefined) return
  Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
    ...descriptor,
    set (html) {
      const isPluginFrame = this.hasAttribute('data-plugin-iframe')
      descriptor.set.call(this, isPluginFrame ? preparePluginFrameHtml(String(html), new URL(PLUGIN_FRAME_RUNNER, document.baseURI).href) : html)
    }
  })
}

// Schemes a click may hand to a new browser tab. upstream's own list
// (electron/shared-with-frontend/is-external-url-allowed.ts) adds app deep
// links and file:, which a browser tab cannot open.
const OPENABLE_SCHEMES = ['http:', 'https:', 'mailto:']

function openExternalUrl (url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return
  }
  if (!OPENABLE_SCHEMES.includes(parsed.protocol)) return
  window.open(parsed.href, '_blank', 'noopener,noreferrer')
}

function platformIs (pattern) {
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? ''
  return pattern.test(platform)
}

function appMembers (kit) {
  declareElectronRenderer(kit)
  guardSingleInstance(kit)
  preparePluginFrames(kit)
  kit.expose('declareElectronRenderer', declareElectronRenderer)
  kit.expose('guardSingleInstance', guardSingleInstance)
  kit.expose('openExternalUrl', openExternalUrl)

  return {
    // The zoom behaviour sets document.documentElement.style.zoom; the app reads
    // the factor back to step it up and down, and an unset style means 1.
    getZoomFactor: () => {
      const factor = Number.parseFloat(document.documentElement.style.zoom)
      return Number.isFinite(factor) && factor > 0 ? factor : 1
    },

    // The page's own platform string. The app reads it for an emoji-picker hint
    // and for the separator of a clipboard-images folder name.
    isLinux: () => platformIs(/linux/i),

    // The Import/Export settings page asks where automatic backups go, in a
    // constructor and without a catch, and adds its backup section only when an
    // answer arrives. There is no such folder here, so no answer ever arrives
    // and the section never appears; a rejection would be an unhandled one every
    // time the page opens.
    getBackupPath: () => new Promise(() => {}),

    // The General settings page asks for the assistant-access (MCP endpoint)
    // state when it opens, and its helper turns a rejection into an error
    // snackbar, so a refusal would show "could not save" every time the page
    // opens. No answer leaves the state empty, which greys the switch out; the
    // endpoint is a listener the main process runs and this port has none.
    getAssistantAccessState: () => new Promise(() => {}),

    // upstream opens the link in the operating system's handler; here it is a
    // new tab, which Orivon opens when a click or key press came a moment ago.
    openExternalUrl,

    // The app reloads its window after a data import or an unrecoverable error.
    // That is the page's own reload.
    reloadMainWin: () => { window.location.reload() }
  }
}
