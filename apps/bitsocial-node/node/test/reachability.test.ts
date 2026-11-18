// What the node answers to "can peers on the internet get to you": AutoNAT's word counts only when it says public, and a
// node that punches answers by its hole punch state, which is what a visitor meets.
import { describe, expect, it } from 'vitest'
import { reachabilityOf, readPunch, relayPeer, type PunchCounts } from '../worker/reachability.js'

const punch = (state: string, extra: Partial<PunchCounts> = {}): PunchCounts => ({ state, relaysKnown: 12, relaysHeld: 2, punched: 0, failed: 0, ...extra })
const node = (given: Partial<Parameters<typeof reachabilityOf>[0]> = {}) => ({ autonat: 'unknown' as const, external: [], relays: [], punch: null, ...given })

describe('reachabilityOf, a node that punches', () => {
  it.each([
    ['a relay holds a place and the relays agree on the address', punch('ready'), 'public', 'punch-ready'],
    ['a punch opened a direct connection', punch('ready', { punched: 3, failed: 1 }), 'public', 'punched'],
    ['every punch failed and none opened', punch('ready', { failed: 2 }), 'unknown', 'punch-failed'],
    ['it is still finding relays', punch('checking', { relaysHeld: 0 }), 'unknown', 'looking'],
    ['each relay saw it at another port', punch('symmetric-nat'), 'private', 'symmetric-nat'],
    ['no relay holds a place and none is left to ask', punch('no-public-relay', { relaysHeld: 0 }), 'private', 'no-public-relay'],
    ['a state this build does not know', punch('something-new'), 'unknown', 'looking']
  ])('answers for the state where %s', (_what, state, reachability, basis) => {
    expect(reachabilityOf(node({ punch: state }))).toEqual({ reachability, basis })
  })

  it('ignores an AutoNAT verdict of private: it dials an address the node does not listen on', () => {
    expect(reachabilityOf(node({ autonat: 'private', punch: punch('ready') }))).toEqual({ reachability: 'public', basis: 'punch-ready' })
    expect(reachabilityOf(node({ autonat: 'private', punch: punch('checking') })).reachability).toBe('unknown')
  })

  it('believes AutoNAT when it says public, and an address it confirmed, whatever the punch state says', () => {
    expect(reachabilityOf(node({ autonat: 'public', punch: punch('symmetric-nat') }))).toEqual({ reachability: 'public', basis: 'autonat' })
    expect(reachabilityOf(node({ external: ['/ip4/203.0.113.7/tcp/4851'], punch: punch('no-public-relay') })).reachability).toBe('public')
    expect(reachabilityOf(node({ external: ['/ip4/192.168.1.5/tcp/4851'], punch: punch('checking') })).reachability).toBe('unknown')
  })
})

describe('reachabilityOf, a relay the person named', () => {
  const circuit = '/ip4/198.51.100.4/tcp/4001/p2p/12D3KooWRelayRelayRelay/p2p-circuit/p2p/12D3KooWnode'

  it('is the way in once it holds a place, even where the router gives each destination its own port', () => {
    expect(reachabilityOf(node({ relays: [circuit], punch: punch('symmetric-nat'), namedRelay: '12D3KooWRelayRelayRelay' }))).toEqual({ reachability: 'public', basis: 'named-relay' })
    expect(reachabilityOf(node({ relays: [circuit], punch: null, namedRelay: '12D3KooWRelayRelayRelay' })).reachability).toBe('public')
  })

  it('counts for nothing while the relay holds no place, or when the place is on another relay', () => {
    expect(reachabilityOf(node({ relays: [], punch: punch('no-public-relay'), namedRelay: '12D3KooWRelayRelayRelay' })).reachability).toBe('private')
    expect(reachabilityOf(node({ relays: [circuit], punch: punch('symmetric-nat'), namedRelay: '12D3KooWSomeoneElse' })).reachability).toBe('private')
  })
})

describe('reachabilityOf, a node that does not punch', () => {
  it('takes AutoNAT at its word', () => {
    expect(reachabilityOf(node({ autonat: 'private' }))).toEqual({ reachability: 'private', basis: 'not-reachable' })
    expect(reachabilityOf(node())).toEqual({ reachability: 'unknown', basis: 'not-measured' })
  })
})

describe('readPunch', () => {
  it('reads the counts the node gives, and null for a node with none', () => {
    expect(readPunch({ state: 'ready', relaysKnown: 5, relaysHeld: 2, punched: 1, failed: 0 })).toEqual({ state: 'ready', relaysKnown: 5, relaysHeld: 2, punched: 1, failed: 0 })
    expect(readPunch(undefined)).toBeNull()
    expect(readPunch({ relaysHeld: 2 })).toBeNull()
    expect(readPunch({ state: 'ready', relaysHeld: -3, punched: 'many' })).toEqual({ state: 'ready', relaysKnown: 0, relaysHeld: 0, punched: 0, failed: 0 })
  })
})

describe('relayPeer', () => {
  it('is the peer id a relay address ends in', () => {
    expect(relayPeer('/ip4/198.51.100.4/tcp/4001/p2p/12D3KooWRelay')).toBe('12D3KooWRelay')
    expect(relayPeer('/dns4/relay.example/tcp/4001')).toBeNull()
    expect(relayPeer(undefined)).toBeNull()
  })
})
