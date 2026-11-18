// Whether peers on the internet can get to the node, as the page API's `swarm/addrs/autonat` and the status the page is
// shown answer it. A client reads three answers (`Public`, `Private`, `Unknown`) and warns the person only on `Private`.
//
// The node says it itself: `reach` in its `/status` is `{state, reason}`, and `readReach` takes it as it is. `reachabilityOf`
// is the fallback for a component that sends no `reach`; it cannot see that a relay limits its circuits, so it says `public`
// for one where the node says `private`. Its reading: a node that punches listens nowhere (`--punch-port` opens no
// listener), so AutoNAT, which dials a listen address, is believed only when it says `public`; what counts is the hole
// punch state (`/orivon/publishing`), whether a visitor was let in directly, and whether a relay holds a place. AutoRelay
// does not change a `Private` verdict in libp2p, so Kubo with reservations held goes on saying it.

/**
 * @typedef {'public' | 'private' | 'unknown'} Reachability
 * @typedef {string} Basis why: a reason of the node's (`REASONS`, a newer node may add more) or a word of the fallback reading
 *
 * @typedef {object} PunchCounts what `GET /orivon/publishing` gives under `punch`
 * @property {'checking' | 'ready' | 'symmetric-nat' | 'no-public-relay' | string} state
 * @property {number} relaysKnown relays in the pool
 * @property {number} relaysHeld relays holding a reservation
 * @property {number} punched direct connections a punch opened
 * @property {number} failed punches that ended without one
 */

/** What each reason the node gives says, in the words of its README section "What the node says about being reached". */
export const REASONS = Object.freeze({
  autonat: 'AutoNAT confirmed a direct address',
  punched: 'a hole punch opened a direct connection',
  'named-relay': 'the named relay holds a place and sends no limit',
  'open-relay': 'a relay the node found holds a place and sends no limit',
  'punch-ready': 'a punch can work and none has been tried',
  'punch-failed': 'the relays agree on the address and every punch so far failed',
  looking: 'a relay, a second sight of the node\'s address or a relay\'s limit is still awaited',
  'not-measured': 'nothing has been measured',
  'relay-limited': 'every relay limits its circuits and the node cannot punch',
  'symmetric-nat': 'the router gives each destination its own port, so no relay without a limit holds a place',
  'no-public-relay': 'no relay holds a place and none is left to ask',
  'not-reachable': 'AutoNAT dialed the node and failed, and nothing else gives a way in'
})

/** A sentence for a reason of the node's, or '' for one this Worker has not heard of. @param {string} reason */
export function reasonText (reason) {
  return Object.hasOwn(REASONS, reason) ? REASONS[/** @type {keyof typeof REASONS} */ (reason)] : ''
}

const PRIVATE_V4 = /^\/ip4\/(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.)/

/** @param {unknown} value @returns {number} */
const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)

/** @param {unknown} value @returns {PunchCounts | null} null for a node that does not punch */
export function readPunch (value) {
  const given = /** @type {Record<string, unknown> | null | undefined} */ (value)
  if (given === null || given === undefined || typeof given !== 'object' || typeof given.state !== 'string') return null
  return { state: given.state, relaysKnown: count(given.relaysKnown), relaysHeld: count(given.relaysHeld), punched: count(given.punched), failed: count(given.failed) }
}

/**
 * The node's own answer, from `reach` in its `/status`: null for a node that sends none (an older component) or sends
 * something that is not a state and a reason, which leaves the Worker's own reading (`reachabilityOf`) to answer.
 * @param {unknown} value
 * @returns {{ reachability: Reachability, basis: Basis } | null}
 */
export function readReach (value) {
  const given = /** @type {Record<string, unknown> | null | undefined} */ (value)
  if (given === null || given === undefined || typeof given !== 'object' || typeof given.state !== 'string' || typeof given.reason !== 'string' || given.reason === '') return null
  const state = given.state.toLowerCase()
  if (state !== 'public' && state !== 'private' && state !== 'unknown') return null
  return { reachability: state, basis: given.reason }
}

/** The peer id a relay address ends in (`<address>/p2p/<id>`), the part a circuit address of that relay carries. @param {string | undefined} address */
export function relayPeer (address) {
  return address?.match(/\/p2p\/([A-Za-z0-9]+)\/?$/)?.[1] ?? null
}

/**
 * The answer, and what it rests on.
 * @param {{ autonat: Reachability, external: readonly string[], relays: readonly string[], punch: PunchCounts | null, namedRelay?: string | null }} node
 *   `autonat` is the node's own AutoNAT verdict, `external` the addresses it confirmed, `relays` the circuit addresses
 *   relays hold for it, `namedRelay` the peer id of the relay the person named
 * @returns {{ reachability: Reachability, basis: Basis }}
 */
export function reachabilityOf ({ autonat, external, relays, punch, namedRelay = null }) {
  // A node that says private has dropped the addresses it had confirmed, so an address only settles a node AutoNAT has no word on.
  if (autonat === 'public' || (autonat === 'unknown' && external.some((address) => !PRIVATE_V4.test(address)))) return { reachability: 'public', basis: 'autonat' }
  // A visitor that was let in directly is the proof, whatever else holds.
  if (punch !== null && punch.state === 'ready' && punch.punched > 0) return { reachability: 'public', basis: 'punched' }
  // The person's own relay is their way in: a place held on it is what they asked for. Whether it sends the visitor no
  // limit (Bitswap does not run over a limited connection) is the person's relay's to settle, not measured here.
  if (namedRelay !== null && relays.some((address) => address.includes(`/p2p/${namedRelay}/p2p-circuit`))) return { reachability: 'public', basis: 'named-relay' }
  if (punch === null) {
    return autonat === 'private' ? { reachability: 'private', basis: 'not-reachable' } : { reachability: 'unknown', basis: 'not-measured' }
  }
  switch (punch.state) {
    // A relay holds a place and the relays agree on the address a visitor dials: a visitor that punches gets in. Punches
    // that all failed prove nothing about this side (the visitor may be the one behind a symmetric router), so they leave the
    // answer open rather than a warning.
    case 'ready': return punch.failed === 0 ? { reachability: 'public', basis: 'punch-ready' } : { reachability: 'unknown', basis: 'punch-failed' }
    // Each relay saw the node at another port: the router gives every destination its own, so no address can be offered.
    case 'symmetric-nat': return { reachability: 'private', basis: 'symmetric-nat' }
    // A minute after the start no relay holds a place and none is left to ask.
    case 'no-public-relay': return { reachability: 'private', basis: 'no-public-relay' }
    default: return { reachability: 'unknown', basis: 'looking' }
  }
}
