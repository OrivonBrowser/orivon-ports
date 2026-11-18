// Seeding: the node keeps, for the communities a person follows (or added), what a reader needs of them while their owner is away:
// the record, the first page of each sort and the one after it, and the post-update files, pinned and announced, plus the
// pubsub topic joined. Off until a person turns it on; it never holds more than the space limit; and turning it off, or taking a
// community out, unpins what seeding pinned and has the node drop the blocks (gc). A community this node hosts is left to the node.
// Everything the environment gives is passed in: the node client, how a community is opened, the store, the clock.

import { canonical } from '../kubo/ipfs.js'
import { checkAddress, ConfigError } from './board-config.js'
import { checkLimit, COMMUNITIES_MAX } from './seeding-store.js'
import { pinsOf } from './seeding-pins.js'

/**
 * @typedef {object} Timing
 * @property {number} passMs how often every community is looked at again, whether or not it said it changed
 * @property {number} retryMs the pause after a community's first failure, doubled for each one in a row
 * @property {number} maxRetryMs @property {number} pinMs how long one pin may take @property {number} provideMs how long the node may take to announce one root
 * @property {number} lanes how many communities one pass looks at at once: a community whose parts nobody answers holds up one lane, not the pass
 * @property {number} waitMs how long a pass waits for a community to open and give its record before it lets it go and tries it again after a pause
 */
/** @type {Readonly<Timing>} */
export const TIMING = Object.freeze({ passMs: 600_000, retryMs: 60_000, maxRetryMs: 1_800_000, pinMs: 120_000, provideMs: 30_000, lanes: 3, waitMs: 120_000 })

/** @typedef {{ now: () => number, after: (ms: number, then: () => void) => () => void }} Clock */
/** @type {Clock} */
const REAL_CLOCK = { now: () => Date.now(), after: (ms, then) => { const timer = setTimeout(then, ms); return () => { clearTimeout(timer) } } }

/**
 * @typedef {object} Runtime a community being followed now
 * @property {{ record: () => import('./seeding-pins.js').SeededRecord | null, onUpdate: (listener: () => void) => () => void, stop: () => Promise<void> } | null} handle
 * @property {'starting' | 'waiting' | 'holding' | 'over-limit' | 'error'} status @property {string | null} error @property {number} failures
 * @property {(() => void) | null} off @property {() => void} cancelRetry @property {number} epoch the limit and list state an over-limit answer was made under
 */

const textOf = (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error))
/** The node's table of announced roots is full (507) or busy (429): the rest of this community is held but not announced. */
const tableFull = (/** @type {unknown} */ error) => [507, 429].includes(/** @type {any} */ (error)?.status)
/** Nobody the node asked has the block (404), or no provider answered in time (504): a host that never announced a part of its community must not stop the rest being held. */
const nobodyHas = (/** @type {unknown} */ error) => [404, 504].includes(/** @type {any} */ (error)?.status)

/**
 * @param {{
 *   store: ReturnType<typeof import('./seeding-store.js').seedingStore>,
 *   node: Pick<ReturnType<typeof import('../kubo/node-client.js').createNodeClient>, 'pin' | 'unpin' | 'pins' | 'provide' | 'unprovide' | 'repoGc' | 'pubsubSubscribe'>,
 *   open: (address: string) => Promise<NonNullable<Runtime['handle']>>,
 *   hosted?: () => Array<{ address: string, name?: string | null, publicKey?: string | null }>,
 *   clock?: Clock, log?: (line: string) => void, warn?: (line: string) => void, timing?: Partial<Timing>
 * }} options `open` starts following a community's record; `hosted` lists the communities this node hosts
 */
export function createSeeder (options) {
  const { store, node, open, hosted = () => [] } = options
  const clock = options.clock ?? REAL_CLOCK
  const timing = { ...TIMING, ...options.timing }
  const log = options.log ?? (() => {})
  const warn = options.warn ?? log
  let state = store.read()
  /** @type {Map<string, Runtime>} */
  const live = new Map()
  /** @type {Map<string, AbortController>} */
  const topics = new Map()
  /** @type {Set<string>} */
  const pending = new Set()
  /** What changes the answer to "does it fit": a limit, a release, a list. */
  let epoch = 0
  let queued = 0
  let began = false
  let stopped = false
  let cancelPass = () => {}
  /** What a pass in flight stops on: turning off, adding, removing or a lower limit end the wait for a part at once, and the next pass starts. */
  let passStop = new AbortController()
  const stopPass = () => { passStop.abort(); passStop = new AbortController() }
  let turn = Promise.resolve()
  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  const inTurn = (work) => { queued += 1; const next = turn.then(work, work); turn = next.catch(() => {}).then(() => { queued -= 1 }); return next }
  const persist = () => { try { store.write(state) } catch (error) { warn(`seeding: could not write its state: ${textOf(error)}`) } }

  const isHosted = (/** @type {string} */ address) => hosted().some((one) => one.address === address || one.name === address || one.publicKey === address)
  const bytesOf = (/** @type {string} */ address) => (state.held[address]?.pins ?? []).reduce((sum, pin) => sum + (pin.owned ? pin.bytes : 0), 0)
  /** Each pin counts once, however many communities hold it. */
  const used = () => {
    const once = new Map()
    for (const one of Object.values(state.held)) for (const pin of one.pins) if (pin.owned) once.set(pin.cid, pin.bytes)
    return [...once.values()].reduce((sum, bytes) => sum + bytes, 0)
  }
  const heldElsewhere = (/** @type {string} */ cid, /** @type {string} */ except) => Object.entries(state.held).some(([address, one]) => address !== except && one.pins.some((pin) => pin.owned && pin.cid === cid))

  /** What the page is shown. */
  function view () {
    return {
      enabled: state.enabled, limitBytes: state.limitBytes, usedBytes: used(), working: queued > 0, lastRun: state.lastRun,
      communities: state.communities.map(({ address, origin }) => {
        const rt = live.get(address)
        const held = state.held[address]
        const status = !state.enabled ? 'off' : isHosted(address) ? 'hosted' : rt?.status ?? 'starting'
        return { address, origin, status, bytes: bytesOf(address), pins: held?.pins.length ?? 0, updatedAt: held === undefined || held.updatedAt === 0 ? null : held.updatedAt, recordAt: held?.recordAt ?? null, error: state.enabled ? rt?.error ?? null : null, topic: topics.has(address) }
      }),
      ignored: [...state.ignored]
    }
  }

  /** Takes a community's topic off, and every pin seeding made for it that no other community of the list also holds. @param {string} address @returns {Promise<boolean>} whether the node was asked to drop anything */
  async function release (address) {
    topics.get(address)?.abort()
    topics.delete(address)
    const held = state.held[address]
    if (held === undefined) return false
    let dropped = false
    const kept = []
    for (const pin of held.pins) {
      if (!pin.owned || heldElsewhere(pin.cid, address)) continue
      try { await node.unprovide(pin.cid); await node.unpin(pin.cid); dropped = true } catch (error) { warn(`seeding: could not release ${pin.cid}: ${textOf(error)}`); kept.push(pin) }
    }
    if (kept.length > 0) state.held[address] = { ...held, pins: kept }
    else delete state.held[address]
    epoch += 1
    persist()
    return dropped
  }

  /** @param {string[]} addresses */
  async function releaseAndCollect (addresses) {
    let dropped = false
    for (const address of addresses) dropped = (await release(address)) || dropped
    if (dropped) await node.repoGc().catch((error) => { warn(`seeding: the node's cleanup failed: ${textOf(error)}`) })
  }

  /** @param {string} address */
  async function close (address) {
    const rt = live.get(address)
    live.delete(address)
    pending.delete(address)
    if (rt === undefined) return
    rt.cancelRetry()
    rt.off?.()
    // A community's stop waits for the read it has in flight, which takes a minute on a slow network: nothing here waits for it.
    rt.handle?.stop().catch(() => {})
  }

  /** A pause that doubles while a community keeps failing. @param {string} address @param {Runtime} rt */
  function retryLater (address, rt) {
    rt.failures += 1
    rt.cancelRetry()
    rt.cancelRetry = clock.after(Math.min(timing.maxRetryMs, timing.retryMs * 2 ** Math.min(rt.failures - 1, 10)), () => { rt.cancelRetry = () => {}; if (live.get(address) === rt) schedule(address) })
  }

  /** Joins the topic a poster and the owner meet on: the node announces a topic it has joined. @param {string} address @param {string | null} topic */
  function join (address, topic) {
    if (topic === null || topics.has(address)) return
    const controller = new AbortController()
    topics.set(address, controller)
    node.pubsubSubscribe(topic, controller.signal).then(async (response) => {
      const reader = response?.body?.getReader()
      while (reader !== undefined && !(await reader.read()).done) { /* messages are for the owner and the poster, not for the seeder */ }
    }).catch(() => { if (topics.get(address) === controller) topics.delete(address) })
  }

  /** Looks at what a community's record asks for and makes the node hold it. What a stopped pass had pinned stays in the ledger, and its status is left alone. @param {string} address @param {AbortSignal} [signal] */
  async function reconcile (address, signal = passStop.signal) {
    const rt = live.get(address)
    if (rt === undefined || rt.handle === null || !state.enabled || stopped) return
    if (rt.status === 'over-limit' && rt.epoch === epoch) return
    const record = rt.handle.record()
    if (record === null || typeof record.updatedAt !== 'number') { rt.status = 'waiting'; return }
    const { pins, topic } = pinsOf(record)
    const before = state.held[address] ?? { pins: [], recordAt: null, updatedAt: 0 }
    const have = new Set(before.pins.map((pin) => pin.cid))
    const want = new Set(pins.map((pin) => pin.cid))
    /** @type {typeof before.pins} */
    const added = []
    const holding = () => [...before.pins, ...added]
    let failure = null
    let overLimit = false
    let full = false
    let current = ''
    let cancelled = false
    /** @type {string[]} */
    const missing = []
    try {
      for (const { cid, name } of pins) {
        if (signal.aborted) { cancelled = true; break }
        if (have.has(cid)) continue
        current = name
        const known = new Map((await node.pins(signal)).map((one) => [canonical(one.cid), one]))
        let pin = { cid, name, bytes: known.get(cid)?.bytes ?? 0, owned: heldElsewhere(cid, address) }
        if (!known.has(cid)) {
          try { await node.pin(cid, AbortSignal.any([AbortSignal.timeout(timing.pinMs), signal])) } catch (error) {
            // The node may still be fetching the root it was asked for, and a call to it can wait for that: the pass does not wait for the answer, so turning seeding off is not held back by it.
            if (signal.aborted) node.unpin(cid).catch(() => {})
            else if (name !== 'record' && nobodyHas(error)) { missing.push(name); continue }
            throw error
          }
          // Claimed in the ledger before the size is read, so that a community looked at at the same time sees this pin as held here and not as the node's own.
          pin = { cid, name, bytes: 0, owned: true }
          state.held[address] = { ...before, pins: [...holding(), pin] }
          pin.bytes = (await node.pins(signal).catch((error) => { if (signal.aborted) return []; throw error })).find((one) => canonical(one.cid) === cid)?.bytes ?? 0
        }
        state.held[address] = { ...before, pins: [...holding(), pin] }
        if (pin.owned && used() > state.limitBytes) { await node.unpin(cid); overLimit = true; break }
        added.push(pin)
        if (pin.owned && !full) {
          // An announce the node does not answer ends with the pass or after `provideMs`: a turn of the queue that waits on one holds back turning seeding off, a limit and a list.
          try { await node.provide(cid, false, AbortSignal.any([AbortSignal.timeout(timing.provideMs), signal])) } catch (error) {
            if (tableFull(error)) full = true
            else if (!signal.aborted) warn(`seeding: ${address}: the node did not announce ${name}: ${textOf(error)}`)
          }
        }
      }
    } catch (error) { if (signal.aborted) cancelled = true; else failure = current === '' ? error : new Error(`${current}: ${textOf(error)}`) }
    state.held[address] = { ...before, pins: holding() }
    if (state.held[address].pins.length === 0) delete state.held[address]
    if (cancelled) { persist(); return }
    if (overLimit) {
      rt.status = 'over-limit'; rt.error = null; rt.epoch = epoch
      warn(`seeding: ${address} does not fit in the space limit (${String(used())} of ${String(state.limitBytes)} bytes held)`)
    } else if (failure === null) {
      const stale = before.pins.filter((pin) => !want.has(pin.cid))
      state.held[address] = { pins: holding().filter((pin) => want.has(pin.cid)), recordAt: record.updatedAt, updatedAt: clock.now() }
      for (const pin of stale) {
        if (pin.owned && !heldElsewhere(pin.cid, address)) await node.unprovide(pin.cid).then(() => node.unpin(pin.cid)).catch((error) => { warn(`seeding: could not release ${pin.cid}: ${textOf(error)}`) })
      }
      if (stale.some((pin) => pin.owned)) await node.repoGc().catch(() => {})
      join(address, topic)
      rt.status = 'holding'; rt.error = null; rt.failures = 0; rt.cancelRetry()
      if (missing.length > 0) {
        rt.error = `Not found yet: ${missing.join(', ')}`
        warn(`seeding: ${address}: nobody has ${missing.join(', ')} yet; the rest is held and these are asked for again`)
        retryLater(address, rt)
      }
      if (full) warn(`seeding: the node's table of announced blocks is full: ${address} is held but not all of it is announced`)
    } else {
      rt.status = 'error'; rt.error = textOf(failure)
      warn(`seeding: ${address}: ${rt.error}`)
      retryLater(address, rt)
    }
    persist()
  }

  /** @param {string} address */
  function schedule (address) {
    if (pending.has(address) || stopped) return
    pending.add(address)
    inTurn(async () => { const started = clock.now(); pending.delete(address); await look(address, passStop.signal); if (state.enabled && !stopped) markRun(started) }).catch(() => {})
  }

  /**
   * One community's turn: open it, wait for its record, make the node hold what the record names, and let it go. Only the communities being looked at have an update loop
   * running, so a long list does not keep dozens of name and record reads going at once. @param {string} address @param {AbortSignal} signal
   */
  async function look (address, signal) {
    let rt = live.get(address)
    if (rt === undefined) { rt = { handle: null, status: 'starting', error: null, failures: 0, off: null, cancelRetry: () => {}, epoch }; live.set(address, rt) }
    if (!state.enabled || stopped || (rt.status === 'over-limit' && rt.epoch === epoch)) return
    const mine = rt
    if (await opened(address, mine, signal)) await reconcile(address, signal)
    letGo(mine)
  }

  /** @param {Runtime} rt */
  function letGo (rt) {
    rt.off?.()
    rt.off = null
    const handle = rt.handle
    rt.handle = null
    handle?.stop().catch(() => {})
  }

  /**
   * Opens a community and resolves true once its record is there, false when it is not (it did not open or had no record within `waitMs`, or the pass was stopped).
   * A community that opens after the wait is over is stopped at once. @param {string} address @param {Runtime} rt @param {AbortSignal} signal
   */
  function opened (address, rt, signal) {
    return new Promise((resolve) => {
      let over = false
      const began = clock.now()
      const finish = (/** @type {boolean} */ found) => {
        if (over) return
        over = true
        cancel()
        signal.removeEventListener('abort', gone)
        if (!found && !signal.aborted && rt.status !== 'error' && live.get(address) === rt) { rt.status = rt.handle === null ? 'starting' : 'waiting'; rt.error = null; retryLater(address, rt) }
        resolve(found)
      }
      const gone = () => { finish(false) }
      const cancel = clock.after(timing.waitMs, () => { finish(false) })
      signal.addEventListener('abort', gone, { once: true })
      open(address).then((handle) => {
        if (over || live.get(address) !== rt) { handle.stop().catch(() => {}); finish(false); return }
        log(`seeding: ${address} opened in ${String(clock.now() - began)} ms`)
        rt.handle = handle
        rt.status = 'waiting'
        const ready = () => { if (handle.record() !== null) finish(true) }
        rt.off = handle.onUpdate(ready)
        ready()
      }, (error) => {
        if (over || live.get(address) !== rt) return
        rt.status = 'error'; rt.error = textOf(error)
        warn(`seeding: could not follow ${address}: ${rt.error}`)
        retryLater(address, rt)
        finish(false)
      })
    })
  }

  /** Brings what is followed in line with the list and the hosted boards, then looks at each community once. */
  async function sync () {
    const started = clock.now()
    const { signal } = passStop
    if (!state.enabled) { await releaseAndCollect(Object.keys(state.held)); return }
    const wanted = state.communities.map((one) => one.address).filter((address) => !isHosted(address))
    for (const address of [...live.keys()]) if (!wanted.includes(address)) await close(address)
    await releaseAndCollect(Object.keys(state.held).filter((address) => !wanted.includes(address)))
    const added = new Set(state.communities.filter((one) => one.origin === 'added').map((one) => one.address))
    const queue = wanted.toSorted((one, other) => Number(live.has(one)) - Number(live.has(other)) || Number(!added.has(one)) - Number(!added.has(other)))
    await Promise.all(Array.from({ length: Math.min(timing.lanes, queue.length) }, async () => { for (let address = queue.shift(); address !== undefined && !signal.aborted; address = queue.shift()) await look(address, signal) }))
    if (signal.aborted) return
    markRun(started)
  }

  /** The last check: when it was, how many communities are followed and how many are held now, whether a pass or one community's new record made the check. @param {number} started */
  function markRun (started) {
    const wanted = state.communities.map((one) => one.address).filter((address) => !isHosted(address))
    state.lastRun = { at: clock.now(), tookMs: clock.now() - started, communities: wanted.length, holding: wanted.filter((address) => live.get(address)?.status === 'holding').length }
    persist()
  }

  function passLater () {
    cancelPass()
    if (!state.enabled || stopped || !began) return
    cancelPass = clock.after(timing.passMs, () => { inTurn(sync).catch(() => {}).then(passLater) })
  }

  const change = (/** @type {() => void} */ edit) => { edit(); epoch += 1; persist() }
  const request = () => { if (began) inTurn(sync).catch((error) => { warn(`seeding: ${textOf(error)}`) }); return view() }

  return {
    state: view,
    /** Starts following what is listed, once pkc-js's server is up. */
    begin () { began = true; if (state.enabled) passLater(); request() },
    enable () { change(() => { state.enabled = true }); passLater(); return request() },
    /** Off: every pin seeding made is taken away and the node is told to drop the blocks. */
    disable () {
      change(() => { state.enabled = false })
      cancelPass()
      stopPass()
      const following = [...live.keys()]
      inTurn(async () => { for (const address of following) await close(address); await sync() }).catch((error) => { warn(`seeding: ${textOf(error)}`) })
      return view()
    },
    /** @param {unknown} bytes */
    setLimit (bytes) {
      change(() => { state.limitBytes = checkLimit(bytes) })
      stopPass()
      inTurn(async () => {
        for (const address of state.communities.map((one) => one.address).reverse()) {
          if (used() <= state.limitBytes) break
          if (state.held[address] === undefined) continue
          await releaseAndCollect([address])
          const rt = live.get(address)
          if (rt !== undefined) { rt.status = 'over-limit'; rt.epoch = epoch }
        }
        await sync()
      }).catch((error) => { warn(`seeding: ${textOf(error)}`) })
      return view()
    },
    /** @param {unknown} address a community's address, a name or a public key */
    add (address) {
      const one = checkAddress(address)
      if (state.communities.length >= COMMUNITIES_MAX && !state.communities.some((entry) => entry.address === one)) throw new ConfigError(`the list holds ${String(COMMUNITIES_MAX)} communities at most`)
      stopPass()
      change(() => {
        state.ignored = state.ignored.filter((entry) => entry !== one)
        const found = state.communities.find((entry) => entry.address === one)
        if (found === undefined) state.communities.push({ address: one, origin: 'added', addedAt: clock.now() })
        else found.origin = 'added'
      })
      return request()
    },
    /** A followed community that is taken out stays out when the page sends the list again; adding it brings it back. @param {unknown} address */
    remove (address) {
      const one = checkAddress(address)
      stopPass()
      change(() => {
        const found = state.communities.find((entry) => entry.address === one)
        if (found?.origin === 'followed' && !state.ignored.includes(one)) state.ignored.push(one)
        state.communities = state.communities.filter((entry) => entry.address !== one)
      })
      return request()
    },
    /** The communities the app says the person follows: they replace the followed ones on the list, in the order sent. @param {unknown} addresses */
    follow (addresses) {
      if (!Array.isArray(addresses)) throw new ConfigError('addresses must be a list of community addresses')
      const sent = [...new Set(addresses.map((address) => checkAddress(address)))]
      change(() => {
        const added = state.communities.filter((entry) => entry.origin === 'added')
        const before = new Map(state.communities.map((entry) => [entry.address, entry]))
        const followed = sent.filter((address) => !state.ignored.includes(address) && !added.some((entry) => entry.address === address)).map((address) => before.get(address) ?? { address, origin: /** @type {const} */ ('followed'), addedAt: clock.now() })
        state.communities = [...followed, ...added].slice(0, COMMUNITIES_MAX)
      })
      return request()
    },
    /** A look at every community now. */
    run () { return request() },
    /** Resolves when everything asked so far is done. */
    settled: async () => { do { await turn; for (let hop = 0; hop < 20; hop++) await Promise.resolve() } while (queued > 0) },
    /** Ends what runs and keeps what is held: the node's own stop is a restart of seeding at the next start. */
    async stop () {
      stopped = true
      cancelPass()
      stopPass()
      for (const controller of topics.values()) controller.abort()
      topics.clear()
      await Promise.all([...live.keys()].map(close))
    }
  }
}
