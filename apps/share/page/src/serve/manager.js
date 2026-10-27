// What this page is serving. Every kept share marked online has a seeder in its own swarm; opening Share resumes
// them, closing it ends them. The state it reports is what the page shows: which shares are online, how many peers
// each has, how much it has uploaded, and whether the page's IPFS node announced it.

import { infoHashOf } from './ids.js'
import { createSeeder } from './seeder.js'
import { joinSwarm } from './swarm.js'

const POLL_MS = 30_000

/**
 * @typedef {'off' | 'starting' | 'announced' | 'unreachable'} NodeState
 * @typedef {{ cid: string, online: boolean, peers: number, uploaded: number, node: NodeState }} ServingShare
 * @typedef {{ shares: ServingShare[], trackers: { connected: number, total: number }, supported: boolean }} ServingState
 * @typedef {object} ServingOptions
 * @property {ReturnType<typeof import('../keep/store.js').createKeep>} keep
 * @property {ReturnType<typeof import('./tracker.js').createTrackerHub>} hub
 * @property {{ provide: (cid: string) => Promise<void>, unprovide: (cid: string) => Promise<void>, poll: () => Promise<boolean>, stateOf: (cid: string) => NodeState } | null} [node]
 * @property {import('./rtc.js').RtcOptions} [rtc]
 * @property {boolean} [supported] whether this page has WebSocket and WebRTC
 */

/** @param {ServingOptions} options */
export function createServing ({ keep, hub, node = null, rtc = {}, supported = typeof WebSocket === 'function' && typeof RTCPeerConnection === 'function' }) {
  /** @type {Map<string, { swarm: ReturnType<typeof joinSwarm>, seeder: ReturnType<typeof createSeeder> }>} */
  const serving = new Map()
  /** @type {Map<string, boolean>} */
  const known = new Map()
  /** @type {Set<(state: ServingState) => void>} */
  const listeners = new Set()
  const total = { links: 0 }
  /** @type {ReturnType<typeof setInterval> | null} */
  let poller = null

  /** @returns {ServingState} */
  function state () {
    return {
      supported,
      trackers: hub.state,
      shares: [...known].map(([cid, online]) => {
        const entry = serving.get(cid)
        return { cid, online, peers: entry?.seeder.peers ?? 0, uploaded: entry?.seeder.stats.uploaded ?? 0, node: node?.stateOf(cid) ?? 'off' }
      })
    }
  }
  const changed = () => { const now = state(); for (const listener of listeners) listener(now) }

  /** @param {string} cid */
  async function serve (cid) {
    known.set(cid, true)
    if (serving.has(cid) || !supported) { changed(); return }
    const seeder = createSeeder({ keep, root: cid, total, onChange: changed })
    const swarm = joinSwarm({ hub, infoHash: await infoHashOf(cid), role: 'seed', canAccept: seeder.canAccept, linkHandlers: seeder.linkHandlers, onLink: seeder.attach, rtc })
    serving.set(cid, { swarm, seeder })
    hub.start()
    node?.provide(cid).catch(() => {}).then(changed)
    changed()
  }

  /** @param {string} cid */
  async function stop (cid) {
    const entry = serving.get(cid)
    if (entry !== undefined) {
      entry.swarm.leave()
      total.links -= entry.seeder.peers
      entry.seeder.closeAll()
      serving.delete(cid)
    }
    await node?.unprovide(cid)
    if (known.has(cid)) known.set(cid, false)
    changed()
  }

  return {
    state,
    /** @param {(state: ServingState) => void} listener @returns {() => void} */
    subscribe (listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    /** Resumes every kept share marked online. Safe to call again. */
    async start () {
      for (const meta of await keep.list()) {
        known.set(meta.cid, meta.online)
        if (meta.online) await serve(meta.cid)
      }
      if (poller === null && node !== null) {
        poller = setInterval(() => {
          node.poll().then(async (alive) => {
            if (!alive) for (const cid of serving.keys()) await node.provide(cid).catch(() => {})
            changed()
          }, () => {})
        }, POLL_MS)
      }
      changed()
    },

    /** Serves a share that is kept, and remembers that it should be. @param {string} cid */
    async setOnline (cid, online) {
      await keep.setOnline(cid, online)
      if (online) await serve(cid)
      else await stop(cid)
    },

    /** A share was kept just now. @param {string} cid @param {boolean} online */
    async added (cid, online) {
      known.set(cid, online)
      if (online) await serve(cid)
      else changed()
    },

    /** A share is gone from this computer. @param {string} cid */
    async removed (cid) {
      await stop(cid)
      known.delete(cid)
      changed()
    },

    /** Ends everything, for the page closing or a test. */
    async close () {
      if (poller !== null) clearInterval(poller)
      poller = null
      for (const cid of [...serving.keys()]) await stop(cid)
      hub.close()
    }
  }
}
