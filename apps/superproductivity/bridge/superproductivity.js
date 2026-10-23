// The five window.ea members that carry a decision rather than a shape, and the
// two document-level edits that are not members: telling the renderer it runs in
// Electron, and keeping a second tab of the app out.
//
// The other 68 are declared in ./members.json and generated -- see ../README.md
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

    // upstream opens the link in the operating system's handler; here it is a
    // new tab, which Orivon opens when a click or key press came a moment ago.
    openExternalUrl,

    // The app reloads its window after a data import or an unrecoverable error.
    // That is the page's own reload.
    reloadMainWin: () => { window.location.reload() }
  }
}
