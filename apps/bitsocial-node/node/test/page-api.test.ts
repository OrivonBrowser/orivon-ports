// The calls a page may make over the gateway's socket: the key at the door, the list of calls and nothing off it, what
// each answer says (kubo's JSON, from the real facade over the mock node), and that the socket never serves the RPC.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gatewayOnly } from '../worker/gateway-only.js'
import { PAGE_API_PATH, PAGE_CALLS, pageApi } from '../worker/page-api.js'
import { createEnv } from './support/env.ts'
import { NODE_PEER } from './support/mock-node.ts'

const KEY = 'page-api-test-key-0123456789abcdef'
const ORIGIN = 'http://127.0.0.1:6473'
const KUBO = 'http://127.0.0.1:50019'

let env: Awaited<ReturnType<typeof createEnv>>
let verdict: 'public' | 'private' | 'unknown'
let bandwidth: (() => Promise<{ TotalIn: number | null, TotalOut: number | null, RateIn: number | null, RateOut: number | null } | null>) | undefined
beforeEach(async () => { env = await createEnv(); verdict = 'private'; bandwidth = undefined })
afterEach(async () => { await env.cleanup() })

function api () {
  return pageApi({ facade: env.facade, authKey: KEY, kuboUrl: KUBO, reachability: async () => verdict, ...(bandwidth === undefined ? {} : { bandwidth }) })
}

const ask = (call: string, init: { method?: string, key?: string | null, query?: string } = {}) => api().handle(new Request(`${ORIGIN}${PAGE_API_PATH}${call}${init.query ?? ''}`, {
  method: init.method ?? 'POST',
  headers: init.key === null ? {} : { Authorization: `Bearer ${init.key ?? KEY}` }
}))

describe('the door', () => {
  it('refuses a request with no key, a wrong key and a key of another length, before it reads the call', async () => {
    for (const key of [null, 'wrong-key', `${KEY}x`, KEY.slice(1)]) {
      const response = await ask('id', { key })
      expect(response.status, String(key)).toBe(401)
    }
    expect(env.node.calls).toEqual([])
  })

  it('refuses a request that is not a POST, as kubo does', async () => {
    expect((await ask('id', { method: 'GET' })).status).toBe(405)
    expect((await ask('id', { method: 'DELETE' })).status).toBe(405)
  })
})

describe('the list', () => {
  it('is the six calls that change nothing', () => {
    expect([...PAGE_CALLS].sort()).toEqual(['id', 'repo/stat', 'stats/bw', 'swarm/addrs/autonat', 'swarm/peers', 'version'])
  })

  it.each(['key/gen', 'key/import', 'files/rm', 'files/write', 'pin/rm', 'block/rm', 'repo/gc', 'config', 'shutdown', 'add', 'pubsub/pub', 'name/publish', 'cat', 'swarm/connect', '', 'id/../key/gen', 'identity'])('refuses %j with 403, and the node hears nothing of it', async (call) => {
    const response = await ask(call)
    expect(response.status).toBe(403)
    expect((await response.json() as { Type: string }).Type).toBe('error')
    expect(env.node.calls).toEqual([])
  })
})

describe('the answers', () => {
  it('id: the peer, in kubo\'s fields', async () => {
    const answer = await (await ask('id')).json() as { ID: string, Addresses: string[] }
    expect(answer.ID).toBe(NODE_PEER)
    expect(answer.Addresses).toEqual(expect.arrayContaining([`/ip4/203.0.113.7/tcp/4001/p2p/${NODE_PEER}`]))
  })

  it('swarm/peers: one entry per connected peer, whatever options the page sends', async () => {
    env.node.peers.push('12D3KooWPeerOne', '12D3KooWPeerTwo')
    const answer = await (await ask('swarm/peers', { query: '?direction=true&latency=true&streams=true' })).json() as { Peers: Array<{ Peer: string }> }
    expect(answer.Peers.map((peer) => peer.Peer)).toEqual(['12D3KooWPeerOne', '12D3KooWPeerTwo'])
  })

  it('repo/stat: the repository\'s size and its limit', async () => {
    await env.call('add', { body: 'hello world\n' })
    const answer = await (await ask('repo/stat')).json() as { RepoSize: number, StorageMax: number, NumObjects: number }
    expect(answer.RepoSize).toBeGreaterThan(0)
    expect(answer.StorageMax).toBe(10_000_000_000)
    expect(answer.NumObjects).toBeGreaterThan(0)
  })

  it.each([['public', 'Public'], ['private', 'Private'], ['unknown', 'Unknown']] as const)('swarm/addrs/autonat: the node\'s verdict %s as %s', async (said, word) => {
    verdict = said
    expect(await (await ask('swarm/addrs/autonat')).json()).toEqual({ reachability: word })
  })

  it('stats/bw: no totals when the node gives none, so a page reads "unknown" and never a zero', async () => {
    expect(await (await ask('stats/bw')).json()).toEqual({ TotalIn: null, TotalOut: null, RateIn: null, RateOut: null })
    bandwidth = async () => null
    expect(await (await ask('stats/bw')).json()).toEqual({ TotalIn: null, TotalOut: null, RateIn: null, RateOut: null })
  })

  it('stats/bw: the node\'s totals and rates, in kubo\'s fields, as the node gave them', async () => {
    bandwidth = async () => ({ TotalIn: 4096, TotalOut: 0, RateIn: 12.5, RateOut: 0 })
    expect(await (await ask('stats/bw')).json()).toEqual({ TotalIn: 4096, TotalOut: 0, RateIn: 12.5, RateOut: 0 })
    expect(env.node.calls).toEqual([])
  })

  it('answers a call the facade fails on with kubo\'s error body and status', async () => {
    vi.spyOn(env.facade, 'handle').mockRejectedValueOnce(new Error('the node is down'))
    const response = await ask('version')
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ Message: 'the node is down', Type: 'error' })
  })
})

describe('the socket', () => {
  const socket = (withApi = true) => gatewayOnly(env.facade, withApi ? api() : undefined)

  it('hands the paths under /orivon/api/ to the page API and the rest to the facade, and still serves no RPC', async () => {
    expect((await socket().handle(new Request(`${ORIGIN}/orivon/api/version`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } }))).status).toBe(200)
    expect((await socket().handle(new Request(`${ORIGIN}/api/v0/version`, { method: 'POST' }))).status).toBe(404)
    expect((await socket().handle(new Request(`${ORIGIN}/ipfs/bafkreihmqln2iovmfzti2f6s7yjlr5l54stgzsadfxndh7diovlbzgucye`))).status).toBeGreaterThanOrEqual(400)
  })

  it('answers 404 for the page API path when no page API is given, and never lets it fall to the facade', async () => {
    const response = await socket(false).handle(new Request(`${ORIGIN}/orivon/api/id`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } }))
    expect(response.status).toBe(404)
    expect(env.node.calls).toEqual([])
  })
})
