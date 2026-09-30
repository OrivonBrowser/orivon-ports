// The launcher's decisions, pure, so a test can drive each: whether the
// install tree needs writing, what the server and its account command are
// run with, what a line of the server's output means, and what a page shown
// in the <webview> is allowed to ask of the app. launcher.js does the DOM,
// the fork and the files, and holds no decision of its own.

/** Where the server listens, and the address the <webview> shows. `lounge.localhost` is web.embed's local pattern (orivon.json). */
export const PORT = 9000
export const HOST = '127.0.0.1'
export const APP_URL = `http://lounge.localhost:${String(PORT)}/`

/** Log lines the panel keeps: enough to read a start-up, bounded so a chatty server cannot grow the page. */
export const LOG_LINES = 400

/** Whether to write the install tree: when the served one is not the one already written, or none was. */
export function installNeeded (served, stored) {
  return stored === null || stored.stamp !== served.stamp
}

/** `install.json` as fetched, checked: a stamp and a list of relative file names, none climbing out. */
export function parseInstall (text) {
  const value = JSON.parse(text)
  if (typeof value?.stamp !== 'string' || !Array.isArray(value.files) || value.files.length === 0) {
    throw new Error('install.json has no stamp or no files')
  }
  for (const file of value.files) {
    if (typeof file !== 'string' || file.startsWith('/') || file.split('/').includes('..') || file === '') {
      throw new Error(`install.json names a file outside the install tree: ${String(file)}`)
    }
  }
  return { stamp: value.stamp, files: value.files }
}

/** The parent directories a file list needs, shortest first, each once. */
export function directoriesOf (files) {
  const dirs = new Set()
  for (const file of files) {
    const parts = file.split('/').slice(0, -1)
    for (let n = 1; n <= parts.length; n++) dirs.add(parts.slice(0, n).join('/'))
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
}

/** The arguments of `thelounge start`: the port and the loopback address, as configuration overrides. */
export function serverArgs () {
  return ['start', '-c', `port=${String(PORT)}`, '-c', `host=${HOST}`]
}

/**
 * The server's environment. NODE_ENV keeps rootpath.ts on the installed
 * layout; the two WS_ variables stop `ws` looking for native accelerators
 * that a WebAssembly-and-JavaScript host never has.
 */
export function serverEnv (homePath) {
  return { THELOUNGE_HOME: homePath, NODE_ENV: 'production', WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1' }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

export function stripAnsi (text) {
  return text.replace(ANSI, '')
}

/** Upstream's own line when the listener is up: "Available at http://127.0.0.1:9000/ in private mode". */
export function isReady (output) {
  return /Available at https?:\/\/\S+/.test(stripAnsi(output))
}

/** Another server already holds the port: the one another tab of this app started, which outlives that tab. */
export function isAddressInUse (output) {
  return /EADDRINUSE/.test(output)
}

/** The log after `chunk`: whole lines, only the last `limit` kept, and the unfinished last line held in `tail`. */
export function appendLog ({ lines, tail }, chunk, limit = LOG_LINES) {
  const parts = (tail + stripAnsi(chunk)).split(/\r?\n/)
  const rest = parts.pop() ?? ''
  const all = [...lines, ...parts]
  return { lines: all.length > limit ? all.slice(all.length - limit) : all, tail: rest }
}

export const EMPTY_LOG = Object.freeze({ lines: [], tail: '' })

export function logText ({ lines, tail }) {
  return tail === '' ? lines.join('\n') : [...lines, tail].join('\n')
}

/** True when a `users/` listing holds an account: upstream stores one `<name>.json` each. */
export function hasAccounts (names) {
  return names.some((name) => name.endsWith('.json'))
}

const FORBIDDEN_NAME = /[\u0000-\u001f<>:"/\\|?*]/

/**
 * What is wrong with the first account's form, in the order the fields
 * appear. The name is a file name in the server's `users/` directory and a
 * command-line argument, so it may not hold a path separator (upstream's own
 * rule) or a character a file name cannot, nor start with a dash.
 */
export function accountProblems ({ name, password, confirm }) {
  const problems = []
  const trimmed = name.trim()
  if (trimmed === '') problems.push('Choose a user name.')
  else if (trimmed !== name) problems.push('The user name may not start or end with a space.')
  else if (FORBIDDEN_NAME.test(name)) problems.push('The user name may not contain a slash, a colon or any of < > " | ? *.')
  else if (name.startsWith('-') || name.startsWith('.')) problems.push('The user name may not start with a dash or a dot.')
  else if (name.length > 64) problems.push('The user name is longer than 64 characters.')
  if (password === '') problems.push('Choose a password.')
  else if (password !== confirm) problems.push('The two passwords differ.')
  return problems
}

/** The arguments of upstream's `add` command. `--password=` keeps a password that starts with a dash from being read as an option. */
export function addArgs ({ name, password, keepHistory }) {
  return ['add', `--password=${password}`, ...(keepHistory ? ['--save-logs'] : []), name]
}

/** True when `add`'s run made the account: it exits 0 even for "already exists", so its own line decides. */
export function accountCreated (output, code) {
  return code === 0 && /User .+ created\./.test(stripAnsi(output))
}

const SHOWN = 120
const clip = (text) => (text.length > SHOWN ? `${text.slice(0, SHOWN)}...` : text)

/** What a window the shown page asked for becomes: a tab for a web address, a named notice for anything else. */
export function popupOutcome (detail) {
  const url = String(detail?.url ?? '')
  let scheme = ''
  try { scheme = new URL(url).protocol } catch { /* not an address at all */ }
  if (scheme === 'http:' || scheme === 'https:') return { kind: 'open', url }
  if (scheme === 'about:' || url === '') return { kind: 'notice', text: 'The page tried to open an empty window. Orivon does not show it.' }
  if (scheme === '') return { kind: 'notice', text: `The page tried to open "${clip(url)}", which is not an address Orivon can open.` }
  return { kind: 'notice', text: `The page tried to open a ${scheme} link (${clip(url)}). Orivon does not hand it to another program.` }
}

/** What a download the shown page started becomes: the bytes are not kept, so it says so by name. */
export function downloadNotice (detail) {
  const name = String(detail?.filename ?? '') || 'a file'
  const bytes = Number(detail?.totalBytes ?? 0)
  const size = bytes > 0 ? `, ${bytes < 1024 * 1024 ? `${String(Math.max(1, Math.round(bytes / 1024)))} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`}` : ''
  return `The page started a download of ${clip(name)} (${String(detail?.mimeType ?? '') || 'unknown type'}${size}). Orivon does not save files from a shown page.`
}

/** The status line for a server that ended: its code or the signal that stopped it, and whether it had been ready. */
export function exitText (code, signal, wasReady) {
  const how = signal !== null && signal !== undefined ? `signal ${signal}` : `exit code ${String(code)}`
  return wasReady ? `The server stopped (${how}).` : `The server stopped before it was ready (${how}). The log below says why.`
}
