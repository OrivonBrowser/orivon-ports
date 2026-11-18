// A real kubo, run as a Bitsocial reader's node: pubsub and IPNS-over-pubsub on. In `loopback` mode it has no bootstrap
// peers and listens on TCP on the loopback address only, so a test dials it and it dials nothing else; in `network`
// mode it keeps kubo's defaults and listens on every interface, as a person's node does.

import { spawn, execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The `Routing` config pkc-js writes into the kubo it is given when it has HTTP routers (its `setup-kubo-http-routers`):
 * providers are found and announced through the routers and nothing else, no DHT for peers or names, which reach a
 * client over pubsub. A kubo that already has it is not asked to restart.
 * @param {string[]} routers
 */
export function bitsocialRouting (routers) {
  const urls = [...routers].sort()
  /** @type {Record<string, unknown>} */
  const routersConfig = { HttpRoutersParallel: { Type: 'parallel', Parameters: { Routers: urls.map((_url, index) => ({ RouterName: `HttpRouter${index + 1}`, IgnoreErrors: true, Timeout: '10s' })) } }, HttpRouterNotSupported: { Type: 'http', Parameters: { Endpoint: 'http://kubohttprouternotsupported' } } }
  urls.forEach((url, index) => { routersConfig[`HttpRouter${index + 1}`] = { Type: 'http', Parameters: { Endpoint: url } } })
  return { Type: 'custom', Methods: { 'find-providers': { RouterName: 'HttpRoutersParallel' }, provide: { RouterName: 'HttpRoutersParallel' }, 'find-peers': { RouterName: 'HttpRouterNotSupported' }, 'get-ipns': { RouterName: 'HttpRouterNotSupported' }, 'put-ipns': { RouterName: 'HttpRouterNotSupported' } }, Routers: routersConfig }
}

/**
 * @param {{ bin: string, repo: string, mode: 'loopback' | 'network', swarmPort?: number, gatewayPort?: number, apiPort: number, httpRouters?: string[], relayService?: boolean, logLevel?: string, logFile?: string, log?: (line: string) => void }} options
 *   `httpRouters`, in `network` mode: configure kubo as pkc-js does for a Bitsocial client with these routers; without
 *   it kubo keeps its own routing (the DHT and its default delegated routers)
 *   `gatewayPort` fixes the gateway's port, which also serves kubo's routing API (`routerUrl`), so a node can ask this kubo for providers
 *   `relayService`, in `loopback` mode: the kubo is a circuit relay v2 that holds a reservation for a node, as a person's named relay does
 *   `logLevel` is kubo's `GOLOG_LOG_LEVEL`, and `logFile` keeps every line kubo writes (the tail `output()` holds is short)
 */
export async function startKubo ({ bin, repo, mode, swarmPort = 0, gatewayPort = 0, apiPort, httpRouters, relayService = false, logLevel, logFile, log = () => {} }) {
  const env = { ...process.env, IPFS_PATH: repo, ...(logLevel === undefined ? {} : { GOLOG_LOG_LEVEL: logLevel }) }
  const ipfs = async (/** @type {string[]} */ ...args) => (await run(bin, args, { env, maxBuffer: 64 << 20 })).stdout.trim()
  await mkdir(repo, { recursive: true })
  await ipfs('init', '--profile', mode === 'loopback' ? 'test' : 'server')
  await ipfs('config', '--json', 'Pubsub.Enabled', 'true')
  await ipfs('config', '--json', 'Ipns.UsePubsub', 'true')
  await ipfs('config', 'Addresses.API', `/ip4/127.0.0.1/tcp/${apiPort}`)
  await ipfs('config', '--json', 'Addresses.Gateway', JSON.stringify(`/ip4/127.0.0.1/tcp/${gatewayPort}`))
  if (mode === 'loopback') {
    await ipfs('config', '--json', 'Routing.Type', '"dhtserver"')
    await ipfs('config', '--json', 'Addresses.Swarm', JSON.stringify([`/ip4/127.0.0.1/tcp/${swarmPort}`]))
    for (const transport of ['QUIC', 'WebTransport', 'WebRTCDirect']) await ipfs('config', '--json', `Swarm.Transports.Network.${transport}`, 'false')
    await ipfs('bootstrap', 'rm', '--all')
    if (relayService) {
      // Kubo starts the relay service only once its node believes it is publicly reachable, which a loopback node never learns,
      // and a reservation it grants carries only the relay's public addresses (a client refuses one with none): an address that looks public stands in (nothing dials it).
      await ipfs('config', '--json', 'Swarm.RelayService.Enabled', 'true')
      await ipfs('config', 'Internal.Libp2pForceReachability', 'public')
      await ipfs('config', '--json', 'Addresses.AppendAnnounce', JSON.stringify([`/ip4/1.2.3.4/tcp/${swarmPort}`]))
    }
  } else {
    await ipfs('config', '--json', 'Addresses.Swarm', JSON.stringify([`/ip4/0.0.0.0/tcp/${swarmPort}`, `/ip6/::/tcp/${swarmPort}`]))
    if (httpRouters !== undefined) {
      await ipfs('config', '--json', 'Routing', JSON.stringify(bitsocialRouting(httpRouters)))
      await ipfs('config', '--json', 'Provide.DHT.SweepEnabled', 'false')
    }
  }
  const daemon = spawn(bin, ['daemon'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', (chunk) => { tail = `${tail}${String(chunk)}`.slice(-4000); if (logFile !== undefined) appendFileSync(logFile, chunk) })
  let ended = false
  daemon.once('exit', () => { ended = true })
  const until = Date.now() + 90_000
  for (;;) {
    if (ended) throw new Error(`kubo ended before it answered: ${tail.slice(-600)}`)
    if (Date.now() > until) { daemon.kill(); throw new Error(`kubo never answered: ${tail.slice(-600)}`) }
    const ready = await fetch(`http://127.0.0.1:${apiPort}/api/v0/id`, { method: 'POST', signal: AbortSignal.timeout(2000) }).then((answer) => answer.ok, () => false)
    if (ready) break
    await sleep(250)
  }
  const id = /** @type {{ ID: string, Addresses: string[] }} */ (await (await fetch(`http://127.0.0.1:${apiPort}/api/v0/id`, { method: 'POST' })).json())
  const loopback = id.Addresses.find((address) => address.startsWith('/ip4/127.0.0.1/tcp/')) ?? null
  log(`kubo ${id.ID} up on ${loopback ?? id.Addresses[0] ?? 'no address'}`)
  return {
    peer: id.ID,
    api: `http://127.0.0.1:${apiPort}/api/v0`,
    /** The origin whose `/routing/v1` kubo answers provider lookups on, or null when no `gatewayPort` was given */
    routerUrl: gatewayPort === 0 ? null : `http://127.0.0.1:${gatewayPort}`,
    /** `/ip4/127.0.0.1/tcp/<port>/p2p/<peer id>`, or null when kubo has no loopback address */
    loopbackAddress: loopback,
    /** @param {string[]} args */
    ipfs,
    /** The last words kubo wrote to its output. */
    output: () => tail,
    async version () { return ipfs('version', '--number') },
    async stop () {
      if (ended) return
      await ipfs('shutdown').catch(() => {})
      await Promise.race([new Promise((resolve) => daemon.once('exit', resolve)), sleep(8000)])
      if (!ended) daemon.kill('SIGKILL')
    }
  }
}

/** Where a repository's API port is written, for a caller that did not choose it. @param {string} repo */
export async function apiAddress (repo) {
  return (await readFile(join(repo, 'api'), 'utf8')).trim()
}
