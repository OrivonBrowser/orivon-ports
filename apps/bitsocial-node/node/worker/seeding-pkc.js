// How seeding follows a community: pkc-js's own server instance opens it by address (it reads the network, since this node does not
// host it), starts its update loop, and says when a new record has come. What the seeder reads of it is a plain copy of the fields
// of the record, never the live object.

/** @param {any} community @returns {import('./seeding-pins.js').SeededRecord | null} null while no record has come */
export function recordOf (community) {
  if (typeof community.updatedAt !== 'number') return null
  const pages = Object.fromEntries(Object.entries(community.posts?.pages ?? {}).map(([sort, page]) => [sort, { nextCid: /** @type {any} */ (page)?.nextCid }]))
  return { updatedAt: community.updatedAt, updateCid: community.updateCid, pubsubTopic: community.pubsubTopic, posts: { pageCids: { ...(community.posts?.pageCids ?? {}) }, pages }, postUpdates: { ...(community.postUpdates ?? {}) } }
}

/**
 * @param {{ pkc: () => any, warn?: (line: string) => void }} options `pkc` is the RPC server's pkc-js instance, or null while there is none
 * @returns {(address: string) => Promise<{ record: () => ReturnType<typeof recordOf>, onUpdate: (listener: () => void) => () => void, stop: () => Promise<void> }>}
 */
export function communityOpener ({ pkc, warn = () => {} }) {
  return async (address) => {
    const instance = pkc()
    if (instance === null || instance === undefined) throw new Error('the node is still starting')
    const community = await instance.createCommunity({ address })
    /** @type {Set<() => void>} */
    const listeners = new Set()
    let lastError = ''
    community.on('update', () => { for (const listener of listeners) { try { listener() } catch { /* one listener does not stop the next */ } } })
    community.on('error', (/** @type {unknown} */ error) => {
      const text = error instanceof Error ? error.message : String(error)
      if (text !== lastError) { lastError = text; warn(`seeding: ${address}: ${text.slice(0, 300)}`) }
    })
    await community.update()
    return {
      record: () => recordOf(community),
      onUpdate: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      stop: () => Promise.resolve(community.stop())
    }
  }
}
