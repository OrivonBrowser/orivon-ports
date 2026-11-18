// The Worker's life, in order: Orivon's IPFS node starts and answers `/health`; the kubo facade is put in front of it
// (answered in this process for pkc-js, and as a gateway on a socket for the page's media, its few read-only calls,
// the board manager's control calls, the challenge list, the listing calls, the name calls, seeding and how the node is reached); the bundled challenges are registered in pkc-js; pkc-js's RPC server opens behind the key guard; the page is told `ready`, and
// the board managers of the boards a person turned them on for start behind it. A `stop` message undoes it in the
// other order. Everything the environment provides is passed in, so a test runs it against stand-ins.

import { createKuboFacade, createLanes, createNodeClient, createNodeFetch, installFetchHook, listenFacade } from '../kubo/index.js'
import { KuboError } from '../kubo/wire.js'
import { traceFacade, traceFetch } from './facade-trace.js'
import { bandwidthReader } from './bandwidth.js'
import { boardChallenges } from './board-challenges.js'
import { boardConfigStore } from './board-config.js'
import { boardRecords } from './board-records.js'
import { challengesApi } from './challenges-api.js'
import { describeChallenges, registerChallenges } from './challenges.js'
import { ETH_RPC_URLS } from './eth-providers.js'
import { canUseLightClient, createEthereumReads, ensRoute, ETHEREUM_ORIGIN, VIEM_MAINNET_URL } from './ethereum-reads.js'
import { superviseBoardManagers } from './board-managers.js'
import { gatewayOnly } from './gateway-only.js'
import { listingApi } from './listing-api.js'
import { managerApi } from './manager-api.js'
import { nameApi } from './name-api.js'
import { nameClaims } from './name-claim.js'
import { pageApi } from './page-api.js'
import { describeReach, reachApi } from './reach-api.js'
import { relaySetting } from './relay-setting.js'
import { createSeeder } from './seeding.js'
import { communityOpener } from './seeding-pkc.js'
import { seedingApi } from './seeding-api.js'
import { seedingStore } from './seeding-store.js'
import { keepAlive } from './workarounds/keep-alive.js'
import { layout, readConfig } from './config.js'
import { routeBoardLog, routeChallengeLog, routeLog } from './diagnostics.js'
import { keySecret } from './key-secret.js'
import { clearLeftLocks } from './left-locks.js'
import { superviseNode } from './node-supervisor.js'
import { desktopPkcOptions, HTTP_ROUTERS } from './pkc-options.js'
import { startRpcServer } from './rpc-server.js'
import { reasonText } from './reachability.js'
import { readStatus, startStatusFeed } from './status-feed.js'

/** Where the node component is spawned from: the app's `bin/ipfs-node.p2/`. */
export const NODE_PROGRAM = '/bin/ipfs-node'

/** Lines of the node's trace that reach the page's console in one run, beside every warning and error. A run asked for more than warnings (`trace`) shows every line, up to a cap. */
const LINES_SHOWN = 25
const LINES_MAX = 150
const LINES_MAX_TRACED = 5000
const KEY_IN_TEXT = /[0-9a-f]{64}/gi

/** What one key scope of the node may hold: a community is one key, and the node's own default of 8 is a few boards. */
export const MAX_IPNS_KEYS = 64

/**
 * How many requests the node serves at once. Its own 8 is one more than the engine's six connections to it, which were the limit before the Worker called it over
 * `http`; with no limit on the calls (`kubo/http-fetch.js`), the ten slow reads of seedit's default communities hold all 8, and a call behind them (a block put, a
 * name's own record) is answered 503 "gateway busy" after the node's 2 s queue wait, again and again until the reads end, 25 s on.
 */
export const NODE_REQUESTS = 64

/** The shell holds an origin to a call rate, and the node's own database traffic can use it up while the RPC server starts: a refusal is asked again. */
const RPC_START_ATTEMPTS = 5

/**
 * The node's command line. `flags` are the options the component in this build accepts beyond the ones every build
 * has (`build/node-component.mjs` lists them): a flag the component does not know ends it at once. `--publish` takes
 * the keys sealed under `secret` when the component has `--key-secret`, else in memory (README.md section Design notes).
 * A node a visitor must reach from behind a router punches (`--punch-port` in place of `--p2p-port`, which it excludes), and
 * a run with no internet (`isolated`) listens, because loopback has no router to punch through.
 * @param {{ config: import('./config.js').WorkerConfig, key: string, nodeDb: string, flags: readonly string[], secret?: string }} options
 */
export function nodeArgs ({ config, key, nodeDb, flags, secret }) {
  const sealed = flags.includes('--key-secret')
  if (flags.includes('--publish') && sealed && secret === undefined) throw new Error('--publish with --key-secret needs the secret')
  if (config.relay !== undefined && !flags.includes('--relay')) throw new Error('this node component has no --relay: the relay the configuration names cannot be used')
  const punching = flags.includes('--publish') && flags.includes('--punch-port') && config.isolated === undefined
  return [
    '--online', '--routing-mode', 'auto', '--db', nodeDb, '--serve',
    ...(flags.includes('--publish') ? ['--publish', ...(sealed ? ['--key-secret', String(secret)] : ['--keys-in-memory']), ...(flags.includes('--max-ipns-keys') ? ['--max-ipns-keys', String(MAX_IPNS_KEYS)] : [])] : []),
    '--api-key', key, '--addr', `127.0.0.1:${config.ports.nodeApi}`, punching ? '--punch-port' : '--p2p-port', String(config.ports.p2p), '--trace-filter', config.trace,
    '--max-concurrent-requests', String(NODE_REQUESTS),
    ...(config.relay === undefined ? [] : ['--relay', config.relay]),
    ...(config.isolated === undefined ? [] : ['--allow-local-dial', '--test-bootstrap', config.isolated.bootstrap.join(',')]),
    ...(flags.includes('--http-router') ? (config.isolated?.routers ?? (config.isolated === undefined ? HTTP_ROUTERS : [])).flatMap((router) => ['--http-router', router]) : [])
  ]
}

/**
 * The line that says what the node's way in is, for the log a bug report carries: the answer and why (the node's reason in
 * a sentence, or that this Worker read it because the node gave none), AutoNAT's own word, and the hole punch counts. Counts and states only, never an address or a peer. Everything else a status holds
 * (the peer count above all) moves too often to be a line.
 * @param {import('./status-feed.js').NodeStatus} status
 */
export function reachabilityLine (status) {
  const { punch } = status
  const way = punch === null ? 'no hole punch' : `hole punch ${punch.state}, ${String(punch.relaysHeld)} of ${String(punch.relaysKnown)} relays hold a place, ${String(punch.punched)} punched, ${String(punch.failed)} failed`
  const why = status.source === 'node' ? [status.basis, reasonText(status.basis)].filter((part) => part !== '').join(': ') : `${status.basis}, read by the Worker: the node gives no reach`
  return `reachability ${status.reachability} (${why}): ${way}; AutoNAT ${status.autonat}; ${String(status.relays)} circuit addresses, ${String(status.external.length)} confirmed addresses`
}

/** @param {unknown} error */
const textOf = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))

/**
 * @typedef {object} Environment
 * @property {Record<string, string | undefined>} env
 * @property {(message: Record<string, unknown>) => void} send to the page
 * @property {(handler: (message: any) => void) => void} onMessage from the page
 * @property {(code: number) => void} exit
 * @property {typeof import('node:child_process').spawn} spawn
 * @property {typeof fetch} fetch the process's own fetch, as it is before the facade's hook replaces it
 * @property {boolean} [nodeOverHttp] call the node's API over `http.request`, one socket a request, as the desktop's Node does, and not with `fetch`, whose engine holds a page to six connections to one host and port (`kubo/http-fetch.js`); `main.js` sets it
 * @property {typeof import('node:http')} http
 * @property {{ PKCWsServer: (options: Record<string, unknown>) => Promise<any> }} PKCRpc
 * @property {{ fetch: typeof fetch }} scope `globalThis`, where pkc-js looks its `fetch` up and where its log lines are handed to the Worker
 * @property {(path: string) => Promise<unknown>} mkdir
 * @property {(path: string) => Promise<boolean>} removeDir removes an empty directory, false when it does not exist
 * @property {(path: string) => Promise<string | null>} readText a file's text, null when it does not exist
 * @property {(path: string, text: string) => Promise<unknown>} writeText a file only its owner can read
 * @property {{ startBoardManager: (options: Record<string, any>) => Promise<{ stop: () => Promise<void> }>, resolveBoardManagerOptions: (board: Record<string, any>, config: Record<string, any>, directory: string) => Record<string, any> }} [boardManager]
 *   the 5chan board manager, which a build that has it passes (`board-manager-entry.js`); without it the control calls answer 503
 * @property {{ registry: Record<string, unknown> }} [challenges] pkc-js's `PKC.challenges`, which the bundled challenges are registered in; without it the list answers 503
 * @property {import('./board-config.js').FileApi} [fs] Node's synchronous file API, which the board manager's config and state are kept with
 * @property {(bytes: number) => string} randomHex
 * @property {readonly string[]} nodeFlags
 * @property {string[]} [ethRpcUrls] the Ethereum providers the name resolvers ask, in place of the desktop clients' six: a test's local fork of the chain, which `main.js` never passes
 * @property {{ use?: unknown }} [orivon] the Worker's `orivon`: a browser that offers an app a light client has `orivon.use` as a function, and Ethereum is read through it first (`ethereum-reads.js`)
 * @property {number} [rpcRetryMs] the pause before the RPC server is started again after the origin's call limit refused it
 * @property {(line: string) => void} [log]
 * @property {(line: string) => void} [warn] where the reachability line goes: a warning is what reaches a bug report from orivon://report (a plain log line does not)
 * @property {Partial<typeof import('./node-supervisor.js').TIMING>} [timing]
 */

/** @param {Environment} env */
export async function startWorker (env) {
  const { send, spawn, http, PKCRpc, scope, nodeFlags } = env
  const log = env.log ?? ((/** @type {string} */ line) => { console.log(`[bitsocial-node] ${line}`) })
  const warn = env.warn ?? ((/** @type {string} */ line) => { console.warn(`[bitsocial-node] ${line}`) })
  const config = readConfig(env.env)
  const tracing = env.env['BITSOCIAL_FACADE_TRACE'] === '1'
  routeLog(scope, warn)
  const redact = (/** @type {string} */ text) => text.split(config.authKey).join('<key>')
  routeBoardLog(scope, warn, redact)
  routeChallengeLog(scope, warn, redact)
  const paths = layout(config.files)
  const nodeKey = env.randomHex(32)
  const nodeBase = `http://127.0.0.1:${config.ports.nodeApi}`
  // Every call to the node's API, the node client's and the readers' alike, goes through `callNode`; any other URL it is given goes to the process's own fetch.
  const callNode = env.nodeOverHttp === true ? createNodeFetch({ http, base: nodeBase, fetch: env.fetch, ...(tracing ? { note: log } : {}) }) : env.fetch
  // The Worker's calls to the node's API that do not go through the node client (its health checks and status reads), written to the log too when tracing.
  const outsideFetch = tracing ? traceFetch(callNode, log) : callNode
  const kuboUrl = `http://127.0.0.1:${config.ports.kubo}`
  const gatewayUrl = `http://127.0.0.1:${config.ports.gateway}`

  /** @type {Array<() => Promise<unknown> | unknown>} */
  const undo = []
  /** @type {ReturnType<typeof startStatusFeed> | null} */
  let feed = null
  let stopping = false
  async function stop (code = 0) {
    if (stopping) return
    stopping = true
    for (const step of undo.reverse()) await Promise.resolve().then(step).catch((error) => { log(`stopping: ${textOf(error)}`) })
    env.exit(code)
  }
  /** @param {string} stage @param {unknown} error */
  async function fail (stage, error) {
    log(`${stage} failed: ${textOf(error)}`)
    send({ type: 'failed', stage, message: error instanceof Error ? error.message : String(error), code: /** @type {any} */ (error)?.code ?? null })
    await stop(1)
  }

  await env.mkdir(`${config.files}/node`)
  await env.mkdir(config.files)
  /** @type {string | undefined} */
  let secret
  if (nodeFlags.includes('--key-secret')) {
    try { secret = await keySecret({ path: paths.keySecret, read: env.readText, write: env.writeText, randomHex: env.randomHex }) } catch (error) { await fail('keys', error); return }
  }

  /** The relay the person named: what they saved, else what the page's configuration names. A component with no `--relay` keeps what the configuration says, which `nodeArgs` refuses. */
  const relay = relaySetting({
    file: paths.relay, fs: env.fs ?? null, ...(config.relay === undefined ? {} : { fromConfig: config.relay }), isolated: config.isolated !== undefined,
    supported: () => nodeFlags.includes('--relay'), log,
    restart: () => { supervisor.restart(currentArgs()) }
  })
  const namedRelay = () => (nodeFlags.includes('--relay') ? relay.current().relay : config.relay)
  const relayOption = () => { const named = namedRelay(); return named === undefined ? {} : { relay: named } }
  const currentArgs = () => nodeArgs({ config: { ...config, relay: namedRelay() }, key: nodeKey, nodeDb: paths.nodeDb, flags: nodeFlags, ...(secret === undefined ? {} : { secret }) })
  let nodeState = 'starting'

  let shown = 0
  const supervisor = superviseNode({
    spawn: /** @type {any} */ (spawn),
    fetch: outsideFetch,
    program: NODE_PROGRAM,
    args: currentArgs(),
    key: nodeKey,
    apiPort: config.ports.nodeApi,
    beforeLaunch: () => clearLeftLocks({ directory: `${config.files}/node`, removeDir: env.removeDir, alive: () => outsideFetch(`${nodeBase}/health`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false), log }),
    ...(env.timing === undefined ? {} : { timing: env.timing }),
    onState: ({ state, detail }) => { nodeState = state; log(`node ${state}${detail === undefined ? '' : `: ${detail}`}`); send({ type: 'node', state, ...(detail === undefined ? {} : { detail }) }) },
    onLine: (line) => {
      const traced = config.trace !== 'warn'
      if (shown < (traced ? LINES_MAX_TRACED : LINES_MAX) && (traced || shown < LINES_SHOWN || /\b(WARN|ERROR)\b|panic|Error:/.test(line))) { shown += 1; log(`node: ${line.replace(KEY_IN_TEXT, '<key>').slice(0, 300)}`) }
    }
  })
  undo.push(() => supervisor.stop())
  env.onMessage((message) => {
    if (message?.cmd === 'stop') stop(0).catch(() => {})
    else if (message?.cmd === 'status') feed?.now().catch(() => {})
  })

  try { await supervisor.ready } catch (error) { await fail('node', error); return }

  if (nodeFlags.includes('--publish')) {
    const publishing = await outsideFetch(`${nodeBase}/orivon/publishing`).then((answer) => answer.json(), () => null).catch(() => null)
    if (publishing?.keys === 'locked') {
      const message = `the node's key file (node/keys.db) was sealed under another secret than ${paths.keySecret}: no community can be started, and nothing is changed or deleted`
      log(`keys: ${message}`)
      send({ type: 'error', where: 'keys', message, code: 'keys-locked' })
    }
  }

  // The lanes keep a few of the engine's six connections to the node's API free of the reads that wait on the network (lanes.js). Called over `http` there is no such
  // pool, so no read is held back by another and none waits for a place. BITSOCIAL_SLOW_CALLS is for a measurement: a number is how many of those reads may be out at
  // once (0: no limit), and "share" is the lanes' usual share of the six, over http as well.
  const slowSetting = env.env['BITSOCIAL_SLOW_CALLS'] ?? ''
  const slowCalls = Number(slowSetting)
  const slowMax = slowSetting === 'share' ? undefined : slowSetting !== '' && Number.isInteger(slowCalls) ? slowCalls : env.nodeOverHttp === true ? 0 : undefined
  const node = createNodeClient({ base: nodeBase, key: nodeKey, fetch: callNode, ...(tracing ? { trace: log } : {}), ...(slowMax === undefined ? {} : { lanes: createLanes({ slowMax }) }) })
  const facade = traceFacade(await createKuboFacade({ node, statePath: paths.facadeState, gateway: `/ip4/127.0.0.1/tcp/${config.ports.gateway}`, allowedOrigins: config.origins }), log, Date.now, { calls: tracing })
  undo.push(() => facade.close())
  const unhook = installFetchHook(scope, [kuboUrl, gatewayUrl], facade)
  undo.push(unhook)

  // Ethereum is read through the browser's light client when the browser offers an app one, and from the public servers as the desktop clients do when it does not or
  // cannot answer. BITSOCIAL_ETH_PUBLIC=off takes the public servers away, for a run that must reach no public chain (a spec): nothing is read but through the light client.
  const publicServers = env.env['BITSOCIAL_ETH_PUBLIC'] === 'off' ? [] : env.ethRpcUrls ?? ETH_RPC_URLS
  const reads = config.isolated === undefined && canUseLightClient(env.orivon)
    ? createEthereumReads({ orivon: /** @type {any} */ (env.orivon), fetch: env.fetch, warn: (line) => { warn(redact(line)) } })
    : null
  if (reads !== null) {
    const endpoint = reads.endpoint(publicServers)
    undo.push(installFetchHook(scope, ETHEREUM_ORIGIN, endpoint))
    // The evm-contract challenge reads an author's name on Ethereum from the server its own viem names, whatever chain its board is on: that server is answered here too.
    undo.push(installFetchHook(scope, VIEM_MAINNET_URL, ensRoute(endpoint)))
  }
  /** Which path reads Ethereum, for the name section of the dashboard; asking is what makes the browser put its question to the person, so the dashboard's first ask starts it. */
  const ethereum = () => {
    if (config.isolated !== undefined) return { path: 'none' }
    if (reads === null) return { path: 'public', why: 'unsupported' }
    reads.look()
    return reads.status()
  }

  /** What a board's settings can name beside pkc-js's own, put where pkc-js looks a name up before anything that could start a community. */
  const registry = env.challenges?.registry ?? {}
  if (env.challenges !== undefined) log(`challenges registered: ${registerChallenges(registry, undefined, reads === null ? {} : { ethereumUrl: ETHEREUM_ORIGIN }).length}`)

  /** The RPC server, once it is up: the board managers connect to it and ask it what it hosts. @type {Awaited<ReturnType<typeof startRpcServer>> | null} */
  let rpcServer = null
  const managers = env.boardManager === undefined || env.fs === undefined
    ? null
    : superviseBoardManagers({
      start: env.boardManager.startBoardManager,
      resolve: env.boardManager.resolveBoardManagerOptions,
      store: boardConfigStore({ directory: paths.boardManager, fs: env.fs }),
      rpcUrl: `ws://127.0.0.1:${config.ports.rpc}/${config.authKey}`,
      hosted: () => rpcServer?.hosted() ?? [],
      log, warn, redact
    })

  const pkc = () => rpcServer?.pkc() ?? null
  /** Seeding: the communities a person follows, kept while their owners are away. Without the file API it has nowhere to keep its list, so a build that has none answers that it has no seeding. */
  const seeder = env.fs === undefined
    ? null
    : createSeeder({ store: seedingStore({ directory: paths.seeding, fs: env.fs }), node, open: communityOpener({ pkc, warn: (line) => { warn(redact(line)) } }), hosted: () => rpcServer?.hosted() ?? [], log, warn: (line) => { warn(redact(line)) } })
  const bandwidth = bandwidthReader({ fetch: outsideFetch, base: nodeBase, key: nodeKey })
  const network = {
    state: async () => describeReach({ status: await readStatus({ fetch: outsideFetch, base: nodeBase, key: nodeKey, ...relayOption() }), bandwidth: await bandwidth(), relay: relay.current(), supported: nodeFlags.includes('--relay'), node: nodeState }),
    setRelay: (/** @type {unknown} */ address) => relay.set(address),
    removeRelay: () => relay.clear()
  }

  /** @type {Awaited<ReturnType<typeof listenFacade>> | null} */
  let gateway = null
  try {
    const api = pageApi({ facade, authKey: config.authKey, kuboUrl, bandwidth, reachability: async () => (await readStatus({ fetch: outsideFetch, base: nodeBase, key: nodeKey, peers: false, ...relayOption() }))?.reachability ?? 'unknown' })
    const challengeList = env.challenges === undefined ? null : { list: () => describeChallenges(registry, { filesDir: config.files }) }
    const server = () => { if (rpcServer === null) throw new KuboError('the board server is not running yet', { status: 503 }); return rpcServer }
    const boardChallengeSettings = challengeList === null ? null : boardChallenges({ hosted: () => rpcServer?.hosted() ?? [], read: async (address) => server().settings(address), edit: async (address, settings) => server().editSettings(address, settings) })
    const boards = boardRecords({ pkc })
    const { authKey } = config
    const doors = gatewayOnly(
      facade, api, managerApi({ authKey, managers, noArchive: async (address) => (await rpcServer?.noArchive(address)) ?? null }), listingApi({ authKey, boards }),
      nameApi({ authKey, boards, claims: nameClaims({ pkc }), ethereum }), seedingApi({ authKey, seeder }), reachApi({ authKey, network }), challengesApi({ authKey, challenges: challengeList, boards: boardChallengeSettings, ethereum })
    )
    gateway = await listenFacade(http, config.ports.gateway, keepAlive(doors), (error) => { log(`gateway request: ${textOf(error)}`) })
    undo.push(() => gateway?.close())
  } catch (error) {
    log(`gateway: ${textOf(error)}`)
    send({ type: 'error', where: 'gateway', message: textOf(error), code: /** @type {any} */ (error)?.code ?? null })
  }

  /** @type {Awaited<ReturnType<typeof startRpcServer>>} */
  let rpc
  for (let attempt = 1; ; attempt += 1) {
    try {
      rpc = await startRpcServer({
        PKCRpc, http, port: config.ports.rpc, authKey: config.authKey,
        pkcOptions: desktopPkcOptions({ dataPath: paths.data, kuboUrl, isolated: config.isolated !== undefined, lightClient: reads !== null, ethRpcUrls: publicServers }),
        onError: (error) => { log(`rpc: ${textOf(error)}`); send({ type: 'error', where: 'rpc', message: textOf(error), code: /** @type {any} */ (error)?.code ?? null }) }
      })
      break
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'limit' || attempt >= RPC_START_ATTEMPTS) { await fail('rpc', error); return }
      log(`rpc: the origin's call limit refused the start (try ${attempt} of ${RPC_START_ATTEMPTS}), asking again`)
      await new Promise((resolve) => setTimeout(resolve, env.rpcRetryMs ?? 2000))
    }
  }
  rpcServer = rpc
  undo.push(() => rpc.close())
  if (managers !== null) {
    undo.push(() => managers.stop())
    managers.begin()
  }
  if (seeder !== null) {
    undo.push(() => seeder.stop())
    seeder.begin()
  }

  let reported = ''
  feed = startStatusFeed({
    read: () => readStatus({ fetch: outsideFetch, base: nodeBase, key: nodeKey, ...relayOption() }),
    onStatus: (status) => {
      send({ type: 'status', status })
      const line = status === null ? null : reachabilityLine(status)
      if (line !== null && line !== reported) { reported = line; warn(line) }
    }
  })
  const started = feed
  undo.push(() => started.stop())
  send({ type: 'ready', ports: { rpc: config.ports.rpc, gateway: gateway === null ? null : config.ports.gateway } })
  log(`ready: RPC on 127.0.0.1:${config.ports.rpc}, gateway ${gateway === null ? 'not listening' : `on 127.0.0.1:${config.ports.gateway}`}`)
}
