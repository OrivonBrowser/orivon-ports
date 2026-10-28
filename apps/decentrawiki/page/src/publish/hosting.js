// Hosting wikis from this computer: the editor's IPFS node (started by node/launch.js) serves the newest version
// of every wiki the person published, to anyone on IPFS, while the editor is open. The version is kept as a CAR in
// IndexedDB ('hosted' in store.js); the node takes it as CAR batches, announces it on the IPFS network (this
// computer reached directly, or through the place the node holds on Orivon's relay) and answers peers. It is
// used only when the node that is shipped says it can: the build records its features (build.json) and the node
// lists them in the `x-orivon-node-features` header of /health; without `listen`, `provide` and `relay` in both,
// it is never started. Orivon Share's node/provide.js is the model.

import { decodeVarint } from '../ipfs/cid.js'
import * as store from '../store.js'
import { callNode, connectNode, findNode, loadLauncher } from './node-link.js'
import { PinningError } from './pinning.js'

/** Whether the editor hosts wikis when the person has not chosen. Provisional: the project decides, and this is the one place it is set. */
export const HOST_WIKIS_DEFAULT = true
/** What a node must be able to do for the editor to host on it. */
export const NODE_FEATURES = ['listen', 'provide', 'relay']
/** The node keeps its blocks in memory, 256 MiB at most, and never lets one go; a run hands it no more than this. */
export const HOST_BUDGET_BYTES = 200 * 1024 * 1024
export const NODE_BATCH_BYTES = 32 * 1024 * 1024
export const POLL_MS = 30_000
const FIRST_POLL_MS = 5_000
const CAR_TYPE = 'application/vnd.ipld.car'
const JSON_TYPE = 'application/json'
/** Lines about the node's reachability, and about failures, the page writes in one run, so a long session cannot flood the console. */
const STATUS_LINES_SHOWN = 40
const FAILURE_LINES_SHOWN = 20
const KEY_SHAPED = /[0-9a-f]{64}/gi

/**
 * @typedef {'off' | 'starting' | 'announced' | 'unreachable'} HostState
 * @typedef {import('./node-link.js').Node} Node
 * @typedef {import('../store.js').Hosted} Hosted
 */

/** Whether this page can run a node that listens: Orivon, with the editor's grants. */
export function hostingAvailable () {
  return typeof globalThis.window?.orivon?.net?.connect === 'function' && typeof globalThis.window?.orivon?.net?.listen === 'function'
}

/** What the build says about the node it shipped. @returns {Promise<{ ipfsNode?: string, nodeFeatures?: string[] }>} */
async function loadBuildInfo () {
  try {
    const response = await fetch('build.json', { cache: 'no-cache' })
    return response.ok ? await response.json() : {}
  } catch {
    return {}
  }
}

/** @param {unknown} features */
const hasFeatures = (features) => Array.isArray(features) && NODE_FEATURES.every((feature) => features.includes(feature))

/** @param {unknown} error */
const wordsOf = (error) => error instanceof Error ? error.message : String(error)

/**
 * The batches a CAR goes to the node in: whole sections, at most `limit` bytes each, every one under the CAR's own
 * header. A CAR that fits goes as it is.
 * @param {Blob} car @param {number} [limit]
 * @returns {Promise<Blob[]>}
 */
export async function carBatches (car, limit = NODE_BATCH_BYTES) {
  if (car.size <= limit) return [car]
  const bytes = new Uint8Array(await car.arrayBuffer())
  const header = decodeVarint(bytes, 0)
  const headerEnd = header.length + header.value
  const head = bytes.subarray(0, headerEnd)
  /** @type {Blob[]} */
  const batches = []
  let from = headerEnd
  let at = headerEnd
  while (at < bytes.length) {
    const section = decodeVarint(bytes, at)
    const end = at + section.length + section.value
    if (end > bytes.length) throw new Error('the stored CAR is cut off in a block')
    if (headerEnd + (end - from) > limit && at > from) {
      batches.push(new Blob([head, bytes.subarray(from, at)], { type: CAR_TYPE }))
      from = at
    }
    at = end
  }
  batches.push(new Blob([head, bytes.subarray(from, at)], { type: CAR_TYPE }))
  return batches
}

/**
 * @typedef {object} HostingOptions
 * @property {{ getSetting: Function, getHosted: Function, putHosted: Function, listHosted: Function }} [storage]
 * @property {() => Promise<import('./node-link.js').Launcher>} [launcher]
 * @property {() => Promise<{ ipfsNode?: string, nodeFeatures?: string[] }>} [buildInfo]
 * @property {typeof connectNode} [connect]
 * @property {typeof findNode} [find]
 * @property {() => boolean} [available]
 * @property {number} [pollMs] 0 turns the polling off
 * @property {number} [budget]
 * @property {number} [batchBytes]
 * @property {() => number} [now]
 */

/** @param {HostingOptions} [options] */
export function createHosting ({ storage = store, launcher = loadLauncher, buildInfo = loadBuildInfo, connect = connectNode, find = findNode, available = hostingAvailable, pollMs = POLL_MS, budget = HOST_BUDGET_BYTES, batchBytes = NODE_BATCH_BYTES, now = Date.now } = {}) {
  /** @type {Promise<Node | null> | null} */
  let started = null
  let running = false
  /** The newest version of each wiki the node announces, by wiki id. @type {Map<string, { cid: string, bytes: number }>} */
  const current = new Map()
  /** @type {Map<string, HostState>} */
  const states = new Map()
  /** What the page wants announced, by wiki id: a placement still under way for another version, or after the wiki went, stops. @type {Map<string, string>} */
  const wanted = new Map()
  /** The blocks the node holds in this run, by CID, whoever handed them over. @type {Map<string, number>} */
  const inNode = new Map()
  /** What the node answered to /provide for each version: the files and folders it announced with the root, and whether its table cut some off. @type {Map<string, { children: number, truncated: boolean }>} */
  const entries = new Map()
  /** Bytes handed to the node in this run, replaced versions included, because the node keeps them. */
  let sent = 0
  let reachability = 'unknown'
  let relays = 0
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let firstPoll = null
  let reported = ''
  let statusLines = 0
  /** @type {Set<string>} */
  const failures = new Set()
  let queue = Promise.resolve()

  /** One placement or release at a time, in the order asked. @template T @param {() => Promise<T>} task @returns {Promise<T>} */
  function enqueue (task) {
    const next = queue.then(task, task)
    queue = next.then(() => {}, () => {})
    return next
  }

  /** A failure, as one console.error line a bug report carries: a line once, no key in it. @param {string} what */
  function failure (what) {
    const line = `[decentrawiki] hosting ${what.replace(KEY_SHAPED, '<key>').slice(0, 300)}`
    if (failures.has(line) || failures.size >= FAILURE_LINES_SHOWN) return
    failures.add(line)
    console.error(line)
  }

  /** What the node reports, as a console.warn line when it differs from the last. @param {string} line */
  function report (line) {
    if (line === reported || statusLines >= STATUS_LINES_SHOWN) return
    reported = line
    statusLines++
    console.warn(`[decentrawiki] hosting status: ${line}`)
  }

  async function enabled () {
    if (!available()) return false
    try {
      return await storage.getSetting('hostWikis', HOST_WIKIS_DEFAULT) === true
    } catch {
      return false
    }
  }

  /**
   * The editor's node as it is now, without starting one: this page's, else one a tab of the editor left running on the
   * port the editor last used. The node is shared by every tab and outlives a reload, so what this page announced, or
   * another tab or an earlier load of this page did, is taken back through it. Null when none runs.
   * @returns {Promise<Node | null>}
   */
  async function nodeInPlace () {
    const mine = started === null ? null : await started
    if (mine !== null || !available()) return mine
    try {
      return await find({ launcher })
    } catch {
      return null
    }
  }

  /** Whether the node has gone, as its /health says. A node that answers still holds and announces what it was given, whatever else a call to it did. @param {Node} node */
  async function isGone (node) {
    return await callNode(node, '/health').then(() => false, (error) => error instanceof PinningError && error.kind === 'unreachable')
  }

  /** Whether the node answers, lists the features and listens. @param {Node} node @returns {Promise<'ok' | 'features' | 'not-listening' | 'gone'>} */
  async function inspect (node) {
    const { response } = await callNode(node, '/health').catch(() => ({ response: null }))
    if (response === null) return 'gone'
    if (!hasFeatures((response.headers.get('x-orivon-node-features') ?? '').split(',').map((feature) => feature.trim()))) return 'features'
    try {
      await callNode(node, '/status')
      return 'ok'
    } catch (error) {
      return error instanceof PinningError && error.kind === 'refused' ? 'not-listening' : 'gone'
    }
  }

  /** @param {AbortSignal} [signal] @returns {Promise<Node | null>} */
  async function begin (signal) {
    try {
      const info = await buildInfo()
      if (!hasFeatures(info.nodeFeatures)) {
        failure('is unavailable: the IPFS node this editor shipped has no listen, provide and relay features')
        return null
      }
      let node = await connect({ launcher, signal, listen: true })
      let verdict = await inspect(node)
      if (verdict === 'not-listening') {
        // A node started for publishing only. A page ends the node it started in this run and starts the host in its place. A node of another tab, or of this page before a reload, no page can end now: it is left running, offline, and the host starts on the next port.
        const stopped = (await (await launcher()).stop?.(node.port)) === true
        node = await connect({ launcher, signal, listen: true, ...(stopped ? {} : { port: node.port + 1 }) })
        verdict = await inspect(node)
        if (verdict === 'not-listening') {
          failure('is unavailable: the IPFS node running in another tab of the editor was started without hosting; close the editor\'s other tabs')
          return null
        }
      }
      if (verdict === 'features') failure('is unavailable: the running IPFS node does not list listen, provide and relay')
      else if (verdict !== 'ok') failure('could not start: the IPFS node did not answer')
      if (verdict !== 'ok') return null
      running = true
      return node
    } catch (error) {
      failure(`could not start the IPFS node: ${wordsOf(error)}`)
      return null
    }
  }

  function schedule () {
    if (timer !== null || pollMs <= 0) return
    timer = setInterval(() => { void provider.poll() }, pollMs)
    firstPoll = setTimeout(() => { void provider.poll() }, Math.min(FIRST_POLL_MS, pollMs))
  }

  function unschedule () {
    if (timer !== null) clearInterval(timer)
    if (firstPoll !== null) clearTimeout(firstPoll)
    timer = null
    firstPoll = null
  }

  /** What the page believed the node held, once the node is gone or ended. */
  function forgetNode () {
    current.clear()
    inNode.clear()
    entries.clear()
    wanted.clear()
    for (const wiki of states.keys()) states.set(wiki, 'off')
    sent = 0
    started = null
    running = false
    unschedule()
  }

  /** Whether the store still keeps this version of the wiki to host: a tab of the editor may have deleted the wiki or published a newer version since this page read the row. A store that cannot be read counts as unchanged. @param {Hosted} row */
  async function stillKept (row) {
    return await storage.getHosted(row.wiki).then((stored) => stored?.cid === row.cid, () => true)
  }

  /** Gives the node a wiki's stored version and has it announce it. @param {Hosted} row @param {AbortSignal} [signal] @returns {Promise<boolean>} */
  async function place (row, signal) {
    const node = await provider.node(signal)
    if (node === null || wanted.get(row.wiki) !== row.cid) return false
    if (current.get(row.wiki)?.cid === row.cid && states.get(row.wiki) !== 'off') return true
    if (!(await stillKept(row))) { await release(row.wiki, row.cid); return false }
    const bytes = row.car.size
    if (!inNode.has(row.cid) && sent + bytes > budget) {
      states.set(row.wiki, 'off')
      failure(`could not host a wiki: the IPFS node's memory budget of ${Math.round(budget / 1024 / 1024)} MiB is used`)
      return false
    }
    states.set(row.wiki, 'starting')
    try {
      if (!inNode.has(row.cid)) {
        for (const batch of await carBatches(row.car, batchBytes)) {
          if (wanted.get(row.wiki) !== row.cid) { states.set(row.wiki, 'off'); return false }
          await callNode(node, '/blocks', { method: 'POST', body: batch, headers: { 'content-type': CAR_TYPE }, ...(signal ? { signal } : {}) })
        }
        inNode.set(row.cid, bytes)
        sent += bytes
      }
      if (wanted.get(row.wiki) !== row.cid) { states.set(row.wiki, 'off'); return false }
      const { body } = await callNode(node, '/provide', { method: 'POST', body: JSON.stringify({ cid: row.cid }), headers: { 'content-type': JSON_TYPE }, ...(signal ? { signal } : {}) })
      if (wanted.get(row.wiki) !== row.cid) {
        await callNode(node, `/provide/${encodeURIComponent(row.cid)}`, { method: 'DELETE' }).catch(() => {})
        states.set(row.wiki, 'off')
        return false
      }
      // Another tab may have deleted the wiki, or published a newer version, while the node took the blocks. Its take-back found nothing announced yet, and its row change came first (the library deletes the row, then calls forget), so a row that has gone or changed means this announcement is the one nobody takes back.
      if (!(await stillKept(row))) { await release(row.wiki, row.cid); return false }
      current.set(row.wiki, { cid: row.cid, bytes })
      if (Number.isSafeInteger(body.children)) entries.set(row.cid, { children: body.children, truncated: body.truncated === true })
      schedule()
      return true
    } catch (error) {
      states.set(row.wiki, 'off')
      if (error instanceof PinningError && error.kind === 'too-large') {
        // The node says it is full, whoever filled it: this page counts only what it handed over itself, and the node is shared with other tabs and outlives a reload. It is handed nothing more in this run.
        sent = Math.max(sent, budget)
        failure(`could not host a wiki: the IPFS node's memory is full, which another tab of the editor may have filled (${wordsOf(error)})`)
      } else {
        failure(`could not give a wiki to the IPFS node: ${wordsOf(error)}`)
      }
      if (error instanceof PinningError && error.kind === 'unreachable' && await isGone(node)) forgetNode()
      return false
    }
  }

  /** Stops announcing a version, unless another wiki's newest version is the same. @param {string} wiki @param {string} cid */
  async function release (wiki, cid) {
    if (wanted.get(wiki) === cid) wanted.delete(wiki)
    if (current.get(wiki)?.cid === cid) current.delete(wiki)
    states.set(wiki, 'off')
    if ([...current.values()].some((held) => held.cid === cid)) return
    entries.delete(cid)
    const node = await nodeInPlace()
    if (node !== null) await callNode(node, `/provide/${encodeURIComponent(cid)}`, { method: 'DELETE' }).catch(() => {})
  }

  /** The tail of the status line about the files and folders announced with the roots, and the versions the node's table cut short. */
  function entriesLine () {
    if (entries.size === 0) return ''
    let announced = 0
    let cut = 0
    for (const { children, truncated } of entries.values()) {
      announced += children
      if (truncated) cut++
    }
    return `, files and folders announced with them ${announced}${cut > 0 ? `, wikis cut short at the node's limit ${cut}` : ''}`
  }

  const provider = {
    /**
     * The editor's node, started once and ready to host; null when hosting is off, this page cannot run one, or the node
     * cannot host. A later call tries again after a failure.
     * @param {AbortSignal} [signal]
     */
    async node (signal) {
      if (!(await enabled())) return null
      if (started === null) {
        const mine = begin(signal)
        started = mine
        void mine.then((node) => { if (node === null && started === mine) started = null })
      }
      return await started
    },

    /** Whether hosting is turned on in Settings and this page can do it. */
    enabled,

    /** @param {string} wikiId @returns {HostState} */
    stateOf (wikiId) {
      return states.get(wikiId) ?? 'off'
    },

    /** Whether the node already holds the blocks of this version, because the page handed them over. @param {string} cid */
    holds (cid) {
      return inNode.has(cid)
    },

    /** Notes that the page handed the node a version's blocks itself (to publish from it), so hosting does not send them again. @param {string} cid @param {number} bytes */
    markHeld (cid, bytes) {
      if (inNode.has(cid)) return
      inNode.set(cid, bytes)
      sent += bytes
    },

    /**
     * Keeps a wiki's newest version to host, replacing the one before it, and has the node announce it. Never throws: a
     * failure is written to the console and the answer is false.
     * @param {string} wikiId @param {string} cid @param {Uint8Array | Blob} car
     */
    async host (wikiId, cid, car) {
      if (!(await enabled())) return false
      try {
        const previous = await storage.getHosted(wikiId)
        /** @type {Hosted} */
        const row = { wiki: wikiId, cid, car: car instanceof Blob ? car : new Blob([/** @type {BufferSource} */ (car)], { type: CAR_TYPE }), at: now() }
        wanted.set(wikiId, cid)
        await storage.putHosted(row)
        if (previous !== undefined && previous.cid !== cid) await enqueue(() => release(wikiId, previous.cid))
        if (started === null) {
          await provider.resume()
          return provider.stateOf(wikiId) !== 'off'
        }
        return await enqueue(() => place(row))
      } catch (error) {
        failure(`could not keep a wiki to host: ${wordsOf(error)}`)
        return false
      }
    },

    /** The version of a wiki the node announces, or else the one kept to host: read before the wiki is deleted, because its stored row goes with it (store.deleteWiki). @param {string} wikiId @returns {Promise<string | undefined>} */
    async hostedVersion (wikiId) {
      return current.get(wikiId)?.cid ?? (await storage.getHosted(wikiId).catch(() => undefined))?.cid
    },

    /**
     * Stops announcing a deleted wiki's version on the node, whichever tab placed it. Call it unawaited after the wiki is deleted, with what `hostedVersion` read before: a node that is starting can take a minute to answer. Never throws.
     * @param {string} wikiId @param {string} [version] left out, it is read here, which is too late once the row has gone
     */
    async forget (wikiId, version) {
      wanted.delete(wikiId)
      const cid = version ?? await provider.hostedVersion(wikiId)
      if (cid !== undefined) await enqueue(() => release(wikiId, cid)).catch(() => {})
    },

    /** Gives the node every stored version, the newest first, until the memory budget is used; does nothing while hosting is off or nothing is stored. @param {AbortSignal} [signal] */
    async resume (signal) {
      if (!(await enabled())) return
      /** @type {Hosted[]} */
      let rows
      try {
        rows = [...await storage.listHosted()].sort((a, b) => b.at - a.at)
      } catch (error) {
        failure(`could not read the wikis it hosts: ${wordsOf(error)}`)
        return
      }
      if (rows.length === 0) return
      for (const row of rows) wanted.set(row.wiki, row.cid)
      if (await provider.node(signal) === null) return
      for (const row of rows) {
        await enqueue(() => place(row, signal))
        if (started === null) return
      }
    },

    /**
     * Asks the node what it announced, whether this computer can be reached and whether the node holds a place on Orivon's
     * relay. Returns false when the node has gone. A version is 'unreachable' only when AutoNAT says private and no relay
     * place is held; a held place lets the node announce, whatever AutoNAT says.
     */
    async poll () {
      const node = started === null ? null : await started
      if (node === null) return true
      try {
        const { body } = await callNode(node, '/status')
        const providing = new Map(Array.isArray(body.providing) ? body.providing.map((/** @type {any} */ row) => [String(row.cid), row.announced]) : [])
        reachability = typeof body.reachability === 'string' ? body.reachability : 'unknown'
        relays = Array.isArray(body.relays) ? body.relays.length : 0
        const cut = reachability === 'private' && relays === 0
        for (const [wiki, { cid }] of current) {
          states.set(wiki, typeof providing.get(cid) === 'number' ? 'announced' : cut ? 'unreachable' : 'starting')
        }
        if (cut && current.size > 0) failure('cannot reach this computer: it refuses connections and holds no place on Orivon\'s relay')
        report(`reachability ${reachability}, relay places held ${relays}, wikis announced ${[...states.values()].filter((state) => state === 'announced').length} of ${current.size}${entriesLine()}`)
        return true
      } catch {
        if (!(await isGone(node))) {
          failure('the IPFS node did not answer a status request')
          return true
        }
        forgetNode()
        failure('the IPFS node stopped answering')
        return false
      }
    },

    /**
     * What Settings shows: whether the node runs, how many wikis it announces, and how it is reached. `state` is the
     * worst of the wikis: 'unreachable' over 'starting' over 'announced'; 'off' when the node holds none.
     */
    summary () {
      const wikis = [...current.keys()]
      const all = wikis.map((wiki) => states.get(wiki) ?? 'off')
      /** @type {HostState} */
      const state = all.length === 0 ? 'off' : all.includes('unreachable') ? 'unreachable' : all.includes('starting') ? 'starting' : 'announced'
      return { running, wikis: wikis.length, announced: all.filter((s) => s === 'announced').length, state, reachability, relays }
    },

    /** Turns hosting off: stops announcing every version, those another tab or an earlier load placed too, and ends the node when this page started it. Stored versions stay, for the next time it is turned on. */
    async stop () {
      unschedule()
      const node = await nodeInPlace()
      wanted.clear()
      if (node !== null) {
        const versions = new Set([...current.values()].map((held) => held.cid))
        try {
          for (const row of await storage.listHosted()) versions.add(row.cid)
        } catch {
          // Only what this page placed is taken back.
        }
        for (const cid of versions) await callNode(node, `/provide/${encodeURIComponent(cid)}`, { method: 'DELETE' }).catch(() => {})
        try {
          await (await launcher()).stop?.(node.port)
        } catch {
          // The node is gone already, or was never this page's to end.
        }
      }
      forgetNode()
    }
  }
  return provider
}

/** The hosting of this page. */
export const hosting = createHosting()
