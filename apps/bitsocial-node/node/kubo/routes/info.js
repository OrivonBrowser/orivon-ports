// The node's identity and peers, its version, and the configuration pkc-js reads and writes: the gateway's address
// to fetch IPNS records from, and the routing and provide settings it sets for the HTTP routers. Configuration is
// the facade's own (see facade.js); the routers are handed to the node at launch, and `shutdown` is accepted and does
// nothing, because the node is not restarted by a request.

import { viaNode } from '../errors.js'
import { emptyResponse, flag, jsonResponse, KuboError } from '../wire.js'

/** @typedef {ReturnType<typeof import('../node-client.js').createNodeClient>} NodeClient */

/** The node's own addresses: what it listens on and what peers see it at. @param {NodeClient} node */
async function addressesOf (node) {
  const [id, status] = await Promise.all([viaNode(() => node.id()), viaNode(() => node.status())])
  const peer = String(id.peer)
  const own = [...(id.listen ?? []), ...(id.external ?? []), ...(status?.listen ?? []), ...(status?.external ?? [])]
  const bare = [...new Set(own.map((address) => String(address).replace(new RegExp(`/p2p/${peer}$`), '')))]
  return { peer, bare }
}

/** @param {{ node: NodeClient, config: { get: (key: string) => unknown, set: (key: string, value: unknown) => Promise<void> } }} deps */
export function infoRoutes ({ node, config }) {
  return {
    async id () {
      const { peer, bare } = await addressesOf(node)
      return jsonResponse({
        ID: peer, PublicKey: '', Addresses: bare.map((address) => `${address}/p2p/${peer}`),
        AgentVersion: 'orivon-ipfs-node', ProtocolVersion: 'ipfs/0.1.0', Protocols: []
      })
    },

    async 'swarm/addrs' () {
      const { peer, bare } = await addressesOf(node)
      return jsonResponse({ Addrs: { [peer]: bare } })
    },

    /** The peers the node is connected to, each with the address of one connection. */
    async 'swarm/peers' () {
      const peers = await viaNode(() => node.swarmPeers())
      return jsonResponse({ Peers: peers.map(({ peer, addr }) => ({ Addr: addr, Peer: peer, Latency: '', Muxer: '', Streams: null })) })
    },

    version () {
      return jsonResponse({ Version: '0.0.0-orivon', Commit: '', Repo: '16', System: '', Golang: '' })
    },

    /** Without a value it reads a key, with one it sets it: JSON with `json=true`, a boolean with `bool=true`, else text. @param {import('../facade.js').Context} ctx */
    async config (ctx) {
      const [key, value] = ctx.args
      if (key === undefined || key === '') throw new KuboError('argument "key" is required')
      if (value === undefined) {
        const found = config.get(key)
        if (found === undefined) throw new KuboError(`key has no attribute: ${key}`)
        return jsonResponse({ Key: key, Value: found })
      }
      /** @type {unknown} */
      let parsed = value
      if (flag(ctx.params, 'json')) {
        try { parsed = JSON.parse(value) } catch { throw new KuboError(`failed to unmarshal json: ${value}`) }
      } else if (flag(ctx.params, 'bool')) {
        parsed = value === 'true'
      }
      await config.set(key, parsed)
      return jsonResponse({ Key: key, Value: parsed })
    },

    shutdown () {
      return emptyResponse()
    }
  }
}
