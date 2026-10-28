// Starts the IPFS node this page publishes and hosts from: Orivon's IPFS node, built for WebAssembly and shipped
// in this app at /bin/ipfs-node, spawned through Orivon's Node shim under the app's own grants. The build bundles
// this one file with the shim into node-launch.js; the rest of the editor never imports it, so it loads only in
// Orivon. A node another tab of the editor started is joined, since a spawned program lives until the
// app's last page closes; `find` looks for one without starting any, and `stop` ends only a node this page started.

import { spawn } from 'child_process'

const PROGRAM = '/bin/ipfs-node'
/** The ports orivon.json lets the node listen on, and the page reach. */
const FIRST_PORT = 5180
const LAST_PORT = 5189
/** The ports orivon.json lets the node accept IPFS connections on, one for each API port above. */
const FIRST_P2P_PORT = 4811
/** Orivon's circuit relay (apps/share/relay): a node that hosts keeps a place on it, so a wiki served from behind a home router opens by its bare IPFS address. */
const RELAY = '/ip4/152.228.138.30/tcp/4003/p2p/12D3KooWReTq9frXSU18aXYvksPBQRWj9qafTSB4gxgUg6QqqnqJ'
const START_WAIT_MS = 30_000
/** All of a start, whatever ports it tries. */
const START_BUDGET_MS = 60_000
const RETRY_MS = 300
/** How long `stop` waits for the node to end, so that the port is free for the next start. */
const STOP_WAIT_MS = 3_000
const STDERR_KEPT = 2048
/** Lines the node says that reach the page's console in one run. Orivon's report log keeps only an app page's error lines, so a failed publish (publish-dialog.js) and a failure of hosting (hosting.js) write their own. */
const LINES_SHOWN = 200
/** What the node traces: warnings only, unless the page's localStorage `decentrawiki.nodeTrace` names a filter (`warn,orivon_ipfs_serve=debug`), to reproduce a problem in detail. */
const TRACE_FILTER = /^[A-Za-z0-9_=,:.-]{1,400}$/
function traceFilter () {
  try {
    const chosen = globalThis.localStorage?.getItem('decentrawiki.nodeTrace') ?? ''
    return TRACE_FILTER.test(chosen) ? chosen : 'warn'
  } catch {
    return 'warn'
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The nodes this page spawned, by API port, so that `stop` ends those and no other tab's. @type {Map<number, { kill: () => void }>} */
const children = new Map()

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

/** The API port a node is looked for on first: where this editor last ran one, else the first of the range. @param {number | null} last */
const firstPort = (last) => Number.isInteger(last) && last >= FIRST_PORT && last <= LAST_PORT ? last : FIRST_PORT

/** What the node is started with: the flags of a node that hosts (the DHT, a port to accept connections on, a place on Orivon's relay), or of one that only publishes (nothing looked up, nothing listened on). @param {number} port @param {string} key @param {string} trace @param {boolean} listen */
function nodeArgs (port, key, trace, listen) {
  const routing = listen ? ['--routing-mode', 'auto'] : ['--routing-mode', 'offline']
  const network = listen ? ['--p2p-port', String(FIRST_P2P_PORT + (port - FIRST_PORT)), '--relay', RELAY] : []
  return ['--online', ...routing, '--serve', '--api-key', key, '--addr', `127.0.0.1:${port}`, ...network, '--trace-filter', trace]
}

/** Spawns the node on `port`; resolves once it answers, rejects with what it said if it ends first. */
async function spawnOn (port, key, deadline, signal, listen) {
  let ended = null
  let stderr = ''
  const trace = traceFilter()
  const shownLines = trace === 'warn' ? LINES_SHOWN : 20 * LINES_SHOWN
  const child = spawn(PROGRAM, nodeArgs(port, key, trace, listen))
  children.set(port, child)
  let said = 0
  const show = (line) => {
    if (line.trim() !== '' && said++ < shownLines) console.warn(`[ipfs-node] ${line.replace(/[0-9a-f]{64}/gi, '<key>').slice(0, 400)}`)
  }
  // The node writes its trace to stdout and its own messages to stderr. Both are read to their ends, whole lines
  // at a time: a pipe nobody reads fills, and a node that cannot write stops.
  const lines = (keep) => {
    let pending = ''
    const decoder = new TextDecoder()
    return {
      take (chunk) {
        const text = decoder.decode(chunk, { stream: true })
        if (keep) stderr = (stderr + text).slice(-STDERR_KEPT)
        const whole = (pending + text).split('\n')
        pending = whole.pop() ?? ''
        whole.forEach(show)
      },
      end () { show(pending); pending = '' }
    }
  }
  const err = lines(true)
  const out = lines(false)
  child.stderr.on('data', err.take)
  child.stdout?.on('data', out.take)
  child.on('error', (error) => { ended = error.message })
  child.on('exit', (code, signal) => { if (children.get(port) === child) children.delete(port); err.end(); out.end(); ended = `it ended (${signal ?? `code ${String(code)}`})${stderr.trim() === '' ? '' : `: ${stderr.trim().split('\n').slice(-2).join(' ')}`}` })
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
 * on `port`, where this editor last ran one (another tab's, or this page's before a reload), and spawned there
 * or on the next free port of the range.
 * `listen` starts a node that hosts (it looks wikis up, accepts connections and keeps a place on Orivon's relay);
 * without it the node only answers the peer the page dials. A node already running is joined as it was started.
 * @param {{ key: string, port?: number | null, signal?: AbortSignal, listen?: boolean }} options `key`: 64 hex characters, the same for every tab of this editor
 */
async function start ({ key, port: last = null, signal, listen = false }) {
  const deadline = Date.now() + START_BUDGET_MS
  const first = firstPort(last)
  const running = await ask(first, key)
  if (running !== null) return { ...running, port: first }
  const order = [first, ...Array.from({ length: LAST_PORT - FIRST_PORT + 1 }, (_, i) => FIRST_PORT + i).filter((p) => p !== first)]
  let reason = 'no port was free'
  for (const port of order) {
    if (Date.now() >= deadline) break
    try {
      return { ...await spawnOn(port, key, deadline, signal, listen), port }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      reason = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(`Your IPFS node could not start: ${reason}.`)
}

/**
 * The node this editor already runs, on `port` (where it last ran one), without starting any: `{ base, peer, port }`,
 * or null when none answers there.
 * @param {{ key: string, port?: number | null }} options
 */
async function find ({ key, port: last = null }) {
  const port = firstPort(last)
  const running = await ask(port, key)
  return running === null ? null : { ...running, port }
}

/** Ends the node this page started on `port` and waits for it to be gone; false when it started none there, which is a node another tab started or none at all. @param {number} port */
async function stop (port) {
  const child = children.get(port)
  if (child === undefined) return false
  children.delete(port)
  const ended = new Promise((resolve) => child.on('exit', resolve))
  child.kill()
  await Promise.race([ended, sleep(STOP_WAIT_MS)])
  return true
}

globalThis.decentrawikiNode = { start, find, stop }
