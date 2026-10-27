// One share being opened on this page: where its blocks come from. They come from this computer when the share is
// kept here, otherwise from its peers over WebRTC and from the trustless gateways, whichever answers; a peer is
// preferred and the gateways start only when it is slow or absent. Every block is checked against its CID before it
// is used, whoever sent it.

import { parseCid } from '../ipfs/cid.js'
import { readFileBlob } from '../ipfs/dagwalk.js'
import { fetchBlock, fetchFileBlob } from '../ipfs/gateway.js'
import { infoHashOf } from '../serve/ids.js'
import { createPool } from '../serve/pool.js'
import { joinSwarm } from '../serve/swarm.js'
import { race } from './race.js'

/** Trustless gateways, in order. Filebase first: shares kept on a pinning service of Orivon's own tests live there. */
export const GATEWAYS = ['https://ipfs.filebase.io', 'https://trustless-gateway.link', 'https://ipfs.orbitor.dev']
const IDLE_MS = 3 * 60 * 1000
const GATEWAY_HEAD_START_MS = 1500
/** How long a read waits for a computer that has the share to be found through the trackers. */
const PEER_WAIT_MS = 25_000
/** While it waits, the read asks the trackers again this often: a page that opened the link first is told of a sender that came after. */
const PEER_REFRESH_MS = 8000
const SMALL_BLOCK_BYTES = 1024 * 1024

/**
 * @typedef {'peer' | 'gateway' | 'local'} Source
 * @typedef {{ done: number, total: number, source: Source }} SourceProgress
 * @typedef {object} SessionDeps
 * @property {ReturnType<typeof import('../keep/store.js').createKeep> | null} [keep]
 * @property {ReturnType<typeof import('../serve/tracker.js').createTrackerHub> | null} [hub] null where this page cannot do WebRTC
 * @property {import('../serve/rtc.js').RtcOptions} [rtc]
 * @property {string[]} [gateways]
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [headStartMs] how long the gateways wait for a peer that is already connected
 * @property {number} [peerWaitMs] how long a read waits for a first peer to connect
 * @property {number} [peerRefreshMs] how often it asks the trackers again meanwhile
 */

/** @type {Map<string, ReturnType<typeof build>>} */
const sessions = new Map()

/**
 * The session of a share, made on first use and ended after three idle minutes or by `closeSession`.
 * @param {string} cid @param {SessionDeps} deps
 */
export async function sessionFor (cid, deps) {
  const root = parseCid(cid).string
  const existing = sessions.get(root)
  if (existing !== undefined) { existing.touch(); return existing }
  const made = build(root, deps)
  sessions.set(root, made)
  await made.ready
  return made
}

/** @param {string} cid */
export function closeSession (cid) {
  sessions.get(parseCid(cid).string)?.close()
}

/** @param {string} root @param {SessionDeps} deps */
function build (root, deps) {
  const { keep = null, hub = null, rtc = {}, gateways = GATEWAYS, fetchImpl, headStartMs = GATEWAY_HEAD_START_MS, peerWaitMs = PEER_WAIT_MS, peerRefreshMs = PEER_REFRESH_MS } = deps
  const pool = createPool()
  /** @type {Map<string, { bytes: Uint8Array, source: Source }>} */
  const small = new Map()
  /** @type {ReturnType<typeof joinSwarm> | null} */
  let swarm = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idle = null
  let kept = false

  /** Resolves once a peer is connected, however late; rejects when none came in time, or the read was cancelled. @param {AbortSignal} signal */
  async function peerArrives (signal) {
    const until = Date.now() + peerWaitMs
    for (;;) {
      const left = until - Date.now()
      if (await pool.hasPeer(Math.max(Math.min(peerRefreshMs, left), 0), signal)) return
      if (signal.aborted) throw signal.reason
      if (left <= peerRefreshMs) throw new Error('No computer that has this share answered.')
      swarm?.refresh()
    }
  }

  /** What an error should say when the trackers were asked and found nobody. @param {unknown} error */
  function withPeers (error) {
    if (swarm === null || pool.size > 0 || !(error instanceof Error) || error.name === 'AbortError') return error
    return Object.assign(new Error(`${error.message} (and no computer that has it was found online)`), { name: error.name })
  }

  const ready = (async () => {
    kept = keep !== null && await keep.meta(root) !== null
    if (kept || hub === null) return
    swarm = joinSwarm({ hub, infoHash: await infoHashOf(root), role: 'leech', onLink: (link) => pool.add(link), rtc })
    hub.start()
  })()

  const session = {
    root,
    ready,
    pool,
    get peers () { return pool.size },
    touch () {
      if (idle !== null) clearTimeout(idle)
      idle = setTimeout(session.close, IDLE_MS)
    },
    close () {
      if (idle !== null) clearTimeout(idle)
      swarm?.leave()
      pool.close()
      sessions.delete(root)
    },

    /**
     * One block, from this computer, a peer or a gateway. `onSource` hears which of them gave it.
     * @param {string} cid @param {{ signal?: AbortSignal, onSource?: (source: Source) => void }} [options] @returns {Promise<Uint8Array>}
     */
    async block (cid, { signal, onSource } = {}) {
      session.touch()
      const key = parseCid(cid).string
      const cached = small.get(key)
      if (cached !== undefined) { onSource?.(cached.source); return cached.bytes }
      const local = kept ? await keep?.block(root, key) : null
      if (local !== null && local !== undefined) { onSource?.('local'); return local }
      /** @type {import('./race.js').Attempt<Uint8Array>[]} */
      const attempts = []
      if (swarm !== null) {
        attempts.push({ name: 'peer', run: async (s) => { await peerArrives(s); return await pool.block(key, { signal: s, timeoutMs: 8000 }) } })
      }
      attempts.push({ name: 'gateway', headStartMs: pool.size > 0 ? headStartMs : 0, run: (s) => fetchBlock(key, { gateways, ...(fetchImpl ? { fetchImpl } : {}), signal: s }) })
      const { value, name } = await race(attempts, signal).catch((error) => { throw withPeers(error) })
      const source = /** @type {'peer' | 'gateway'} */ (name)
      if (value.length <= SMALL_BLOCK_BYTES) small.set(key, { bytes: value, source })
      onSource?.(source)
      return value
    },

    /**
     * A whole file, from this computer, or the peers and the gateways raced. `onProgress` hears the source that is
     * ahead, with its name.
     * @param {string} cid
     * @param {{ signal?: AbortSignal, total?: number, maxBytes?: number, onProgress?: (progress: SourceProgress) => void }} [options]
     * @returns {Promise<{ blob: Blob, source: Source }>}
     */
    async file (cid, { signal, total = 0, maxBytes = Infinity, onProgress } = {}) {
      session.touch()
      const key = parseCid(cid).string
      /** @type {Record<string, number>} */
      const done = { peer: 0, gateway: 0 }
      /** @param {'peer' | 'gateway'} source @param {number} bytes */
      const report = (source, bytes) => {
        done[source] = bytes
        const shown = total > 0 ? Math.min(bytes, total) : bytes
        if (bytes >= (done[source === 'peer' ? 'gateway' : 'peer'] ?? 0)) onProgress?.({ done: shown, total, source })
      }
      if (kept && keep !== null) {
        const blob = await readFileBlob({ block: async (c) => (await keep.block(root, c)) ?? Promise.reject(new Error('missing block')), blob: (c) => keep.blob(root, c) }, key, { ...(signal ? { signal } : {}) })
        onProgress?.({ done: blob.size, total, source: 'local' })
        return { blob, source: 'local' }
      }
      /** @type {import('./race.js').Attempt<Blob>[]} */
      const attempts = []
      if (swarm !== null) {
        attempts.push({
          name: 'peer',
          run: async (s) => {
            await peerArrives(s)
            let got = 0
            return await readFileBlob({ block: (c) => pool.block(c, { signal: s, timeoutMs: 8000 }) }, key, { signal: s, onBytes: (n) => { got += n; report('peer', got) } })
          }
        })
      }
      attempts.push({
        name: 'gateway',
        headStartMs: pool.size > 0 ? headStartMs : 0,
        busy: () => (done.peer ?? 0) > 0,
        run: async (s) => (await fetchFileBlob(key, { gateways, ...(fetchImpl ? { fetchImpl } : {}), signal: s, maxBytes, onProgress: (bytes) => report('gateway', bytes) })).blob
      })
      const { value, name } = await race(attempts, signal).catch((error) => { throw withPeers(error) })
      const source = /** @type {'peer' | 'gateway'} */ (name)
      onProgress?.({ done: value.size, total: total > 0 ? total : value.size, source })
      return { blob: value, source }
    }
  }
  session.touch()
  return session
}
