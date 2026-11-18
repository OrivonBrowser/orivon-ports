// The Worker's replacement for the board manager's own multi-board runner (`board-managers.ts`, which watches a folder with
// chokidar, and the shim has no `fs.watch`): one `startBoardManager` per board a person turned the manager on for, kept running.
// A board's manager starts when its config says it is on and when the Worker starts, restarts with a pause that grows while it
// keeps failing (a board that is not started yet, an RPC connection that closed), and stops with the Worker. What it does and
// why it failed is written as a warning, the level a bug report from orivon://report carries, and never takes the Worker down.
// Config changes arrive through `enable`, `disable`, `configure` and `configureDefaults`, which is what the control API calls.

import { applyChange, checkAddress, checkPatch, ConfigError } from './board-config.js'

/** @typedef {import('./board-config.js').BoardConfig} BoardConfig */
/** @typedef {import('./board-config.js').BoardFields} BoardFields */

export class NotFoundError extends ConfigError {}

/**
 * What the manager uses for a field a board and the defaults both leave unset (`DEFAULTS` in its `board-manager.ts`; the bump
 * limit is `DEFAULT_BUMP_LIMIT` of its `defaults.ts`). Shown to a person; the manager applies its own.
 */
export const MANAGER_DEFAULTS = Object.freeze({ perPage: 15, pages: 10, bumpLimit: 300, archivePurgeSeconds: 172_800 })

/**
 * @typedef {object} Timing
 * @property {number} retryMs the pause after a manager's first failure; doubled for each one in a row
 * @property {number} maxRetryMs
 * @property {number} stableMs a manager that ran this long before it failed starts the count again
 * @property {number} stopWaitMs how long a manager is given to stop
 */
/** @type {Readonly<Timing>} */
export const TIMING = Object.freeze({ retryMs: 5_000, maxRetryMs: 300_000, stableMs: 60_000, stopWaitMs: 20_000 })

/**
 * @typedef {object} Clock
 * @property {() => number} now
 * @property {(ms: number, then: () => void) => () => void} after runs `then` later; the answer cancels it
 */
/** @type {Clock} */
const REAL_CLOCK = { now: () => Date.now(), after: (ms, then) => { const timer = setTimeout(then, ms); return () => { clearTimeout(timer) } } }

const textOf = (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error))

/**
 * @typedef {object} Hosted a community this node hosts, as pkc-js's `communities` lists it
 * @property {string} address @property {boolean} [started]
 */

/**
 * @typedef {object} Options
 * @property {(options: Record<string, any>) => Promise<{ stop: () => Promise<void> }>} start the board manager's `startBoardManager`
 * @property {(board: Record<string, any>, config: Record<string, any>, directory: string) => Record<string, any>} resolve its `resolveBoardManagerOptions`
 * @property {ReturnType<typeof import('./board-config.js').boardConfigStore>} store
 * @property {string} rpcUrl the Worker's own RPC, with the key in it: handed to the manager, never written down
 * @property {() => Hosted[]} [hosted] the communities this node hosts
 * @property {(line: string) => void} [log] @property {(line: string) => void} [warn]
 * @property {(text: string) => string} [redact] removes what a line must not carry (the key) from it
 * @property {Clock} [clock] @property {Partial<Timing>} [timing]
 * @property {Record<string, unknown>} [startOptions] more options for every manager (a test's short purge sweep)
 */

/**
 * @typedef {object} Entry
 * @property {BoardConfig} config
 * @property {boolean} want the loop runs while this is true
 * @property {'off' | 'starting' | 'running' | 'backoff' | 'stopping'} state
 * @property {number} attempt which start this is: a callback of an earlier one is ignored
 * @property {number} failures failures in a row
 * @property {number} restarts starts after the first
 * @property {string | null} lastError @property {number | null} lastErrorAt @property {number | null} since @property {number | null} nextAttemptAt
 * @property {null | 'restart' | 'off' | 'stop'} cut what asked the running manager to end
 * @property {boolean} lost the manager's RPC connection closed
 * @property {() => void} wake
 * @property {Promise<void> | null} loop
 */

/** @param {Options} options */
export function superviseBoardManagers (options) {
  const { start, resolve, store, rpcUrl, hosted = () => [] } = options
  const log = options.log ?? (() => {})
  const warn = options.warn ?? log
  const redact = options.redact ?? ((/** @type {string} */ text) => text)
  const clock = options.clock ?? REAL_CLOCK
  const timing = { ...TIMING, ...options.timing }
  /** @type {Map<string, Entry>} */
  const entries = new Map()
  /** @type {BoardFields} */
  let defaults = {}
  /** @type {Record<string, unknown>} */
  let globalRest = {}
  let stopping = false
  let began = false
  /** Starts go one at a time: each opens a connection to the RPC and loads the community. @type {Promise<unknown>} */
  let turn = Promise.resolve()
  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  const inTurn = (work) => { const next = turn.then(work, work); turn = next.catch(() => {}); return next }
  /** @param {string} line */
  const say = (line) => { warn(`board manager ${redact(line)}`) }

  /** @param {number} ms @param {Promise<unknown>} wake */
  const pause = (ms, wake) => new Promise((resolveIt) => { const cancel = clock.after(ms, () => { resolveIt(undefined) }); wake.then(() => { cancel(); resolveIt(undefined) }) })

  /** @param {{ stop: () => Promise<void> }} handle @param {string} address */
  async function halt (handle, address) {
    /** @type {() => void} */
    let cancel = () => {}
    try {
      await Promise.race([handle.stop(), new Promise((_, reject) => { cancel = clock.after(timing.stopWaitMs, () => { reject(new Error('did not stop in time')) }) })])
    } catch (error) { say(`${address}: stopping it: ${textOf(error)}`) } finally { cancel() }
  }

  /** @param {Entry} entry */
  function optionsFor (entry) {
    const board = { ...entry.config }
    const resolved = resolve(board, { boards: [board], defaults, ...(typeof globalRest['userAgent'] === 'string' ? { userAgent: globalRest['userAgent'] } : {}) }, store.directory)
    return { ...resolved, ...options.startOptions, pkcRpcUrl: rpcUrl }
  }

  /** @param {Entry} entry @param {unknown} error */
  function failed (entry, error) {
    entry.lastError = redact(textOf(error))
    entry.lastErrorAt = clock.now()
  }

  /** One board's life: start its manager, wait for it to end or be cut, and start again while the board is wanted. @param {Entry} entry */
  async function keep (entry) {
    /** A promise the entry's `wake` resolves: what a pause or the running manager waits on. @returns {Promise<unknown>} */
    const fresh = () => new Promise((resolveIt) => { entry.wake = () => { resolveIt(undefined) } })
    while (entry.want && !stopping) {
      entry.cut = null
      entry.lost = false
      const turnNumber = entry.attempt += 1
      let signal = () => {}
      const wake = fresh()
      signal = entry.wake
      entry.state = 'starting'
      entry.nextAttemptAt = null
      /** @type {{ stop: () => Promise<void> } | null} */
      let handle = null
      try {
        handle = await inTurn(() => start({ ...optionsFor(entry), onRpcDisconnect: () => { if (entry.attempt === turnNumber) { entry.lost = true; signal() } }, onAddressChange: (/** @type {string} */ from, /** @type {string} */ to) => { moved(entry, from, to) } }))
      } catch (error) {
        failed(entry, error)
        entry.failures += 1
        const wait = Math.min(timing.maxRetryMs, timing.retryMs * 2 ** Math.min(entry.failures - 1, 16))
        if (entry.cut === null) {
          entry.state = 'backoff'
          entry.nextAttemptAt = clock.now() + wait
          say(`${entry.config.address}: did not start (${entry.lastError}); trying again in ${String(Math.round(wait / 1000))} s`)
          await pause(wait, fresh())
        }
        if (entry.cut === 'restart') entry.failures = 0
        continue
      }
      let ranMs = 0
      if (entry.cut === null && !entry.lost) {
        entry.state = 'running'
        entry.since = clock.now()
        const from = entry.since
        say(`${entry.config.address}: running`)
        await wake
        ranMs = clock.now() - from
      }
      entry.state = 'stopping'
      await halt(handle, entry.config.address)
      entry.since = null
      if (entry.cut === null && entry.lost) {
        if (ranMs >= timing.stableMs) entry.failures = 0
        entry.failures += 1
        failed(entry, 'its RPC connection closed')
        const wait = Math.min(timing.maxRetryMs, timing.retryMs * 2 ** Math.min(entry.failures - 1, 16))
        entry.state = 'backoff'
        entry.nextAttemptAt = clock.now() + wait
        say(`${entry.config.address}: lost its RPC connection; starting again in ${String(Math.round(wait / 1000))} s`)
        await pause(wait, fresh())
        if (entry.cut === 'restart') entry.failures = 0
      } else if (entry.cut === 'restart') {
        entry.failures = 0
        entry.restarts += 1
      }
    }
    entry.state = 'off'
    entry.nextAttemptAt = null
    say(`${entry.config.address}: stopped`)
  }

  /** The manager renamed its own board: the folder and the config follow, the way its CLI does. @param {Entry} entry @param {string} from @param {string} to */
  function moved (entry, from, to) {
    try { store.renameBoard(from, to) } catch (error) { say(`${from}: could not take the new address ${to} on disk: ${textOf(error)}`); return }
    entries.delete(from)
    entry.config = { ...entry.config, address: to }
    entries.set(to, entry)
    say(`${from}: the board's address is now ${to}`)
  }

  /** @param {BoardConfig} config @returns {Entry} */
  function entryFor (config) {
    /** @type {Entry} */
    const entry = { config, want: false, state: 'off', attempt: 0, failures: 0, restarts: 0, lastError: null, lastErrorAt: null, since: null, nextAttemptAt: null, cut: null, lost: false, wake: () => {}, loop: null }
    entries.set(config.address, entry)
    return entry
  }

  /** Starts the loop of an entry that has none running. @param {Entry} entry */
  function run (entry) {
    if (stopping) return
    entry.want = true
    if (entry.loop !== null) return
    const loop = keep(entry).catch((error) => { say(`${entry.config.address}: the supervisor failed: ${textOf(error)}`) }).finally(() => { if (entry.loop === loop) entry.loop = null })
    entry.loop = loop
  }

  /** Ends the running manager of an entry; `how` says whether it comes back. @param {Entry} entry @param {'restart' | 'off' | 'stop'} how */
  function cut (entry, how) {
    entry.cut = how
    if (how !== 'restart') entry.want = false
    entry.wake()
  }

  const isOn = (/** @type {BoardConfig} */ config) => config.enabled !== false

  /** @param {string} address */
  function known (address) {
    checkAddress(address)
    const entry = entries.get(address)
    const listed = hosted().some((one) => one.address === address)
    if (entry === undefined && !listed) throw new NotFoundError(`${address} is not a community this node hosts`)
    return entry
  }

  /** @param {string} address @returns {ReturnType<typeof view>} */
  function viewOf (address) {
    return view(address, entries.get(address))
  }

  /** @param {string} address @param {Entry | undefined} entry */
  function view (address, entry) {
    const listed = hosted().find((one) => one.address === address)
    const own = entry?.config ?? { address }
    const { address: _address, enabled: _enabled, ...fields } = own
    const effective = { ...MANAGER_DEFAULTS, ...defaults, ...fields }
    return {
      address,
      hosted: listed !== undefined,
      started: listed === undefined ? null : listed.started ?? null,
      managed: entry !== undefined,
      enabled: entry !== undefined && isOn(entry.config),
      state: entry?.state ?? 'off',
      failures: entry?.failures ?? 0,
      restarts: entry?.restarts ?? 0,
      lastError: entry?.lastError ?? null,
      lastErrorAt: entry?.lastErrorAt ?? null,
      since: entry?.since ?? null,
      nextAttemptAt: entry?.nextAttemptAt ?? null,
      archivedThreads: entry === undefined ? 0 : store.archivedThreads(address),
      config: fields,
      effective: { perPage: effective.perPage, pages: effective.pages, bumpLimit: effective.bumpLimit, archivePurgeSeconds: effective.archivePurgeSeconds },
      capacity: effective.perPage * effective.pages
    }
  }

  return {
    /** Reads the config folder and starts the manager of every board that is on; resolves when they are on their way, not when they run. */
    begin () {
      if (began) return
      began = true
      const loaded = store.load()
      for (const problem of loaded.problems) say(`config: ${problem}`)
      const { defaults: given = {}, ...rest } = loaded.global
      defaults = given
      globalRest = rest
      for (const config of loaded.boards) {
        const entry = entryFor(config)
        if (isOn(config)) run(entry)
      }
    },

    /** Every board this node hosts, and every board with a config, in address order. */
    boards () {
      const addresses = new Set([...hosted().map((one) => one.address), ...entries.keys()])
      return [...addresses].sort().map(viewOf)
    },

    /** @param {string} address */
    board (address) {
      known(address)
      return viewOf(address)
    },

    /**
     * Turns the manager on for a board, with `patch` applied to its config when given.
     * @param {string} address @param {unknown} [patch]
     */
    async enable (address, patch = {}) {
      const change = checkPatch(patch)
      const existing = known(address)
      /** @type {BoardConfig} */
      const config = { ...applyChange(existing?.config ?? { address }, change), address }
      delete config.enabled
      store.writeBoard(config)
      const entry = existing ?? entryFor(config)
      const was = entry.want
      entry.config = config
      if (was) cut(entry, 'restart')
      else run(entry)
      return viewOf(address)
    },

    /** @param {string} address */
    async disable (address) {
      const entry = known(address)
      if (entry === undefined) return viewOf(address)
      const config = { ...entry.config, enabled: false }
      store.writeBoard(config)
      entry.config = config
      const loop = entry.loop
      cut(entry, 'off')
      await loop
      return viewOf(address)
    },

    /**
     * Sets a board's limits, which a running manager takes by starting again. A board with no config yet gets one that is off.
     * @param {string} address @param {unknown} patch
     */
    async configure (address, patch) {
      const change = checkPatch(patch)
      const existing = known(address)
      /** @type {BoardConfig} */
      const config = { ...applyChange(existing?.config ?? { address, enabled: false }, change), address }
      store.writeBoard(config)
      const entry = existing ?? entryFor(config)
      entry.config = config
      if (entry.want) cut(entry, 'restart')
      return viewOf(address)
    },

    /** The defaults every board takes unless it sets the field. */
    defaults () {
      return { set: defaults, effective: { ...MANAGER_DEFAULTS, ...defaults } }
    },

    /** Changes `global.json`'s defaults; every running manager starts again, as the manager's own runner does. @param {unknown} patch */
    async configureDefaults (patch) {
      const change = checkPatch(patch)
      defaults = applyChange(defaults, change)
      store.writeGlobal({ ...globalRest, defaults })
      for (const entry of entries.values()) if (entry.want) cut(entry, 'restart')
      return { set: defaults, effective: { ...MANAGER_DEFAULTS, ...defaults } }
    },

    /** Ends every manager and waits for them. */
    async stop () {
      stopping = true
      const loops = []
      for (const entry of entries.values()) {
        if (entry.loop !== null) loops.push(entry.loop)
        cut(entry, 'stop')
      }
      /** @type {() => void} */
      let cancel = () => {}
      await Promise.race([Promise.all(loops), new Promise((resolveIt) => { cancel = clock.after(timing.stopWaitMs + 5_000, () => { resolveIt(undefined) }) })])
      cancel()
    }
  }
}
