// The log scans of one page's life, and the time they are allowed. A node answers a log query over at most 1024 blocks,
// so a stretch of chain is read as windows of 1024, each one call. The page keeps eight windows in flight at once, the turns
// shared out between the calls that want them, and a window is timed from the moment it is let go. Every window read at or below
// the safe block is kept in memory as the call that reads it, so a scan that ran out of time leaves what it read for the next one,
// and two lookups that need the same window (the resolver check is every name's) make the one call. A scan never answers in part:
// out of time it refuses in words and says to ask again.

import { ChainError } from '../sdk/chain.js'

/** @typedef {import('../sdk/chain.js').Chain} Chain */
/** @typedef {import('../sdk/chain.js').Log} Log */

/** The widest stretch one call reads. */
export const WINDOW = 1024

/** Windows one scan asks at once. */
export const CONCURRENCY = 8

/** Windows in flight at once on the whole page, whichever scans and calls want them: what the browser lets one page have open at the node. */
export const WINDOWS_IN_FLIGHT = 8

/** What a call keeps for itself after its scans: the freshness rule and the answer, which take no node call. */
export const FINISH_RESERVE_MS = 2_000

/** What one window is expected to take until some have been read: a light client reads a window of a few blocks with a log in about a second. */
export const FIRST_WINDOW_MS = 3_000

/** How much of the pace estimate the newest window decides: the rest is what the windows before it said, so a slow stretch is forgotten as fast ones come. */
const NEWEST_WINDOW = 0.3

/** A refusal in words: the answer cannot be given safely or in time. The browser sees a resolver that could not answer; the words are on the loading screen and in the page's console. */
export class OgRefusal extends Error {
  /** @param {string} message */
  constructor (message) {
    super(message)
    this.name = 'OgRefusal'
    this.code = 'unavailable'
  }
}

/**
 * Who a window is read for: one lookup (all the scans it needs), or the page's own read-ahead. A call has the page's turns in common
 * with every other call, one object each.
 * @typedef {{ background?: boolean }} Call
 */

/**
 * @typedef {object} Session what one page remembers
 * @property {Map<string, Promise<Log[]>>} windows each window asked, by scan and range, as the call that reads it
 * @property {{ done: number, ms: number }} pace the windows read so far and how long one takes from the moment it is let go, weighted to the latest
 * @property {Map<string, number>} written the block of the last change this page made to a name, by label
 * @property {() => number} now
 * @property {Launcher} launcher the page's turns at the node
 */

/** @param {{ now?: () => number, windowsInFlight?: number }} [options] @returns {Session} */
export const createSession = (options = {}) => ({
  windows: new Map(),
  pace: { done: 0, ms: 0 },
  written: new Map(),
  now: options.now ?? Date.now,
  launcher: createLauncher(options.windowsInFlight ?? WINDOWS_IN_FLIGHT)
})

/** A call for a page's lookup, or with `background` for what the page reads ahead of any. @param {{ background?: boolean }} [options] @returns {Call} */
export const newCall = (options = {}) => ({ background: options.background === true })

/**
 * @typedef {object} Launcher the turns a page's windows take at the node
 * @property {(call: Call, wait: { until: number, now: () => number, signal?: AbortSignal | undefined }) => Promise<boolean>} acquire resolves true when the call may let a window go, false when `until` came first, and rejects when the signal fires
 * @property {(call: Call) => void} release gives the turn back, when the window it was for has been answered or failed
 */

/**
 * Lets at most `slots` windows go at once. A turn goes to a lookup before the page's read-ahead, then to the call holding the fewest
 * windows, then to the one that has waited longest: no call keeps another waiting for all of its windows.
 * @param {number} slots
 * @returns {Launcher}
 */
function createLauncher (slots) {
  let open = 0
  let arrivals = 0
  /** @type {Map<Call, number>} */
  const held = new Map()
  /** @type {{ call: Call, order: number, grant: () => void }[]} */
  const waiting = []

  /** @param {Call} call */
  const take = (call) => { open++; held.set(call, (held.get(call) ?? 0) + 1) }

  /** Who goes first: a lookup before the read-ahead, then the call holding the fewest windows, then the longest waiting. @param {(typeof waiting)[number]} item */
  const rank = (item) => [item.call.background === true ? 1 : 0, held.get(item.call) ?? 0, item.order]

  /** @param {number[]} a @param {number[]} b */
  const goesBefore = (a, b) => { const at = a.findIndex((part, index) => part !== b[index]); return at >= 0 && /** @type {number} */ (a[at]) < /** @type {number} */ (b[at]) }

  function pump () {
    while (open < slots && waiting.length > 0) {
      let best = 0
      for (let index = 1; index < waiting.length; index++) {
        if (goesBefore(rank(/** @type {(typeof waiting)[number]} */ (waiting[index])), rank(/** @type {(typeof waiting)[number]} */ (waiting[best])))) best = index
      }
      const [next] = /** @type {[(typeof waiting)[number]]} */ (waiting.splice(best, 1))
      take(next.call)
      next.grant()
    }
  }

  return {
    acquire (call, { until, now, signal }) {
      signal?.throwIfAborted()
      if (open < slots && waiting.length === 0) {
        take(call)
        return Promise.resolve(true)
      }
      return new Promise((resolve, reject) => {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer
        const entry = {
          call,
          order: arrivals++,
          grant: () => { clearTimeout(timer); signal?.removeEventListener('abort', leave); resolve(true) }
        }
        const unqueue = () => { const at = waiting.indexOf(entry); if (at >= 0) waiting.splice(at, 1); return at >= 0 }
        function leave () { if (unqueue()) { clearTimeout(timer); reject(signal?.reason) } }
        waiting.push(entry)
        signal?.addEventListener('abort', leave, { once: true })
        if (until !== Infinity) timer = setTimeout(() => { if (unqueue()) { signal?.removeEventListener('abort', leave); resolve(false) } }, Math.max(0, until - now()))
      })
    },
    release (call) {
      open--
      const left = (held.get(call) ?? 1) - 1
      if (left <= 0) held.delete(call)
      else held.set(call, left)
      pump()
    }
  }
}

/**
 * @param {number} from
 * @param {number} to
 * @returns {[number, number][]} the windows of at most 1024 blocks that cover `from` to `to`, both ends counted
 */
export function windowsOf (from, to) {
  /** @type {[number, number][]} */
  const windows = []
  for (let first = from; first <= to; first += WINDOW) windows.push([first, Math.min(first + WINDOW - 1, to)])
  return windows
}

/**
 * What one window is expected to take: one and a half times what the latest windows took, each from the moment it was let go.
 * @param {Session} session
 */
export const expectedMs = (session) => session.pace.done === 0 ? FIRST_WINDOW_MS : Math.max(500, 1.5 * session.pace.ms)

/**
 * @typedef {object} Scan
 * @property {string} id which scan this is, so windows of two scans are never mixed up
 * @property {string | string[]} address
 * @property {(string | null)[]} topics
 * @property {number} from first block
 * @property {number} to last block, counted
 * @property {(log: Log) => boolean} accept whether a log the node returned is one the scan asked for
 */

/**
 * Lets one window go. The turn the caller holds is given back when the window has been answered or has failed. Kept for the next call
 * only when it ends at or below `final`, the highest block no reorganisation can still change; above it the node may yet answer
 * otherwise, so it is shared with the scans that want it now and dropped after.
 * @param {Chain} chain
 * @param {Session} session
 * @param {Scan} scan
 * @param {number} first
 * @param {number} last
 * @param {{ call: Call, final: number }} turn
 * @returns {Promise<Log[]>}
 */
function startWindow (chain, session, scan, first, last, { call, final }) {
  const key = `${scan.id}:${first}-${last}`
  const startedAt = session.now()
  const pending = chain.getLogs({ fromBlock: first, toBlock: last, address: scan.address, topics: scan.topics }).then((logs) => {
    const { pace } = session
    const took = Math.max(0, session.now() - startedAt)
    pace.ms = pace.done === 0 ? took : (1 - NEWEST_WINDOW) * pace.ms + NEWEST_WINDOW * took
    pace.done++
    return logs.filter((log) => !log.removed && log.blockNumber >= first && log.blockNumber <= last && scan.accept(log))
  })
  session.windows.set(key, pending)
  const done = (/** @type {boolean} */ kept) => {
    session.launcher.release(call)
    if (!kept && session.windows.get(key) === pending) session.windows.delete(key)
  }
  // A window that failed is asked again by the next scan that needs it, and so is one that may still change.
  pending.then(() => { done(last <= final) }, () => { done(false) })
  return pending
}

/**
 * Every log of `scan` from its first block to its last, window by window. Windows already read, or being read by another scan,
 * are used as they are; the others wait for the page's turn at the node. A call may let at least one round of windows go however
 * slow the node has been, so a slow stretch never stops every later lookup; past that round a window is let go only when it is
 * expected to be answered in the time left. When the time left cannot take another window the scan stops and refuses, keeping what it
 * read. A node that cannot be asked throws as it is; a node whose answer cannot be read refuses.
 * @param {Chain} chain
 * @param {Session} session
 * @param {Scan} scan
 * @param {{ deadlineAt?: number | undefined, signal?: AbortSignal | undefined, progress?: ((detail: string, fraction?: number) => void) | undefined, what?: string, call?: Call | undefined, final?: number | undefined }} [options]
 *   `what`: the words for what is being checked, such as "the recent history of alice.og"; `call`: who the windows are read for, one for all the scans
 *   of a lookup (a scan of its own by default); `final`: the highest block whose logs no reorganisation can change, up to which windows are kept
 *   (none by default)
 * @returns {Promise<Log[]>}
 */
export async function scanLogs (chain, session, scan, options = {}) {
  const { deadlineAt = Infinity, signal, progress, what = 'recent history', call = newCall(), final = -Infinity } = options
  const ranges = windowsOf(scan.from, scan.to)
  /** @type {(Log[] | undefined)[]} */
  const results = new Array(ranges.length)
  let next = 0
  let finished = 0
  let stopped = false
  /** @type {unknown} */
  let failure
  const scanDeadline = deadlineAt - FINISH_RESERVE_MS

  /** Waits for a window, at most until the scan's deadline: a window another scan is reading may be slower than this one can wait. @param {Promise<Log[]>} pending */
  async function untilDeadline (pending) {
    if (scanDeadline === Infinity) return await pending
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    const late = new Promise((resolve) => { timer = setTimeout(() => { resolve(undefined) }, Math.max(0, scanDeadline - session.now())) })
    try {
      return await Promise.race([pending, late])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The window of `first` to `last`: the one already asked for, or one let go now, when the page's turn comes and the time left allows.
   * A worker's first window of the call is let go whatever the pace says, while any time is left: `mine.letGo` tells it is not yet.
   * @param {number} first @param {number} last @param {{ letGo: boolean }} mine
   * @returns {Promise<{ pending: Promise<Log[]> } | undefined>} the window, in an object so that waiting for it is the caller's; undefined when the scan stops
   */
  async function windowFor (first, last, mine) {
    const key = `${scan.id}:${first}-${last}`
    const asked = session.windows.get(key)
    if (asked !== undefined) return { pending: asked }
    if (!await session.launcher.acquire(call, { until: scanDeadline, now: session.now, signal })) return undefined
    const meanwhile = session.windows.get(key)
    const room = session.now() < scanDeadline
    const fits = session.now() + expectedMs(session) <= scanDeadline
    if (meanwhile !== undefined || failure !== undefined || stopped || !(fits || (!mine.letGo && room))) {
      session.launcher.release(call)
      return meanwhile === undefined ? undefined : { pending: meanwhile }
    }
    mine.letGo = true
    return { pending: startWindow(chain, session, scan, first, last, { call, final }) }
  }

  async function worker () {
    const mine = { letGo: false }
    while (failure === undefined && !stopped) {
      signal?.throwIfAborted()
      const index = next++
      const range = ranges[index]
      if (range === undefined) return
      const [first, last] = range
      try {
        const window = await windowFor(first, last, mine)
        if (window === undefined) {
          stopped = true
          return
        }
        const logs = await untilDeadline(window.pending)
        if (logs === undefined) {
          stopped = true
          return
        }
        results[index] = logs
        finished++
        progress?.(`Checking ${what}: ${finished} of ${ranges.length}`, finished / ranges.length)
      } catch (error) {
        if (failure === undefined) failure = error
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ranges.length) }, worker))
  signal?.throwIfAborted()
  if (failure !== undefined) {
    if (failure instanceof ChainError && ['badAnswer', 'invalid', 'reverted'].includes(failure.reason)) throw new OgRefusal(`The node's answer about ${what} could not be read, so these records are not vouched for.`)
    throw failure
  }
  if (stopped || finished < ranges.length) {
    throw new OgRefusal(`Still checking ${what}: ${ranges.length - finished} of ${ranges.length} stretches of the chain are left and the time ran out. What was checked is kept: try again shortly.`)
  }
  return results.flatMap((logs) => logs ?? [])
}
