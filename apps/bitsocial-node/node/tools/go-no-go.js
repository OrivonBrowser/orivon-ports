// Go/no-go 1: a community hosted by the Worker under plain Node (`host.js`, over the native build of Orivon's IPFS node
// and the kubo facade) is read and posted to by a separate, unmodified Bitsocial client (pkc-js over a real kubo), on loopback
// only. Prints one JSON result and exits 0 when the reader resolved the community, posted, passed the challenge over pubsub
// and saw the post in the community's next update.
//
//   IPFS_NODE_BIN=<native node> KUBO_BIN=<kubo 0.43.x> node go-no-go.js [--keep] [--results <dir>] [--trace <filter>]
//
// The binary is built from a checkout of Orivon's IPFS node (README.md section Go/no-go), which this repository does not hold.

import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startKubo } from './kubo.js'
import { readAndPost, startHostedCommunity, waitFor } from './scenario.js'

const here = dirname(fileURLToPath(import.meta.url))
const keep = process.argv.includes('--keep')
const argValue = (/** @type {string} */ name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const resultsAt = argValue('--results')
const kuboBin = process.env['KUBO_BIN'] ?? 'ipfs'
const nodeBin = process.env['IPFS_NODE_BIN']
if (nodeBin === undefined) throw new Error('IPFS_NODE_BIN names the native node binary')

const binding = join(here, '..', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
if (!existsSync(binding)) throw new Error(`${binding} is missing: pkc-js's database needs its native binding under plain Node. \`npm run bitsocial-node:install\` installs without install scripts, so run \`npm rebuild better-sqlite3 --prefix apps/bitsocial-node/node\` after it`)

const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = /** @type {import('node:net').AddressInfo} */ (server.address()); server.close(() => { resolve(port) }) }) })

const dir = await mkdtemp(join(tmpdir(), 'bitsocial-go-no-go-'))
const logPath = join(dir, 'run.log')
const out = createWriteStream(logPath)
const started = Date.now()
const log = (/** @type {string} */ line) => { const text = `[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`; out.write(`${text}\n`); console.error(text) }

/** @type {Awaited<ReturnType<typeof startKubo>> | null} */
let kubo = null
/** @type {import('node:child_process').ChildProcess | null} */
let host = null
/** @type {Awaited<ReturnType<typeof startHostedCommunity>> | null} */
let hosted = null
const result = /** @type {Record<string, any>} */ ({ when: new Date().toISOString(), ok: false, steps: {} })
try {
  const [rpc, gateway, fakeKubo, nodeApi, p2p, readerApi, readerSwarm] = await Promise.all(Array.from({ length: 7 }, freePort))
  kubo = await startKubo({ bin: kuboBin, repo: join(dir, 'reader-kubo'), mode: 'loopback', swarmPort: readerSwarm, apiPort: readerApi, log })
  result.kuboVersion = await kubo.version()
  if (kubo.loopbackAddress === null) throw new Error('the reader kubo has no loopback address')

  const authKey = randomBytes(16).toString('hex')
  const config = { authKey, files: join(dir, 'files'), ports: { rpc, gateway, kubo: fakeKubo, nodeApi, p2p }, origins: [], trace: argValue('--trace') ?? 'warn,orivon_ipfs_gateway=info', isolated: { bootstrap: [kubo.loopbackAddress] } }
  host = fork(join(here, 'host.js'), [], { silent: true, serialization: 'advanced', env: { ...process.env, BITSOCIAL_NODE: JSON.stringify(config), IPFS_NODE_BIN: nodeBin, NODE_LOG_FILE: join(dir, 'node.log'), NODE_ENV: 'production' } })
  const messages = /** @type {Array<Record<string, any>>} */ ([])
  for (const stream of [host.stdout, host.stderr]) stream?.on('data', (chunk) => { for (const line of String(chunk).split('\n')) if (line.trim() !== '') out.write(`  host: ${line}\n`) })
  host.on('message', (/** @type {Record<string, any>} */ message) => { messages.push(message); if (message['type'] !== 'status') log(`host says ${JSON.stringify(message).slice(0, 300)}`) })
  host.once('exit', (code) => { log(`host ended (${String(code)})`) })
  const ready = await waitFor(() => messages.find((message) => message['type'] === 'ready' || message['type'] === 'failed'), 120_000, 'the Worker never said ready')
  if (ready['type'] !== 'ready') throw new Error(`the Worker failed: ${JSON.stringify(ready)}`)
  result.steps['hostReady'] = { ms: Date.now() - started }
  const peer = await waitFor(() => messages.filter((message) => message['type'] === 'status').map((message) => message['status']?.peer).find((one) => typeof one === 'string'), 30_000, 'the node never reported its peer')
  const hostAddress = `/ip4/127.0.0.1/tcp/${p2p}/p2p/${peer}`
  log(`host node ${peer}; reader kubo ${kubo.peer} dials ${hostAddress}`)
  await kubo.ipfs('swarm', 'connect', hostAddress)
  result.steps['connected'] = { peers: (await kubo.ipfs('swarm', 'peers')).split('\n').filter(Boolean).length }

  hosted = await startHostedCommunity({ rpcUrl: `ws://127.0.0.1:${rpc}/${authKey}`, log })
  result.steps['hosted'] = { address: hosted.address, startedMs: hosted.startedMs }
  result.steps['reader'] = await readAndPost({ api: kubo.api, address: hosted.address, answer: hosted.answer, log })
  result.ok = result.steps['reader'].ok === true
} catch (error) {
  result.error = error instanceof Error ? `${error.message}` : String(error)
  log(`FAILED: ${result.error}`)
} finally {
  await hosted?.stop().catch(() => {})
  if (host !== null && host.exitCode === null) {
    const ended = new Promise((resolve) => host?.once('exit', resolve))
    host.send({ cmd: 'stop' })
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 15_000))])
    if (host.exitCode === null) host.kill('SIGKILL')
  }
  await kubo?.stop().catch(() => {})
  result.kuboTail = result.ok ? undefined : kubo?.output().slice(-1500)
  result.totalMs = Date.now() - started
  out.end()
  const text = `${JSON.stringify(result, null, 2)}\n`
  if (resultsAt !== undefined) {
    await mkdir(resultsAt, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await writeFile(join(resultsAt, `plain-${stamp}.json`), text)
    await writeFile(join(resultsAt, `plain-${stamp}.log`), await readFile(logPath, 'utf8'))
    await writeFile(join(resultsAt, `plain-${stamp}.node.log`), await readFile(join(dir, 'node.log'), 'utf8').catch(() => ''))
  }
  process.stdout.write(text)
  if (keep || !result.ok) console.error(`kept ${dir}`)
  else await rm(dir, { recursive: true, force: true })
  process.exit(result.ok ? 0 : 1)
}
