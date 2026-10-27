import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { tcp } from '@libp2p/tcp'
import { multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'

// Dials a relay and prints what it says about itself: node probe.mjs /ip4/<ip>/tcp/4003/p2p/<peer id>
const target = process.argv[2]
if (target == null) {
  console.error('usage: node probe.mjs <multiaddr of the relay, with its /p2p/ peer ID>')
  process.exit(2)
}

const node = await createLibp2p({ transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()], services: { identify: identify() } })
try {
  const identified = new Promise((resolve, reject) => {
    node.addEventListener('peer:identify', (event) => { resolve(event.detail) })
    setTimeout(() => { reject(new Error('identify timed out')) }, 10_000).unref()
  })
  const connection = await node.dial(multiaddr(target), { signal: AbortSignal.timeout(10_000) })
  const info = await identified
  const protocols = [...info.protocols].sort()
  const hop = protocols.includes('/libp2p/circuit/relay/0.2.0/hop')
  console.log(JSON.stringify({ peer: connection.remotePeer.toString(), agent: info.agentVersion ?? null, relayV2Hop: hop, protocols }, null, 2))
  process.exitCode = hop ? 0 : 1
} catch (error) {
  console.error(`could not identify the relay: ${error?.name ?? 'Error'}`)
  process.exitCode = 1
} finally {
  await node.stop()
}
