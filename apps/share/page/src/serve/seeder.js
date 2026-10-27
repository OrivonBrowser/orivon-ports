// What a share answers a peer: the blocks of that share, by CID, from the kept bytes, and nothing else. A peer is
// taken only while the share has fewer than `perShare` and Share as a whole fewer than `total`.

/** @typedef {ReturnType<typeof import('./wire.js').createLink>} Link */

export const PEERS_PER_SHARE = 8
export const PEERS_TOTAL = 24
export const REQUESTS_PER_PEER = 32

/**
 * @param {{ keep: ReturnType<typeof import('../keep/store.js').createKeep>, root: string, total: { links: number }, onChange: () => void }} options
 */
export function createSeeder ({ keep, root, total, onChange }) {
  /** @type {Set<Link>} */
  const links = new Set()
  const stats = { uploaded: 0 }
  return {
    stats,
    get peers () { return links.size },
    canAccept: () => links.size < PEERS_PER_SHARE && total.links < PEERS_TOTAL,

    /** The handlers every link of this share gets: it answers a request from the share's own index only. */
    linkHandlers: /** @type {import('./wire.js').LinkHandlers} */ ({
      maxInFlight: REQUESTS_PER_PEER,
      onRequest: async (cid) => {
        const bytes = await keep.block(root, cid)
        if (bytes !== null) { stats.uploaded += bytes.length; onChange() }
        return bytes
      }
    }),

    /** @param {Link} link */
    attach (link) {
      if (links.size >= PEERS_PER_SHARE || total.links >= PEERS_TOTAL) { link.close(); return }
      links.add(link)
      total.links += 1
      onChange()
      const watch = setInterval(() => {
        if (link.open) return
        clearInterval(watch)
        if (links.delete(link)) { total.links -= 1; onChange() }
      }, 1000)
    },

    closeAll () {
      for (const link of links) link.close()
    }
  }
}
