import { AsyncLocalStorage } from 'node:async_hooks'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { tcp } from '@libp2p/tcp'
import { createLibp2p } from 'libp2p'

/** What the service enforces unless a caller (a test) says otherwise. */
export const DEFAULTS = {
  // No limit in a reservation or a connect answer: a client that sees one marks the relayed
  // connection "limited", and other IPFS nodes then refuse to fetch blocks over it.
  reservations: { applyDefaultLimit: false, maxReservations: 512, reservationTtl: 60 * 60 * 1000 },
  // 512 reservations each hold one connection, and the rest are the nodes fetching from them.
  connectionManager: { maxConnections: 768, maxIncomingPendingConnections: 32, inboundConnectionThreshold: 10 },
  maxInboundHopStreams: 32,
  maxOutboundStopStreams: 64,
  // One address (an IPv6 /64) may hold this many of the 512 reservations. A household or an office
  // behind one address fits; one host cannot take the table.
  perHostReservations: 16
}

/** The address a connection came from, as a key: the IPv4 address, or the first 64 bits of an IPv6 one. */
export function hostOf (address) {
  const ip = address?.getComponents()[0]
  if (ip?.value == null) return undefined
  if (ip.name !== 'ip6' || ip.value.includes('.')) return ip.value
  const [head, tail] = ip.value.split('::')
  const before = head === '' ? [] : head.split(':')
  const after = tail == null || tail === '' ? [] : tail.split(':')
  const groups = tail == null ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after]
  return groups.slice(0, 4).map((group) => parseInt(group, 16)).join(':')
}

/**
 * How many other reservations were made from the same address as the one `peer` is making. The
 * server keeps the address of the connection each reservation was made on, for as long as the
 * reservation lasts; nothing about an address is stored here.
 */
function reservationsFromSameHost (node, peer) {
  const host = hostOf(node.getConnections(peer)[0]?.remoteAddr)
  if (host == null) return 0
  let count = 0
  for (const [other, reservation] of node.services.relay.reservations.entries()) {
    if (!other.equals(peer) && hostOf(reservation.addr) === host) count++
  }
  return count
}

/**
 * Counts what libp2p does not: circuits opened and bytes passed through them. It wraps the server's
 * connect handler on the instance, and a test fails when a libp2p update changes what it relies on.
 * A byte is counted once, where it is read from one end of a circuit, and nothing about who the
 * ends are is read.
 */
function countCircuits (server, counters) {
  const context = new AsyncLocalStorage()
  const stopHop = server.stopHop.bind(server)
  const handleConnect = server.handleConnect.bind(server)

  server.stopHop = async (options, abort) => {
    const destination = await stopHop(options, abort)
    const circuit = context.getStore()
    if (destination != null && circuit != null) circuit.destination = destination
    return destination
  }

  server.handleConnect = (options, abort) => context.run({}, async () => {
    const circuit = context.getStore()
    await handleConnect(options, abort)
    if (circuit.destination == null) return
    counters.circuits++
    for (const end of [options.stream.unwrap(), circuit.destination]) {
      end.addEventListener('message', (event) => { counters.bytes += event.data.byteLength })
    }
  })
}

/**
 * The relay: a libp2p node that serves circuit relay v2 and nothing else. It dials no one, stores
 * nothing, and reads no relayed byte (the ends encrypt with Noise between themselves).
 *
 * `listen` and `announce` are multiaddr strings; `announce` may be empty. `overrides` replaces
 * single entries of DEFAULTS.
 */
export async function createRelayNode ({ privateKey, listen, announce = [], overrides = {} }) {
  const options = { ...DEFAULTS, ...overrides }
  const counters = { circuits: 0, bytes: 0 }
  const libp2p = await createLibp2p({
    privateKey,
    nodeInfo: { name: 'orivon-share-relay', version: '1' },
    addresses: { listen, announce },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: options.connectionManager,
    connectionGater: {
      // The relay only answers connections that clients open. It never dials an address it is given.
      denyDialMultiaddr: () => true,
      denyInboundRelayReservation: (peer) => reservationsFromSameHost(libp2p, peer) >= options.perHostReservations
    },
    services: {
      identify: identify(),
      ping: ping(),
      relay: circuitRelayServer({
        reservations: options.reservations,
        maxInboundHopStreams: options.maxInboundHopStreams,
        maxOutboundStopStreams: options.maxOutboundStopStreams
      })
    }
  })
  countCircuits(libp2p.services.relay, counters)

  return {
    libp2p,
    peerId: libp2p.peerId,
    addresses: () => libp2p.getMultiaddrs().map(String),
    /** A snapshot: what is active now, and the totals since the start. */
    stats: () => ({
      reservations: libp2p.services.relay.reservations.size,
      connections: libp2p.getConnections().length,
      circuits: counters.circuits,
      bytes: counters.bytes
    }),
    stop: async () => { await libp2p.stop() }
  }
}
