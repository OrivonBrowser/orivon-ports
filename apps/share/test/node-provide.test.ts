import { describe, expect, it, vi } from 'vitest'
import { readCar } from '../page/src/ipfs/car.js'
import { importTree } from '../page/src/ipfs/unixfs.js'
import { memoryBackend } from '../page/src/keep/backends.js'
import { createKeep } from '../page/src/keep/store.js'
import { NODE_BATCH_BYTES, NODE_FEATURES, NODE_MAX_SHARE_BYTES, createNodeProvider } from '../page/src/node/provide.js'
import { createNodeState } from '../page/src/publish/node-state.js'

const NODE = 'http://127.0.0.1:5203'
const FEATURES = ['listen', 'provide', 'relay']

function pattern (size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7 + (i >>> 18)) & 255)
}

async function kept (keep: ReturnType<typeof createKeep>, content: Uint8Array, name = 'a.bin') {
  const files = [{ path: name, content }]
  const imported = await importTree(files, () => {})
  await keep.add(imported.cid, { kind: 'files', encrypted: false, bytes: content.length, files: 1, online: true }, async (sink) => { await importTree(files, sink) })
  return imported.cid
}

type Call = { method: string, path: string, key: string | null, body: Blob | string | undefined, type: string | null }

/** A node as Orivon's will answer, and what it was asked. */
function fakeNode (options: { features?: string[], status?: object, blocks?: (n: number) => Response | Promise<Response>, provided?: (cid: string) => object, refuseProvide?: Response } = {}) {
  const calls: Call[] = []
  let blocks = 0
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const headers = new Headers(init.headers)
    calls.push({ method: init.method ?? 'GET', path: url.pathname, key: headers.get('x-orivon-key'), body: init.body as Blob | string | undefined, type: headers.get('content-type') })
    if (url.pathname === '/health') return new Response('ok', { headers: { 'x-orivon-node-features': (options.features ?? FEATURES).join(', ') } })
    if (url.pathname === '/blocks') return (await options.blocks?.(++blocks)) ?? Response.json({ roots: [], blocks: 1 })
    if (url.pathname === '/provide') return options.refuseProvide?.clone() ?? Response.json(options.provided?.(JSON.parse(String(init.body)).cid) ?? {}, { status: 202 })
    if (url.pathname.startsWith('/provide/')) return new Response('', { status: 200 })
    if (url.pathname === '/status') {
      if (options.status === undefined) throw new TypeError('fetch failed')
      return Response.json(options.status)
    }
    return new Response('no', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function provider (keep: ReturnType<typeof createKeep>, node: ReturnType<typeof fakeNode>, { nodeFeatures = FEATURES, available = true } = {}) {
  const started: object[] = []
  const launcher = async () => ({ start: async (options: object) => { started.push(options); return { base: NODE, peer: '12D3KooWpage', port: 5203 } } })
  const made = createNodeProvider({
    keep, state: createNodeState(undefined), launcher: launcher as never, buildInfo: async () => ({ ipfsNode: 'bafy', nodeFeatures }),
    fetchImpl: node.fetchImpl, available: () => available, uploadRetryMs: 1
  })
  return { made, started }
}

describe('the page\'s IPFS node', () => {
  it('is never started by a page without Orivon\'s sockets, nor for a node build that lists no features', async () => {
    const keep = createKeep(memoryBackend())
    const none = fakeNode()
    const off = provider(keep, none, { available: false })
    expect(await off.made.node()).toBeNull()
    const old = provider(keep, none, { nodeFeatures: [] })
    expect(await old.made.node()).toBeNull()
    const half = provider(keep, none, { nodeFeatures: ['listen'] })
    expect(await half.made.node()).toBeNull()
    const noRelay = provider(keep, none, { nodeFeatures: ['serve', 'listen', 'provide'] })
    expect(await noRelay.made.node()).toBeNull()
    expect([off, old, half, noRelay].map((p) => p.started.length)).toEqual([0, 0, 0, 0])
    expect(none.calls).toEqual([])
    expect(NODE_FEATURES).toEqual(['listen', 'provide', 'relay'])
  })

  it('is started once with a key of its own, and used only if it lists listen, provide and relay in its /health answer', async () => {
    const keep = createKeep(memoryBackend())
    const node = fakeNode()
    const { made, started } = provider(keep, node)
    const first = await made.node()
    expect(first).toMatchObject({ base: NODE })
    expect(first!.key).toMatch(/^[0-9a-f]{64}$/)
    expect(await made.node()).toBe(first)
    expect(started).toHaveLength(1)
    expect(node.calls[0]).toMatchObject({ method: 'GET', path: '/health', key: first!.key })
    const liar = provider(keep, fakeNode({ features: ['listen'] }))
    expect(await liar.made.node()).toBeNull()
    const withoutRelay = provider(keep, fakeNode({ features: ['serve', 'listen', 'provide'] }))
    expect(await withoutRelay.made.node()).toBeNull()
  })

  it('takes a share as CAR batches and has the node announce it', async () => {
    const keep = createKeep(memoryBackend())
    const cid = await kept(keep, pattern(600_000))
    const node = fakeNode()
    const { made } = provider(keep, node)
    await made.provide(cid)
    const sent = node.calls.filter((c) => c.path === '/blocks')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ method: 'POST', type: 'application/vnd.ipld.car' })
    expect((await readCar(new Uint8Array(await (sent[0]!.body as Blob).arrayBuffer()))).size).toBeGreaterThan(3)
    const provide = node.calls.find((c) => c.path === '/provide')!
    expect(provide).toMatchObject({ method: 'POST', type: 'application/json' })
    expect(JSON.parse(provide.body as string)).toEqual({ cid })
    expect(node.calls.every((c) => c.key === node.calls[0]!.key)).toBe(true)
    expect(made.stateOf(cid)).toBe('starting')
    expect(made.stateOf('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')).toBe('off')
  })

  it('cuts a large share into batches of at most 32 MiB', async () => {
    const keep = createKeep(memoryBackend())
    const cid = await kept(keep, pattern(NODE_BATCH_BYTES + 3_000_000))
    const node = fakeNode()
    const { made } = provider(keep, node)
    await made.provide(cid)
    const sent = node.calls.filter((c) => c.path === '/blocks')
    expect(sent.length).toBe(2)
    expect(sent.every((c) => (c.body as Blob).size <= NODE_BATCH_BYTES)).toBe(true)
    expect(node.calls.at(-1)!.path).toBe('/provide')
  }, 60_000)

  it('leaves a share to WebRTC when the node could not hold it, alone or with the others', async () => {
    const node = fakeNode()
    const big = { meta: async () => ({ stored: NODE_MAX_SHARE_BYTES + 1 }), eachBatch: vi.fn() }
    const { made } = provider(big as never, node)
    await made.provide('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')
    expect(big.eachBatch).not.toHaveBeenCalled()
    expect(made.stateOf('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')).toBe('off')

    const stored: Record<string, number> = { one: 150 * 1024 * 1024, two: 100 * 1024 * 1024 }
    const several = { meta: async (cid: string) => ({ stored: stored[cid] }), eachBatch: async () => {} }
    const second = provider(several as never, fakeNode())
    await second.made.provide('one')
    await second.made.provide('two')
    expect(second.made.stateOf('one')).toBe('starting')
    expect(second.made.stateOf('two')).toBe('off')
  })

  it('reports what the node says it announced, and that this computer cannot be reached', async () => {
    const keep = createKeep(memoryBackend())
    const a = await kept(keep, pattern(2000), 'a.bin')
    const b = await kept(keep, pattern(3000), 'b.bin')
    const c = await kept(keep, pattern(4000), 'c.bin')
    const node = fakeNode({ status: { peer: 'p', listen: [], external: [], relays: [], reachability: 'private', providing: [{ cid: a, announced: 1_700_000_000_000 }, { cid: b, announced: null }, { cid: c, announced: null }] } })
    const { made } = provider(keep, node)
    for (const cid of [a, b, c]) await made.provide(cid)
    expect(await made.poll()).toBe(true)
    expect([a, b, c].map((cid) => made.stateOf(cid))).toEqual(['announced', 'unreachable', 'unreachable'])
    const waiting = fakeNode({ status: { providing: [{ cid: a, announced: null }], reachability: 'unknown' } })
    const second = provider(keep, waiting)
    await second.made.provide(a)
    await second.made.poll()
    expect(second.made.stateOf(a)).toBe('starting')
  })

  it('is not unreachable behind a router while the node holds a place on the relay, and announced once it has announced', async () => {
    const keep = createKeep(memoryBackend())
    const a = await kept(keep, pattern(2000), 'a.bin')
    const b = await kept(keep, pattern(3000), 'b.bin')
    const circuit = '/ip4/152.228.138.30/tcp/4003/p2p/12D3KooWRelay/p2p-circuit/p2p/12D3KooWpage'
    const waiting = fakeNode({ status: { relays: [circuit], reachability: 'private', providing: [{ cid: a, announced: null }, { cid: b, announced: null }] } })
    const first = provider(keep, waiting)
    for (const cid of [a, b]) await first.made.provide(cid)
    await first.made.poll()
    expect([a, b].map((cid) => first.made.stateOf(cid))).toEqual(['starting', 'starting'])
    const done = fakeNode({ status: { relays: [circuit], reachability: 'private', providing: [{ cid: a, announced: 1_700_000_000_000 }, { cid: b, announced: null }] } })
    const second = provider(keep, done)
    for (const cid of [a, b]) await second.made.provide(cid)
    await second.made.poll()
    expect([a, b].map((cid) => second.made.stateOf(cid))).toEqual(['announced', 'starting'])
    const lost = fakeNode({ status: { relays: [], reachability: 'private', providing: [{ cid: a, announced: null }] } })
    const third = provider(keep, lost)
    await third.made.provide(a)
    await third.made.poll()
    expect(third.made.stateOf(a)).toBe('unreachable')
  })

  it('writes the node\'s reachability and its relay places to the console once for each change, for a bug report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const keep = createKeep(memoryBackend())
      const cid = await kept(keep, pattern(2000))
      let status: object = { relays: [], reachability: 'unknown', providing: [{ cid, announced: null }] }
      const node = fakeNode()
      const live = { ...node, fetchImpl: (async (input: string, init?: RequestInit) => String(input).endsWith('/status') ? Response.json(status) : node.fetchImpl(input, init)) as typeof fetch }
      const { made } = provider(keep, live)
      await made.provide(cid)
      await made.poll()
      await made.poll()
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual(['[share-node] reachability unknown, relay places held 0, shares announced 0 of 1'])
      status = { relays: ['/ip4/1.2.3.4/tcp/4003/p2p/R/p2p-circuit/p2p/N'], reachability: 'private', providing: [{ cid, announced: 1_700_000_000_000 }] }
      await made.poll()
      await made.poll()
      expect(warn.mock.calls.map((call) => String(call[0])).at(-1)).toBe('[share-node] reachability private, relay places held 1, shares announced 1 of 1')
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('writes how many files and folders the node holds under the roots, from its table, and the shares it cut short', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const keep = createKeep(memoryBackend())
      const small = await kept(keep, pattern(2000), 'a.bin')
      const big = await kept(keep, pattern(3000), 'b.bin')
      const answers: Record<string, object> = { [small]: { cid: small, children: 12, truncated: false }, [big]: { cid: big, children: 1023, truncated: true } }
      const listed = (count: number) => Array.from({ length: count }, (_, i) => ({ cid: `listed-${i}`, announced: 1_700_000_000_000 }))
      let status: object = { relays: ['/ip4/1.2.3.4/tcp/4003/p2p/R/p2p-circuit/p2p/N'], reachability: 'private', providing: [{ cid: small, announced: 1_700_000_000_000 }, ...listed(12)] }
      const node = fakeNode({ provided: (cid) => answers[cid] ?? {} })
      const live = { ...node, fetchImpl: (async (input: string, init?: RequestInit) => String(input).endsWith('/status') ? Response.json(status) : node.fetchImpl(input, init)) as typeof fetch }
      const { made } = provider(keep, live)
      await made.provide(small)
      await made.poll()
      expect(warn.mock.calls.at(-1)?.[0]).toBe('[share-node] reachability private, relay places held 1, shares announced 1 of 1, files and folders announced with them 12, the node\'s table holds 13 of 1024')
      status = { relays: ['/ip4/1.2.3.4/tcp/4003/p2p/R/p2p-circuit/p2p/N'], reachability: 'private', providing: [{ cid: small, announced: 1_700_000_000_000 }, { cid: big, announced: null }, ...listed(1022)] }
      await made.provide(big)
      await made.poll()
      expect(warn.mock.calls.at(-1)?.[0]).toBe('[share-node] reachability private, relay places held 1, shares announced 1 of 2, files and folders announced with them 1022, the node\'s table holds 1024 of 1024, shares the node cut short when it took them 1')
      status = { relays: ['/ip4/1.2.3.4/tcp/4003/p2p/R/p2p-circuit/p2p/N'], reachability: 'private', providing: [{ cid: small, announced: 1_700_000_000_000 }, ...listed(3)] }
      await made.unprovide(big)
      await made.poll()
      expect(warn.mock.calls.at(-1)?.[0]).toBe('[share-node] reachability private, relay places held 1, shares announced 1 of 1, files and folders announced with them 3, the node\'s table holds 4 of 1024')
      status = { relays: ['/ip4/1.2.3.4/tcp/4003/p2p/R/p2p-circuit/p2p/N'], reachability: 'private', providing: [] }
      await made.unprovide(small)
      await made.poll()
      expect(warn.mock.calls.at(-1)?.[0]).toBe('[share-node] reachability private, relay places held 1, shares announced 0 of 0')
    } finally {
      warn.mockRestore()
    }
  })

  it('says so when the node\'s table names its limit of CIDs and refuses a share, and the share stays off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const keep = createKeep(memoryBackend())
      const cid = await kept(keep, pattern(2000))
      const { made } = provider(keep, fakeNode({ refuseProvide: new Response('already announcing 1024 CIDs', { status: 429 }) }))
      await expect(made.provide(cid)).rejects.toThrow(/Your IPFS node refused it: already announcing 1024 CIDs/)
      expect(made.stateOf(cid)).toBe('off')
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual(['[share-node] a share was not announced: the node\'s table already names 1024 CIDs, so it travels page to page only'])
    } finally {
      warn.mockRestore()
    }
  })

  it('writes nothing about the table for another refusal of /provide', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const keep = createKeep(memoryBackend())
      const cid = await kept(keep, pattern(2000))
      const { made } = provider(keep, fakeNode({ refuseProvide: new Response('the node cannot announce', { status: 503 }) }))
      await expect(made.provide(cid)).rejects.toThrow(/the node cannot announce/)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('asks again for an upload the node refused because another runs, and gives up after six tries', async () => {
    const keep = createKeep(memoryBackend())
    const cid = await kept(keep, pattern(2000))
    const busy = () => new Response('another upload is in progress; try again', { status: 429 })
    const once = fakeNode({ blocks: (n) => n === 1 ? busy() : Response.json({ roots: [], blocks: 1 }) })
    const first = provider(keep, once)
    await first.made.provide(cid)
    expect(once.calls.filter((call) => call.path === '/blocks')).toHaveLength(2)
    expect(once.calls.some((call) => call.path === '/provide')).toBe(true)
    const never = fakeNode({ blocks: busy })
    const second = provider(keep, never)
    await expect(second.made.provide(cid)).rejects.toThrow(/another upload is in progress/)
    expect(never.calls.filter((call) => call.path === '/blocks')).toHaveLength(6)
    expect(never.calls.some((call) => call.path === '/provide')).toBe(false)
    expect(second.made.stateOf(cid)).toBe('off')
  })

  it('gives the node one share at a time, and a share stopped while it waits is never given', async () => {
    const keep = createKeep(memoryBackend())
    const a = await kept(keep, pattern(2000), 'a.bin')
    const b = await kept(keep, pattern(3000), 'b.bin')
    const c = await kept(keep, pattern(4000), 'c.bin')
    let open = 0
    let overlapped = false
    const node = fakeNode({ blocks: async () => { open++; overlapped ||= open > 1; await new Promise((resolve) => setTimeout(resolve, 20)); open--; return Response.json({ roots: [], blocks: 1 }) } })
    const { made } = provider(keep, node)
    const all = [made.provide(a), made.provide(b), made.provide(c)]
    await made.unprovide(b)
    await Promise.all(all)
    expect(overlapped).toBe(false)
    expect(node.calls.filter((call) => call.path === '/provide').map((call) => JSON.parse(String(call.body)).cid)).toEqual([a, c])
    expect(made.stateOf(b)).toBe('off')
  })

  it('writes nothing about entries when the node\'s answer does not carry them, and ignores a children count that is not a number', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const keep = createKeep(memoryBackend())
      const cid = await kept(keep, pattern(2000))
      const status = { relays: [], reachability: 'public', providing: [{ cid, announced: null }] }
      for (const answer of [{}, { children: '7', truncated: true }, { children: null }, { children: 1.5 }]) {
        warn.mockClear()
        const { made } = provider(keep, fakeNode({ status, provided: () => answer }))
        await made.provide(cid)
        await made.poll()
        expect(warn.mock.calls.map((call) => String(call[0]))).toEqual(['[share-node] reachability public, relay places held 0, shares announced 0 of 1'])
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('forgets what it logged about entries when the node stops answering', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const keep = createKeep(memoryBackend())
      const cid = await kept(keep, pattern(2000))
      let status: object | undefined = { relays: [], reachability: 'public', providing: [{ cid, announced: 1_700_000_000_000 }, ...['a', 'b', 'c', 'd'].map((listed) => ({ cid: listed, announced: 1_700_000_000_000 }))] }
      let answer: object = { children: 4, truncated: false }
      const node = fakeNode({ provided: () => answer })
      const live = { ...node, fetchImpl: (async (input: string, init?: RequestInit) => String(input).endsWith('/status') ? (status === undefined ? Promise.reject(new TypeError('fetch failed')) : Response.json(status)) : node.fetchImpl(input, init)) as typeof fetch }
      const { made } = provider(keep, live)
      await made.provide(cid)
      await made.poll()
      expect(warn.mock.calls.at(-1)?.[0]).toBe('[share-node] reachability public, relay places held 0, shares announced 1 of 1, files and folders announced with them 4, the node\'s table holds 5 of 1024')
      status = undefined
      expect(await made.poll()).toBe(false)
      status = { relays: [], reachability: 'public', providing: [] }
      answer = {}
      await made.provide(cid)
      await made.poll()
      expect(warn.mock.calls.at(-1)?.[0]).toBe('[share-node] reachability public, relay places held 0, shares announced 0 of 1')
    } finally {
      warn.mockRestore()
    }
  })

  it('forgets everything when the node stops answering, and starts it again for the next share', async () => {
    const keep = createKeep(memoryBackend())
    const cid = await kept(keep, pattern(2000))
    const node = fakeNode()
    const { made, started } = provider(keep, node)
    await made.provide(cid)
    expect(await made.poll()).toBe(false)
    expect(made.stateOf(cid)).toBe('off')
    await made.provide(cid)
    expect(started).toHaveLength(2)
  })

  it('stops announcing a share and says so', async () => {
    const keep = createKeep(memoryBackend())
    const cid = await kept(keep, pattern(2000))
    const node = fakeNode()
    const { made } = provider(keep, node)
    await made.provide(cid)
    await made.unprovide(cid)
    expect(node.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/provide/${cid}` })
    expect(made.stateOf(cid)).toBe('off')
  })

  it('does not announce a share that was stopped while the node was still taking its blocks', async () => {
    const keep = createKeep(memoryBackend())
    const cid = await kept(keep, pattern(2000))
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const node = fakeNode({ blocks: async () => { await gate; return Response.json({ roots: [], blocks: 1 }) } })
    const { made } = provider(keep, node)
    const giving = made.provide(cid)
    await vi.waitFor(() => { expect(node.calls.some((c) => c.path === '/blocks')).toBe(true) })
    await made.unprovide(cid)
    release()
    await giving
    expect(node.calls.filter((c) => c.method === 'POST' && c.path === '/provide')).toHaveLength(0)
    expect(made.stateOf(cid)).toBe('off')
  })

  it('says in words that the node is full, and when it refuses a share', async () => {
    const keep = createKeep(memoryBackend())
    const cid = await kept(keep, pattern(2000))
    const full = provider(keep, fakeNode({ blocks: () => new Response('table full', { status: 507 }) }))
    await expect(full.made.provide(cid)).rejects.toMatchObject({ kind: 'too-large' })
    expect(full.made.stateOf(cid)).toBe('off')
    const refusing = provider(keep, fakeNode({ blocks: () => new Response('a block does not match its CID', { status: 400 }) }))
    await expect(refusing.made.provide(cid)).rejects.toThrow(/Your IPFS node refused it: a block does not match its CID/)
  })
})
