// Serving kept shares from Orivon's IPFS node in this page, as a second way beside WebRTC. The node (bin/ipfs-node,
// started by launch.js) takes a share's blocks as CAR batches, announces them on the IPFS network when this
// computer can be reached (directly, or through the place it holds on Orivon's relay), and answers IPFS peers.
// It is used only when the node that is shipped says it can: the build records the features the shipped node
// has (build.json), and the node itself lists them in the `x-orivon-node-features` header of /health; without
// `listen`, `provide` and `relay` in both, it is never started.

import { nodeState } from '../publish/node-state.js'
import { PinningError } from '../publish/pinning.js'

/** What a node must be able to do for Share to start it. */
export const NODE_FEATURES = ['listen', 'provide', 'relay']
/** The node keeps its blocks in memory, 256 MiB at most; a share above this, or beyond this in all, is served over WebRTC only. */
export const NODE_MAX_SHARE_BYTES = 200 * 1024 * 1024
export const NODE_BATCH_BYTES = 32 * 1024 * 1024
const LOADING = 'Your IPFS node could not be loaded.'
/** Lines the page writes about the node's reachability in one run, so a long session cannot flood the console. */
const STATUS_LINES_SHOWN = 40
/** The places in the node's table of announced addresses, which belongs to the whole node: a root, and the files and folders listed under it, each take one. */
const NODE_TABLE_PLACES = 1024
/** The node takes one upload at a time and answers 429 to a second: a page whose upload is refused for that asks again this often, this many times. */
const UPLOAD_RETRIES = 6

/** Whether this page can run a node: Orivon, with Share's grants. */
export function pageNodeAvailable () {
  return typeof globalThis.window?.orivon?.net?.connect === 'function' && typeof globalThis.window?.orivon?.net?.listen === 'function'
}

/** Loads node-launch.js, the one bundled file, once. @returns {Promise<{ start: (o: { key: string, port: number | null, signal?: AbortSignal }) => Promise<{ base: string, peer: string, port: number }> }>} */
function loadLauncher () {
  if (globalThis.shareNode) return Promise.resolve(globalThis.shareNode)
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = new URL('../../node-launch.js', import.meta.url).href
    script.onload = () => globalThis.shareNode ? resolve(globalThis.shareNode) : reject(new Error(LOADING))
    script.onerror = () => reject(new Error(LOADING))
    document.head.append(script)
  })
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

/** @param {string[] | undefined} features */
const hasFeatures = (features) => Array.isArray(features) && NODE_FEATURES.every((feature) => features.includes(feature))

/**
 * @typedef {'off' | 'starting' | 'announced' | 'unreachable'} NodeState
 * @typedef {object} ProviderOptions
 * @property {ReturnType<typeof import('../keep/store.js').createKeep>} keep
 * @property {import('../publish/node-state.js').NodeState} [state]
 * @property {() => Promise<{ start: (o: { key: string, port: number | null, signal?: AbortSignal }) => Promise<{ base: string, peer: string, port: number }> }>} [launcher]
 * @property {() => Promise<{ ipfsNode?: string, nodeFeatures?: string[] }>} [buildInfo]
 * @property {typeof fetch} [fetchImpl]
 * @property {() => boolean} [available]
 * @property {number} [uploadRetryMs] How long to wait before asking again after the node refused an upload because another runs.
 */

/** @param {ProviderOptions} options */
export function createNodeProvider ({ keep, state = nodeState(), launcher = loadLauncher, buildInfo = loadBuildInfo, fetchImpl = (...args) => fetch(...args), available = pageNodeAvailable, uploadRetryMs = 3000 }) {
  /** @type {Promise<{ base: string, key: string } | null> | null} */
  let started = null
  /** @type {Map<string, number>} */
  const held = new Map()
  /** @type {Map<string, NodeState>} */
  const states = new Map()
  /** The shares this page wants the node to announce: a `provide` still under way when `unprovide` runs must not finish what was stopped. @type {Set<string>} */
  const wanted = new Set()
  /** Whether the node cut a share short when it took it, for each share whose `/provide` answer said how many files and folders it announced with the root. @type {Map<string, boolean>} */
  const entries = new Map()
  /** What the page last wrote about the node's reachability: a line is written only when it changes. */
  let reported = ''
  let reportedLines = 0

  /** @param {{ base: string, key: string }} node @param {string} path @param {RequestInit} [init] */
  async function call (node, path, init = {}) {
    let response
    try {
      response = await fetchImpl(`${node.base}${path}`, { ...init, headers: { ...(init.headers ?? {}), 'x-orivon-key': node.key } })
    } catch {
      if (init.signal?.aborted) throw new PinningError('aborted', 'Cancelled.')
      throw new PinningError('unreachable', 'Your IPFS node stopped answering.')
    }
    const text = await response.text()
    if (!response.ok) throw Object.assign(new PinningError(response.status === 507 ? 'too-large' : 'refused', `Your IPFS node refused it: ${text.trim().slice(0, 200) || `status ${response.status}`}`), { status: response.status })
    /** @type {any} */
    let body = {}
    try { body = text === '' ? {} : JSON.parse(text) } catch { /* /health answers plain text */ }
    return { response, body }
  }

  /** @param {AbortSignal} [signal] */
  async function begin (signal) {
    if (!available()) return null
    const info = await buildInfo()
    if (!hasFeatures(info.nodeFeatures)) return null
    const key = await state.getOrCreate('nodeKey', () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join(''))
    const spawned = await (await launcher()).start({ key, port: await state.get('nodePort', null), ...(signal ? { signal } : {}) })
    await state.set('nodePort', spawned.port)
    const node = { base: spawned.base, key }
    const { response } = await call(node, '/health').catch(() => ({ response: null }))
    const listed = (response?.headers.get('x-orivon-node-features') ?? '').split(',').map((feature) => feature.trim())
    return hasFeatures(listed) ? node : null
  }

  /** Writes what the node reports to the page's console, which a bug report carries, when it differs from the last line. @param {string} line */
  function report (line) {
    if (line === reported || reportedLines >= STATUS_LINES_SHOWN) return
    reported = line
    reportedLines++
    console.warn(`[share-node] ${line}`)
  }

  /**
   * The tail of the status line about the node's table: the files and folders it holds under the roots of the shares
   * this page gave it (read from the table itself, because a root that arrives later pushes another share's entries
   * out) and the shares it cut short when it took them. Empty while the node has not answered a `/provide`.
   * @param {Set<string>} places the CIDs the node's table holds
   */
  function entriesLine (places) {
    if (entries.size === 0) return ''
    let roots = 0
    for (const cid of held.keys()) if (places.has(cid)) roots++
    let cut = 0
    for (const truncated of entries.values()) if (truncated) cut++
    return `, files and folders announced with them ${places.size - roots}, the node's table holds ${places.size} of ${NODE_TABLE_PLACES}${cut > 0 ? `, shares the node cut short when it took them ${cut}` : ''}`
  }

  /** The share being given to the node now; the next waits for it. @type {Promise<unknown>} */
  let turn = Promise.resolve()

  /** One batch of a share's blocks. The node answers 429 while another upload runs (another tab of Share uses the same node), and the upload is asked again shortly. @param {{ base: string, key: string }} node @param {Blob} batch @param {AbortSignal} [signal] */
  async function upload (node, batch, signal) {
    for (let attempt = 1; ; attempt++) {
      try {
        await call(node, '/blocks', { method: 'POST', body: batch, headers: { 'content-type': 'application/vnd.ipld.car' }, ...(signal ? { signal } : {}) })
        return
      } catch (error) {
        if (/** @type {any} */ (error).status !== 429 || attempt >= UPLOAD_RETRIES) throw error
        await new Promise((resolve) => setTimeout(resolve, uploadRetryMs))
      }
    }
  }

  /** Asks the node to announce a share it holds. Its 429 here means its table already names its limit of CIDs, each a root or one asked for by name: this share is not announced, and the page says so. @param {{ base: string, key: string }} node @param {string} cid @param {AbortSignal} [signal] */
  async function announce (node, cid, signal) {
    try {
      return await call(node, '/provide', { method: 'POST', body: JSON.stringify({ cid }), headers: { 'content-type': 'application/json' }, ...(signal ? { signal } : {}) })
    } catch (error) {
      if (/** @type {any} */ (error).status === 429) report(`a share was not announced: the node's table already names ${NODE_TABLE_PLACES} CIDs, so it travels page to page only`)
      throw error
    }
  }

  /** @param {string} cid @param {AbortSignal} [signal] */
  async function give (cid, signal) {
    if (!wanted.has(cid)) return
    const meta = await keep.meta(cid)
    if (meta === null || meta.stored > NODE_MAX_SHARE_BYTES) return
    const node = await provider.node(signal)
    if (node === null || !wanted.has(cid)) return
    const others = [...held].filter(([held_cid]) => held_cid !== cid).reduce((sum, [, size]) => sum + size, 0)
    if (others + meta.stored > NODE_MAX_SHARE_BYTES) return
    states.set(cid, 'starting')
    try {
      await keep.eachBatch(cid, NODE_BATCH_BYTES, (batch) => upload(node, batch, signal))
      if (!wanted.has(cid)) { states.set(cid, 'off'); return }
      const { body } = await announce(node, cid, signal)
      if (!wanted.has(cid)) {
        await call(node, `/provide/${encodeURIComponent(cid)}`, { method: 'DELETE' }).catch(() => {})
        states.set(cid, 'off')
        return
      }
      held.set(cid, meta.stored)
      if (Number.isSafeInteger(body.children)) entries.set(cid, body.truncated === true)
    } catch (error) {
      states.set(cid, 'off')
      throw error
    }
  }

  const provider = {
    /** The node, started once; null when this page has none to use. @param {AbortSignal} [signal] */
    node (signal) {
      started ??= begin(signal).catch(() => null)
      return started
    },

    /** @param {string} cid @returns {NodeState} */
    stateOf (cid) {
      return states.get(cid) ?? 'off'
    },

    /**
     * Gives the node a kept share and has it announce it. A share the node cannot hold stays 'off'. The node takes
     * one upload at a time, so the shares go to it one after another.
     * @param {string} cid @param {AbortSignal} [signal]
     */
    provide (cid, signal) {
      wanted.add(cid)
      const run = turn.then(() => give(cid, signal))
      turn = run.catch(() => {})
      return run
    },

    /** @param {string} cid */
    async unprovide (cid) {
      wanted.delete(cid)
      held.delete(cid)
      entries.delete(cid)
      states.set(cid, 'off')
      const node = started === null ? null : await started
      if (node !== null) await call(node, `/provide/${encodeURIComponent(cid)}`, { method: 'DELETE' }).catch(() => {})
    },

    /**
     * Asks the node what it announced, whether this computer can be reached and whether the node holds a place on
     * Orivon's relay. Returns false when the node has gone. A share is 'unreachable' only when AutoNAT says private
     * and no relay place is held; a held place lets the node announce, whatever AutoNAT says.
     */
    async poll () {
      const node = started === null ? null : await started
      if (node === null) return true
      try {
        const { body } = await call(node, '/status')
        const providing = new Map(Array.isArray(body.providing) ? body.providing.map((/** @type {any} */ row) => [String(row.cid), row.announced]) : [])
        const places = new Set(providing.keys())
        const relays = Array.isArray(body.relays) ? body.relays.length : 0
        for (const cid of held.keys()) {
          states.set(cid, typeof providing.get(cid) === 'number' ? 'announced' : body.reachability === 'private' && relays === 0 ? 'unreachable' : 'starting')
        }
        report(`reachability ${String(body.reachability ?? 'unknown')}, relay places held ${relays}, shares announced ${[...held.keys()].filter((cid) => typeof providing.get(cid) === 'number').length} of ${held.size}${entriesLine(places)}`)
        return true
      } catch {
        held.clear()
        entries.clear()
        for (const cid of states.keys()) states.set(cid, 'off')
        started = null
        report('the node stopped answering')
        return false
      }
    }
  }
  return provider
}
