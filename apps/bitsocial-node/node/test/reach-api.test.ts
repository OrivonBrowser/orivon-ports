// How the node says it is reached, as the page is told: what is read of the node, the circuits and whether the relay a person named
// holds a place, and the door that answers it and takes the person's relay.
import { describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../worker/board-config.js'
import { describeReach, REACH_API_PATH, reachApi } from '../worker/reach-api.js'
import { gatewayOnly } from '../worker/gateway-only.js'
import { UnsupportedError } from '../worker/relay-setting.js'
import { summarise } from '../worker/status-feed.js'

const KEY = 'reach-test-key-0123456789abcdef'
const ORIGIN = 'http://127.0.0.1:6473'
const RELAY = '/ip4/198.51.100.4/tcp/4001/p2p/12D3KooWRelayRelay'
const circuit = (relay: string) => `${relay}/p2p-circuit/p2p/12D3KooWnode`

const status = (over: Record<string, unknown> = {}, publishing: Record<string, unknown> | null = null) => summarise({ peer: '12D3KooWnode', reachability: 'unknown', ...over }, 7, publishing)

describe('describeReach', () => {
  it('says the relay the person named holds a place when one of the circuits given out is through it, and names the circuits', () => {
    const got = describeReach({
      status: status({ relays: [circuit(RELAY), circuit('/ip4/203.0.113.9/tcp/4001/p2p/12D3KooWOther')], reach: { state: 'public', reason: 'named-relay' } }, { puts: { pending: 1, ok: 4, retries: 0, superseded: 0, gaveUp: 0 } }),
      bandwidth: { TotalIn: 10, TotalOut: 20, RateIn: 1, RateOut: 2 }, relay: { relay: RELAY, source: 'saved' }, supported: true, node: 'up'
    })
    expect(got).toMatchObject({ reachability: 'public', reason: 'named-relay', source: 'node', peers: 7, node: 'up', answered: true, puts: { pending: 1, ok: 4 }, bandwidth: { totalIn: 10, totalOut: 20, rateIn: 1, rateOut: 2 } })
    expect(got.relay).toEqual({ address: RELAY, peer: '12D3KooWRelayRelay', source: 'saved', supported: true, holds: true })
    expect(got.circuits).toEqual([{ relay: RELAY, peer: '12D3KooWRelayRelay', named: true }, { relay: '/ip4/203.0.113.9/tcp/4001/p2p/12D3KooWOther', peer: '12D3KooWOther', named: false }])
  })

  it('says the named relay holds no place while only another relay\'s circuit is given out, or none', () => {
    const base = { bandwidth: null, relay: { relay: RELAY, source: 'saved' as const }, supported: true, node: 'up' }
    expect(describeReach({ ...base, status: status({ relays: [circuit('/ip4/203.0.113.9/tcp/4001/p2p/12D3KooWOther')] }) }).relay.holds).toBe(false)
    expect(describeReach({ ...base, status: status({ relays: [] }) }).relay.holds).toBe(false)
  })

  it('has no relay and no hold when none was named', () => {
    const got = describeReach({ status: status({ relays: [circuit(RELAY)] }), bandwidth: null, relay: { relay: undefined, source: 'none' }, supported: true, node: 'up' })
    expect(got.relay).toEqual({ address: null, peer: null, source: 'none', supported: true, holds: false })
    expect(got.circuits[0]).toMatchObject({ named: false })
  })

  it('reports a node that did not answer as unknown and unanswered, with the supervisor\'s word, and a node with no counts as no bandwidth', () => {
    const got = describeReach({ status: null, bandwidth: null, relay: { relay: undefined, source: 'none' }, supported: false, node: 'restarting' })
    expect(got).toMatchObject({ answered: false, reachability: 'unknown', reason: null, node: 'restarting', bandwidth: null, puts: null, circuits: [], relay: { supported: false } })
  })
})

function door (over: { network?: Record<string, unknown> | null } = {}) {
  const network = over.network === undefined
    ? { state: vi.fn(async () => ({ reachability: 'unknown' })), setRelay: vi.fn(async () => ({})), removeRelay: vi.fn(async () => ({})) }
    : over.network
  return { network, api: reachApi({ authKey: KEY, network: network as never }) }
}
const call = (api: ReturnType<typeof door>['api'], name: string, body: unknown = {}, key: string | null = KEY, method = 'POST') => api.handle(new Request(`${ORIGIN}${REACH_API_PATH}${name}`, { method, headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { Authorization: `Bearer ${key}` }) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }))

describe('the reach calls', () => {
  it('answer the state, and take a relay: set and remove each answer the state after the change', async () => {
    const { api, network } = door()
    expect(await (await call(api, 'state')).json()).toEqual({ reachability: 'unknown' })
    expect((await call(api, 'relay/set', { relay: RELAY })).status).toBe(200)
    expect(network!['setRelay']).toHaveBeenCalledWith(RELAY)
    expect((await call(api, 'relay/remove')).status).toBe(200)
    expect(network!['removeRelay']).toHaveBeenCalledTimes(1)
    expect(network!['state']).toHaveBeenCalledTimes(3)
  })

  it('refuse without the key (401), by a method but POST (405), a call off the list (403) and a build with no way to read the node (503)', async () => {
    const { api } = door()
    expect((await call(api, 'state', {}, null)).status).toBe(401)
    expect((await call(api, 'state', {}, 'wrong')).status).toBe(401)
    expect((await call(api, 'state', {}, KEY, 'GET')).status).toBe(405)
    expect((await call(api, 'relay/list')).status).toBe(403)
    expect((await call(door({ network: null }).api, 'state')).status).toBe(503)
  })

  it('answers 400 for a relay that cannot be one and 409 for a node component with no relay support, and does not answer a state then', async () => {
    const setRelay = vi.fn(async (relay: unknown) => { if (relay === 'bad') throw new ConfigError('relay must be /ip4|ip6|dns4|dns6/<host>/tcp/<port>/p2p/<relay peer id>'); throw new UnsupportedError('this node component has no --relay') })
    const { api, network } = door({ network: { state: vi.fn(async () => ({})), setRelay, removeRelay: vi.fn() } })
    const bad = await call(api, 'relay/set', { relay: 'bad' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { Message: string }).Message).toMatch(/relay must be/)
    expect((await call(api, 'relay/set', { relay: RELAY })).status).toBe(409)
    expect(network!['state']).not.toHaveBeenCalled()
  })

  it('is behind the gateway\'s door and not reachable without it', async () => {
    const { api } = door()
    const facade = { handle: async () => new Response('facade') }
    expect((await gatewayOnly(facade, undefined, undefined, undefined, undefined, undefined, api).handle(new Request(`${ORIGIN}${REACH_API_PATH}state`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } }))).status).toBe(200)
    expect((await gatewayOnly(facade).handle(new Request(`${ORIGIN}${REACH_API_PATH}state`, { method: 'POST' }))).status).toBe(404)
  })
})
