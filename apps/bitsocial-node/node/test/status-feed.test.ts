// What the page is told about the node: reachability from the node's own word, its addresses and its hole punch state, and the feed that reports a change once.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readStatus, startStatusFeed, summarise } from '../worker/status-feed.js'

afterEach(() => { vi.useRealTimers() })

describe('summarise', () => {
  it('takes the node\'s own word for reachability', () => {
    expect(summarise({ peer: 'p', reachability: 'Public', external: [] }, 3)).toMatchObject({ peer: 'p', reachability: 'public', peers: 3 })
    expect(summarise({ reachability: 'private', external: ['/ip4/8.8.8.8/tcp/4001'] }, null)).toMatchObject({ reachability: 'private', peers: null })
  })

  it('says public for an unknown reachability when a public address is seen, and unknown otherwise', () => {
    expect(summarise({ reachability: 'unknown', external: ['/ip4/203.0.113.7/tcp/4851'] }, null).reachability).toBe('public')
    expect(summarise({ reachability: 'unknown', external: ['/ip4/192.168.1.5/tcp/4851', '/ip4/10.0.0.2/tcp/4851'] }, null).reachability).toBe('unknown')
    expect(summarise({}, null)).toEqual({ peer: null, reachability: 'unknown', basis: 'not-measured', source: 'worker', autonat: 'unknown', listen: [], external: [], relays: 0, circuits: [], puts: null, punch: null, peers: null })
  })

  it('keeps the circuits the node gives out and the puts it has in flight, and reads a figure it cannot trust as zero', () => {
    const circuit = '/ip4/198.51.100.4/tcp/4001/p2p/12D3KooWRelay/p2p-circuit/p2p/12D3KooWme'
    const got = summarise({ relays: [circuit, 7] }, 1, { puts: { pending: 2, ok: 5, retries: 1, superseded: 0, gaveUp: 'x' } })
    expect(got.circuits).toEqual([circuit])
    expect(got.puts).toEqual({ pending: 2, ok: 5, retries: 1, superseded: 0, gaveUp: 0 })
    expect(summarise({}, null, { puts: 'none' }).puts).toBeNull()
  })

  it('answers by the hole punch state for a node that punches, whatever AutoNAT said', () => {
    const punch = (state: string) => ({ punch: { state, relaysKnown: 9, relaysHeld: 2, punched: 0, failed: 0 } })
    expect(summarise({ reachability: 'unknown', relays: ['/ip4/198.51.100.4/tcp/4001/p2p/12D3KooWRelay/p2p-circuit/p2p/12D3KooWme'] }, 5, punch('ready'))).toMatchObject({ reachability: 'public', basis: 'punch-ready', autonat: 'unknown', relays: 1, punch: { state: 'ready', relaysHeld: 2 } })
    expect(summarise({ reachability: 'private' }, 5, punch('ready'))).toMatchObject({ reachability: 'public', autonat: 'private' })
    expect(summarise({ reachability: 'unknown' }, 5, punch('symmetric-nat')).reachability).toBe('private')
    expect(summarise({ reachability: 'private' }, 5, punch('checking')).reachability).toBe('unknown')
  })

  it('counts the relay the person named as the way in once it holds a place', () => {
    const status = { reachability: 'unknown', relays: ['/ip4/198.51.100.4/tcp/4001/p2p/12D3KooWRelay/p2p-circuit/p2p/12D3KooWme'] }
    expect(summarise(status, null, { punch: { state: 'symmetric-nat' } }, '12D3KooWRelay')).toMatchObject({ reachability: 'public', basis: 'named-relay' })
  })
})

describe('summarise, a node that says what a reader can do (`reach`)', () => {
  const circuit = '/ip4/198.51.100.4/tcp/4001/p2p/12D3KooWRelay/p2p-circuit/p2p/12D3KooWme'
  const reach = (state: string, reason: string) => ({ reach: { state, reason } })
  const punch = (state: string, punched = 0, failed = 0) => ({ punch: { state, relaysKnown: 9, relaysHeld: 2, punched, failed } })

  it('answers with the node\'s state and reason, and says the node decided', () => {
    expect(summarise({ reachability: 'unknown', ...reach('public', 'open-relay') }, 2)).toMatchObject({ reachability: 'public', basis: 'open-relay', source: 'node' })
    expect(summarise({ reachability: 'private', ...reach('unknown', 'looking') }, 2)).toMatchObject({ reachability: 'unknown', basis: 'looking', source: 'node', autonat: 'private' })
  })

  it('does not call a punch that has not been tried reachable, as the Worker\'s own reading did', () => {
    const status = { reachability: 'unknown', relays: [circuit], ...reach('unknown', 'punch-ready') }
    expect(summarise(status, 2, punch('ready'))).toMatchObject({ reachability: 'unknown', basis: 'punch-ready', source: 'node' })
    expect(summarise({ reachability: 'unknown', relays: [circuit] }, 2, punch('ready'))).toMatchObject({ reachability: 'public', basis: 'punch-ready', source: 'worker' })
  })

  it('does not call a named relay that limits its circuits reachable', () => {
    const status = { reachability: 'unknown', relays: [circuit], ...reach('private', 'relay-limited') }
    expect(summarise(status, 2, punch('symmetric-nat'), '12D3KooWRelay')).toMatchObject({ reachability: 'private', basis: 'relay-limited', source: 'node' })
  })

  it('follows the node over AutoNAT, the addresses it confirmed and the punch counts', () => {
    const status = { reachability: 'public', external: ['/ip4/203.0.113.7/tcp/4851'], ...reach('private', 'not-reachable') }
    expect(summarise(status, 2, punch('ready', 1))).toMatchObject({ reachability: 'private', basis: 'not-reachable', autonat: 'public' })
  })

  it('passes a reason this Worker has never heard of, and reads the state case-insensitively', () => {
    expect(summarise(reach('Public', 'quic-direct'), null)).toMatchObject({ reachability: 'public', basis: 'quic-direct', source: 'node' })
  })

  it.each([
    ['a state that is not one of the three', { reach: { state: 'maybe', reason: 'looking' } }],
    ['no reason', { reach: { state: 'public' } }],
    ['a reach that is not an object', { reach: 'public' }],
    ['a null reach', { reach: null }]
  ])('reads the node itself, as it did before the field, when it sends %s', (_what, status) => {
    expect(summarise({ reachability: 'private', ...status }, null)).toMatchObject({ reachability: 'private', basis: 'not-reachable', source: 'worker' })
  })
})

describe('readStatus', () => {
  const node = (routes: Record<string, () => Response>) => ({ base: 'http://node.test', key: 'k', fetch: (async (url: string) => (routes[new URL(url).pathname] ?? (() => new Response('', { status: 404 })))()) as unknown as typeof fetch })

  it('reads the status and counts the peers when the node has the route', async () => {
    const status = await readStatus(node({ '/status': () => Response.json({ peer: 'p', reachability: 'public', listen: ['/ip4/0.0.0.0/tcp/4851'], external: [] }), '/orivon/swarm/peers': () => Response.json({ peers: [{ peer: 'a' }, { peer: 'b' }] }) }))
    expect(status).toMatchObject({ peer: 'p', reachability: 'public', peers: 2 })
  })

  it('reads the hole punch counts from the publishing route, with the named relay, in the same round as the rest', async () => {
    const circuit = '/ip4/198.51.100.4/tcp/4001/p2p/12D3KooWRelay/p2p-circuit/p2p/12D3KooWme'
    const asked: string[] = []
    const routes = {
      '/status': () => Response.json({ peer: 'p', reachability: 'unknown', relays: [circuit] }),
      '/orivon/swarm/peers': () => Response.json({ peers: [] }),
      '/orivon/publishing': () => Response.json({ keys: 'sealed', punch: { state: 'symmetric-nat', relaysKnown: 4, relaysHeld: 1, punched: 0, failed: 0 } })
    }
    const fetch = (async (url: string) => { asked.push(new URL(url).pathname); return routes[new URL(url).pathname as keyof typeof routes]() }) as unknown as typeof globalThis.fetch
    expect(await readStatus({ base: 'http://node.test', key: 'k', fetch, relay: '/ip4/198.51.100.4/tcp/4001/p2p/12D3KooWRelay' })).toMatchObject({ reachability: 'public', basis: 'named-relay', punch: { state: 'symmetric-nat', relaysHeld: 1 } })
    expect(await readStatus({ base: 'http://node.test', key: 'k', fetch })).toMatchObject({ reachability: 'private', basis: 'symmetric-nat' })
    asked.length = 0
    expect((await readStatus({ base: 'http://node.test', key: 'k', fetch, peers: false }))?.peers).toBeNull()
    expect(asked.sort()).toEqual(['/orivon/publishing', '/status'])
  })

  it('hands the node\'s reach through from /status', async () => {
    const status = await readStatus(node({ '/status': () => Response.json({ peer: 'p', reachability: 'unknown', reach: { state: 'unknown', reason: 'punch-ready' } }) }))
    expect(status).toMatchObject({ reachability: 'unknown', basis: 'punch-ready', source: 'node' })
  })

  it('leaves the count unknown for a node without the route, and answers null for a node that does not answer', async () => {
    expect((await readStatus(node({ '/status': () => Response.json({ peer: 'p' }) })))?.peers).toBeNull()
    expect(await readStatus(node({}))).toBeNull()
    expect(await readStatus({ base: 'http://x', key: 'k', fetch: (async () => { throw new TypeError('fetch failed') }) as typeof fetch })).toBeNull()
  })
})

describe('startStatusFeed', () => {
  it('reports at the start and at each interval, but only a change', async () => {
    vi.useFakeTimers()
    let value: { peer: string } | null = { peer: 'a' }
    const seen: unknown[] = []
    const feed = startStatusFeed({ read: async () => value as never, onStatus: (status) => seen.push(status), intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3000)
    expect(seen).toEqual([{ peer: 'a' }])
    value = { peer: 'b' }
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([{ peer: 'a' }, { peer: 'b' }])
    await feed.now()
    expect(seen).toHaveLength(3)
    feed.stop()
    value = null
    await vi.advanceTimersByTimeAsync(5000)
    expect(seen).toHaveLength(3)
  })
})
