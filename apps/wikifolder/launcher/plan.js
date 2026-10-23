// The launcher's decisions, pure, so a test can drive each: whether the
// install tree needs writing and how the pack is cut into files, what the
// server and its `--init` run are given, what a line of the server's output
// means, and what a page shown in the <webview> is allowed to ask of the app.
// launcher.js does the DOM, the fork and the files, and holds no decision of
// its own.

/** Where the server listens, and the address the <webview> shows. `wiki.localhost` is web.embed's local pattern (orivon.json). */
export const PORT = 8777
export const HOST = '127.0.0.1'
export const APP_URL = `http://wiki.localhost:${String(PORT)}/`

/** Log lines the panel keeps: enough to read a start-up, bounded so a chatty server cannot grow the page. */
export const LOG_LINES = 400

/** Whether to write the install tree: when the served one is not the one already written, or none was. */
export function installNeeded (served, stored) {
  return stored === null || stored.stamp !== served.stamp
}

/** Why the served install tree is not the one this launcher's server reads, or null. The server bundle and the launcher are built together, so a different stamp is a mixed deployment. */
export function installMismatch (served, builtStamp) {
  return served.stamp === builtStamp ? null : `install.json carries stamp ${served.stamp}, but this page was built for ${builtStamp}: the app's files are from two different builds`
}

/**
 * `install.json` as fetched, checked: a stamp and `[name, size]` pairs, no
 * name climbing out of the tree, each size a whole number of bytes.
 */
export function parseInstall (text) {
  const value = JSON.parse(text)
  if (typeof value?.stamp !== 'string' || !/^[0-9a-f]{8,64}$/.test(value.stamp) || !Array.isArray(value.files) || value.files.length === 0) {
    throw new Error('install.json has no stamp or no files')
  }
  const files = value.files.map((entry) => {
    const [name, size] = Array.isArray(entry) ? entry : []
    if (typeof name !== 'string' || name === '' || name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error(`install.json names a file outside the install tree: ${String(name)}`)
    }
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`install.json gives ${name} a size that is not a number of bytes: ${String(size)}`)
    return [name, size]
  })
  return { stamp: value.stamp, files }
}

/** Each file with the offset of its bytes in the pack: `{ name, offset, size }`, the sizes laid end to end in the order the index lists them. */
export function layout (files) {
  let offset = 0
  return files.map(([name, size]) => {
    const placed = { name, offset, size }
    offset += size
    return placed
  })
}

/** Why the pack is not the one the index describes (its length must be the sum of the sizes), or null. */
export function packMismatch (files, byteLength) {
  const expected = files.reduce((sum, [, size]) => sum + size, 0)
  return expected === byteLength ? null : `install/pack.bin holds ${String(byteLength)} bytes, but install.json describes ${String(expected)}: the app's files are from two different builds`
}

/** The directory a file of the install tree lives in, relative to the tree, or '' when it sits at the top. */
export function parentOf (file) {
  return file.split('/').slice(0, -1).join('/')
}

/** The entries of the install parent directory that are not the current tree: other versions, and anything an earlier layout left. */
export function staleInstalls (names, stamp) {
  return names.filter((name) => name !== stamp)
}

/**
 * Runs `work(item)` over `items` with at most `limit` in flight and settles
 * when all have; the first failure stops handing out items and rejects.
 */
export async function forEachLimited (items, limit, work) {
  let next = 0
  let failed = false
  const lane = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]
      try {
        await work(item)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}

/**
 * Calls a second the install tree's writes are paced to. The broker admits an
 * origin 100 control calls a second after a burst of 200, and the shim asks a
 * refused call again for about five seconds in all; a dozen callers asking
 * at once starve one another past that, so the tree's roughly fifteen
 * hundred calls are spaced out instead of retried.
 */
export const WRITES_PER_SECOND = 80

/**
 * A function to await before each call: it resolves at once while fewer than
 * `perSecond` calls a second have been asked for, and otherwise after the
 * time that keeps the rate. `now` and `sleep` are the clock, so a test can
 * drive it.
 */
export function createPacer (perSecond, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const gap = 1000 / perSecond
  let next = 0
  return async () => {
    const at = Math.max(next, now())
    next = at + gap
    const wait = at - now()
    if (wait > 0) await sleep(wait)
  }
}

/** The arguments of `tiddlywiki <wiki> --listen`: the wiki folder, then the loopback address and port as the command's named parameters. */
export function serverArgs (wikiPath) {
  return [wikiPath, '--listen', `host=${HOST}`, `port=${String(PORT)}`]
}

/** The arguments of `tiddlywiki <wiki> --init server`, upstream's own way to make a wiki folder that serves and saves. */
export function initArgs (wikiPath) {
  return [wikiPath, '--init', 'server']
}

/** The server's environment: where the install tree was written, which bridge/server-entry.js boots the kernel from. */
export function serverEnv (installPath) {
  return { WIKIFOLDER_INSTALL: installPath }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

export function stripAnsi (text) {
  return text.replace(ANSI, '')
}

/** Upstream's own line when the listener is up: "Serving on http://127.0.0.1:8777". */
export function isReady (output) {
  return /Serving on https?:\/\/\S+/.test(stripAnsi(output))
}

/**
 * Another server already holds the port: the one another tab of this app
 * started, which outlives that tab. Node says `EADDRINUSE`; orivon-mvp's
 * broker words a listen that finds every granted port taken as "no free port
 * in the granted range", and the manifest grants one port.
 */
export function isAddressInUse (output) {
  return /EADDRINUSE|no free port in the granted range/.test(output)
}

/** Waits, in ms, before each retry of a start that found the port held; after the last, the holder is taken to be another program. */
export const RETRY_DELAYS_MS = Object.freeze([250, 500, 1000, 2000])

/**
 * How long to wait before starting again after "address in use", or null to
 * conclude that the port is held for good. A start made while this page's own
 * server was still running a moment ago may only be early, since the port is
 * released after the process ends; any other start finds a holder that is
 * there to stay: the server of another tab, or another program.
 */
export function addressInUseDelay (attempt, ownServerStopped) {
  return ownServerStopped ? (RETRY_DELAYS_MS[attempt] ?? null) : null
}

/** What the status line says when the port is held and what answers there did not load. */
export function heldPortText () {
  return `Port ${String(PORT)} is held, and the page there did not load. Another program may be using it: stop that program, then press Restart.`
}

/** True when a listing of the wiki folder holds `tiddlywiki.info`, the file that makes a folder a wiki. */
export function wikiExists (names) {
  return names.includes('tiddlywiki.info')
}

/** True when `--init`'s run made the wiki folder: it exits 0 and prints its "Copied edition" line, while a folder that was not empty is an error it returns as text. */
export function initDone (output, code) {
  return code === 0 && /Copied edition 'server' to /.test(stripAnsi(output))
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
