// Go/no-go on the real network, the reader's side: a real kubo with its defaults (public bootstrap, DHT, pubsub on) and
// pkc-js as a plain client over it, run on a public machine. Given a community's address and challenge answer, it records
// whether the reader finds and reads the community through the DHT, the HTTP routers and pubsub alone, how long that takes,
// and whether a post arrives. Nothing is tuned and the reader is never told the host's address.
//
//   node network-reader.js --kubo <ipfs> --repo <dir> --address <community> --answer <text> [--routing bitsocial|kubo] [--host-peer <peer id>] [--cid <cid>] [--kubo-log <GOLOG level>] [--out <file>]
//
// With `--host-peer` the reader's kubo is asked twice a second which connections it holds to that peer (`swarm peers` with
// directions and streams) and the result lists each change: the address of the connection (a `/p2p-circuit` address is a
// relayed one, anything else a direct one), its direction, the protocols of its open streams, and the moment of each, next
// to the moments of the reader's own steps (`events`). Every two seconds it also asks which peers kubo lists for the
// community's pubsub topic and keeps when the host appears among them (`topicTimeline`). `--cid <cid>` (repeatable) asks
// the DHT for the providers of a CID the host announces and lists the addresses their records carry (kubo's own routing
// only: `--routing kubo`).
//
// `--routing bitsocial` (default) configures kubo as pkc-js does for a Bitsocial client: the four HTTP routers the desktop
// clients use, no DHT. `--routing kubo` leaves kubo's own routing (the DHT and its default delegated routers) and gives pkc-js
// no router.

import { writeFileSync } from 'node:fs'
import { startKubo } from './kubo.js'
import { readAndPost, sleep } from './scenario.js'

const args = (/** @type {string} */ name) => process.argv.flatMap((one, index) => (one === name ? [process.argv[index + 1] ?? ''] : []))

const arg = (/** @type {string} */ name, /** @type {string | undefined} */ fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback)
const need = (/** @type {string} */ name) => { const value = arg(name, undefined); if (value === undefined) throw new Error(`${name} is required`); return value }
const started = Date.now()
const events = /** @type {Array<{ atMs: number, line: string }>} */ ([])
const log = (/** @type {string} */ line) => { events.push({ atMs: Date.now() - started, line: line.slice(0, 200) }); console.error(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`) }
const result = /** @type {Record<string, any>} */ ({ when: new Date().toISOString(), ok: false })
/**
 * Polls the reader's kubo for its connections to `peer` and keeps each change. A connection whose address has
 * `/p2p-circuit` is relayed; any other is direct.
 * With `topic`, it also keeps each change of whether kubo lists `peer` among the peers of that pubsub topic.
 * @param {string} api @param {string} peer @param {string} [topic]
 */
function watchHost (api, peer, topic) {
  const timeline = /** @type {Array<Record<string, any>>} */ ([])
  const topicTimeline = /** @type {Array<Record<string, any>>} */ ([])
  const topicArg = topic === undefined ? undefined : `u${Buffer.from(topic).toString('base64url')}`
  let last = ''
  let lastListed = null
  let tick = 0
  let stopped = false
  const protocols = { direct: new Set(), relayed: new Set() }
  const marks = /** @type {Record<string, number | null>} */ ({ firstSeenMs: null, firstRelayedMs: null, firstDirectMs: null, relayedGoneAfterDirectMs: null })
  const done = (async () => {
    while (!stopped) {
      try {
        const answer = await fetch(`${api}/swarm/peers?direction=true&streams=true`, { method: 'POST', signal: AbortSignal.timeout(5000) })
        const peers = /** @type {{ Peers?: Array<{ Peer: string, Addr: string, Direction?: number, Streams?: Array<{ Protocol: string }> }> }} */ (await answer.json()).Peers ?? []
        const mine = peers.filter((one) => one.Peer === peer).map((one) => {
          const kind = one.Addr.includes('/p2p-circuit') ? 'relayed' : 'direct'
          const streams = [...new Set((one.Streams ?? []).map((stream) => stream.Protocol))].sort()
          for (const protocol of streams) protocols[kind].add(protocol)
          return { kind, addr: one.Addr, direction: one.Direction === 1 ? 'inbound' : one.Direction === 2 ? 'outbound' : 'unknown', streams }
        })
        const signature = JSON.stringify(mine)
        const atMs = Date.now() - started
        if (signature !== last) {
          last = signature
          if (timeline.length < 400) timeline.push({ atMs, connections: mine })
          if (mine.length > 0 && marks['firstSeenMs'] === null) marks['firstSeenMs'] = atMs
          if (mine.some((one) => one.kind === 'relayed') && marks['firstRelayedMs'] === null) marks['firstRelayedMs'] = atMs
          if (mine.some((one) => one.kind === 'direct') && marks['firstDirectMs'] === null) marks['firstDirectMs'] = atMs
          if (marks['firstDirectMs'] !== null && marks['relayedGoneAfterDirectMs'] === null && mine.length > 0 && mine.every((one) => one.kind === 'direct')) marks['relayedGoneAfterDirectMs'] = atMs
        }
      } catch { /* kubo is not up yet, or is going down */ }
      if (topicArg !== undefined && tick++ % 4 === 0) {
        try {
          const answer = await fetch(`${api}/pubsub/peers?arg=${topicArg}`, { method: 'POST', signal: AbortSignal.timeout(5000) })
          const listed = /** @type {{ Strings?: string[] }} */ (await answer.json()).Strings ?? []
          const hostListed = listed.includes(peer)
          if (hostListed !== lastListed && topicTimeline.length < 100) { lastListed = hostListed; topicTimeline.push({ atMs: Date.now() - started, hostListed, topicPeers: listed.length }) }
        } catch { /* kubo is not up yet, or is going down */ }
      }
      await sleep(500)
    }
  })()
  return {
    async stop () { stopped = true; await done; return { ...marks, streamsSeen: { direct: [...protocols.direct].sort(), relayed: [...protocols.relayed].sort() }, timeline, topicTimeline } }
  }
}

/**
 * The providers kubo's DHT finds for `cid`, with the addresses their records carry.
 * @param {string} api @param {string} cid
 */
async function findProviders (api, cid) {
  const began = Date.now()
  const answer = await fetch(`${api}/routing/findprovs?arg=${cid}&num-providers=10&timeout=45s`, { method: 'POST', signal: AbortSignal.timeout(60_000) })
  const providers = /** @type {Array<{ id: string, addrs: string[] }>} */ ([])
  for (const line of (await answer.text()).split('\n')) {
    if (line.trim() === '') continue
    try {
      const event = JSON.parse(line)
      if (event.Type === 4) for (const one of event.Responses ?? []) providers.push({ id: one.ID, addrs: one.Addrs ?? [] })
    } catch { /* a line that is not an event */ }
  }
  return { cid, ms: Date.now() - began, providers, circuit: providers.some((one) => one.addrs.some((address) => address.includes('/p2p-circuit'))) }
}
const address = need('--address')
const answer = need('--answer')
const hostPeer = arg('--host-peer', undefined)
const routing = arg('--routing', 'bitsocial')
const ROUTERS = ['https://routing.lol', 'https://peers.pleb.bot', 'https://peers.plebpubsub.xyz', 'https://peers.forumindex.com']
const httpRouters = routing === 'bitsocial' ? ROUTERS : undefined
// Kubo 0.43 ships its bootstrap list as the placeholder `auto`, which it expands only under its own routing: with the
// Bitsocial routers' custom routing the node has no bootstrap peer and never meets another (`failed to bootstrap`).
// A client that runs this kubo is given the long-standing default list, as older kubos carry it.
const BOOTSTRAP = ['/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN', '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa', '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb', '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt', '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ']
/** @type {Awaited<ReturnType<typeof startKubo>> | null} */
let kubo = null
/** @type {ReturnType<typeof watchHost> | null} */
let watcher = null
const lookups = /** @type {Array<Promise<unknown>>} */ ([])
try {
  kubo = await startKubo({ bin: need('--kubo'), repo: need('--repo'), mode: 'network', swarmPort: Number(arg('--swarm-port', '14001')), apiPort: Number(arg('--api-port', '15001')), ...(httpRouters === undefined ? {} : { httpRouters }), ...(arg('--kubo-log', undefined) === undefined ? {} : { logLevel: arg('--kubo-log', ''), logFile: `${arg('--out', 'reader')}.kubo.log` }), log })
  result.routing = routing
  result.kuboVersion = await kubo.version()
  if (hostPeer !== undefined) watcher = watchHost(kubo.api, hostPeer, address)
  if (routing === 'kubo') for (const cid of args('--cid').flatMap((one) => one.split(',')).filter(Boolean)) lookups.push(findProviders(kubo.api, cid).then((found) => { (result.dhtProviders ??= []).push(found) }, (error) => { (result.dhtProviders ??= []).push({ cid, error: String(error) }) }))
  if (routing === 'bitsocial') {
    await kubo.ipfs('bootstrap', 'rm', '--all').catch(() => {})
    for (const address of BOOTSTRAP) await kubo.ipfs('bootstrap', 'add', address).catch(() => {})
    await Promise.allSettled(BOOTSTRAP.map((address) => kubo?.ipfs('swarm', 'connect', address)))
  }
  // Let kubo's DHT warm up, as a node that has been running does.
  await sleep(Number(arg('--warm-ms', '30000')))
  result.warmPeers = (await kubo.ipfs('swarm', 'peers')).split('\n').filter(Boolean).length
  const reader = await readAndPost({ api: kubo.api, address, answer, log, resolveMs: Number(arg('--resolve-ms', '300000')), ...(httpRouters === undefined ? {} : { httpRouters }), postMs: Number(arg('--post-ms', '180000')), visibleMs: Number(arg('--visible-ms', '240000')) })
  Object.assign(result, reader)
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
  log(`FAILED: ${result.error}`)
} finally {
  if (kubo !== null) {
    const peers = (await kubo.ipfs('swarm', 'peers').catch(() => '')).split('\n').filter(Boolean)
    result.endPeers = peers.length
    result.connectedToHost = hostPeer === undefined ? null : peers.some((line) => line.includes(hostPeer))
    await Promise.allSettled(lookups)
    if (watcher !== null) result.hostConnection = await watcher.stop()
    await kubo.stop().catch(() => {})
  }
  result.events = events
  result.totalMs = Date.now() - started
  const text = `${JSON.stringify(result, null, 2)}\n`
  const out = arg('--out', undefined)
  if (out !== undefined) writeFileSync(out, text)
  process.stdout.write(text)
  process.exit(result.ok ? 0 : 1)
}
