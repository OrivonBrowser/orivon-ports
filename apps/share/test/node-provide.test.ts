import { describe, expect, it, vi } from 'vitest'
import { readCar } from '../page/src/ipfs/car.js'
import { importTree } from '../page/src/ipfs/unixfs.js'
import { memoryBackend } from '../page/src/keep/backends.js'
import { createKeep } from '../page/src/keep/store.js'
import { NODE_BATCH_BYTES, NODE_FEATURES, NODE_MAX_SHARE_BYTES, createNodeProvider } from '../page/src/node/provide.js'
import { createNodeState } from '../page/src/publish/node-state.js'

const NODE = 'http://127.0.0.1:5203'
const FEATURES = ['listen', 'provide']

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
function fakeNode (options: { features?: string[], status?: object, blocks?: (n: number) => Response } = {}) {
  const calls: Call[] = []
  let blocks = 0
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const headers = new Headers(init.headers)
    calls.push({ method: init.method ?? 'GET', path: url.pathname, key: headers.get('x-orivon-key'), body: init.body as Blob | string | undefined, type: headers.get('content-type') })
    if (url.pathname === '/health') return new Response('ok', { headers: { 'x-orivon-node-features': (options.features ?? FEATURES).join(', ') } })
    if (url.pathname === '/blocks') return options.blocks?.(++blocks) ?? Response.json({ roots: [], blocks: 1 })
    if (url.pathname === '/provide') return Response.json({}, { status: 202 })
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
    fetchImpl: node.fetchImpl, available: () => available
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
    expect([off, old, half].map((p) => p.started.length)).toEqual([0, 0, 0])
    expect(none.calls).toEqual([])
    expect(NODE_FEATURES).toEqual(['listen', 'provide'])
  })

  it('is started once with a key of its own, and used only if it lists listen and provide in its /health answer', async () => {
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
    const node = fakeNode({ status: { peer: 'p', listen: [], external: [], reachability: 'private', providing: [{ cid: a, announced: 1_700_000_000_000 }, { cid: b, announced: null }, { cid: c, announced: null }] } })
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
