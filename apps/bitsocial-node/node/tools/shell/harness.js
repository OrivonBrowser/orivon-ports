// What every run in the Orivon shell shares: the built app served from this process, the shell launched headless, the
// page the app opens, and counters on the broker's control channel. `shell.js` (the go/no-go with a local reader),
// `starts.js` (the node's start, alone) and `network.js` (the real network) build on it. Run through `run.js`, which sets
// `ORIVON_MVP_ROOT` (a built Orivon checkout), `DRIVE_DIST` (the built app) and `DRIVE_RESULTS`.

import { createServer } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { waitFor } from '../scenario.js'

export const ROOT = process.env['ORIVON_MVP_ROOT']
export const DIST = process.env['DRIVE_DIST']
export const RESULTS = process.env['DRIVE_RESULTS']
if (ROOT === undefined || DIST === undefined || RESULTS === undefined) throw new Error('ORIVON_MVP_ROOT, DRIVE_DIST and DRIVE_RESULTS are required (run.js sets them)')
export const PORT = Number(process.env['DRIVE_PORT'] ?? 8954)
export const ORIGIN = `http://127.0.0.1:${PORT}`
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.css': 'text/css', '.svg': 'image/svg+xml' }

const { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } = await import(`${ROOT}/test/support/launch-electron.mjs`)
const { findChrome, findViewShowing } = await import(`${ROOT}/test/support/smoke-helpers.mjs`)
const { APP_CLOSE_RACE_MS, clickAddressBarRetrying, waitForAddressBarStable } = await import(`${ROOT}/test/support/e2e-helpers.js`)
const { answerEveryQuestion, stubNativeDialogs } = await import(`${ROOT}/test/support/question-support.js`)

/** The promise's value, or `fallback` when it rejects or `ms` pass. */
export const within = async (promise, ms, fallback) => {
  let timer
  try { return await Promise.race([promise.catch(() => fallback), new Promise((resolve) => { timer = setTimeout(() => { resolve(fallback) }, ms) })]) } finally { clearTimeout(timer) }
}

export const free = () => new Promise((resolve) => { const s = createSocketServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => { resolve(port) }) }) })

/**
 * Counts every call the shell's broker receives on its control channel, by method, from the main process (a read-only
 * wrapper around the handler, installed from the test; nothing of the shell is changed).
 */
export async function countControlCalls (app) {
  await app.evaluate(({ ipcMain }) => {
    const counts = globalThis.__controlCounts = {}
    const wrap = () => {
      const handlers = ipcMain._invokeHandlers
      const current = handlers?.get('orivon:control')
      if (current === undefined || current.__counted === true) return
      const paths = globalThis.__controlPaths = {}
      const counted = async (event, envelope) => {
        const method = envelope?.method ?? '?'
        counts[method] = (counts[method] ?? 0) + 1
        const where = envelope?.payload?.path ?? envelope?.payload?.from ?? null
        if (typeof where === 'string') { const key = `${method} ${where.replace(/[0-9a-f]{8,}|[A-Za-z0-9]{40,}/g, '<id>').split('/').slice(-3).join('/')}`; paths[key] = (paths[key] ?? 0) + 1 }
        return await current(event, envelope)
      }
      counted.__counted = true
      handlers.set('orivon:control', counted)
    }
    wrap()
    globalThis.__controlWrap = setInterval(wrap, 250)
  })
}

/** The calls on a handle the origin already holds, which the broker paces on a budget of their own instead of the control one (`control-limiter.ts`). */
const HANDLE_IO_METHODS = new Set(['fs.read', 'fs.write', 'fs.fstat', 'fs.truncate', 'fs.sync', 'fs.close', 'net.close', 'net.setNoDelay', 'net.setKeepAlive', 'net.cancel'])

/**
 * The control calls (a budget of 200, refilled at 100 a second) per second, sampled until `stop()`. Every second is kept in
 * `series` as `{ at, control, handle }` (calls per second, the handle ones apart); each second at or above `threshold` is
 * also kept in `busy` with its busiest methods.
 * @param {{ evaluate: Function }} app @param {Array<{ at: string, controlPerSecond: number, handlePerSecond: number, top: Array<[string, number]> }>} busy
 * @param {Array<{ at: number, control: number, handle: number }>} [series]
 */
export function sampleControlCalls (app, busy, series = [], threshold = 40) {
  let stopped = false
  let last = {}
  let lastAt = Date.now()
  const done = (async () => {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const now = await within(app.evaluate(() => JSON.stringify(globalThis.__controlCounts ?? {})), 4000, null)
      if (now === null) continue
      const counts = JSON.parse(now)
      const at = Date.now()
      const seconds = (at - lastAt) / 1000
      const delta = Object.entries(counts).map(([method, total]) => [method, total - (last[method] ?? 0)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
      const control = delta.filter(([method]) => !HANDLE_IO_METHODS.has(method))
      const total = control.reduce((sum, [, n]) => sum + n, 0)
      const handle = delta.reduce((sum, [, n]) => sum + n, 0) - total
      series.push({ at, control: total / seconds, handle: handle / seconds })
      if (total / seconds >= threshold) busy.push({ at: new Date(at).toISOString(), controlPerSecond: Math.round(total / seconds), handlePerSecond: Math.round(handle / seconds), top: control.slice(0, 4) })
      last = counts
      lastAt = at
    }
  })()
  return async () => { stopped = true; await done }
}

/** Mean and peak of the control calls per second between two instants (ms since the epoch). @param {Array<{ at: number, control: number, handle: number }>} series */
export function controlRate (series, from, to) {
  const inside = series.filter((one) => one.at >= from && one.at <= to)
  if (inside.length === 0) return null
  const mean = (/** @type {'control' | 'handle'} */ key) => inside.reduce((sum, one) => sum + one[key], 0) / inside.length
  const peak = (/** @type {'control' | 'handle'} */ key) => Math.max(...inside.map((one) => one[key]))
  return { seconds: inside.length, controlMean: Math.round(mean('control')), controlPeak: Math.round(peak('control')), secondsAbove100: inside.filter((one) => one.control > 100).length, handleMean: Math.round(mean('handle')), handlePeak: Math.round(peak('handle')) }
}

/**
 * Serves the built app on `PORT`. The manifest gets `connect` added to its `tcp.connect` (`*:*` does not cover a loopback address, which
 * the shell refuses a socket to unless it is listed); `pageScript`, when given, runs in the page ahead of the app's own script
 * (to change what the app's page asks `startBitsocialNode` for); `serverPrefix` is put ahead of the Worker bundle.
 * @param {{ connect?: string[], pageScript?: string, serverPrefix?: string }} [options]
 */
export function serveApp ({ connect = [], pageScript, serverPrefix } = {}) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', ORIGIN).pathname)
    if (path === '/.well-known/orivon.json') {
      const manifest = JSON.parse(readFileSync(join(DIST, path), 'utf8'))
      manifest.capabilities.net.tcp.connect.push(...connect)
      res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify(manifest)); return
    }
    if (path === '/__drive/page.js' && pageScript !== undefined) { res.writeHead(200, { 'content-type': MIME['.js'] }).end(pageScript); return }
    const file = normalize(join(DIST, path === '/' ? 'index.html' : path))
    if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('not found'); return }
    let body = readFileSync(file)
    if ((path === '/' || path === '/index.html') && pageScript !== undefined) body = body.toString('utf8').replace('<script src="status.js">', '<script src="/__drive/page.js"></script>\n<script src="status.js">')
    if (path === '/node/server.mjs' && serverPrefix !== undefined) body = Buffer.concat([Buffer.from(serverPrefix), body])
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body)
  })
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', () => { resolve(server) }) })
}

/**
 * Launches the shell, lets the consent question through and opens the app. `pageLogs` collects every console line and page error of
 * the app's page; `snapshot()` is what the page's `bitsocialNodeApp` holds, null before the page has it.
 * @param {{ log: (line: string) => void, controlCalls?: Array<object>, series?: Array<object> }} options
 */
export async function openApp ({ log, controlCalls = [], series = [] }) {
  const pageLogs = []
  const app = await launchElectron({ appPath: '.', args: [] })
  await countControlCalls(app).catch((error) => { log(`no control-call counter: ${String(error)}`) })
  const stopCounting = sampleControlCalls(app, controlCalls, series)
  await stubNativeDialogs(app)
  answerEveryQuestion(app)
  const attach = (page) => {
    const tag = () => page.url().replace(ORIGIN, '').slice(0, 40) || 'page'
    page.on('console', (m) => { pageLogs.push(`[${tag()}] ${m.type()}: ${m.text().slice(0, 600)}`) })
    page.on('pageerror', (e) => { pageLogs.push(`[${tag()}] pageerror: ${e.message.slice(0, 500)}`) })
  }
  for (const page of app.windows()) attach(page)
  app.context().on('page', attach)
  await waitFor(() => app.windows().length === 2, 60_000, 'the shell never opened its two windows')
  const chrome = findChrome(app)
  await waitForAddressBarStable(chrome)
  await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
  const viewOf = () => findViewShowing(app, chrome, `${ORIGIN}/`) ?? app.windows().find((w) => w.url().startsWith(ORIGIN))
  const snapshot = async () => {
    const view = viewOf()
    if (view === undefined) return null
    const text = await within(view.evaluate(() => { const a = window.bitsocialNodeApp; return JSON.stringify(a === undefined ? null : { error: a.error, snapshot: a.handle?.snapshot() ?? null, rpcUrl: a.handle?.rpcUrl ?? null }) }), 8000, 'null')
    return JSON.parse(text)
  }
  /** Runs `fn` in the app's page and returns its JSON value, `fallback` when the page does not answer in `ms`. */
  const inPage = async (fn, arg, ms = 30_000, fallback = null) => {
    const view = viewOf()
    return view === undefined ? fallback : await within(view.evaluate(fn, arg), ms, fallback)
  }
  return { app, chrome, pageLogs, snapshot, inPage, viewOf, stopCounting }
}

/** The totals the run's counters hold, the shell's own output, and the shell closed with nothing left of it. */
export async function closeApp (app, stopCounting, result) {
  await stopCounting().catch(() => {})
  result.controlTotals = JSON.parse(await within(app.evaluate(() => JSON.stringify(globalThis.__controlCounts ?? {})), 4000, '{}'))
  result.controlPaths = JSON.parse(await within(app.evaluate(() => JSON.stringify(Object.entries(globalThis.__controlPaths ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 40))), 4000, '[]'))
  result.main = mainOutput(app).slice(-4000)
  result.mainLines = mainOutput(app).split('\n').filter((line) => /bitsocial|reachability|\[orivon\]\[(app|child-host)/i.test(line)).slice(-200)
  await closeElectron(app, { raceMs: APP_CLOSE_RACE_MS }).catch(() => {})
  result.survivors = await assertNoElectronSurvivors().catch((error) => String(error))
}

export { mainOutput }
