// What the page reports about the computer and the build, and which of the app's features this
// build hides. Upstream's preload reports the host it was written for (an Electron main process on
// the person's operating system); the renderer decides what to draw from `getCapabilities()`.

/** The operating system as Node names it, read from the browser: the shim reports `linux` on every host, and the app labels its shortcuts from this. */
export function platform (nav = globalThis.navigator) {
  const reported = nav?.userAgentData?.platform ?? nav?.platform ?? ''
  if (/mac|iphone|ipad/i.test(reported)) return 'darwin'
  if (/win/i.test(reported)) return 'win32'
  return 'linux'
}

/**
 * Upstream's capability flags, overridden where this build differs. Each `false` hides a screen the
 * build cannot back: ZenNotes Cloud and a remote server need a network grant the manifest does not
 * make; the updater, the command line tool, native menus and extra windows belong to the desktop
 * program; grammar checking and custom code languages load WebAssembly through URL schemes only the
 * desktop program registers, and assistants edit notes through a program Orivon does not start.
 */
export const CAPABILITY_OVERRIDES = {
  supportsUpdater: false,
  supportsNativeMenus: false,
  supportsFloatingWindows: false,
  supportsRemoteWorkspace: false,
  supportsCloudSync: false,
  supportsCliInstall: false,
  supportsCustomCodeLanguages: false,
  supportsHarper: false,
  supportsAgentEditReview: false,
  supportsEncryptedBackupArchive: false
}

/** What `getAppInfo().engine` says: the browser the app runs in, not an Electron it is not running in. */
export function engine (nav = globalThis.navigator) {
  const chromium = /Chrome\/([\d.]+)/.exec(nav?.userAgent ?? '')?.[1]
  return chromium === undefined ? 'Orivon' : `Orivon (Chromium ${chromium})`
}

/** The install facts the preload folds into `getAppInfo()`. */
export function installInfo (nav = globalThis.navigator) {
  const names = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
  return { os: names[platform(nav)], install: 'Orivon app' }
}

/** Applies the overrides to the object the preload published as `window.zen`. */
export function adjustHost (zen, nav = globalThis.navigator) {
  const capabilities = zen.getCapabilities.bind(zen)
  const info = zen.getAppInfo.bind(zen)
  zen.getCapabilities = () => ({ ...capabilities(), ...CAPABILITY_OVERRIDES })
  zen.getAppInfo = () => ({ ...info(), engine: engine(nav) })
  zen.platformSync = () => platform(nav)
  return zen
}
