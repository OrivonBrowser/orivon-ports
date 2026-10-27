// Starts the IPFS node this page publishes from: Orivon's IPFS node, built for WebAssembly and shipped in this
// app at /bin/ipfs-node, spawned through Orivon's Node shim under the app's own grants. The build bundles this
// one file with the shim into node-launch.js; the rest of the page never imports it, so it loads only in
// Orivon. A node another tab of Share started is joined, since a spawned program lives until the
// app's last page closes.

import { spawn } from 'child_process'

const PROGRAM = '/bin/ipfs-node'
/** The ports orivon.json lets the node listen on, and the page reach. */
const FIRST_PORT = 5200
const LAST_PORT = 5209
/** The ports orivon.json lets the node accept IPFS connections on, one for each API port above. */
const FIRST_P2P_PORT = 4801
const START_WAIT_MS = 30_000
/** All of a start, whatever ports it tries. */
const START_BUDGET_MS = 60_000
const RETRY_MS = 300
const STDERR_KEPT = 2048
/** Lines the node says on stderr that reach the page's console (and so a bug report) in one run. */
const STDERR_LINES_SHOWN = 200
/** What the node traces: warnings only, unless the page's localStorage `share.nodeTrace` names a filter (`warn,freedom_ipfs_serve=debug`), to reproduce a problem in detail. */
const TRACE_FILTER = /^[A-Za-z0-9_=,:.-]{1,200}$/
function traceFilter () {
  try {
    const chosen = globalThis.localStorage?.getItem('share.nodeTrace') ?? ''
    return TRACE_FILTER.test(chosen) ? chosen : 'warn'
  } catch {
    return 'warn'
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The node answering at `port` with this key, or null. @param {number} port @param {string} key */
async function ask (port, key) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/id`, { headers: { 'x-orivon-key': key }, signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return null
    const { peer } = await response.json()
    return typeof peer === 'string' ? { base: `http://127.0.0.1:${port}`, peer } : null
  } catch {
    return null
  }
}

/** Spawns the node on `port`; resolves once it answers, rejects with what it said if it ends first. */
async function spawnOn (port, key, deadline, signal) {
  let ended = null
  let stderr = ''
  const trace = traceFilter()
  const shownLines = trace === 'warn' ? STDERR_LINES_SHOWN : 20 * STDERR_LINES_SHOWN
  const child = spawn(PROGRAM, ['--online', '--routing-mode', 'auto', '--serve', '--api-key', key, '--addr', `127.0.0.1:${port}`, '--p2p-port', String(FIRST_P2P_PORT + (port - FIRST_PORT)), '--trace-filter', trace])
  let said = 0
  let pending = ''
  const decoder = new TextDecoder()
  const show = (line) => {
    if (line.trim() !== '' && said++ < shownLines) console.warn(`[ipfs-node] ${line.replace(/[0-9a-f]{64}/gi, '<key>').slice(0, 400)}`)
  }
  child.stderr.on('data', (chunk) => {
    const text = decoder.decode(chunk, { stream: true })
    stderr = (stderr + text).slice(-STDERR_KEPT)
    const lines = (pending + text).split('\n')
    pending = lines.pop() ?? ''
    lines.forEach(show)
  })
  child.on('error', (error) => { ended = error.message })
  child.on('exit', (code, signal) => { show(pending); ended = `it ended (${signal ?? `code ${String(code)}`})${stderr.trim() === '' ? '' : `: ${stderr.trim().split('\n').slice(-2).join(' ')}`}` })
  const until = Math.min(Date.now() + START_WAIT_MS, deadline)
  while (Date.now() < until) {
    if (signal?.aborted) {
      child.kill()
      throw new DOMException('The upload was cancelled.', 'AbortError')
    }
    const node = await ask(port, key)
    if (node !== null) return node
    if (ended !== null) throw new Error(ended)
    await sleep(RETRY_MS)
  }
  child.kill()
  throw new Error('it did not answer in time')
}

/**
 * The page's node: `{ base, peer, port }`, its HTTP address, its peer id and its port. A node is looked for
 * on `port`, where this page last ran one (another tab's, or this page's before a reload), and spawned there
 * or on the next free port of the range.
 * @param {{ key: string, port?: number | null, signal?: AbortSignal }} options `key`: 64 hex characters, the same for every tab of Share
 */
async function start ({ key, port: last = null, signal }) {
  const deadline = Date.now() + START_BUDGET_MS
  const first = Number.isInteger(last) && last >= FIRST_PORT && last <= LAST_PORT ? last : FIRST_PORT
  const running = await ask(first, key)
  if (running !== null) return { ...running, port: first }
  const order = [first, ...Array.from({ length: LAST_PORT - FIRST_PORT + 1 }, (_, i) => FIRST_PORT + i).filter((p) => p !== first)]
  let reason = 'no port was free'
  for (const port of order) {
    if (Date.now() >= deadline) break
    try {
      return { ...await spawnOn(port, key, deadline, signal), port }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      reason = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(`Your IPFS node could not start: ${reason}.`)
}

globalThis.shareNode = { start }
