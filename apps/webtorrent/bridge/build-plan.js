// The build's decisions, as plain functions esbuild.orivon.config.mjs calls
// and build-plan.test.ts proves: where the app lives in its own files, which
// modules the bundle must and must not hold, and the two edits to upstream's
// entry document.

import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Where the install lives in the app's own files: `__dirname` of build/config.js is APP_ROOT/build, so upstream's STATIC_PATH is APP_ROOT/static. */
export const APP_ROOT = '/orivon/app/webtorrent-desktop'

/** The one script the entry document loads. */
export const ENTRY_FILE = 'webtorrent-desktop.js'

/** The files the page copies into APP_ROOT/static, and the stamp that says when they changed. */
export const STAMP_FILE = 'install.json'

/**
 * Modules upstream requires that the port answers itself, each in bridge/:
 * the main-process objects its renderer reaches (`electron` for upstream's own
 * modules only, and @electron/remote), application-config-path, whose
 * platform switch has no branch for Orivon, and the three cast-device finders
 * and local peer discovery, which need multicast UDP.
 */
export const STAND_INS = {
  electron: 'electron.js',
  '@electron/remote': 'remote.js',
  'application-config-path': 'application-config-path.js',
  chromecasts: 'no-cast-devices.js',
  dlnacasts: 'no-cast-devices.js',
  airplayer: 'no-cast-devices.js',
  'bittorrent-lsd': 'no-local-discovery.js'
}

/**
 * Native addons. Orivon runs no machine code for an app and none of these has
 * a WebAssembly build, so each fails to load the way an optional dependency
 * that was never installed does (refusedNativeSource). Every one is required
 * inside upstream's own try/catch, which then takes its JavaScript path:
 * webtorrent runs without uTP, ws masks frames in JavaScript, chokidar polls
 * instead of using fsevents.
 */
export const REFUSED_NATIVE = ['utp-native', 'bufferutil', 'utf-8-validate', 'fsevents']

/** The module a refused native addon resolves to: it throws on load, with the code Node gives a module that is not installed. */
export function refusedNativeSource (name) {
  const message = `${name} is a native addon, which the Orivon port of WebTorrent Desktop does not load`
  return `throw Object.assign(new Error(${JSON.stringify(message)}), { code: 'MODULE_NOT_FOUND' })\n`
}

/**
 * Inputs the bundle must hold, each proving the Node resolution upstream's
 * Electron build gets: a `browser` field would have mapped every one to
 * nothing, and the app would be a WebRTC-only client with no streaming server.
 */
export const REQUIRED_INPUTS = [
  { path: 'node_modules/webtorrent/lib/conn-pool.js', why: 'TCP peers: webtorrent\'s browser field drops its connection pool' },
  { path: 'node_modules/webtorrent/lib/server.js', why: 'the streaming server the player plays from: the browser field drops it' },
  { path: 'node_modules/bittorrent-dht/client.js', why: 'the DHT: torrent-discovery\'s browser field drops it, and magnet links without trackers find no peers' },
  { path: 'node_modules/bittorrent-tracker/lib/client/udp-tracker.js', why: 'UDP trackers: bittorrent-tracker\'s browser field drops them' },
  { path: 'node_modules/ut_pex/index.js', why: 'peer exchange: webtorrent\'s browser field drops it' },
  { path: 'build/renderer/webtorrent.js', why: 'upstream\'s hidden torrent window' },
  { path: 'build/renderer/main.js', why: 'upstream\'s main window' }
]

/** Inputs the bundle must not hold: each is refused by name, or its loader is. */
export const FORBIDDEN_PREFIXES = [
  ...REFUSED_NATIVE.map((name) => ({ prefix: `node_modules/${name}/`, why: `${name} is a native addon, refused by refusedNativeSource` })),
  ...['chromecasts', 'dlnacasts', 'airplayer', 'bittorrent-lsd', 'application-config-path', '@electron/remote'].map((name) => ({ prefix: `node_modules/${name}/`, why: `${name} is answered by a stand-in (STAND_INS), which did not take effect` }))
]

/** What is wrong with a bundle, from its metafile's input paths (relative to the clone, posix). Empty when it can run. */
export function checkBundle (code, inputs) {
  const problems = []
  const held = new Set(inputs)
  for (const { path, why } of REQUIRED_INPUTS) {
    if (!held.has(path)) problems.push(`${path} is missing from the bundle (${why})`)
  }
  for (const { prefix, why } of FORBIDDEN_PREFIXES) {
    const found = inputs.find((input) => input.startsWith(prefix))
    if (found !== undefined) problems.push(`${found} is in the bundle, but ${why}`)
  }
  return problems
}

const DIRECTIVES = /^(?:#![^\n]*\n)?(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:(['"])use strict\1;?)?/

/**
 * A module's source with `__dirname` and `__filename` declared as they would
 * be in the install at APP_ROOT, after its hashbang and directive prologue so
 * a `'use strict'` stays one. A module that names neither is returned as it is.
 */
export function moduleScope (source, relPath) {
  if (!/\b__(?:dirname|filename)\b/.test(source)) return source
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
  const scope = `var __dirname = ${JSON.stringify(dir === '' ? APP_ROOT : `${APP_ROOT}/${dir}`)}, __filename = ${JSON.stringify(`${APP_ROOT}/${relPath}`)};`
  const prologue = DIRECTIVES.exec(source)?.[0] ?? ''
  const end = /['"]$/.test(prologue) ? ';' : ''
  return `${prologue}${end}${scope}${source.slice(prologue.length)}`
}

const UPSTREAM_SCRIPT = /<script>\s*require\('\.\.\/build\/renderer\/main\.js'\)\s*<\/script>/
const UPSTREAM_STYLE = /<link rel="stylesheet" href="main\.css">/

/** The tab icon: upstream sets its window icon from main, so the page names none. */
export const ICON_LINK = '<link rel="icon" type="image/png" href="static/WebTorrent.png">'

/** Upstream's static/main.html served from the tree's root: the bundle in place of its require(), its stylesheet under static/, and the icon. */
export function mainHtml (html) {
  if (!UPSTREAM_SCRIPT.test(html)) throw new Error('static/main.html no longer loads build/renderer/main.js with an inline require(): upstream changed its entry document')
  if (!UPSTREAM_STYLE.test(html)) throw new Error('static/main.html no longer links main.css: upstream changed its entry document')
  return html
    .replace(UPSTREAM_SCRIPT, `<script src="${ENTRY_FILE}"></script>`)
    .replace(UPSTREAM_STYLE, `<link rel="stylesheet" href="static/main.css">\n    ${ICON_LINK}`)
}

/**
 * The files of upstream's static/ that the app reaches by path rather than by a URL of the served tree:
 * the default torrents and their posters, which it reads with fs, and the sounds, which it plays from
 * `file://` + their path.
 */
export async function installFiles (staticDir) {
  const top = (await readdir(staticDir)).filter((name) => /\.(?:torrent|jpg)$/.test(name))
  const sounds = (await readdir(join(staticDir, 'sound')).catch(() => [])).filter((name) => name.endsWith('.wav')).map((name) => `sound/${name}`)
  return [...top, ...sounds].sort()
}

/** A short hash over each file's name and bytes, in the order given. */
export function stampOf (files) {
  const hash = createHash('sha256')
  for (const [name, bytes] of files) hash.update(`${name}\0${String(bytes.length)}\0`).update(bytes)
  return hash.digest('hex').slice(0, 16)
}

const SENT = /ipcRenderer\.send\(\s*'([^']+)'/g
const ANSWERED = /ipcMain\.on\(\s*'([^']+)'/g
const NOOP_LIST = /for \(const channel of \[([^\]]*)\]\)/

/** The channels upstream's windows send to main, from their sources; `wt-*` goes window to window, never to main. */
export function sentChannels (sources) {
  const channels = new Set()
  for (const source of sources) for (const [, channel] of source.matchAll(SENT)) if (!channel.startsWith('wt-')) channels.add(channel)
  return channels
}

/** The channels bridge/main-process.js answers: each `ipcMain.on('x', ...)`, and its list of channels answered by doing nothing. */
export function answeredChannels (mainProcessSource) {
  const channels = new Set([...mainProcessSource.matchAll(ANSWERED)].map(([, channel]) => channel))
  const list = NOOP_LIST.exec(mainProcessSource)?.[1] ?? ''
  for (const [, channel] of list.matchAll(/'([^']+)'/g)) channels.add(channel)
  return channels
}

/** A sent channel nobody answers would be a call that silently goes nowhere. */
export function unansweredChannels (sent, answered) {
  return [...sent].filter((channel) => !answered.has(channel)).sort()
}
