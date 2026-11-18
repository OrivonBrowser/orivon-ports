// Starts Bitsocial Node's Worker from a page and reports on it. A Bitsocial node already answering on the RPC port
// (another tab of this app, or the person's own Bitsocial desktop or command-line node) is used as it is; otherwise the
// page forks the Worker bundle (node/server.mjs), which runs pkc-js's RPC server over Orivon's IPFS node. The build
// bundles this file with Orivon's Node shim into `node-client.js` for any page, which gets `globalThis.BitsocialNodeClient`.

import { fork } from 'child_process'
import { startFollowSync } from './follow-sync.js'

/** The ports the manifest lets this app listen on and reach. `rpc` and `gateway` are the Bitsocial desktop clients' own. */
export const DEFAULT_PORTS = Object.freeze({ rpc: 9138, gateway: 6473, kubo: 50019, nodeApi: 5351, p2p: 4851 })
/** The app's files directory in the Worker's file system, where the node keeps its data. */
export const DEFAULT_FILES = '/orivon/app/bitsocial'
export const DEFAULT_SERVER = 'node/server.mjs'

/** Where the Worker's gateway socket answers a page's read-only calls (`node/worker/page-api.js`). */
const PAGE_API_PATH = '/orivon/api/'
/** Where it answers the board manager's control calls (`node/worker/manager-api.js`). */
const MANAGER_API_PATH = '/orivon/manager/'
/** Where it answers the listing calls (`node/worker/listing-api.js`). */
const LISTING_API_PATH = '/orivon/listing/'
/** Where it answers the name calls (`node/worker/name-api.js`). */
const NAME_API_PATH = '/orivon/name/'
/** Where it answers the seeding calls (`node/worker/seeding-api.js`) and the reach calls (`node/worker/reach-api.js`). */
const SEEDING_API_PATH = '/orivon/seeding/'
const REACH_API_PATH = '/orivon/reach/'
const PROBE_MS = 2_000
const READY_MS = 150_000
const STOP_MS = 15_000
/** A node that is busy (a board starting, a pin) answers a statistics call late; a missing value shows as unknown, so it is waited for. */
const STATS_CALL_MS = 20_000
/** Where it answers the read of the anti-spam challenges it runs (`node/worker/challenges-api.js`). */
const CHALLENGES_API_PATH = '/orivon/challenges/'
const KEY_NAME = 'bitsocial-node-key'

/** @typedef {{ rpc: number, gateway: number, kubo: number, nodeApi: number, p2p: number }} Ports */
/**
 * @typedef {object} Snapshot
 * @property {boolean} running a Worker of this page, or a node found on the RPC port, is up
 * @property {boolean} reused the node was already running
 * @property {'unknown' | 'starting' | 'up' | 'restarting' | 'failed'} node the IPFS node, as the Worker last said
 * @property {string | null} peer
 * @property {'public' | 'private' | 'unknown'} reachability whether peers on the internet can get to the node (`node/worker/reachability.js`)
 * @property {string | null} basis what that answer rests on, as the Worker named it
 * @property {{ state: string, relaysKnown: number, relaysHeld: number, punched: number, failed: number } | null} punch the node's hole punch state and counts, null for a node that does not punch
 * @property {number | null} peers
 * @property {string[]} listen
 * @property {string[]} external
 * @property {Array<{ where: string, message: string, code: string | null }>} errors the last ten
 */

/**
 * The key this app's tabs share, kept in `storage` (a page's `localStorage`) and made once.
 * @param {{ getItem: (name: string) => string | null, setItem: (name: string, value: string) => void }} storage
 * @param {() => string} [random] 32 hex characters
 */
export function authKeyFrom (storage, random = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')) {
  const kept = storage.getItem(KEY_NAME)
  if (kept !== null && /^[A-Za-z0-9_-]{16,128}$/.test(kept)) return kept
  const made = random()
  storage.setItem(KEY_NAME, made)
  return made
}

/** Whether something accepts a WebSocket at `url`. @param {string} url @param {typeof WebSocket} Socket */
function answering (url, Socket) {
  return new Promise((resolve) => {
    let done = false
    /** @type {WebSocket | undefined} */
    let socket
    const finish = (/** @type {boolean} */ yes) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { socket?.close() } catch { /* already closed */ }
      resolve(yes)
    }
    const timer = setTimeout(() => { finish(false) }, PROBE_MS)
    try { socket = new Socket(url) } catch { finish(false); return }
    socket.onopen = () => { finish(true) }
    socket.onerror = () => { finish(false) }
    socket.onclose = () => { finish(false) }
  })
}

/** @param {unknown} said kubo's AutoNAT word, in any case @returns {'public' | 'private' | 'unknown'} */
const verdictOf = (said) => { const word = typeof said === 'string' ? said.toLowerCase() : ''; return word === 'public' || word === 'private' ? word : 'unknown' }

/** @param {unknown} value @returns {number | null} */
const numberOf = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** What a Worker says about itself, folded into the page's view of it. @returns {Snapshot} */
const blank = () => ({ running: false, reused: false, node: 'unknown', peer: null, reachability: 'unknown', basis: null, punch: null, peers: null, listen: [], external: [], errors: [] })

/** @type {Map<number, Promise<any>>} one start per RPC port in a page */
const SHARED = new Map()

/**
 * @typedef {object} StartOptions
 * @property {string} authKey the path the RPC is opened at; the same for every tab of the app
 * @property {Partial<Ports>} [ports]
 * @property {string} [files]
 * @property {string} [serverPath] where the Worker bundle is served, default `node/server.mjs` beside the page
 * @property {string[]} [origins] page origins the media gateway answers fetches from
 * @property {string} [trace] the IPFS node's trace filter
 * @property {string} [debug] more of pkc-js's log namespaces for the Worker to write (a `debug` pattern); the few that say how its RPC server started are always written
 * @property {string} [relay] a circuit relay the person names, `/ip4|ip6|dns4|dns6/<host>/tcp/<port>/p2p/<relay peer id>`; none by default
 * @property {{ bootstrap: string[] }} [isolated] a run with no internet, for a test (`node/worker/config.js` says what it means)
 */

/**
 * @param {StartOptions} options
 * @param {{ fork?: typeof fork, WebSocket?: typeof WebSocket, fetch?: typeof fetch, shared?: Map<number, Promise<any>> }} [deps]
 */
export function startBitsocialNode (options, deps = {}) {
  const ports = { ...DEFAULT_PORTS, ...options.ports }
  const shared = deps.shared ?? SHARED
  const existing = shared.get(ports.rpc)
  if (existing !== undefined) return existing
  const started = begin(options, ports, deps)
  shared.set(ports.rpc, started)
  const forget = () => { if (shared.get(ports.rpc) === started) shared.delete(ports.rpc) }
  started.then((handle) => {
    handle.on('exit', forget)
    // The communities the app follows reach the node for seeding while the page is open, whoever started the node.
    if (globalThis.indexedDB !== undefined) handle.on('exit', startFollowSync(handle))
  }, forget)
  return started
}

/** @param {StartOptions} options @param {Ports} ports @param {NonNullable<Parameters<typeof startBitsocialNode>[1]>} deps */
async function begin (options, ports, deps) {
  const { authKey, files = DEFAULT_FILES } = options
  const forkWorker = deps.fork ?? fork
  const Socket = deps.WebSocket ?? globalThis.WebSocket
  const rpcUrl = `ws://localhost:${ports.rpc}/${authKey}`
  const gatewayUrl = `http://localhost:${ports.gateway}`

  /** @type {Snapshot} */
  let state = blank()
  /** @type {Map<string, Set<(value: any) => void>>} */
  const listeners = new Map()
  const emit = (/** @type {string} */ name, /** @type {any} */ value) => { for (const handler of listeners.get(name) ?? []) { try { handler(value) } catch (error) { console.warn(`[bitsocial-node] a listener of "${name}" threw`, error) } } }
  const update = (/** @type {Partial<Snapshot>} */ change) => { state = { ...state, ...change }; emit('status', state) }

  /** One call of a control channel on the gateway's socket, with the key. @param {string} path @param {string} what @param {string} call @param {Record<string, unknown>} body @param {{ signal?: AbortSignal }} options @returns {Promise<any>} */
  async function control (path, what, call, body, { signal } = {}) {
    const answer = await (deps.fetch ?? globalThis.fetch.bind(globalThis))(`${gatewayUrl}${path}${call}`, { method: 'POST', headers: { Authorization: `Bearer ${authKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) })
    const text = await answer.text()
    /** @type {any} */
    let value = null
    try { value = JSON.parse(text) } catch { /* the Worker answered something else */ }
    if (!answer.ok) throw Object.assign(new Error(typeof value?.Message === 'string' ? value.Message : `${what} answered ${String(answer.status)}`), { status: answer.status })
    return value
  }

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  const handle = {
    rpcUrl,
    gatewayUrl,
    ports,
    get reused () { return state.reused },
    /** @returns {Snapshot} */
    snapshot: () => state,
    /** @param {'status' | 'node' | 'error' | 'exit'} name @param {(value: any) => void} handler @returns {() => void} */
    on (name, handler) {
      const set = listeners.get(name) ?? new Set()
      set.add(handler)
      listeners.set(name, set)
      return () => { set.delete(handler) }
    },
    /**
     * One of the read-only calls the Worker answers a page over the gateway's socket (`node/worker/page-api.js`: kubo's
     * `id`, `swarm/peers`, `repo/stat` and the AutoNAT verdict), with the key. It works for a node this page did not
     * start, which has no Worker handle to ask, and it answers with kubo's own JSON.
     * @param {string} call @param {{ query?: string, signal?: AbortSignal }} [options] @returns {Promise<Response>}
     */
    api (call, { query = '', signal } = {}) {
      return (deps.fetch ?? globalThis.fetch.bind(globalThis))(`${gatewayUrl}${PAGE_API_PATH}${call}${query}`, { method: 'POST', headers: { Authorization: `Bearer ${authKey}` }, ...(signal === undefined ? {} : { signal }) })
    },
    /**
     * One of the board manager's control calls (`node/worker/manager-api.js`: `boards`, `board`, `enable`, `disable`, `config`,
     * `defaults`, `defaults/set`), with the key. It answers the call's JSON, and throws an error carrying `status` and kubo's
     * `Message` when the Worker refuses (400 for a value it does not take, 404 for a board the node does not host, 503 for a
     * build with no board manager). Like `api`, it reaches a node this page did not start.
     * @param {string} call @param {Record<string, unknown>} [body] @param {{ signal?: AbortSignal }} [options] @returns {Promise<any>}
     */
    manager: (call, body = {}, options = {}) => control(MANAGER_API_PATH, 'the board manager', call, body, options),
    /**
     * One of the listing calls (`node/worker/listing-api.js`: `board`, a board's record as a directory checks it, and `sign`, a request
     * to be listed that the board's own key signs), answered and refused as the board manager's are (409 for a board whose
     * identity key the node does not hold).
     * @param {string} call @param {Record<string, unknown>} [body] @param {{ signal?: AbortSignal }} [options] @returns {Promise<any>}
     */
    listing: (call, body = {}, options = {}) => control(LISTING_API_PATH, 'the listing call', call, body, options),
    /**
     * One of the name calls (`node/worker/name-api.js`: `boards`, `record`, the text record a name must hold to point at a board, `check`, whether
     * it does, and `transaction`, the transaction that sets the record, as data for a wallet), answered and refused as the listing calls are
     * (409 for a name with no resolver, 502 when Ethereum could not be read, 429 while two reads are running).
     * @param {string} call @param {Record<string, unknown>} [body] @param {{ signal?: AbortSignal }} [options] @returns {Promise<any>}
     */
    names: (call, body = {}, options = {}) => control(NAME_API_PATH, 'the name call', call, body, options),
    /**
     * One of the seeding calls (`node/worker/seeding-api.js`: `state`, `enable`, `disable`, `limit`, `add`, `remove`, `follow`, `run`), answered and
     * refused as the board manager's are (400 for a value it does not take, 503 for a build with no seeding).
     * @param {string} call @param {Record<string, unknown>} [body] @param {{ signal?: AbortSignal }} [options] @returns {Promise<any>}
     */
    seeding: (call, body = {}, options = {}) => control(SEEDING_API_PATH, 'the seeding call', call, body, options),
    /**
     * One of the reach calls (`node/worker/reach-api.js`: `state`, `relay/set`, `relay/remove`), answered and refused as the seeding calls are
     * (409 for a node that cannot take a relay, as one that runs on its own).
     * @param {string} call @param {Record<string, unknown>} [body] @param {{ signal?: AbortSignal }} [options] @returns {Promise<any>}
     */
    reach: (call, body = {}, options = {}) => control(REACH_API_PATH, 'the reach call', call, body, options),
    /** What a statistics page shows, from the page API; a value the node does not answer is null. */
    async stats () {
      /** @param {string} call @returns {Promise<any>} */
      const ask = async (call) => { try { const answer = await handle.api(call, { signal: AbortSignal.timeout(STATS_CALL_MS) }); return answer.ok ? await answer.json() : null } catch { return null } }
      const [id, peers, autonat, repo] = await Promise.all([ask('id'), ask('swarm/peers'), ask('swarm/addrs/autonat'), ask('repo/stat')])
      return { peer: typeof id?.ID === 'string' ? id.ID : null, peers: Array.isArray(peers?.Peers) ? peers.Peers.length : null, reachability: verdictOf(autonat?.reachability), repoBytes: numberOf(repo?.RepoSize), storageMax: numberOf(repo?.StorageMax) }
    },
    /**
     * The anti-spam challenges the node runs and the challenges of the boards it hosts (`node/worker/challenges-api.js`): `challenges('list')` answers
     * `{ challenges, unavailable }`, each challenge with its `name` (the name a board's settings use), `version`, `licence`, `description`, what it
     * `asks` of a poster, `type`, the schema of its options and the hosts it calls, and each one this build left out with its reason; `'boards'` the
     * boards the node hosts, `'board'` (`{ address }`) one board's challenges and the names of its other settings, and `'apply'` (`{ address, challenges,
     * expect }`) sets a board's challenges and keeps every other setting. It throws an error carrying `status` and kubo's `Message` when the Worker
     * refuses (503 for a build with none, 404 for a board the node does not host, 409 when `expect` is not the list the board has now, 400 for a list
     * pkc-js refuses, with `failures`: the challenge and the option of each). Like `api`, it reaches a node this page did not start.
     * @param {'list' | 'boards' | 'board' | 'apply'} call @param {Record<string, unknown>} [body] @param {{ signal?: AbortSignal }} [options] @returns {Promise<any>}
     */
    async challenges (call, body = {}, { signal } = {}) {
      const answer = await (deps.fetch ?? globalThis.fetch.bind(globalThis))(`${gatewayUrl}${CHALLENGES_API_PATH}${call}`, { method: 'POST', headers: { Authorization: `Bearer ${authKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) })
      const text = await answer.text()
      /** @type {any} */
      let value = null
      try { value = JSON.parse(text) } catch { /* the Worker answered something else */ }
      if (!answer.ok) throw Object.assign(new Error(typeof value?.Message === 'string' ? value.Message : `the challenge list answered ${String(answer.status)}`), { status: answer.status, ...(Array.isArray(value?.failures) ? { failures: value.failures } : {}) })
      return value
    },
    /** The node's reachability now: the Worker is asked, and the last known value stands when it does not answer. @returns {Promise<'public' | 'private' | 'unknown'>} */
    async reachability () {
      if (child === null && state.running) {
        const answer = await handle.api('swarm/addrs/autonat', { signal: AbortSignal.timeout(STATS_CALL_MS) }).then((response) => (response.ok ? response.json() : null), () => null)
        // `unknown` is an answer too (the node is still finding a way in): only a call that gave none leaves the last verdict.
        if (typeof answer?.reachability === 'string') update({ reachability: verdictOf(answer.reachability) })
        return state.reachability
      }
      if (child === null || !state.running) return state.reachability
      const answered = new Promise((resolve) => { const off = handle.on('status', () => { off(); resolve(undefined) }); setTimeout(() => { off(); resolve(undefined) }, 5_000) })
      child.send({ cmd: 'status' })
      await answered
      return state.reachability
    },
    /** Ends the Worker this page started, and with it the node; a node found running is left alone. */
    async stop () {
      if (child === null) return
      const ended = new Promise((resolve) => { child?.once('exit', () => { resolve(undefined) }) })
      try { child.send({ cmd: 'stop' }) } catch { child.kill() }
      await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, STOP_MS))])
      if (state.running) child.kill()
    }
  }

  if (await answering(rpcUrl, Socket)) {
    update({ running: true, reused: true })
    return handle
  }

  const config = { authKey, files, ports, origins: options.origins ?? [], trace: options.trace ?? 'warn', ...(options.debug === undefined ? {} : { debug: options.debug }), ...(options.relay === undefined ? {} : { relay: options.relay }), ...(options.isolated === undefined ? {} : { isolated: options.isolated }) }
  const serverPath = options.serverPath ?? new URL(DEFAULT_SERVER, globalThis.location?.href).pathname
  const worker = forkWorker(serverPath, [], { silent: true, serialization: 'advanced', env: { BITSOCIAL_NODE: JSON.stringify(config), NODE_ENV: 'production', WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1' } })
  child = worker
  update({ node: 'starting' })

  for (const [stream, write] of /** @type {const} */ ([[worker.stdout, console.log], [worker.stderr, console.warn]])) {
    let pending = ''
    const decoder = new TextDecoder()
    stream?.on('data', (/** @type {Uint8Array | string} */ chunk) => {
      const whole = (pending + (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))).split('\n')
      pending = whole.pop() ?? ''
      for (const line of whole) if (line.trim() !== '') write(line)
    })
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => { settle(new Error(`Bitsocial Node did not start within ${String(READY_MS / 1000)} seconds`)); worker.kill() }, READY_MS)
    const settle = (/** @type {Error | null} */ error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === null) resolve(handle)
      else reject(error)
    }
    worker.on('message', (/** @type {any} */ message) => {
      switch (message?.type) {
        case 'node':
          update({ node: message.state })
          emit('node', { state: message.state, detail: message.detail ?? null })
          break
        case 'status':
          if (message.status !== null) update({ peer: message.status.peer, reachability: message.status.reachability, basis: message.status.basis ?? null, punch: message.status.punch ?? null, peers: message.status.peers, listen: message.status.listen, external: message.status.external })
          break
        case 'error': {
          const problem = { where: String(message.where), message: String(message.message), code: message.code ?? null }
          update({ errors: [...state.errors, problem].slice(-10) })
          emit('error', problem)
          break
        }
        case 'ready':
          update({ running: true })
          settle(null)
          break
        case 'failed':
          settle(Object.assign(new Error(`Bitsocial Node could not start (${String(message.stage)}): ${String(message.message)}`), { stage: message.stage, code: message.code ?? null }))
          break
      }
    })
    worker.on('error', (/** @type {Error} */ error) => { settle(error); update({ running: false }); emit('exit', { code: null, signal: null, error: error.message }) })
    worker.on('exit', (/** @type {number | null} */ code, /** @type {string | null} */ signal) => {
      settle(new Error(`Bitsocial Node's Worker ended before it was ready (${signal ?? `code ${String(code)}`})`))
      update({ running: false, node: 'unknown' })
      emit('exit', { code, signal })
    })
  })
}
