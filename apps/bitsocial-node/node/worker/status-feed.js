// What the page is told about the node: its peer, whether other peers can reach it (the node says, and `reachability.js`
// reads its word or, for a node that gives none, decides), its addresses, how many peers it is connected to and its hole punch counts. Read from the node's
// `/status`, from `/orivon/publishing` and from `/orivon/swarm/peers` when the node has them.

import { readPunch, readReach, reachabilityOf, relayPeer } from './reachability.js'

/**
 * @typedef {object} NodeStatus
 * @property {string | null} peer
 * @property {import('./reachability.js').Reachability} reachability `public` when peers on the internet can get to the node
 * @property {import('./reachability.js').Basis} basis what the answer rests on
 * @property {'node' | 'worker'} source who decided it: the node (its `reach`), or this Worker's own reading for a node that sends none
 * @property {import('./reachability.js').Reachability} autonat the node's AutoNAT verdict, as it said it
 * @property {string[]} listen
 * @property {string[]} external addresses peers see the node at
 * @property {number} relays places relays hold for the node now
 * @property {string[]} circuits those places as the node announces them, `<relay address>/p2p/<relay id>/p2p-circuit/p2p/<this node>`
 * @property {{ pending: number, ok: number, retries: number, superseded: number, gaveUp: number } | null} puts the name records the node is putting to the network in the background, null for a node that does not say
 * @property {import('./reachability.js').PunchCounts | null} punch null for a node that does not punch
 * @property {number | null} peers connected peers, null when the node cannot say
 */

/** @param {unknown} value @returns {string[]} */
const strings = (value) => (Array.isArray(value) ? value.filter((one) => typeof one === 'string') : [])

/**
 * @param {Record<string, unknown>} status the node's `/status`
 * @param {number | null} peers
 * @param {{ punch?: unknown, puts?: unknown } | null} [publishing] the node's `/orivon/publishing`
 * @param {string | null} [namedRelay] the peer id of the relay the person named
 * @returns {NodeStatus}
 */
export function summarise (status, peers, publishing = null, namedRelay = null) {
  const external = strings(status.external)
  const relays = strings(status.relays)
  const said = typeof status.reachability === 'string' ? status.reachability.toLowerCase() : ''
  /** @type {NodeStatus['autonat']} */
  const autonat = said === 'public' || said === 'private' ? said : 'unknown'
  const punch = readPunch(publishing?.punch)
  const reach = readReach(status.reach)
  const { reachability, basis } = reach ?? reachabilityOf({ autonat, external, relays, punch, namedRelay })
  return { peer: typeof status.peer === 'string' ? status.peer : null, reachability, basis, source: reach === null ? 'worker' : 'node', autonat, listen: strings(status.listen), external, relays: relays.length, circuits: relays, puts: readPuts(publishing?.puts), punch, peers }
}

/** @param {unknown} value @returns {NodeStatus['puts']} */
function readPuts (value) {
  const given = /** @type {Record<string, unknown> | null | undefined} */ (value)
  if (given === null || given === undefined || typeof given !== 'object') return null
  const count = (/** @type {unknown} */ one) => (typeof one === 'number' && Number.isFinite(one) && one >= 0 ? Math.floor(one) : 0)
  return { pending: count(given.pending), ok: count(given.ok), retries: count(given.retries), superseded: count(given.superseded), gaveUp: count(given.gaveUp) }
}

/**
 * The three reads go out together: a node under load answers each slowly, and a page asking for the verdict waits for the slowest.
 * @param {{ fetch: typeof fetch, base: string, key: string, relay?: string, peers?: boolean }} node `relay` is the address the person named,
 *   `peers: false` leaves the peer count out for a caller that wants the verdict alone
 * @returns {Promise<NodeStatus | null>} null when the node does not answer
 */
export async function readStatus ({ fetch: ask, base, key, relay, peers: wantPeers = true }) {
  const headers = { 'x-orivon-key': key }
  /** @param {string} path @returns {Promise<any>} null when the node has no such route */
  const read = async (path) => {
    try {
      const answer = await ask(`${base}${path}`, { headers, signal: AbortSignal.timeout(5_000) })
      return answer.ok ? await answer.json() : null
    } catch { return null }
  }
  const [status, swarm, publishing] = await Promise.all([read('/status'), wantPeers ? read('/orivon/swarm/peers') : null, read('/orivon/publishing')])
  if (status === null || typeof status !== 'object') return null
  return summarise(status, swarm === null ? null : (swarm.peers ?? []).length, publishing, relayPeer(relay))
}

/**
 * Reads the status now and every `intervalMs`, handing each one to `onStatus` when it differs from the last.
 * @param {{ read: () => Promise<NodeStatus | null>, onStatus: (status: NodeStatus | null) => void, intervalMs?: number }} options
 */
export function startStatusFeed ({ read, onStatus, intervalMs = 15_000 }) {
  let last = ''
  let stopped = false
  async function poll () {
    const status = await read()
    const text = JSON.stringify(status)
    if (!stopped && text !== last) { last = text; onStatus(status) }
  }
  const timer = setInterval(() => { poll().catch(() => {}) }, intervalMs)
  poll().catch(() => {})
  return {
    /** Reads now and reports even an unchanged status. */
    async now () { const status = await read(); last = JSON.stringify(status); onStatus(status) },
    stop () { stopped = true; clearInterval(timer) }
  }
}
