// Go/no-go on the real network, the host's side: the Worker under plain Node over the native node, on this computer
// (behind a router, outbound connections only), with the node's own defaults (public DHT, the HTTP routers the build
// knows). It creates and starts a community, prints its address and challenge answer for a reader elsewhere, then
// samples the node every 10 s for `--minutes` (default 5): connections the process holds (`ss`), the node's own
// reachability, and the failed dials it logged. Prints one JSON result when done; stop it with a signal to end early.
//
//   IPFS_NODE_BIN=<native node> node network-host.js --files <dir> [--minutes 5] [--out <file>] [--flags '["--publish",...]'] [--punch] [--trace <tracing filter>]
//
// `--punch` runs the node with `--punch-port <the Worker's p2p port>` in place of `--p2p-port`, which is what the node does to
// be reached from behind a router (the Worker passes `--p2p-port` only); a wrapper rewrites the one flag and changes nothing
// else. The samples then carry the node's reservations (`relays`), its hole punch state and counts (`punch`), the CIDs it
// announces (`providing`), and, once the community is up, what each HTTP router lists for those CIDs (`routers`).
//
// While it samples it keeps the community started, so a reader can resolve and post; the reader's own numbers come from
// `network-reader.js`.

import { execFile, fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { startHostedCommunity, waitFor, sleep } from './scenario.js'

const here = dirname(fileURLToPath(import.meta.url))
const arg = (/** @type {string} */ name, /** @type {string | undefined} */ fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback)
const files = arg('--files', undefined)
if (files === undefined) throw new Error('--files names the directory the Worker keeps its data in')
const minutes = Number(arg('--minutes', '5'))
const outFile = arg('--out', undefined)
const nodeBin = process.env['IPFS_NODE_BIN']
if (nodeBin === undefined) throw new Error('IPFS_NODE_BIN names the native node binary')
const flags = arg('--flags', undefined)
const ports = { rpc: Number(arg('--rpc', '19138')), gateway: Number(arg('--gateway', '16473')), kubo: Number(arg('--kubo', '50019')), nodeApi: Number(arg('--node-api', '15351')), p2p: Number(arg('--p2p', '4851')) }
const punch = process.argv.includes('--punch')
const nodeLog = join(files, 'node-all.log')
const run = promisify(execFile)
const ROUTERS = ['https://routing.lol', 'https://peers.pleb.bot', 'https://peers.plebpubsub.xyz', 'https://peers.forumindex.com']

/** The program the Worker's spawn runs: the node itself, or with `--punch` a script that hands the node its arguments with `--p2p-port` renamed `--punch-port`. */
function nodeProgram () {
  if (!punch) return nodeBin
  const wrapper = join(files, 'node-punch.sh')
  const script = `#!/bin/sh\nn=$#\nwhile [ "$n" -gt 0 ]; do\n  a=$1; shift; n=$((n - 1))\n  if [ "$a" = "--p2p-port" ]; then set -- "$@" --punch-port; else set -- "$@" "$a"; fi\ndone\nexec '${nodeBin}' "$@"\n`
  writeFileSync(wrapper, script)
  chmodSync(wrapper, 0o700)
  return wrapper
}

const started = Date.now()
const log = (/** @type {string} */ line) => { console.error(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`) }
const result = /** @type {Record<string, any>} */ ({ when: new Date().toISOString(), ok: false, samples: [] })
const authKey = randomBytes(16).toString('hex')
const config = { authKey, files, ports, origins: [], trace: arg('--trace', 'warn,orivon_ipfs_gateway=info,orivon_ipfs_serve=debug') }
const host = fork(join(here, 'host.js'), [], { silent: true, serialization: 'advanced', env: { ...process.env, BITSOCIAL_NODE: JSON.stringify(config), IPFS_NODE_BIN: nodeProgram(), NODE_LOG_FILE: nodeLog, NODE_ENV: 'production', ...(flags === undefined ? {} : { IPFS_NODE_FLAGS: flags }) } })
const messages = /** @type {Array<Record<string, any>>} */ ([])
host.stdout?.on('data', (chunk) => { for (const line of String(chunk).split('\n')) if (line.trim() !== '') log(`host: ${line.slice(0, 300)}`) })
host.stderr?.on('data', (chunk) => { for (const line of String(chunk).split('\n')) if (line.trim() !== '') log(`host: ${line.slice(0, 300)}`) })
host.on('message', (/** @type {Record<string, any>} */ message) => { messages.push(message) })

/** The node binary's process id, from `pgrep` on its own command line. */
async function nodePid () {
  try {
    const pid = (await run('pgrep', ['-f', `${nodeBin} .*--api-key`])).stdout.trim().split('\n')[0]
    return pid === undefined || pid === '' ? null : pid
  } catch { return null }
}

/** Established TCP connections held by the node binary. */
async function connections () {
  try {
    const pid = await nodePid()
    if (pid === null) return null
    const { stdout } = await run('ss', ['-H', '-tnp', 'state', 'established'])
    return stdout.split('\n').filter((line) => line.includes(`pid=${pid},`)).length
  } catch { return null }
}

/** One of the node's own routes, behind the key the Worker gave it on the command line (read from the process, as `ps` shows it). @param {string} path */
async function nodeGet (path) {
  try {
    const pid = await nodePid()
    if (pid === null) return null
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    const key = argv[argv.indexOf('--api-key') + 1]
    const answer = await fetch(`http://127.0.0.1:${ports.nodeApi}${path}`, { headers: { 'x-orivon-key': String(key) }, signal: AbortSignal.timeout(5000) })
    return answer.ok ? await answer.json() : null
  } catch { return null }
}

/** What each HTTP router lists as providers of `cid`: peer ids, and whether any address is a circuit address. @param {string} cid */
async function routerProviders (cid) {
  /** @type {Record<string, unknown>} */
  const found = {}
  await Promise.all(ROUTERS.map(async (router) => {
    const began = Date.now()
    try {
      const answer = await fetch(`${router}/routing/v1/providers/${cid}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
      const body = answer.ok ? /** @type {{ Providers?: Array<{ ID?: string, Addrs?: string[] }> | null }} */ (await answer.json()) : null
      found[router] = { status: answer.status, ms: Date.now() - began, providers: (body?.Providers ?? []).map((one) => ({ id: one.ID, addrs: one.Addrs ?? [], circuit: (one.Addrs ?? []).some((address) => address.includes('/p2p-circuit')) })) }
    } catch (error) { found[router] = { error: error instanceof Error ? error.message : String(error), ms: Date.now() - began } }
  }))
  return found
}

/** A relay's circuit address as `<relay ip>/<relay port>/<relay peer>`: what the sample shows of which relay holds the reservation. @param {string} address */
const relayOf = (address) => address.split('/p2p-circuit')[0] ?? address

/** @param {string} text */
const count = (text, /** @type {RegExp} */ pattern) => (text.match(pattern) ?? []).length

let hosted = null
const finish = async (/** @type {number} */ code) => {
  await hosted?.stop().catch(() => {})
  host.send({ cmd: 'stop' })
  await Promise.race([new Promise((resolve) => host.once('exit', resolve)), sleep(15_000)])
  if (host.exitCode === null) host.kill('SIGKILL')
  result.totalMs = Date.now() - started
  const text = `${JSON.stringify(result, null, 2)}\n`
  if (outFile !== undefined) writeFileSync(outFile, text)
  process.stdout.write(text)
  process.exit(code)
}
process.on('SIGTERM', () => { void finish(2) })
process.on('SIGINT', () => { void finish(2) })

try {
  const ready = await waitFor(() => messages.find((message) => message['type'] === 'ready' || message['type'] === 'failed'), 180_000, 'the Worker never said ready')
  if (ready['type'] !== 'ready') throw new Error(`the Worker failed: ${JSON.stringify(ready)}`)
  const peer = await waitFor(() => messages.filter((message) => message['type'] === 'status').map((message) => message['status']?.peer).find((one) => typeof one === 'string'), 60_000, 'the node never reported its peer')
  result.peer = peer
  if (outFile !== undefined) writeFileSync(`${outFile}.peer`, `${peer}\n`)
  hosted = await startHostedCommunity({ rpcUrl: `ws://127.0.0.1:${ports.rpc}/${authKey}`, log, startMs: 300_000 })
  result.community = { address: hosted.address, answer: hosted.answer, startedMs: hosted.startedMs, startedAtMs: Date.now() - started }
  // The reader reads these two lines; nothing else on stdout is for it.
  console.error(`COMMUNITY ${hosted.address} ANSWER ${JSON.stringify(hosted.answer)}`)
  if (outFile !== undefined) writeFileSync(`${outFile}.community`, `${hosted.address} ${hosted.answer}\n`)
  const sampleUntil = Date.now() + minutes * 60_000
  let lastFailed = 0
  const checked = new Set()
  const pending = /** @type {Promise<void>[]} */ ([])
  const sampleFrom = Date.now()
  result.routers = []
  while (Date.now() < sampleUntil) {
    await sleep(10_000)
    const text = (() => { try { return readFileSync(nodeLog, 'utf8') } catch { return '' } })()
    const failedTotal = count(text, /outgoing connection failed/g)
    const status = messages.filter((message) => message['type'] === 'status').at(-1)?.['status']
    /** @type {{ relays?: string[], providing?: Array<{ cid: string, announced: number | null }> } | null} */
    const own = await nodeGet('/status')
    /** @type {{ punch?: Record<string, unknown> } | null} */
    const publishing = await nodeGet('/orivon/publishing')
    const providing = own?.providing ?? []
    const sample = { atS: Math.round((Date.now() - started) / 1000), connections: await connections(), failedDialsTotal: failedTotal, failedDialsIn10s: failedTotal - lastFailed, reachability: status?.reachability ?? null, external: status?.external ?? [], peers: status?.peers ?? null, relays: (own?.relays ?? []).map(relayOf), punch: publishing?.punch ?? null, providing: providing.map((one) => `${one.cid}${one.announced === null ? ' (not announced)' : ''}`) }
    lastFailed = failedTotal
    result.samples.push(sample)
    log(`sample ${JSON.stringify(sample)}`)
    // What the routers list, once the node has had time to announce: twice, a minute into the run and at its end.
    const sinceStart = (Date.now() - sampleFrom) / 1000
    for (const mark of [60, minutes * 60 - 40]) {
      if (sinceStart >= mark && !checked.has(mark) && providing.length > 0) {
        checked.add(mark)
        const cids = providing.slice(0, 8).map((one) => one.cid)
        pending.push(Promise.all(cids.map(async (cid) => [cid, await routerProviders(cid)])).then((rows) => { result.routers.push({ atS: Math.round((Date.now() - started) / 1000), byCid: Object.fromEntries(rows) }); log(`routers ${JSON.stringify(Object.fromEntries(rows))}`) }))
      }
    }
  }
  await Promise.all(pending)
  const text = (() => { try { return readFileSync(nodeLog, 'utf8') } catch { return '' } })()
  result.summary = { sampledMinutes: minutes, failedDials: count(text, /outgoing connection failed/g), connectionsClosed: count(text, /connection closed/g), connectionsMax: Math.max(0, ...result.samples.map((/** @type {{ connections: number | null }} */ one) => one.connections ?? 0)), lastReachability: result.samples.at(-1)?.reachability ?? null, externalAddresses: result.samples.at(-1)?.external ?? [] }
  result.ok = true
  await finish(0)
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
  log(`FAILED: ${result.error}`)
  await finish(1)
}
