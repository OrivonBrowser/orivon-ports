// The page's side of Actual's backend: what upstream's Electron main does around the utility process
// that runs loot-core. It writes the files the backend reads from its install tree, forks the backend
// bundle (server.mjs) into a Worker of this app, relays the renderer's messages to it and its replies
// back, and ends it with the page. Everything it touches arrives in `deps` (backend-entry.js wires
// the real ones, the tests fakes), and the decisions are plan.js's.
//
// One page runs the backend at a time: two would each hold the budget's database open, and the
// SQLite shim has no locking between connections. A second page of the app gets the failure the
// renderer already knows how to show.

import {
  BACKEND_LOCK, backendArgs, backendDirs, backendEnv, busyFailure, exitFailure, failurePayload, importTarget, INSTALL_DIR, installDirFor,
  installNeeded, installUrl, parentOf, parseInstall, READY_TYPE, staleInstalls
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
  let failure = null
  let holding = false
  let stopping = false

  function emit (message) {
    for (const listener of [...listeners]) listener(message)
  }

  function fail (payload) {
    failure = payload
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

  async function storedInstall (stamp) {
    try {
      return parseInstall(new TextDecoder().decode(await deps.files.readFile(`${deps.root}/${installDirFor(stamp)}/install.json`)))
    } catch {
      return null
    }
  }

  async function fetchOk (url) {
    const response = await deps.fetch(url)
    if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
    return response
  }

  /** Writes upstream's database template and migrations where the backend reads them, unless this build's tree is already there. */
  async function materialise () {
    const served = parseInstall(await (await fetchOk('install/install.json')).text())
    if (served.stamp !== deps.stamp) {
      throw new Error(`install.json carries stamp ${served.stamp}, but this page was built for ${deps.stamp}: the app's files are from two different builds`)
    }
    if (installNeeded(served, await storedInstall(served.stamp))) {
      const base = `${deps.root}/${installDirFor(served.stamp)}`
      const made = new Set()
      for (const file of served.files) {
        const dir = parentOf(file)
        if (!made.has(dir)) {
          await deps.files.mkdir(dir === '' ? base : `${base}/${dir}`, { recursive: true })
          made.add(dir)
        }
        await deps.files.writeFile(`${base}/${file}`, new Uint8Array(await (await fetchOk(installUrl(file))).arrayBuffer()))
      }
      // Last, so a run cut short is written again rather than trusted.
      await deps.files.writeFile(`${base}/install.json`, new TextEncoder().encode(JSON.stringify(served)))
    }
    try {
      const parent = `${deps.root}/${INSTALL_DIR}`
      for (const name of staleInstalls((await deps.files.readdir(parent)).map(String), served.stamp)) {
        await deps.files.rm(`${parent}/${name}`, { recursive: true, force: true }).catch(() => undefined)
      }
    } catch { /* nothing to clean: the next start tries again */ }
  }

  async function prepare () {
    if (!holding) {
      holding = await claimLock()
      if (!holding) throw new BusyError('the backend is held by another page')
    }
    await materialise()
    for (const dir of backendDirs()) await deps.files.mkdir(`${deps.root}/${dir}`, { recursive: true })
    // The copies of earlier picked files are not wanted again: the backend has read them by now.
    await deps.files.rm(`${deps.root}/${backendDirs()[2]}`, { recursive: true, force: true }).catch(() => undefined)
    await deps.files.mkdir(`${deps.root}/${backendDirs()[2]}`, { recursive: true })
  }

  // --- the child --------------------------------------------------------------

  function flush () {
    while (queue.length > 0 && child !== null) child.send(queue.shift())
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
        flush()
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

  async function start () {
    try {
      await prepare()
    } catch (error) {
      fail(error instanceof BusyError ? busyFailure() : failurePayload(error))
      return
    }
    child = deps.fork(deps.serverPath, backendArgs(), { silent: true, serialization: 'advanced', env: backendEnv(deps.root) })
    wire(child)
  }

  function ensureStarted () {
    if (starting === null) starting = start()
    return starting
  }

  function post (message) {
    if (failure !== null) {
      emit(failure)
      return
    }
    if (ready && child !== null) {
      child.send(message)
      return
    }
    queue.push(message)
    void ensureStarted()
  }

  function listen (name, handler) {
    if (name === 'message') listeners.push(handler)
  }

  function stop () {
    stopping = true
    const ended = child
    child = null
    ready = false
    ended?.kill()
  }

  /** Ends the backend and starts a fresh one; what the renderer sent meanwhile waits for it. */
  function restart () {
    stop()
    stopping = false
    starting = null
    failure = null
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

  return { listen, post, restart, stop, importFile }
}
