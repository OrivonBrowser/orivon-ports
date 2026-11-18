// A board that comes back after its Worker is killed: the Worker under plain Node (`host.js`, over the native build of
// Orivon's IPFS node) hosts a community that a pkc-js client creates and starts; the Worker is then killed with no stop
// message, as the shell does when an app's last page closes, and started again over the same files. The run says
// whether pkc-js's RPC server started the community again by itself, how long that took, and what the second Worker
// logged (`--debug` turns pkc-js's own logs on, so the auto-start lines are read, not guessed).
//
//   IPFS_NODE_BIN=<native node> [RESTART_OUT=<where the run's folder goes>] node restart.js [--debug] [--kill stop|term|kill] [--keep]
//
// The node runs with its own defaults (the public DHT, the four HTTP routers, the six name resolvers), as a person's does;
// `--kill` is how the first Worker ends (`kill`, the default, ends the Worker and the node at once).

import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import PKC from '@pkcprotocol/pkc-js'
import { sleep, waitFor } from './scenario.js'

const here = dirname(fileURLToPath(import.meta.url))
const argValue = (/** @type {string} */ name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const debug = process.argv.includes('--debug')
const keep = process.argv.includes('--keep')
const kill = argValue('--kill') ?? 'kill'
const nodeBin = process.env['IPFS_NODE_BIN']
if (nodeBin === undefined) throw new Error('IPFS_NODE_BIN names the native node binary')
const binding = join(here, '..', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
if (!existsSync(binding)) throw new Error(`${binding} is missing: \`npm rebuild better-sqlite3 --prefix apps/bitsocial-node/node\``)

const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = /** @type {import('node:net').AddressInfo} */ (server.address()); server.close(() => { resolve(port) }) }) })
const dir = await mkdtemp(join(process.env['RESTART_OUT'] ?? tmpdir(), 'bitsocial-restart-'))
const logPath = join(dir, 'run.log')
const out = createWriteStream(logPath)
const started = Date.now()
const log = (/** @type {string} */ line) => { const text = `[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`; out.write(`${text}\n`); console.error(text) }
const textOf = (/** @type {unknown} */ error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))

const [rpc, gateway, fakeKubo, nodeApi, p2p] = await Promise.all(Array.from({ length: 5 }, freePort))
const authKey = randomBytes(16).toString('hex')
const files = join(dir, 'files')
await mkdir(files, { recursive: true })
const config = { authKey, files, ports: { rpc, gateway, kubo: fakeKubo, nodeApi, p2p }, origins: [], trace: 'warn' }
const rpcUrl = `ws://127.0.0.1:${rpc}/${authKey}`

/** @param {string} label */
function startHost (label) {
  const host = fork(join(here, 'host.js'), [], {
    silent: true, detached: true, serialization: 'advanced',
    env: { ...process.env, BITSOCIAL_NODE: JSON.stringify(config), IPFS_NODE_BIN: nodeBin, NODE_LOG_FILE: join(dir, `${label}-node.log`), NODE_ENV: 'production', ...(debug ? { DEBUG: 'pkc*,-pkc*:trace' } : {}) }
  })
  const messages = /** @type {Array<Record<string, any>>} */ ([])
  for (const stream of [host.stdout, host.stderr]) stream?.on('data', (chunk) => { for (const line of String(chunk).split('\n')) if (line.trim() !== '') out.write(`  ${label}: ${line.slice(0, 600)}\n`) })
  host.on('message', (/** @type {Record<string, any>} */ message) => { messages.push(message); if (message['type'] !== 'status') log(`${label} says ${JSON.stringify(message).slice(0, 300)}`) })
  host.once('exit', (code) => { log(`${label} ended (${String(code)})`) })
  return { host, messages, ready: () => waitFor(() => messages.find((message) => message['type'] === 'ready' || message['type'] === 'failed'), 180_000, `${label} never said ready`) }
}

const result = /** @type {Record<string, any>} */ ({ when: new Date().toISOString(), ok: false, steps: {}, dir })
/** @type {ReturnType<typeof startHost> | null} */
let first = null
/** @type {ReturnType<typeof startHost> | null} */
let second = null
try {
  first = startHost('first')
  const firstReady = await first.ready()
  if (firstReady['type'] !== 'ready') throw new Error(`the first Worker failed: ${JSON.stringify(firstReady)}`)
  result.steps['firstReadyMs'] = Date.now() - started

  const pkc = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined })
  pkc.on('error', (/** @type {unknown} */ error) => { log(`client error: ${textOf(error)}`) })
  const community = await pkc.createCommunity({ title: 'restart board', description: 'a board that must come back' })
  community.on('error', (/** @type {unknown} */ error) => { log(`community error: ${textOf(error)}`) })
  const address = /** @type {string} */ (community.address)
  for (let attempt = 1; ; attempt += 1) {
    try { await community.start(); break } catch (error) {
      if (!/not local|toJSONInternalRpcBeforeFirstUpdate/.test(textOf(error)) || attempt >= 5) throw error
      await sleep(2000)
    }
  }
  const beganStart = Date.now()
  await waitFor(() => (community.updatedAt !== undefined && community.startedState === 'succeeded' ? true : undefined), 240_000, `the community never published (state ${String(community.startedState)})`)
  const firstUpdatedAt = /** @type {number} */ (community.updatedAt)
  result.steps['firstStart'] = { address, ms: Date.now() - beganStart, updatedAt: firstUpdatedAt }
  log(`community ${address} started, updatedAt ${firstUpdatedAt}`)
  await pkc.destroy().catch(() => {})

  // The first Worker ends the way the shell ends it: no stop message.
  if (kill === 'stop') first.host.send({ cmd: 'stop' })
  else if (first.host.pid !== undefined) { try { process.kill(-first.host.pid, kill === 'term' ? 'SIGTERM' : 'SIGKILL') } catch { /* gone */ } }
  await waitFor(() => (first?.host.exitCode !== null || first?.host.signalCode !== null ? true : undefined), 60_000, 'the first Worker did not end')
  // Anything the group kill missed (the node binary is in the host's group, so nothing should be left).
  const quiet = await waitFor(async () => !(await portAnswers(nodeApi)) && !(await portAnswers(rpc)), 30_000, 'a socket of the first Worker stayed open').catch(() => false)
  result.steps['firstEnded'] = { ms: Date.now() - started, socketsClosed: quiet !== false }
  await sleep(1500)

  second = startHost('second')
  const secondReady = await second.ready()
  if (secondReady['type'] !== 'ready') throw new Error(`the second Worker failed: ${JSON.stringify(secondReady)}`)
  const readyAt = Date.now()
  result.steps['secondReadyMs'] = readyAt - started

  // What a page does with a board it opens: a client of the RPC asks for the community by its address and follows it.
  const pkc2 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined })
  pkc2.on('error', (/** @type {unknown} */ error) => { log(`client 2 error: ${textOf(error)}`) })
  const listed = await waitFor(() => (pkc2.communities?.includes(address) ? true : undefined), 60_000, 'the RPC never listed the community as local').catch(() => false)
  result.steps['listedAsLocal'] = listed !== false
  const again = await pkc2.createCommunity({ address })
  again.on('error', (/** @type {unknown} */ error) => { log(`community 2 error: ${textOf(error)}`) })
  again.on('startedstatechange', (/** @type {string} */ state) => { log(`community 2 started state: ${state}`) })
  again.on('updatingstatechange', (/** @type {string} */ state) => { log(`community 2 updating state: ${state}`) })
  again.on('update', () => { log(`community 2 update: updatedAt ${String(again.updatedAt)}`) })
  await again.update().catch((/** @type {unknown} */ error) => { log(`community 2 update(): ${textOf(error)}`) })
  const back = await waitFor(() => (again.updatedAt !== undefined && again.updatedAt > firstUpdatedAt ? again.updatedAt : undefined), 240_000, 'the community never published a newer record').catch(() => false)
  result.steps['backAfterMs'] = back === false ? null : Date.now() - readyAt
  result.steps['updatedAtAfter'] = again.updatedAt ?? null
  result.steps['stateAfter'] = { state: again.state, startedState: again.startedState ?? null, updatingState: again.updatingState ?? null }
  result.ok = back !== false
  await pkc2.destroy().catch(() => {})
} catch (error) {
  result.error = textOf(error)
  log(`FAILED: ${result.error}`)
} finally {
  for (const run of [first, second]) {
    if (run?.host.pid !== undefined) { try { process.kill(-run.host.pid, 'SIGKILL') } catch { /* gone */ } }
  }
  out.end()
  result.log = logPath
  console.log(JSON.stringify(result, null, 2))
  if (!keep && result.ok) await rm(dir, { recursive: true, force: true })
  process.exit(result.ok ? 0 : 1)
}

/** @param {number} port */
function portAnswers (port) {
  return new Promise((resolve) => {
    import('node:net').then(({ connect }) => {
      const socket = connect(port, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { resolve(false) })
    }, () => { resolve(false) })
  })
}
