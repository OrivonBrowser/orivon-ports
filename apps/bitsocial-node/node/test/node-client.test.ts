// The page module: reuse a node that answers, otherwise fork the Worker, wait for ready, and keep what the Worker says.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { authKeyFrom, DEFAULT_PORTS, startBitsocialNode } from '../../page/node-client.js'

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  sent: unknown[] = []
  killed = false
  send (message: unknown) { this.sent.push(message); return true }
  kill () { this.killed = true; queueMicrotask(() => { this.emit('exit', null, 'SIGTERM') }); return true }
}

/** A WebSocket that opens when `opens` says so for its URL and otherwise errors. */
const sockets = (opens: (url: string) => boolean) => class {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor (public url: string) { queueMicrotask(() => { if (opens(url)) this.onopen?.(); else this.onerror?.() }) }
  close () {}
} as unknown as typeof WebSocket

function setup (opens = false) {
  const children: FakeChild[] = []
  const forks: Array<{ path: string, options: { env: Record<string, string>, serialization: string, silent: boolean } }> = []
  const deps = {
    fork: ((path: string, _args: string[], options: never) => { const child = new FakeChild(); children.push(child); forks.push({ path, options }); return child }) as never,
    WebSocket: sockets(() => opens),
    shared: new Map<number, Promise<unknown>>()
  }
  return { deps, children, forks }
}
const ready = (child: FakeChild) => { child.emit('message', { type: 'ready', ports: { rpc: 9138, gateway: 6473 } }) }

describe('startBitsocialNode', () => {
  it('uses a node that already answers on the RPC port and forks nothing', async () => {
    const { deps, forks } = setup(true)
    const node = await startBitsocialNode({ authKey: KEY }, deps)
    expect(forks).toHaveLength(0)
    expect(node.reused).toBe(true)
    expect(node.snapshot()).toMatchObject({ running: true, reused: true })
    expect(node.rpcUrl).toBe(`ws://localhost:9138/${KEY}`)
    expect(node.gatewayUrl).toBe('http://localhost:6473')
  })

  it('forks the Worker with its configuration in the environment, and resolves when it says ready', async () => {
    const { deps, children, forks } = setup()
    const starting = startBitsocialNode({ authKey: KEY, files: '/orivon/app/x', serverPath: '/node/server.mjs', origins: ['http://localhost:8882'] }, deps)
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    expect(forks[0]!.path).toBe('/node/server.mjs')
    expect(forks[0]!.options).toMatchObject({ serialization: 'advanced', silent: true })
    expect(JSON.parse(forks[0]!.options.env['BITSOCIAL_NODE']!)).toEqual({ authKey: KEY, files: '/orivon/app/x', ports: DEFAULT_PORTS, origins: ['http://localhost:8882'], trace: 'warn' })
    ready(children[0]!)
    const node = await starting
    expect(node.reused).toBe(false)
    expect(node.snapshot().running).toBe(true)
  })

  it('does not wait for ready when the Worker says the node failed, and says which stage', async () => {
    const { deps, children } = setup()
    const starting = startBitsocialNode({ authKey: KEY, serverPath: '/s.mjs' }, deps)
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    children[0]!.emit('message', { type: 'failed', stage: 'rpc', message: 'listen EADDRINUSE', code: 'EADDRINUSE' })
    await expect(starting).rejects.toMatchObject({ message: expect.stringContaining('EADDRINUSE') as unknown, stage: 'rpc', code: 'EADDRINUSE' })
    expect(deps.shared.size).toBe(0)
  })

  it('rejects when the Worker ends before it is ready, and lets a later call start it again', async () => {
    const { deps, children } = setup()
    const starting = startBitsocialNode({ authKey: KEY, serverPath: '/s.mjs' }, deps)
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    children[0]!.emit('exit', 1, null)
    await expect(starting).rejects.toThrow(/ended before it was ready/)
    await vi.waitFor(() => { expect(deps.shared.size).toBe(0) })
  })

  it('starts one Worker however many times the page asks', async () => {
    const { deps, children } = setup()
    const first = startBitsocialNode({ authKey: KEY, serverPath: '/s.mjs' }, deps)
    const second = startBitsocialNode({ authKey: KEY, serverPath: '/s.mjs' }, deps)
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    ready(children[0]!)
    expect(await first).toBe(await second)
    expect(children).toHaveLength(1)
  })

  it('keeps what the Worker says: node state, status, and the last ten errors, and tells listeners', async () => {
    const { deps, children } = setup()
    const starting = startBitsocialNode({ authKey: KEY, serverPath: '/s.mjs' }, deps)
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    const child = children[0]!
    ready(child)
    const node = await starting
    const statuses: string[] = []
    const states: unknown[] = []
    node.on('status', (snapshot: { reachability: string }) => statuses.push(snapshot.reachability))
    node.on('node', (state: unknown) => states.push(state))
    child.emit('message', { type: 'node', state: 'up' })
    const punch = { state: 'ready', relaysKnown: 6, relaysHeld: 2, punched: 1, failed: 0 }
    child.emit('message', { type: 'status', status: { peer: '12D3KooWx', reachability: 'public', basis: 'punched', punch, peers: 4, listen: ['/ip4/0.0.0.0/tcp/4851'], external: ['/ip4/203.0.113.7/tcp/4851'] } })
    expect(node.snapshot()).toMatchObject({ node: 'up', peer: '12D3KooWx', reachability: 'public', basis: 'punched', punch, peers: 4 })
    expect(statuses.at(-1)).toBe('public')
    expect(states).toEqual([{ state: 'up', detail: null }])
    for (let i = 0; i < 12; i++) child.emit('message', { type: 'error', where: 'gateway', message: `problem ${String(i)}`, code: null })
    expect(node.snapshot().errors).toHaveLength(10)
    expect(node.snapshot().errors.at(-1)).toMatchObject({ message: 'problem 11' })
    child.emit('message', { type: 'status', status: null })
    expect(node.snapshot().peer).toBe('12D3KooWx')
  })

  it('hands the relay the person names to the Worker, and none when none is named', async () => {
    const relay = '/ip4/145.40.68.4/tcp/4001/p2p/12D3KooWRelayRelay'
    const named = setup()
    void startBitsocialNode({ authKey: KEY, serverPath: '/s.mjs', relay }, named.deps)
    await vi.waitFor(() => { expect(named.forks).toHaveLength(1) })
    expect(JSON.parse(named.forks[0]!.options.env['BITSOCIAL_NODE']!)).toMatchObject({ relay })
    const none = setup()
    void startBitsocialNode({ authKey: KEY, serverPath: '/s.mjs' }, none.deps)
    await vi.waitFor(() => { expect(none.forks).toHaveLength(1) })
    expect(JSON.parse(none.forks[0]!.options.env['BITSOCIAL_NODE']!)).not.toHaveProperty('relay')
  })

  it('asks the Worker for its reachability and answers with what it sends back', async () => {
    const { deps, children } = setup()
    const starting = startBitsocialNode({ authKey: KEY, serverPath: '/s.mjs' }, deps)
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    const child = children[0]!
    ready(child)
    const node = await starting
    const asked = node.reachability()
    await vi.waitFor(() => { expect(child.sent).toEqual([{ cmd: 'status' }]) })
    child.emit('message', { type: 'status', status: { peer: 'p', reachability: 'private', peers: 0, listen: [], external: [] } })
    expect(await asked).toBe('private')
  })

  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  it('makes a read-only call over the gateway\'s socket with the key, whether or not this page started the node', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => answer({ ID: 'p' }))
    const node = await startBitsocialNode({ authKey: KEY }, { ...setup(true).deps, fetch: fetch as never })
    expect(await (await node.api('id')).json()).toEqual({ ID: 'p' })
    await node.api('swarm/peers', { query: '?direction=true' })
    expect(fetch.mock.calls.map((call) => call[0])).toEqual(['http://localhost:6473/orivon/api/id', 'http://localhost:6473/orivon/api/swarm/peers?direction=true'])
    expect(fetch.mock.calls[0]![1]).toEqual({ method: 'POST', headers: { Authorization: `Bearer ${KEY}` } })
  })

  it('makes a board manager control call with the key and a JSON body, and answers the JSON', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => answer({ address: 'a.bso', enabled: true }))
    const node = await startBitsocialNode({ authKey: KEY }, { ...setup(true).deps, fetch: fetch as never })
    expect(await node.manager('enable', { address: 'a.bso', config: { perPage: 5 } })).toEqual({ address: 'a.bso', enabled: true })
    expect(fetch.mock.calls[0]![0]).toBe('http://localhost:6473/orivon/manager/enable')
    expect(fetch.mock.calls[0]![1]).toEqual({ method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ address: 'a.bso', config: { perPage: 5 } }) })
    await node.manager('boards')
    expect((fetch.mock.calls[1]![1] as { body: string }).body).toBe('{}')
  })

  it('throws what the Worker refused a control call with, and its status', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => answer({ Message: 'perPage must be a positive integer', Code: 0, Type: 'error' }, 400))
    const node = await startBitsocialNode({ authKey: KEY }, { ...setup(true).deps, fetch: fetch as never })
    await expect(node.manager('config', { address: 'a.bso', config: { perPage: 0 } })).rejects.toMatchObject({ message: 'perPage must be a positive integer', status: 400 })
    fetch.mockResolvedValueOnce(new Response('gateway down', { status: 502 }))
    await expect(node.manager('boards')).rejects.toMatchObject({ message: 'the board manager answered 502', status: 502 })
  })

  it('reads the challenge list with the key, and throws what the Worker refused it with', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => answer({ challenges: [{ name: '@bitsocial/wordfilter-challenge' }], unavailable: [] }))
    const node = await startBitsocialNode({ authKey: KEY }, { ...setup(true).deps, fetch: fetch as never })
    expect(await node.challenges('list')).toEqual({ challenges: [{ name: '@bitsocial/wordfilter-challenge' }], unavailable: [] })
    expect(fetch.mock.calls[0]![0]).toBe('http://localhost:6473/orivon/challenges/list')
    expect(fetch.mock.calls[0]![1]).toEqual({ method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: '{}' })
    fetch.mockResolvedValueOnce(answer({ Message: 'this build of the node has no challenges', Code: 0, Type: 'error' }, 503))
    await expect(node.challenges('list')).rejects.toMatchObject({ message: 'this build of the node has no challenges', status: 503 })
    fetch.mockResolvedValueOnce(new Response('gateway down', { status: 502 }))
    await expect(node.challenges('list')).rejects.toMatchObject({ message: 'the challenge list answered 502', status: 502 })
  })

  it('sends a board\'s challenges with a call\'s body, and throws a refusal with the failures of each challenge', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => answer({ address: 'a.bso', challenges: [], otherSettings: [] }))
    const node = await startBitsocialNode({ authKey: KEY }, { ...setup(true).deps, fetch: fetch as never })
    expect(await node.challenges('apply', { address: 'a.bso', challenges: [], expect: [{ name: 'x' }] })).toEqual({ address: 'a.bso', challenges: [], otherSettings: [] })
    expect(fetch.mock.calls[0]![0]).toBe('http://localhost:6473/orivon/challenges/apply')
    expect((fetch.mock.calls[0]![1] as { body: string }).body).toBe(JSON.stringify({ address: 'a.bso', challenges: [], expect: [{ name: 'x' }] }))
    const failures = [{ index: 0, name: 'text-math', option: 'difficulty', message: 'a required option is missing: difficulty' }]
    fetch.mockResolvedValueOnce(answer({ Message: 'Challenge 1 (text-math): a required option is missing: difficulty.', Code: 0, Type: 'error', failures }, 400))
    await expect(node.challenges('apply', { address: 'a.bso', challenges: [{ name: 'text-math' }] })).rejects.toMatchObject({ status: 400, failures })
  })

  it('makes a listing call the same way, on its own path, and throws what the Worker refused it with', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => answer({ address: 'a.bso', signable: true }))
    const node = await startBitsocialNode({ authKey: KEY }, { ...setup(true).deps, fetch: fetch as never })
    expect(await node.listing('board', { address: 'a.bso' })).toEqual({ address: 'a.bso', signable: true })
    expect(fetch.mock.calls[0]![0]).toBe('http://localhost:6473/orivon/listing/board')
    expect(fetch.mock.calls[0]![1]).toEqual({ method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ address: 'a.bso' }) })
    fetch.mockResolvedValueOnce(answer({ Message: 'this node does not hold the key', Code: 0, Type: 'error' }, 409))
    await expect(node.listing('sign', { address: 'a.bso', file: 'f' })).rejects.toMatchObject({ message: 'this node does not hold the key', status: 409 })
    fetch.mockResolvedValueOnce(new Response('gateway down', { status: 502 }))
    await expect(node.listing('board', { address: 'a.bso' })).rejects.toMatchObject({ message: 'the listing call answered 502', status: 502 })
  })

  it('makes a name call on its own path, and throws what the Worker refused it with', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => answer({ outcome: 'none' }))
    const node = await startBitsocialNode({ authKey: KEY }, { ...setup(true).deps, fetch: fetch as never })
    expect(await node.names('check', { address: 'a.bso', name: 'x.bso' })).toEqual({ outcome: 'none' })
    expect(fetch.mock.calls[0]![0]).toBe('http://localhost:6473/orivon/name/check')
    expect(fetch.mock.calls[0]![1]).toEqual({ method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ address: 'a.bso', name: 'x.bso' }) })
    fetch.mockResolvedValueOnce(answer({ Message: 'x.eth has no resolver set', Code: 0, Type: 'error' }, 409))
    await expect(node.names('transaction', { address: 'a.bso', name: 'x.bso' })).rejects.toMatchObject({ message: 'x.eth has no resolver set', status: 409 })
    fetch.mockResolvedValueOnce(new Response('gateway down', { status: 502 }))
    await expect(node.names('boards')).rejects.toMatchObject({ message: 'the name call answered 502', status: 502 })
  })

  it('reads the reachability of a node it found from the page API, and keeps the last verdict when that is not answered', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => answer({ reachability: 'Public' }))
    const node = await startBitsocialNode({ authKey: KEY }, { ...setup(true).deps, fetch: fetch as never })
    expect(await node.reachability()).toBe('public')
    expect(node.snapshot().reachability).toBe('public')
    fetch.mockResolvedValueOnce(answer({ message: 'no' }, 401))
    expect(await node.reachability()).toBe('public')
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await node.reachability()).toBe('public')
    fetch.mockResolvedValueOnce(answer({ reachability: 'Unknown' }))
    expect(await node.reachability()).toBe('unknown')
  })

  it('gathers what a statistics page shows from four calls, and leaves null what the node does not answer', async () => {
    const fetch = vi.fn(async (url: unknown) => {
      const call = String(url).split('/orivon/api/')[1]
      if (call === 'id') return answer({ ID: '12D3KooWx' })
      if (call === 'swarm/peers') return answer({ Peers: [{ Peer: 'a' }, { Peer: 'b' }, { Peer: 'c' }] })
      if (call === 'swarm/addrs/autonat') return answer({ reachability: 'Private' })
      return answer({ Message: 'down' }, 500)
    })
    const node = await startBitsocialNode({ authKey: KEY }, { ...setup(true).deps, fetch: fetch as never })
    expect(await node.stats()).toEqual({ peer: '12D3KooWx', peers: 3, reachability: 'private', repoBytes: null, storageMax: null })
    fetch.mockImplementation(async (url: unknown) => (String(url).endsWith('/repo/stat') ? answer({ RepoSize: 1234, StorageMax: 10_000, NumObjects: 3 }) : answer({}, 404)))
    expect(await node.stats()).toEqual({ peer: null, peers: null, reachability: 'unknown', repoBytes: 1234, storageMax: 10_000 })
  })

  it('stops the Worker it started and leaves a node it found alone', async () => {
    const { deps, children } = setup()
    const starting = startBitsocialNode({ authKey: KEY, serverPath: '/s.mjs' }, deps)
    await vi.waitFor(() => { expect(children).toHaveLength(1) })
    const child = children[0]!
    ready(child)
    const node = await starting
    const stopping = node.stop()
    expect(child.sent).toContainEqual({ cmd: 'stop' })
    child.emit('exit', 0, null)
    await stopping
    expect(node.snapshot().running).toBe(false)
    const found = await startBitsocialNode({ authKey: KEY }, { ...setup(true).deps })
    await found.stop()
  })
})

describe('authKeyFrom', () => {
  const memory = () => { const kept = new Map<string, string>(); return { kept, getItem: (name: string) => kept.get(name) ?? null, setItem: (name: string, value: string) => { kept.set(name, value) } } }

  it('makes a key once and gives the same one afterwards', () => {
    const storage = memory()
    const first = authKeyFrom(storage, () => KEY)
    expect(first).toBe(KEY)
    expect(authKeyFrom(storage, () => 'another-key-another-key-another')).toBe(KEY)
  })

  it('replaces a kept value that is not a usable key', () => {
    const storage = memory()
    storage.kept.set('bitsocial-node-key', 'a/b')
    expect(authKeyFrom(storage, () => KEY)).toBe(KEY)
  })
})

describe('the manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../orivon.json', import.meta.url), 'utf8')) as { crossOriginIsolated: boolean, capabilities: { net: { tcp: { connect: string[], listen: { local: string[], network: string[] } } } } }
  const { listen, connect } = manifest.capabilities.net.tcp

  it('lets the app listen on the loopback ports of the RPC, the gateway and the node, and on the node\'s IPFS port for the network', () => {
    expect(listen.local).toEqual(expect.arrayContaining([DEFAULT_PORTS.rpc, DEFAULT_PORTS.gateway, DEFAULT_PORTS.nodeApi].map(String)))
    expect(listen.network).toEqual([String(DEFAULT_PORTS.p2p)])
  })

  it('lets the page reach the RPC and the node by name and by address, and runs in an isolated page for the Worker\'s file calls', () => {
    for (const port of [DEFAULT_PORTS.rpc, DEFAULT_PORTS.nodeApi, DEFAULT_PORTS.gateway]) expect(connect).toEqual(expect.arrayContaining([`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]))
    expect(manifest.crossOriginIsolated).toBe(true)
  })
})
