// Starts the Bitsocial node the desktop app starts in its main process, and answers the page's calls to the node's API.
// Loaded last in the head, after node-client.js (the node package's page module, which sets BitsocialNodeClient).
//
// 1. The node: started with the ports of this app's manifest and the key the bridge made, or found already running.
//    `window.orivonBitsocialNode.ready` settles with its handle, or with null and `error` when it did not start. A failed start
//    is made again after a pause (v0.1.0 refuses a closed app's start as `revoked` for about half a minute); on a content address
//    the first failure reads the node's files (below) instead.
// 2. The bundle: the build leaves the page's module entry typed `orivon-held-module`, which no browser runs. It is given its own
//    type back as soon as the page is parsed, on every launch, before the node has answered (README, "The bundle is shown while the
//    node starts"): the RPC socket the bundle opens is held (item 4), so the app does not wait for the node to be up. A page that has no
//    bundle to release (the node dashboard) says what it waits for once the wait is noticeable, until the node answered or the last
//    retry failed.
// 3. `fetch`: a call to the desktop's kubo port (the page's node statistics and the reachability check) never leaves
//    the page. It is answered by the node's own socket with the key, so no kubo API listens on a port another app of
//    this person could be granted. The node (`node/worker/page-api.js`) says which calls are allowed.
// 4. `WebSocket`, the RPC socket: one the bundle opens before the node has answered is reported open at once, as a dial to a node that is
//    there would be (an app whose RPC is not connected shows a dialog of its own), what is sent on it waits, and the real one is opened
//    when the node has answered or failed to start. A node that answers after 270 seconds makes the page load once more. Every other
//    socket, and every socket after the answer, is left as it is.
//
// Outside Orivon (no `window.orivon.version`, which every Orivon tab has), and in a page that has not been given its permissions yet, nothing is started and the bundle runs at once; outside Orivon `fetch` and `WebSocket` also stay as they are.

(function () {
  const PORTS = { rpc: 9138, gateway: 6473, kubo: 50019, nodeApi: 50119, p2p: 4001 }
  const KEY_STORAGE = 'orivon.pkcRpcAuthKey'
  const RELOAD_STORAGE = 'orivon.bitsocialNodeReload'
  const HELD_TYPE = 'orivon-held-module'
  const KUBO_PATH = '/api/v0/'
  const KUBO_ORIGINS = [`http://localhost:${String(PORTS.kubo)}`, `http://127.0.0.1:${String(PORTS.kubo)}`]
  const serverPath = new URL('../node/server.mjs', document.currentScript.src).pathname
  const RETRY_PAUSES_MS = [4_000, 8_000, 16_000, 30_000]
  const WAITING_AFTER_MS = 1_500
  /** A call sent to the RPC client waits 300 s for its answer; a node that answers after this long has left the first calls timed out. */
  const RELOAD_AFTER_MS = 270_000
  const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  // The same test the hint makes: every Orivon tab's main frame has it, and an ordinary browser does not.
  const inOrivon = typeof window.orivon === 'object' && window.orivon !== null && typeof window.orivon.version === 'number'

  const node = { ready: Promise.resolve(null), handle: null, error: null }
  window.orivonBitsocialNode = node

  const parsed = document.readyState === 'loading' ? new Promise((resolve) => { document.addEventListener('DOMContentLoaded', resolve, { once: true }) }) : Promise.resolve()

  let released = false
  let waiting = null
  const BASE_WAITING = 'Starting your Bitsocial node...'
  let waitingText = BASE_WAITING

  /** What the wait says now, shown at once when it is already on the page. */
  function say (text) {
    waitingText = text
    if (waiting !== null) waiting.textContent = text
  }

  /** The page is empty while the bundle is held, so a wait a person can notice says what it is for. */
  function showWaiting () {
    if (released || waiting !== null || document.body == null) return
    waiting = document.createElement('div')
    waiting.textContent = waitingText
    waiting.style.cssText = 'position:fixed;top:12px;left:12px;font:14px sans-serif;color:#555'
    document.body.append(waiting)
  }

  function release () {
    if (released) return
    released = true
    waiting?.remove()
    for (const held of document.querySelectorAll(`script[type="${HELD_TYPE}"]`)) {
      const script = document.createElement('script')
      for (const { name, value } of held.attributes) script.setAttribute(name, name === 'type' ? 'module' : value)
      held.replaceWith(script)
    }
  }

  function rpcKey () {
    if (typeof window.pkcRpcAuthKey === 'string') return window.pkcRpcAuthKey
    try { return localStorage.getItem(KEY_STORAGE) } catch { return null }
  }

  // The node's files are read, once, after a first start that failed. A page served from a content address (an `.orivon` host such as `<cid>.ipfs.orivon`, or a `.eth` name) gets every
  // file of its own from the browser's verifier, which first has to find the file's blocks on the IPFS network, and sends nothing of a file until it holds the whole of it and has
  // checked it. The node's two big files, the Worker's packed script (5.5 MB) and the node's packed program (6.3 MB), are the ones a slow or crowded route does not deliver in time: the fork loads them
  // once, with no second try, and the node client ends the start after 150 s, which ends the fork's loads with them. So the node is forked at once, as it was before this existed, and
  // when that start fails the files are read here, whole and with another try after a pause that doubles, in place of the first pause: each file leaves the blocks it did reach in the
  // browser's IPFS store, so every try reaches further and the next fork's own loads are answered from it. A start that succeeds reads nothing, so an installed app whose files the
  // browser holds starts as fast as ever. The wait is the page the person is already shown ("Starting your Bitsocial node"), with the file it is on. A page served from this computer
  // (a loopback address, as the specs and the dev server are) has its files already, and reads nothing.
  // The files the fork loads at start, with their sizes: the Worker's loader and its script (packed, as is the node's program), the node's program (`ipfs-node.p2/` is jco's output for it:
  // its glue, the packed program and three small parts), and the SQLite engine the Worker opens. `node-start.test.ts` compares the list with the node bundle's pin, so a bundle that
  // changes its files fails there.
  const NODE_FILES = [
    ['node/server.mjs', 1_354],
    ['node/server.bundle.js.deflate', 5_537_350],
    ['bin/ipfs-node.p2/ipfs-node.js', 1_029_550],
    ['bin/ipfs-node.p2/ipfs-node.core.wasm.deflate', 6_260_967],
    ['bin/ipfs-node.p2/ipfs-node.core2.wasm', 4_045],
    ['bin/ipfs-node.p2/ipfs-node.core3.wasm', 1_731],
    ['bin/ipfs-node.p2/ipfs-node.core4.wasm', 697],
    ['node/sqlite3.wasm', 868_907]
  ]
  const CONTENT_ADDRESSED = /\.(orivon|eth)$/i
  /** How long one file may take to be read, from its first try to its last: ten minutes, or its size at 20 kB/s when that is longer. Past it the node's start gives up, naming the file. A try that brings nothing may still have fetched blocks the next one uses, so a file is not given up on while the provider could be delivering it at that rate. */
  const WARM_PATIENCE_MS = 600_000
  const WARM_MIN_BYTES_PER_SECOND = 20_000
  /** The pause before the second try of a file; each later one is twice as long, up to the last. */
  const WARM_PAUSES_MS = [2_000, 4_000, 8_000, 16_000, 30_000]
  /** A read that has received nothing for this long is ended and made again: the verifier sends a file only once it holds the whole of it and has checked it, so the first byte can be minutes in, and the blocks a read had gathered stay for the next one. */
  const WARM_STALL_MS = 330_000
  const appRoot = new URL('../', document.currentScript.src)
  const pageFetch = window.fetch.bind(window)
  const RealWebSocket = window.WebSocket

  /** One read of `file` to its end, `progress(bytes so far, the answer's length)` as it comes. A cut throws with the bytes it had brought (`got`), whether the connection broke or the answer ended short. A file this build has not got is let go. */
  async function readFileWhole (file, progress) {
    const stop = new AbortController()
    let stalled = setTimeout(() => { stop.abort() }, WARM_STALL_MS)
    let got = 0
    try {
      const answer = await pageFetch(new URL(file, appRoot).href, { cache: 'no-store', signal: stop.signal })
      if (answer.status === 404) { await answer.body?.cancel(); return }
      if (!answer.ok) throw new Error(`answered ${String(answer.status)}`)
      const length = answer.headers.get('content-length')
      const size = length === null ? Number.NaN : Number(length)
      const reader = answer.body.getReader()
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        got += part.value.length
        clearTimeout(stalled)
        stalled = setTimeout(() => { stop.abort() }, WARM_STALL_MS)
        progress(got, size)
      }
      if (Number.isFinite(size) && got !== size) throw new Error(`the answer ended at ${String(got)} of ${String(size)} bytes`)
    } catch (error) {
      const said = new Error(stop.signal.aborted ? `nothing came for ${String(WARM_STALL_MS / 1000)} s` : typeof error?.message === 'string' ? error.message : String(error))
      throw Object.assign(said, { got })
    } finally {
      clearTimeout(stalled)
    }
  }

  /** Whether the page is served from a content address, whose files the verifier fetches over the IPFS network. */
  function contentAddressed () {
    try { return CONTENT_ADDRESSED.test(new URL(location.origin).hostname) } catch { return false }
  }

  async function warmNodeFiles () {
    const megabytes = (bytes) => (bytes / 1_000_000).toFixed(1)
    for (const [index, [file, bytes]] of NODE_FILES.entries()) {
      const patience = Math.max(WARM_PATIENCE_MS, bytes / WARM_MIN_BYTES_PER_SECOND * 1000)
      const began = Date.now()
      for (let attempt = 1; ; attempt++) {
        try {
          say(`${BASE_WAITING} loading ${file} (${String(index + 1)} of ${String(NODE_FILES.length)})`)
          await readFileWhole(file, (got, size) => { say(`${BASE_WAITING} loading ${file}: ${megabytes(got)} of ${Number.isFinite(size) ? megabytes(size) : '?'} MB`) })
          break
        } catch (error) {
          const reason = error.message
          const pausing = WARM_PAUSES_MS[Math.min(attempt - 1, WARM_PAUSES_MS.length - 1)]
          const spent = Date.now() - began
          if (spent + pausing > patience) throw new Error(`the node's file ${file} could not be read: ${reason} (try ${String(attempt)}, ${String(error.got)} bytes received, ${String(Math.round(spent / 1000))} s after the first read of it began)`)
          console.error(`[5chan] reading ${file}: try ${String(attempt)} failed after ${String(error.got)} bytes (${reason}); trying again in ${String(pausing / 1000)} s`)
          say(`${BASE_WAITING} ${file} did not come whole; trying again in ${String(pausing / 1000)} s`)
          await pause(pausing)
        }
      }
    }
    say(BASE_WAITING)
  }

  async function start () {
    const client = window.BitsocialNodeClient
    if (client === undefined) throw new Error('node-client.js did not load')
    const authKey = rpcKey()
    if (authKey === null) throw new Error('this page has no node key yet: open 5chan first')
    let warmed = false
    for (let attempt = 0; ; attempt++) {
      try {
        // The client first asks whether a node answers on the RPC port, with a socket of its own: it is given the browser's, which holds nothing.
        node.handle = await client.startBitsocialNode({ authKey, ports: PORTS, origins: [location.origin], serverPath }, RealWebSocket === undefined ? {} : { WebSocket: RealWebSocket })
        return node.handle
      } catch (error) {
        if (attempt === RETRY_PAUSES_MS.length) throw error
        const reason = typeof error?.message === 'string' ? error.message : String(error)
        if (!warmed && contentAddressed()) {
          warmed = true
          console.error(`[5chan] the Bitsocial node did not start (${reason}); reading its files before it is started again`)
          await warmNodeFiles()
        } else {
          console.error(`[5chan] the Bitsocial node did not start (${reason}); trying again in ${String(RETRY_PAUSES_MS[attempt] / 1000)} s`)
          await pause(RETRY_PAUSES_MS[attempt])
        }
      }
    }
  }

  /** Gives the bundle its type back before the node has answered, on a page that has a bundle to give it to (the node dashboard has none). */
  function releaseEarly () {
    parsed.then(() => { if (document.querySelectorAll(`script[type="${HELD_TYPE}"]`).length > 0) release() })
  }

  // The RPC sockets the bundle opened while the node was starting, and whether the node is still starting.
  const holds = new Set()
  let holding = false
  let firstHeldAt = null

  /** A WebSocket that is open to the page while the node starts, and then the mirror of the real one, opened when the node has answered or failed: its events, and what is sent on it. */
  class HeldSocket extends EventTarget {
    #args
    #inner = null
    #queued = []
    #timer
    #binaryType = 'blob'
    #handlers = {}

    constructor (args) {
      super()
      this.#args = args
      this.url = String(args[0])
      this.readyState = 0
      for (const type of ['open', 'message', 'error', 'close']) {
        this.addEventListener(type, (event) => { this.#handlers[type]?.call(this, event) })
        Object.defineProperty(this, `on${type}`, { get: () => this.#handlers[type] ?? null, set: (handler) => { this.#handlers[type] = typeof handler === 'function' ? handler : undefined }, enumerable: true, configurable: true })
      }
      this.#timer = setTimeout(() => { this.#reportOpen() }, 0)
      holds.add(this)
      firstHeldAt ??= Date.now()
    }

    get protocol () { return this.#inner?.protocol ?? '' }
    get extensions () { return this.#inner?.extensions ?? '' }
    get bufferedAmount () { return this.#inner?.bufferedAmount ?? 0 }
    get binaryType () { return this.#binaryType }
    set binaryType (type) { this.#binaryType = type; if (this.#inner !== null) this.#inner.binaryType = type }

    #emit (type, fields = {}) {
      this.dispatchEvent(Object.assign(new Event(type), fields))
    }

    /** The socket says it is open as a dial to a node already there would, so the app sees the RPC it has on the desktop (a page not connected to its RPC says so with a dialog of its own); what is sent on it waits for the real one. */
    #reportOpen () {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.#emit('open')
    }

    /** The node has answered, or failed to start: the real socket is opened (a failed node refuses it, as the RPC client's own would have been) and mirrored. */
    settle () {
      clearTimeout(this.#timer)
      holds.delete(this)
      if (this.readyState > 1) return
      const socket = Reflect.construct(RealWebSocket, this.#args)
      socket.binaryType = this.#binaryType
      this.#inner = socket
      socket.addEventListener('open', () => {
        if (this.readyState === 0) { this.readyState = 1; this.#emit('open') }
        for (const data of this.#queued.splice(0)) socket.send(data)
      })
      socket.addEventListener('message', (event) => { this.#emit('message', { data: event.data, origin: event.origin, lastEventId: event.lastEventId }) })
      socket.addEventListener('error', () => { this.#emit('error') })
      socket.addEventListener('close', (event) => { this.readyState = 3; this.#emit('close', { code: event.code, reason: event.reason, wasClean: event.wasClean }) })
    }

    send (data) {
      if (this.readyState === 0) throw Object.assign(new Error("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state."), { name: 'InvalidStateError' })
      if (this.readyState !== 1) return
      if (this.#inner !== null && this.#inner.readyState === 1) this.#inner.send(data)
      else this.#queued.push(data)
    }

    close (code, reason) {
      if (this.readyState > 1) return
      if (this.#inner !== null) { this.readyState = 2; this.#inner.close(code, reason); return }
      // Closed before there was a real socket: a connection that never opened fails, one that was reported open ends.
      const neverOpen = this.readyState === 0
      this.readyState = 2
      clearTimeout(this.#timer)
      holds.delete(this)
      this.#queued = []
      Promise.resolve().then(() => {
        this.readyState = 3
        if (neverOpen) this.#emit('error')
        this.#emit('close', { code: neverOpen ? 1006 : (code ?? 1005), reason: neverOpen ? '' : (reason ?? ''), wasClean: !neverOpen })
      })
    }
  }
  Object.assign(HeldSocket.prototype, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })

  /** The node has answered (`handle`) or failed to start (null): the held sockets are opened, and a page that waited too long for a node that answered loads once more. */
  function settled (handle) {
    holding = false
    const waited = firstHeldAt === null ? 0 : Date.now() - firstHeldAt
    for (const held of [...holds]) held.settle()
    if (handle === null) return
    try {
      if (waited <= RELOAD_AFTER_MS) { sessionStorage.removeItem(RELOAD_STORAGE); return }
      // The calls the RPC client sent have timed out and its hooks do not ask again: the page loads once more, now that the node answers.
      if (sessionStorage.getItem(RELOAD_STORAGE) !== null) return
      sessionStorage.setItem(RELOAD_STORAGE, String(Date.now()))
      location.reload()
    } catch { /* no storage to remember it in: a page that cannot be told it has reloaded does not reload */ }
  }

  const refusal = (status, message) => new Response(JSON.stringify({ Message: message, Code: 0, Type: 'error' }), { status, headers: { 'Content-Type': 'application/json' } })

  async function kuboCall (address, signal) {
    if (!address.pathname.startsWith(KUBO_PATH)) return refusal(404, `${address.pathname} is not served by this build`)
    const handle = await node.ready
    if (handle === null) return refusal(503, node.error ?? 'the Bitsocial node is not running')
    return handle.api(address.pathname.slice(KUBO_PATH.length), { query: address.search, signal })
  }

  function addressOf (input) {
    try { return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href) } catch { return null }
  }

  const RPC_SOCKET = new RegExp(`^wss?://(localhost|127\\.0\\.0\\.1):${String(PORTS.rpc)}/`)

  try {
    const permitted = inOrivon && window.crossOriginIsolated === true && typeof window.orivon.fs?.readFile === 'function'
    if (permitted) {
      holding = true
      releaseEarly()
      node.ready = start().catch((error) => {
        node.error = error instanceof Error ? error.message : String(error)
        console.error(`[5chan] the Bitsocial node did not start: ${node.error}`)
        return null
      })
      node.ready.then(settled)
    } else {
      node.error = 'this page was not given the permissions the node needs'
    }
    if (inOrivon && typeof RealWebSocket === 'function') window.WebSocket = new Proxy(RealWebSocket, {
      construct (target, args, newTarget) {
        const url = String(args[0])
        const rpc = RPC_SOCKET.test(url)
        return rpc && holding ? new HeldSocket(args) : Reflect.construct(target, args, newTarget)
      }
    })
    const realFetch = window.fetch.bind(window)
    if (inOrivon) window.fetch = function fetch (input, init) {
      const address = addressOf(input)
      if (address === null || !KUBO_ORIGINS.includes(address.origin)) return realFetch(input, init)
      return kuboCall(address, init?.signal ?? input?.signal)
    }
  } catch (error) {
    node.error = error instanceof Error ? error.message : String(error)
    console.error(`[5chan] the node's start script failed: ${node.error}`)
  }
  parsed.then(() => (document.body == null ? undefined : pause(WAITING_AFTER_MS))).then(showWaiting)
  node.ready.then(() => parsed).then(release, release)
})()
