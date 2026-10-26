// The page's side of Actual's backend: what upstream's Electron main does around the utility process
// that runs loot-core. It forks the backend bundle (server.mjs) into a Worker of this app, writes the
// files the backend reads from its install tree while that Worker boots, relays the renderer's
// messages to it and its replies back, and ends it with the page. Everything it touches arrives in
// `deps` (backend-entry.js wires the real ones, the tests fakes), and the decisions are plan.js's.
//
// The backend starts when the page loads (`warm`), not at the renderer's first message, so its boot
// overlaps the renderer's own loading. A page that does not hold the `fs` grant, as on a first
// visit before the person answers, starts nothing and holds nothing: its next message gets a
// failure that says why, and a later one starts the backend if the grant has arrived.
//
// One page runs the backend at a time: two would each hold the budget's database open, and the
// SQLite shim has no locking between connections. A second page of the app gets the failure the
// renderer already knows how to show.

import {
  BACKEND_LOCK, backendArgs, backendDirs, backendEnv, busyFailure, createPacer, deniedFailure, exitFailure, failurePayload, forEachLimited, importTarget,
  INSTALL_DIR, INSTALL_LANES, installDirFor, installNeeded, isDenial, layout, packProblem, parentOf, parseInstall, READY_TYPE, staleInstalls, WRITES_BURST, WRITES_PER_SECOND
} from './plan.js'

const LOCK_TRIES = 12
const LOCK_WAIT_MS = 250

/** Thrown when another page of the app holds the backend. */
export class BusyError extends Error {}

/** The page's side of the backend. `deps` is described at the call in backend-entry.js. */
export function createBackend (deps) {
  const listeners = []
  const queue = []
  let child = null
  let starting = null
  let ready = false
  let installed = false
  let failure = null
  let denied = false
  let holding = false
  let stopping = false

  // Diagnostics and the status line only watch the start: whatever they throw must not stop it.
  const mark = (name) => { try { deps.mark?.(name) } catch { /* a mark is not worth a failed start */ } }
  const progress = (phase, done = 0, total = 0) => { try { deps.progress?.({ phase, done, total }) } catch { /* nor is a status line */ } }

  function emit (message) {
    for (const listener of [...listeners]) listener(message)
  }

  function fail (payload) {
    failure = payload
    progress('failed')
    emit(payload)
  }

  // --- the lock and the install tree ----------------------------------------

  async function claimLock () {
    for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
      const got = await new Promise((resolve) => {
        deps.locks.request(BACKEND_LOCK, { ifAvailable: true }, (lock) => {
          resolve(lock !== null)
          return lock === null ? undefined : new Promise(() => {})
        })
      })
      if (got) return true
      await deps.sleep(LOCK_WAIT_MS)
    }
    return false
  }

  async function storedInstall () {
    try {
      return parseInstall(new TextDecoder().decode(await deps.files.readFile(`${deps.root}/${installDirFor(deps.stamp)}/install.json`)))
    } catch {
      return null
    }
  }

  async function fetchOk (url) {
    const response = await deps.fetch(url)
    if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
    return response
  }

  /** Writes the pack's files into the install tree, a few at a time and paced to the broker's limit, and the marker last, so a run cut short is written again rather than trusted. */
  async function writeInstall (served, pack) {
    const base = `${deps.root}/${installDirFor(served.stamp)}`
    const entries = layout(served)
    const paced = createPacer(WRITES_PER_SECOND, WRITES_BURST, deps.now, deps.sleep)
    const made = new Map()
    const ensureDir = (dir) => {
      if (!made.has(dir)) made.set(dir, paced().then(async () => await deps.files.mkdir(dir === '' ? base : `${base}/${dir}`, { recursive: true })))
      return made.get(dir)
    }
    let done = 0
    progress('install', done, entries.length)
    await forEachLimited(entries, INSTALL_LANES, async ({ name, offset, size }) => {
      await ensureDir(parentOf(name))
      await paced()
      await deps.files.writeFile(`${base}/${name}`, pack.slice(offset, offset + size))
      done += 1
      progress('install', done, entries.length)
    })
    await deps.files.writeFile(`${base}/install.json`, new TextEncoder().encode(JSON.stringify(served)))
  }

  /** Puts upstream's database template and migrations where the backend reads them, unless this build's tree is already there. Nothing is fetched on a later start. */
  async function materialise () {
    if (!installNeeded({ stamp: deps.stamp }, await storedInstall())) return
    const [manifest, packed] = await Promise.all([fetchOk('install/install.json'), fetchOk('install/pack.bin')])
    const served = parseInstall(await manifest.text())
    if (served.stamp !== deps.stamp) {
      throw new Error(`install.json carries stamp ${served.stamp}, but this page was built for ${deps.stamp}: the app's files are from two different builds`)
    }
    const pack = new Uint8Array(await packed.arrayBuffer())
    const wrong = packProblem(served, pack.length)
    if (wrong !== null) throw new Error(wrong)
    await writeInstall(served, pack)
  }

  /** Removes the install trees of other builds; off the path to the first message, and a failure waits for the next start. */
  async function tidy () {
    try {
      const parent = `${deps.root}/${INSTALL_DIR}`
      for (const name of staleInstalls((await deps.files.readdir(parent)).map(String), deps.stamp)) {
        await deps.files.rm(`${parent}/${name}`, { recursive: true, force: true }).catch(() => undefined)
      }
    } catch { /* nothing to clean: the next start tries again */ }
  }

  /** The directories the backend works in. The copies of earlier picked files are not wanted again: the backend has read them by now. */
  async function prepareDirs () {
    const [, documents, imports] = backendDirs()
    const made = { recursive: true }
    await Promise.all([
      deps.files.mkdir(`${deps.root}/${documents}`, made),
      deps.files.rm(`${deps.root}/${imports}`, { recursive: true, force: true }).catch(() => undefined).then(async () => await deps.files.mkdir(`${deps.root}/${imports}`, made))
    ])
  }

  // --- the child --------------------------------------------------------------

  /** Both halves are in: the backend answers, and the files it reads when a budget opens are written. */
  function settle () {
    if (!ready || !installed || child === null) return
    mark('actual:ready')
    progress('ready')
    while (queue.length > 0) child.send(queue.shift())
  }

  function wire (forked) {
    const decode = new TextDecoder()
    for (const stream of [forked.stdout, forked.stderr]) {
      stream?.on('data', (chunk) => { deps.log(typeof chunk === 'string' ? chunk : decode.decode(chunk, { stream: true })) })
    }
    forked.on('message', (message) => {
      if (child !== forked) return
      if (message?.type === READY_TYPE) {
        ready = true
        settle()
      } else if (message?.type === 'app-init-failure') {
        fail(message)
      } else {
        emit(message)
      }
    })
    forked.on('error', (error) => {
      if (child === forked) fail(failurePayload(error))
    })
    forked.on('close', (code) => {
      if (child !== forked || stopping) return
      child = null
      ready = false
      if (failure === null) fail(exitFailure(code))
    })
  }

  /** The first call to the app's files is the check for the `fs` grant: a page without it starts nothing and holds nothing. */
  async function start () {
    try {
      await deps.files.mkdir(`${deps.root}/${backendDirs()[0]}`, { recursive: true })
    } catch (error) {
      if (!isDenial(error)) fail(failurePayload(error))
      denied = isDenial(error)
      return
    }
    denied = false
    try {
      if (!holding) {
        holding = await claimLock()
        if (!holding) throw new BusyError('the backend is held by another page')
      }
      await prepareDirs()
    } catch (error) {
      fail(error instanceof BusyError ? busyFailure() : failurePayload(error))
      return
    }
    mark('actual:fork')
    progress('starting')
    const forked = deps.fork(deps.serverPath, backendArgs(), { silent: true, serialization: 'advanced', env: backendEnv(deps.root) })
    child = forked
    wire(forked)
    materialise().then(() => {
      if (child !== forked) return
      installed = true
      mark('actual:installed')
      settle()
      void tidy()
    }, (error) => {
      if (child !== forked) return
      child = null
      forked.kill()
      fail(failurePayload(error))
    })
  }

  function ensureStarted () {
    if (starting === null) starting = start().catch((error) => { fail(failurePayload(error)) }).finally(() => { if (denied) starting = null })
    return starting
  }

  /** Starts the backend now if the page may, without a message to answer: no failure is reported until the renderer speaks. */
  function warm () {
    void ensureStarted()
  }

  function post (message) {
    if (failure !== null) {
      emit(failure)
      return
    }
    if (ready && installed && child !== null) {
      child.send(message)
      return
    }
    queue.push(message)
    void ensureStarted().then(() => { if (denied) emit(deniedFailure()) })
  }

  function listen (name, handler) {
    if (name === 'message') listeners.push(handler)
  }

  function stop () {
    stopping = true
    const ended = child
    child = null
    ready = false
    installed = false
    ended?.kill()
  }

  /** Ends the backend and starts a fresh one; what the renderer sent meanwhile waits for it. */
  function restart () {
    stop()
    stopping = false
    starting = null
    failure = null
    denied = false
    void ensureStarted()
  }

  // --- files the renderer asks for -------------------------------------------

  /** Copies a picked file into the app's own folder and returns the path the backend reads it at. */
  async function importFile (handle) {
    const target = importTarget(deps.root, deps.newId(), handle.name)
    await deps.files.mkdir(`${deps.root}/${target.directory}`, { recursive: true })
    const { size } = await handle.stat()
    const bytes = size === 0 ? new Uint8Array(0) : await handle.read({ position: 0, length: size })
    await deps.files.writeFile(target.absolute, bytes)
    return target.absolute
  }

  return { listen, post, restart, stop, warm, importFile }
}
