// Serving kept shares from Orivon's IPFS node in this page, as a second way beside WebRTC. The node (bin/ipfs-node,
// started by launch.js) takes a share's blocks as CAR batches, announces them on the IPFS network when this
// computer can be reached, and answers IPFS peers. It is used only when the node that is shipped says it can:
// the build records the features the shipped node has (build.json), and the node itself lists them in the
// `x-orivon-node-features` header of /health; without `listen` and `provide` in both, it is never started.

import { nodeState } from '../publish/node-state.js'
import { PinningError } from '../publish/pinning.js'

/** What a node must be able to do for Share to start it. */
export const NODE_FEATURES = ['listen', 'provide']
/** The node keeps its blocks in memory, 256 MiB at most; a share above this, or beyond this in all, is served over WebRTC only. */
export const NODE_MAX_SHARE_BYTES = 200 * 1024 * 1024
export const NODE_BATCH_BYTES = 32 * 1024 * 1024
const LOADING = 'Your IPFS node could not be loaded.'

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
 */

/** @param {ProviderOptions} options */
export function createNodeProvider ({ keep, state = nodeState(), launcher = loadLauncher, buildInfo = loadBuildInfo, fetchImpl = (...args) => fetch(...args), available = pageNodeAvailable }) {
  /** @type {Promise<{ base: string, key: string } | null> | null} */
  let started = null
  /** @type {Map<string, number>} */
  const held = new Map()
  /** @type {Map<string, NodeState>} */
  const states = new Map()
  /** The shares this page wants the node to announce: a `provide` still under way when `unprovide` runs must not finish what was stopped. @type {Set<string>} */
  const wanted = new Set()

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
    if (!response.ok) throw new PinningError(response.status === 507 ? 'too-large' : 'refused', `Your IPFS node refused it: ${text.trim().slice(0, 200) || `status ${response.status}`}`)
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
     * Gives the node a kept share and has it announce it. A share the node cannot hold stays 'off'.
     * @param {string} cid @param {AbortSignal} [signal]
     */
    async provide (cid, signal) {
      const meta = await keep.meta(cid)
      if (meta === null || meta.stored > NODE_MAX_SHARE_BYTES) return
      wanted.add(cid)
      const node = await provider.node(signal)
      if (node === null || !wanted.has(cid)) return
      const others = [...held].filter(([held_cid]) => held_cid !== cid).reduce((sum, [, size]) => sum + size, 0)
      if (others + meta.stored > NODE_MAX_SHARE_BYTES) return
      states.set(cid, 'starting')
      try {
        await keep.eachBatch(cid, NODE_BATCH_BYTES, async (batch) => {
          await call(node, '/blocks', { method: 'POST', body: batch, headers: { 'content-type': 'application/vnd.ipld.car' }, ...(signal ? { signal } : {}) })
        })
        if (!wanted.has(cid)) { states.set(cid, 'off'); return }
        await call(node, '/provide', { method: 'POST', body: JSON.stringify({ cid }), headers: { 'content-type': 'application/json' }, ...(signal ? { signal } : {}) })
        if (!wanted.has(cid)) {
          await call(node, `/provide/${encodeURIComponent(cid)}`, { method: 'DELETE' }).catch(() => {})
          states.set(cid, 'off')
          return
        }
        held.set(cid, meta.stored)
      } catch (error) {
        states.set(cid, 'off')
        throw error
      }
    },

    /** @param {string} cid */
    async unprovide (cid) {
      wanted.delete(cid)
      held.delete(cid)
      states.set(cid, 'off')
      const node = started === null ? null : await started
      if (node !== null) await call(node, `/provide/${encodeURIComponent(cid)}`, { method: 'DELETE' }).catch(() => {})
    },

    /** Asks the node what it announced and whether this computer can be reached. Returns false when the node has gone. */
    async poll () {
      const node = started === null ? null : await started
      if (node === null) return true
      try {
        const { body } = await call(node, '/status')
        const providing = new Map(Array.isArray(body.providing) ? body.providing.map((/** @type {any} */ row) => [String(row.cid), row.announced]) : [])
        for (const cid of held.keys()) {
          states.set(cid, typeof providing.get(cid) === 'number' ? 'announced' : body.reachability === 'private' ? 'unreachable' : 'starting')
        }
        return true
      } catch {
        held.clear()
        for (const cid of states.keys()) states.set(cid, 'off')
        started = null
        return false
      }
    }
  }
  return provider
}
