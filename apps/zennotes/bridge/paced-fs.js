// Keeps upstream's file calls inside what Orivon admits from one app. Orivon's budget for calls on a
// picked folder is about a hundred a second after a burst of two hundred, and its `fs` answers
// `readdir(..., { withFileTypes: true })` with one call for the names and one more for every entry's
// type. Upstream's vault module lists a vault with up to 256 notes' worth of `stat` and `readFile` at
// once, so a vault of a few hundred notes spent the budget in seconds, and the calls that found it empty
// waited out the shim's retries (about five seconds) and threw. Upstream's list code drops a note whose
// read threw: the notes listed were a different set each time.
//
// This keeps the calls in flight few and their rate under the budget (a token bucket), so each waits its
// turn inside that window and none is refused; answers `stat` and
// `lstat` for a path from a short-lived memory (the same path is asked for again by the next step of the
// same operation); builds a folder's entries from the one `stat` each (the type, and later the
// `stat` upstream makes of the same note); and asks once for a file that is not there (the app's
// settings file, a note's metadata file), at once or under a folder found missing. Anything written
// forgets the memory. Pure: the `fs.promises` object is passed in, so the tests run it on a stand-in.

/** Calls in flight at once. The broker's budget refills at about a hundred a second; this many waiting at most keeps a turn near a tenth of a second. */
export const MAX_IN_FLIGHT = 12

/** Calls a second admitted, sustained, and the burst allowed before that: under the broker's 100 a second and burst of 200, which the page's own calls share. */
export const RATE_PER_SECOND = 90
export const BURST = 150

/** How long a `stat` or `lstat` answer, found or missing, is reused when nothing was written meanwhile. */
export const STAT_TTL_MS = 10_000

/** The calls that change files or folders: any of them forgets what was remembered. */
const MUTATING = new Set(['writeFile', 'appendFile', 'rename', 'unlink', 'rmdir', 'rm', 'mkdir', 'copyFile', 'cp', 'mkdtemp', 'chmod', 'lchmod', 'truncate'])

/** Errors that mean "not there" or "not that kind of thing": the ordinary answers of a probe, not worth a console line. */
const ORDINARY = new Set(['ENOENT', 'ENOTDIR', 'EEXIST', 'EISDIR', 'ENOTEMPTY'])

/** Runs each call once fewer than `max` are running, in the order asked. */
export function createQueue (max) {
  let running = 0
  const waiting = []
  return async function queued (run) {
    if (running < max) running += 1
    else await new Promise((resolve) => { waiting.push(resolve) })
    try {
      return await run()
    } finally {
      const next = waiting.shift()
      if (next === undefined) running -= 1
      else next()
    }
  }
}

/**
 * A token bucket: `take()` resolves when a call may go, at most `burst` at once and `ratePerSecond` sustained.
 * Callers are admitted one at a time, in order, so a wait is never shared out twice.
 */
export function createBucket ({ ratePerSecond = RATE_PER_SECOND, burst = BURST, now = Date.now, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }) } = {}) {
  let tokens = burst
  let last = now()
  let admitting = Promise.resolve()
  async function admit () {
    for (;;) {
      const at = now()
      tokens = Math.min(burst, tokens + ((at - last) * ratePerSecond) / 1000)
      last = at
      if (tokens >= 1) { tokens -= 1; return }
      await sleep(Math.ceil(((1 - tokens) * 1000) / ratePerSecond))
    }
  }
  return async function take () {
    const turn = admitting.then(admit)
    admitting = turn.catch(() => {})
    await turn
  }
}

function missing (path, syscall) {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`), { code: 'ENOENT', errno: -2, syscall, path })
}

const text = (path) => (typeof path === 'string' ? path : path instanceof URL ? path.pathname : String(path))
const join = (dir, name) => `${dir.replace(/\/+$/, '')}/${name}`

/** What `readdir(..., { withFileTypes: true })` hands back, from the `stat` of the entry. */
class Entry {
  constructor (name, parentPath, stat) {
    this.name = name
    this.parentPath = parentPath
    this.path = parentPath
    this.stat = stat
  }

  isFile () { return this.stat?.isFile() === true }
  isDirectory () { return this.stat?.isDirectory() === true }
  isSymbolicLink () { return false }
  isBlockDevice () { return false }
  isCharacterDevice () { return false }
  isFIFO () { return false }
  isSocket () { return false }
}

/**
 * `promises` (the module's `fs.promises`), with every function queued and `stat` remembered.
 * @param {Record<string, unknown>} promises
 * @param {{ max?: number, ttlMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void>, ratePerSecond?: number, burst?: number, onError?: (name: string, path: string, error: unknown) => void }} [options]
 */
export function pace (promises, { max = MAX_IN_FLIGHT, ttlMs = STAT_TTL_MS, now = Date.now, sleep, ratePerSecond = RATE_PER_SECOND, burst = BURST, onError = () => {} } = {}) {
  const queued = createQueue(max)
  const take = createBucket({ ratePerSecond, burst, now, ...(sleep === undefined ? {} : { sleep }) })
  let generation = 0
  /** @type {Map<string, { at: number, stat?: unknown, missing?: boolean }>} */
  const seen = new Map()
  const fresh = (entry) => entry !== undefined && now() - entry.at <= ttlMs

  /** True when a fresh answer says one of `path`'s folders is missing: nothing under it can exist. */
  function underMissing (path) {
    const parts = text(path).split('/')
    for (let end = parts.length - 1; end > 0; end -= 1) {
      const entry = seen.get(parts.slice(0, end).join('/'))
      if (fresh(entry) && entry.missing === true) return true
    }
    return false
  }

  /** One call to the real function, in its turn; an unexpected failure is said once in the console, then thrown as it came. */
  async function call (name, args) {
    try {
      return await queued(async () => {
        await take()
        return await promises[name](...args)
      })
    } catch (error) {
      if (!ORDINARY.has(error?.code)) onError(name, text(args[0]), error)
      throw error
    }
  }

  /** The same `stat` asked again while it is being asked (upstream starts 256 notes at once, each asking the same folders) waits for that answer. */
  const asking = new Map()

  async function status (name, args) {
    const key = text(args[0])
    const entry = seen.get(key)
    if (fresh(entry)) {
      if (entry.missing === true) throw missing(key, name)
      return entry.stat
    }
    if (underMissing(key)) throw missing(key, name)
    const joined = asking.get(key)
    if (joined !== undefined) return await joined
    const asked = generation
    const run = (async () => {
      try {
        const stat = await call(name, args)
        if (asked === generation) seen.set(key, { at: now(), stat })
        return stat
      } catch (error) {
        if (error?.code === 'ENOENT' && asked === generation) seen.set(key, { at: now(), missing: true })
        throw error
      }
    })()
    asking.set(key, run)
    try {
      return await run
    } finally {
      if (asking.get(key) === run) asking.delete(key)
    }
  }

  /** `open` and `readFile` of a file that is not there: asked once, then answered from memory. A file that is there is read each time. */
  const probing = new Map()

  async function probe (name, args) {
    const key = text(args[0])
    const entry = seen.get(key)
    if ((fresh(entry) && entry.missing === true) || underMissing(key)) throw missing(key, 'open')
    const id = `${name} ${key}`
    const joined = probing.get(id)
    if (joined !== undefined) {
      try {
        await joined
      } catch (error) {
        if (error?.code === 'ENOENT') throw missing(key, 'open')
      }
    }
    const asked = generation
    const run = call(name, args)
    probing.set(id, run)
    try {
      return await run
    } catch (error) {
      if (error?.code === 'ENOENT' && asked === generation) seen.set(key, { at: now(), missing: true })
      throw error
    } finally {
      if (probing.get(id) === run) probing.delete(id)
    }
  }

  async function entries (args) {
    const dir = text(args[0])
    const names = await call('readdir', [args[0], { ...args[1], withFileTypes: false }])
    return await Promise.all(names.map(async (name) => new Entry(name, dir, await status('stat', [join(dir, name)]).catch(() => undefined))))
  }

  const paced = {}
  for (const name of Object.keys(promises)) {
    const original = promises[name]
    if (typeof original !== 'function' || name === 'watch') { paced[name] = original; continue }
    paced[name] = async (...args) => {
      if (MUTATING.has(name) || (name === 'open' && /[wa+]/.test(String(args[1] ?? 'r')))) {
        generation += 1
        seen.clear()
      }
      if (name === 'stat' || name === 'lstat') return await status(name, args)
      if (name === 'readdir' && args[1]?.withFileTypes === true) return await entries(args)
      if (name === 'readFile' || (name === 'open' && !/[wa+]/.test(String(args[1] ?? 'r')))) return await probe(name, args)
      return await call(name, args)
    }
  }
  return paced
}
