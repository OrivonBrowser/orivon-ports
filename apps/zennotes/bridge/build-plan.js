// The build's decisions, as plain functions esbuild.orivon.config.mjs and hooks.mjs call and
// build-plan.test.ts proves: where the bundle goes, how upstream's entry document starts it, which
// modules the bundle must and must not hold, and which channels the preload sends. The metafile
// gate and the shim plugin are src/build/esbuild-kit.mjs's.

/** The bundle, relative to the served tree: upstream's preload and the part of its main process the notes need, as one classic script. */
export const BUNDLE_FILE = 'orivon/zennotes.js'

/** The script that starts upstream's renderer once the bundle's start-up work (config, user data) is done. */
export const START_FILE = 'orivon/zennotes-start.js'

/** Where the bundle keeps what upstream's main process keeps in `~/.config/zennotes`: the app's own files. */
export const CONFIG_DIR = '/orivon/app/config'

/**
 * Modules upstream's main process imports that the port answers itself, each in bridge/: the
 * `electron` module (orivon-mvp's shim plus the two members the preload needs), and the file
 * watcher, which needs `fs.watch`.
 */
export const STAND_INS = {
  electron: 'electron.js',
  chokidar: 'no-watch.js'
}

/**
 * Native modules upstream reaches for. Orivon runs no machine code for an app, so each fails to load
 * the way an optional dependency that was never installed does. Every one is behind a try/catch or
 * a dynamic import in upstream's own code.
 */
export const REFUSED_NATIVE = ['keytar', 'font-list', 'fsevents']

/** The module a refused native addon resolves to: it throws on load, with the code Node gives a module that is not installed. */
export function refusedNativeSource (name) {
  const message = `${name} is a native module, which the Orivon port of ZenNotes does not load`
  return `throw Object.assign(new Error(${JSON.stringify(message)}), { code: 'MODULE_NOT_FOUND' })\n`
}

/**
 * Inputs the bundle must hold, each proving the piece of upstream the notes need is in it, and
 * inputs it must not hold, each proving a stand-in took effect. Paths are relative to the clone.
 */
export const REQUIRED_INPUTS = [
  { path: 'apps/desktop/src/preload/index.ts', why: 'upstream\'s preload: it builds window.zen, the object the renderer calls' },
  { path: 'apps/desktop/src/main/vault.ts', why: 'upstream\'s vault module: it reads and writes the notes' },
  { path: 'apps/desktop/src/main/app-config.ts', why: 'upstream\'s settings file' },
  { path: 'packages/bridge-contract/src/ipc.ts', why: 'the channel names the preload sends and the bundle answers' }
]

export const FORBIDDEN_PREFIXES = [
  ...REFUSED_NATIVE.map((name) => ({ prefix: `node_modules/${name}/`, why: `${name} is a native module, refused by refusedNativeSource` })),
  { prefix: 'node_modules/chokidar/', why: 'chokidar is answered by bridge/no-watch.js, which did not take effect' },
  { prefix: 'node_modules/electron/', why: 'the electron module is answered by bridge/electron.js, which did not take effect' }
]

const MODULE_SCRIPT = /<script type="module" crossorigin src="([^"]+)"><\/script>/

/** The start script's text: it waits for the bundle's start-up work, then loads the module upstream's document loaded. The address is the document's own, because the script sits in a directory of its own and a relative import would be read from there. */
export function startScript (entryHref) {
  return `// Starts upstream's renderer once the bundle has read the settings and the app's files.\n`
    + `{\n`
    + `  const ready = globalThis.__zennotesReady ?? Promise.resolve()\n`
    + `  const entry = new URL(${JSON.stringify(entryHref)}, document.baseURI).href\n`
    + `  ready.then(() => import(entry), (error) => { console.error('ZenNotes could not start:', error) })\n`
    + `}\n`
}

/**
 * Upstream's built document with the bundle first in the head and the renderer's entry module started
 * by START_FILE instead of by the document. Returns the entry module's address too, for START_FILE.
 */
export function startHtml (html) {
  if (html.includes(BUNDLE_FILE)) return { html, entry: null }
  const match = MODULE_SCRIPT.exec(html)
  if (match === null) {
    throw new Error('the built index.html no longer loads its renderer with one <script type="module" crossorigin src=...>: upstream\'s document changed shape')
  }
  const rewritten = html
    .replace(MODULE_SCRIPT, `<script src="${START_FILE}"></script>`)
    .replace(/<head>/i, `<head>\n    <script src="${BUNDLE_FILE}"></script>`)
  return { html: rewritten, entry: match[1] }
}

const SENT = /ipcRenderer\.(?:invoke|send|sendSync)\(\s*(?:\n\s*)?IPC\.([A-Z0-9_]+)/g
const MENTIONED = /\bIPC\.([A-Z0-9_]+)/g

/** The channels upstream's preload sends to main, from its source. */
export function sentChannels (preloadSource) {
  return new Set([...preloadSource.matchAll(SENT)].map(([, channel]) => channel))
}

/**
 * The channels the bridge's own sources name. A channel is registered by a line that names it, so
 * a sent channel no source names is one nothing answers; the page's first run proves the rest.
 */
export function answeredChannels (...sources) {
  const channels = new Set()
  for (const source of sources) for (const [, channel] of source.matchAll(MENTIONED)) channels.add(channel)
  return channels
}

/** A sent channel nobody answers is a call that rejects or hangs, far from its cause. */
export function unansweredChannels (sent, answered) {
  return [...sent].filter((channel) => !answered.has(channel)).sort()
}
