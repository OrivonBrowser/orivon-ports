// The peers one receiving page is connected to, as a source of blocks. A block is asked of the peer with the least
// waiting, checked against its CID, and asked of another if the first has not got it, sent a wrong one, or went
// away. A peer that sends a wrong block is dropped at once. At most `maxInFlight` requests wait at a time.

import { SHA2_256, bytesEqual, parseCid, sha256 } from '../ipfs/cid.js'

/** @param {Uint8Array} bytes @param {import('../ipfs/cid.js').Cid} cid */
async function matches (bytes, cid) {
  return cid.hashCode === SHA2_256 && bytesEqual(await sha256(bytes), cid.digest)
}

/** @param {{ maxInFlight?: number, waitMs?: number }} [options] */
export function createPool ({ maxInFlight = 16, waitMs = 8000 } = {}) {
  /** @type {Map<ReturnType<typeof import('./wire.js').createLink>, number>} */
  const links = new Map()
  /** @type {(() => void)[]} */
  const joined = []
  /** @type {(() => void)[]} */
  const slots = []
  let inFlight = 0
  let closed = false
  const stats = { bytes: 0, blocks: 0 }

  async function take () {
    if (inFlight >= maxInFlight) await new Promise((resolve) => slots.push(() => resolve(undefined)))
    inFlight += 1
  }
  function give () {
    inFlight -= 1
    slots.shift()?.()
  }

  const pool = {
    stats,
    get size () { return [...links.keys()].filter((link) => link.open).length },

    /** @param {ReturnType<typeof import('./wire.js').createLink>} link */
    add (link) {
      if (closed) { link.close(); return }
      links.set(link, 0)
      for (const wake of joined.splice(0)) wake()
    },

    /** Resolves true once a peer is connected, or false after `ms`. @param {number} [ms] @param {AbortSignal} [signal] */
    async hasPeer (ms = waitMs, signal) {
      if (pool.size > 0) return true
      return await new Promise((resolve) => {
        const timer = setTimeout(() => finish(false), ms)
        const wake = () => finish(pool.size > 0)
        function finish (/** @type {boolean} */ value) { clearTimeout(timer); const at = joined.indexOf(wake); if (at >= 0) joined.splice(at, 1); signal?.removeEventListener('abort', abort); resolve(value) }
        const abort = () => finish(false)
        joined.push(wake)
        signal?.addEventListener('abort', abort)
      })
    },

    /**
     * The block `cid`, verified.
     * @param {string} cid @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
     * @returns {Promise<Uint8Array>}
     */
    async block (cid, { signal, timeoutMs } = {}) {
      const parsed = parseCid(cid)
      const tried = new Set()
      await take()
      try {
        for (;;) {
          signal?.throwIfAborted()
          if (closed) throw new Error('The peers were let go.')
          const candidates = [...links].filter(([link]) => !tried.has(link) && link.open).sort((a, b) => a[1] - b[1])
          const chosen = candidates[0]
          if (chosen === undefined) throw new Error(links.size === 0 ? 'No peer is connected.' : 'No connected peer has this block.')
          const link = chosen[0]
          tried.add(link)
          links.set(link, (links.get(link) ?? 0) + 1)
          try {
            const bytes = await link.request(parsed.bytes, timeoutMs)
            if (bytes === null) continue
            if (!(await matches(bytes, parsed))) { link.close(); continue }
            stats.bytes += bytes.length
            stats.blocks += 1
            return bytes
          } catch (error) {
            if (signal?.aborted) throw error
          } finally {
            if (links.has(link)) links.set(link, Math.max((links.get(link) ?? 1) - 1, 0))
          }
        }
      } finally {
        give()
      }
    },

    /** Lets every peer go. */
    close () {
      closed = true
      for (const link of links.keys()) link.close()
      links.clear()
      for (const wake of joined.splice(0)) wake()
    },

    /** Forgets a peer that closed. @param {ReturnType<typeof import('./wire.js').createLink>} link */
    remove (link) {
      links.delete(link)
    }
  }
  return pool
}
