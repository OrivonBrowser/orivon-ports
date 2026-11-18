// Opens a built 5chan and a built seedit in an ordinary browser, with no Orivon, the way a person meets them through a web
// host or an IPFS path gateway: each tree is served twice, from the root of a host and under `/ipfs/<the tree's CID>/`, where
// nothing outside that folder answers. A test-side tool, never served.
//
//   node apps/bitsocial-node/test/plain-browser.mjs [--trees <dir>] [--shots <dir>] [--continue] [5chan] [seedit]
//
// It needs `playwright` with a headless Chromium, read from `MODULES` (a node_modules folder) first, then from this
// checkout's node_modules. `--trees` names the folder that holds `<app>/static` (default `out`), `--shots` the folder the
// screenshots go to (default `out/plain-browser-shots`); `--continue` opens each page as a visitor who already pressed the hint's "Continue
// anyway", which is how a tree whose hint is a landing (tier 2) is checked past it. It prints a JSON list of the runs and exits 1 when one failed.
//
// What it asserts is what the page does itself, never that content loads: the app's root rendered, none of the desktop's
// values exists, no request or socket went to a loopback address other than the test server, and the hint's landing is not
// shown. Every other address is refused (a route, and a proxy that is not there, loopback addresses included), so no request
// reaches a Bitsocial service, a gateway, a tracker or another program on this machine; the hosts the page asked for are listed in the run.

import http from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const TEST = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(TEST, '..', '..', '..')
const args = process.argv.slice(2)
const option = (name, fallback) => { const at = args.indexOf(name); return at === -1 ? fallback : resolve(args[at + 1] ?? '') }
const TREES = option('--trees', join(REPO, 'out'))
const SHOTS = option('--shots', join(REPO, 'out', 'plain-browser-shots'))
const named = args.filter((one, at) => !one.startsWith('--') && !args[at - 1]?.startsWith('--'))
const CONTINUE = args.includes('--continue')
const APPS = named.length > 0 ? named : ['5chan', 'seedit']
const SETTLE_MS = 4000
const MOUNT_TIMEOUT_MS = 45_000
const PLACEHOLDER_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

async function load (name, entry) {
  const roots = [process.env['MODULES'], join(REPO, 'node_modules')].filter((root) => root !== undefined && root !== '')
  for (const root of roots) {
    const path = join(root, name, entry)
    if (existsSync(path)) return await import(pathToFileURL(path).href)
  }
  throw new Error(`${name} was not found in ${roots.join(' or ')}. Set MODULES to a node_modules folder that has playwright.`)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8'
}

/** A static server for one tree. With a `prefix`, only paths under it answer, as a path gateway's folder does. */
function serve (root, prefix) {
  const missing = []
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    let path = decodeURIComponent(url.pathname)
    if (prefix !== '') {
      if (!path.startsWith(prefix)) { missing.push(path); response.writeHead(404).end('not in the folder'); return }
      path = `/${path.slice(prefix.length)}`
    }
    if (path.endsWith('/')) path += 'index.html'
    const file = normalize(join(root, path))
    if (file !== root && !file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return }
    try {
      const body = await readFile(file)
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body)
    } catch {
      missing.push(url.pathname)
      response.writeHead(404).end('not found')
    }
  })
  return new Promise((resolveServer) => { server.listen(0, '127.0.0.1', () => { resolveServer({ server, port: server.address().port, missing }) }) })
}

async function cidOf (root) {
  try {
    const { stdout } = await promisify(execFile)('node', [join(REPO, 'src', 'cli.ts'), 'cid', root], { maxBuffer: 1 << 20 })
    const cid = stdout.trim().split('\n').at(-1) ?? ''
    return /^baf[a-z0-9]+$/.test(cid) ? cid : PLACEHOLDER_CID
  } catch {
    return PLACEHOLDER_CID
  }
}

// What the bridge sets inside Orivon. `defaultPkcOptions` is not here: the renderer writes it itself from its web defaults, so what is
// checked is that it holds no RPC client and no loopback address.
const DESKTOP_VALUES = ['isElectron', 'electronApi', 'electron', 'defaultMediaIpfsGatewayUrl', 'pkcRpcAuthKey']

/** Read inside the page: what the bridge, the hint and the app left on it. */
function inspect (desktopValues) {
  const root = document.getElementById('root')
  const hint = document.querySelector('orivon-hint')
  const native = (fn) => typeof fn === 'function' && /\[native code\]/.test(Function.prototype.toString.call(fn))
  let key = 'unreadable'
  try { key = localStorage.getItem('orivon.pkcRpcAuthKey') } catch {}
  return {
    rootChildren: root === null ? 0 : root.children.length,
    reactMounted: root !== null && Object.keys(root).some((name) => name.startsWith('__reactContainer')),
    desktopValues: desktopValues.filter((name) => window[name] !== undefined),
    storedKey: key,
    pkcOptionKeys: window.defaultPkcOptions === undefined ? null : Object.keys(window.defaultPkcOptions),
    pkcOptionsDesktop: window.defaultPkcOptions !== undefined && /pkcRpcClientsOptions|localhost|127\.0\.0\.1/.test(JSON.stringify(window.defaultPkcOptions)),
    fetchIsNative: native(window.fetch),
    webSocketIsNative: native(window.WebSocket),
    hintMode: hint === null ? null : hint.getAttribute('data-mode'),
    plaintext: document.querySelector('plaintext') !== null,
    heldEntries: document.querySelectorAll('script[type="orivon-held-module"]').length,
    orivon: typeof window.orivon,
    title: document.title,
    location: location.href
  }
}

function localAttempt (target, testPort) {
  let url
  try { url = new URL(target) } catch { return false }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (!loopback) return false
  const port = url.port === '' ? (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80') : url.port
  return url.hostname !== '127.0.0.1' || port !== String(testPort)
}

async function visit (chromium, app, mode, base, testPort, missing) {
  const browser = await chromium.launch({
    headless: true,
    // Nothing leaves the machine, and nothing reaches another program on it (the owner's own Orivon listens on loopback ports): every address
    // but the test server's is sent to a proxy that is not there, loopback ones included, and WebRTC may not use a route a proxy would not carry.
    args: [`--proxy-server=socks5://127.0.0.1:1`, `--proxy-bypass-list=<-loopback>;127.0.0.1:${String(testPort)}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const refused = new Map()
  const local = []
  await context.route('**/*', async (route) => {
    const target = route.request().url()
    const url = new URL(target)
    if (url.protocol === 'data:' || url.protocol === 'blob:') { await route.continue(); return }
    if (url.hostname === '127.0.0.1' && url.port === String(testPort)) { await route.continue(); return }
    if (localAttempt(target, testPort)) local.push(`${route.request().method()} ${target}`)
    refused.set(url.host, (refused.get(url.host) ?? 0) + 1)
    await route.abort('blockedbyclient')
  })
  if (CONTINUE) await context.addInitScript(() => { try { sessionStorage.setItem('orivon-hint:state', 'continue') } catch {} })
  const page = await context.newPage()
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200)) })
  page.on('pageerror', (error) => { pageErrors.push(String(error.message).slice(0, 200)) })
  // A socket is not routed; it is seen when it is made, and the proxy that is not there refuses it.
  page.on('websocket', (socket) => {
    const target = socket.url()
    if (localAttempt(target, testPort)) local.push(`WebSocket ${target}`)
    refused.set(new URL(target).host, (refused.get(new URL(target).host) ?? 0) + 1)
  })

  const failures = []
  let state = null
  try {
    await page.goto(`http://127.0.0.1:${String(testPort)}${base}`, { waitUntil: 'load', timeout: 60_000 })
    const deadline = Date.now() + MOUNT_TIMEOUT_MS
    do {
      state = await page.evaluate(inspect, DESKTOP_VALUES)
      if (state.reactMounted && state.rootChildren > 0) break
      await page.waitForTimeout(500)
    } while (Date.now() < deadline)
    await page.waitForTimeout(SETTLE_MS)
    state = await page.evaluate(inspect, DESKTOP_VALUES)
  } catch (error) {
    failures.push(`the page did not load: ${error instanceof Error ? error.message : String(error)}`)
  }

  let worker = null
  try {
    worker = await page.evaluate(async () => {
      const found = await navigator.serviceWorker?.getRegistrations?.()
      return found === undefined ? 'no API' : found.map((one) => ({ scope: one.scope, state: (one.active ?? one.installing ?? one.waiting)?.state ?? 'none' }))
    })
  } catch {}

  if (state !== null) {
    if (!state.reactMounted || state.rootChildren === 0) failures.push(`the app's root did not render (react mounted: ${String(state.reactMounted)}, children: ${String(state.rootChildren)})`)
    if (state.desktopValues.length > 0) failures.push(`the page has the desktop's values: ${state.desktopValues.join(', ')}`)
    if (state.pkcOptionsDesktop) failures.push('the page\'s defaultPkcOptions names an RPC client or a loopback address')
    if (state.storedKey !== null) failures.push('the page stored an RPC key')
    if (!state.fetchIsNative) failures.push('window.fetch is not the browser\'s own')
    if (!state.webSocketIsNative) failures.push('window.WebSocket is not the browser\'s own')
    if (state.hintMode === 'landing' || state.plaintext) failures.push('the hint\'s landing is shown, and the app is held back')
    if (state.heldEntries > 0) failures.push('the module entry is still held')
  }
  if (local.length > 0) failures.push(`the page reached for a loopback address: ${local.join('; ')}`)

  await mkdir(SHOTS, { recursive: true })
  const shot = join(SHOTS, `${app}-${mode}.png`)
  await page.screenshot({ path: shot })
  await browser.close()
  return {
    app,
    mode,
    url: `http://127.0.0.1:${String(testPort)}${base}`,
    ok: failures.length === 0,
    failures,
    state,
    serviceWorker: worker,
    refusedHosts: Object.fromEntries([...refused].sort((a, b) => b[1] - a[1])),
    loopbackAttempts: local,
    notFound: [...new Set(missing)],
    consoleErrors: [...new Set(consoleErrors)].slice(0, 8),
    pageErrors: [...new Set(pageErrors)].slice(0, 8),
    screenshot: shot
  }
}

const { chromium } = await load('playwright', 'index.mjs')
const runs = []
for (const app of APPS) {
  const root = join(TREES, app, 'static')
  if (!existsSync(join(root, 'index.html'))) { runs.push({ app, ok: false, failures: [`${root} has no built tree`] }); continue }
  const cid = await cidOf(root)
  for (const [mode, prefix] of [['root', ''], ['gateway', `/ipfs/${cid}/`]]) {
    const { server, port, missing } = await serve(root, prefix)
    try {
      runs.push(await visit(chromium, app, mode, prefix === '' ? '/' : prefix, port, missing))
    } finally {
      server.close()
    }
  }
}
process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`)
const failed = runs.filter((run) => !run.ok)
process.stderr.write(`${String(runs.length - failed.length)} of ${String(runs.length)} runs passed\n`)
process.exit(failed.length === 0 ? 0 : 1)
