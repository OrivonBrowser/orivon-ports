// The mutable file system through its `files/*` routes: paths, overwrites, removal, moves and copies, what a flush
// keeps and pins, how it survives a restart, and a directory big enough to be sharded.
import { importer } from 'ipfs-unixfs-importer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createKuboFacade, createNodeClient } from '../kubo/index.js'
import { bytes, createEnv, GATEWAY, lines, textOf } from './support/env.ts'
import { NODE_KEY } from './support/mock-node.ts'

const EMPTY_DIRECTORY = 'bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354'

let env: Awaited<ReturnType<typeof createEnv>>
beforeEach(async () => { env = await createEnv() })
afterEach(async () => { await env.cleanup() })

const write = (path: string, body: string | Uint8Array, query: Record<string, string | number | boolean> = {}): Promise<Response> =>
  env.call('files/write', { args: [path], body, query: { create: true, parents: true, truncate: true, flush: true, ...query } })

async function read (path: string, query: Record<string, string | number | boolean> = {}): Promise<string> {
  const response = await env.call('files/read', { args: [path], query })
  if (!response.ok) throw new Error(await response.text())
  return textOf(new Uint8Array(await response.arrayBuffer()))
}

async function message (response: Response): Promise<string> {
  expect(response.ok).toBe(false)
  return ((await response.json()) as { Message: string }).Message
}

const stat = (path: string): Promise<{ Hash: string, Size: number, CumulativeSize: number, Blocks: number, Type: string }> =>
  env.json('files/stat', { args: [path] })

describe('paths and files', () => {
  it('starts as an empty directory whose flush is the empty directory\'s CID, pinned', async () => {
    expect(await env.json('files/flush')).toEqual({ Cid: EMPTY_DIRECTORY })
    expect(await stat('/')).toMatchObject({ Hash: EMPTY_DIRECTORY, Type: 'directory', Blocks: 0 })
    expect([...env.node.pins]).toEqual([EMPTY_DIRECTORY])
  })

  it('writes a file under directories it makes, and reads, stats and lists it', async () => {
    expect((await write('/community/postUpdates/86400/post.json', '{"a":1}')).status).toBe(200)
    expect(await read('/community/postUpdates/86400/post.json')).toBe('{"a":1}')
    expect(await stat('/community/postUpdates/86400/post.json')).toMatchObject({ Type: 'file', Size: 7, Blocks: 0 })
    expect(await stat('/community/postUpdates/86400')).toMatchObject({ Type: 'directory', Blocks: 1 })
    const listing = await env.json<{ Entries: Array<{ Name: string, Type: number, Size: number, Hash: string }> }>('files/ls', { args: ['/community/postUpdates/86400'] })
    expect(listing.Entries).toEqual([{ Name: 'post.json', Type: 0, Size: 7, Hash: expect.stringMatching(/^bafkrei/) }])
    expect(await lines(await env.call('files/ls', { args: ['/community'], query: { stream: true } }))).toEqual([{ Name: 'postUpdates', Type: 1, Size: 0, Hash: expect.stringMatching(/^bafybei/) }])
  })

  it('refuses to create what the flags do not allow, in the words pkc-js matches', async () => {
    expect(await message(await env.call('files/write', { args: ['/missing.txt'], body: 'x', query: { create: false } }))).toBe('file does not exist')
    expect(await message(await env.call('files/write', { args: ['/a/b.txt'], body: 'x', query: { create: true } }))).toBe('file does not exist')
    expect(await message(await env.call('files/stat', { args: ['/nothing'] }))).toBe('file does not exist')
    expect(await message(await env.call('files/read', { args: ['/nothing'] }))).toBe('file does not exist')
    expect(await message(await env.call('files/stat', { args: ['relative'] }))).toMatch(/leading slash/)
  })

  it('overwrites with truncate, and in place at an offset without it', async () => {
    await write('/f.txt', 'hello world')
    await write('/f.txt', 'HELLO', { truncate: false })
    expect(await read('/f.txt')).toBe('HELLO world')
    await write('/f.txt', '!', { truncate: false, offset: 11 })
    expect(await read('/f.txt')).toBe('HELLO world!')
    await write('/f.txt', 'bye')
    expect(await read('/f.txt')).toBe('bye')
    await write('/f.txt', 'abcdef', { count: 3 })
    expect(await read('/f.txt')).toBe('abc')
  })

  it('reads a range of a file', async () => {
    await write('/f.txt', 'hello world')
    expect(await read('/f.txt', { offset: 6, count: 5 })).toBe('world')
  })

  it('writes a file past one block and reads it whole', async () => {
    const big = new Uint8Array(600_000).map((_, index) => (index * 7) % 256)
    await write('/big.bin', big)
    const answer = await env.call('files/read', { args: ['/big.bin'] })
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(big)
    expect((await stat('/big.bin')).Blocks).toBe(3)
  })

  it('makes directories, with parents, and says so when one exists', async () => {
    await env.call('files/mkdir', { args: ['/a/b/c'], query: { parents: true } })
    expect(await stat('/a/b/c')).toMatchObject({ Type: 'directory', Blocks: 0 })
    expect((await env.call('files/mkdir', { args: ['/a/b/c'], query: { parents: true } })).status).toBe(200)
    expect(await message(await env.call('files/mkdir', { args: ['/a/b/c'] }))).toBe('file already exists')
    expect(await message(await env.call('files/mkdir', { args: ['/x/y'] }))).toBe('file does not exist')
  })
})

describe('removing, moving and copying', () => {
  it('removes a file, a directory only with recursive, and a missing path only with force', async () => {
    await write('/d/f.txt', 'x')
    expect(await message(await env.call('files/rm', { args: ['/d'] }))).toBe('/d is a directory, use -r to remove directories')
    expect((await env.call('files/rm', { args: ['/d/f.txt'] })).status).toBe(200)
    expect(await message(await env.call('files/stat', { args: ['/d/f.txt'] }))).toBe('file does not exist')
    expect(await message(await env.call('files/rm', { args: ['/d/f.txt'] }))).toBe('file does not exist')
    expect((await env.call('files/rm', { args: ['/d/f.txt', '/nothing/at/all'], query: { force: true, recursive: true } })).status).toBe(200)
    expect((await env.call('files/rm', { args: ['/d'], query: { recursive: true } })).status).toBe(200)
    expect(await message(await env.call('files/stat', { args: ['/d'] }))).toBe('file does not exist')
    expect(await message(await env.call('files/rm', { args: ['/'], query: { recursive: true } }))).toMatch(/root/)
  })

  it('moves a directory, renaming it or into another, and refuses what is not there', async () => {
    await write('/old/f.txt', 'x')
    expect((await env.call('files/mv', { args: ['/old', '/new'] })).status).toBe(200)
    expect(await read('/new/f.txt')).toBe('x')
    expect(await message(await env.call('files/stat', { args: ['/old'] }))).toBe('file does not exist')
    await env.call('files/mkdir', { args: ['/into'] })
    await env.call('files/mv', { args: ['/new', '/into'] })
    expect(await read('/into/new/f.txt')).toBe('x')
    expect(await message(await env.call('files/mv', { args: ['/old', '/other'] }))).toBe('file does not exist')
    expect(await message(await env.call('files/mv', { args: ['/into', '/into/new'] }))).toMatch(/itself|already has entry/)
  })

  it('copies from /ipfs by linking the CID, and between MFS paths', async () => {
    const [entry] = await lines<{ Hash: string }>(await env.call('add', { body: 'from ipfs' }))
    await env.call('files/cp', { args: [`/ipfs/${entry?.Hash}`, '/copied.txt'] })
    expect(await read('/copied.txt')).toBe('from ipfs')
    expect((await stat('/copied.txt')).Size).toBe(9)
    await write('/dir/inner.txt', 'inner')
    await env.call('files/cp', { args: ['/dir', '/dir2'] })
    expect(await read('/dir2/inner.txt')).toBe('inner')
    await write('/dir/inner.txt', 'changed')
    expect(await read('/dir2/inner.txt')).toBe('inner')
    expect(await message(await env.call('files/cp', { args: ['/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/nope', '/x'] }))).toBeTruthy()
    expect((await env.call('files/cp', { args: ['/dir', '/dir2'] })).status).toBe(200)
    expect(await read('/dir2/dir/inner.txt')).toBe('changed')
    expect(await message(await env.call('files/cp', { args: ['/dir', '/dir2'] }))).toMatch(/already has entry/)
  })
})

describe('flush, pins and restarts', () => {
  async function build (target: typeof env): Promise<string> {
    const put = (path: string, body: string): Promise<Response> => target.call('files/write', { args: [path], body, query: { create: true, parents: true, truncate: true } })
    await put('/community/postUpdates/86400/a.json', '{"a":1}')
    await put('/community/postUpdates/86400/b.json', '{"b":2}')
    await put('/community/postUpdates/3600/c.json', '{"c":3}')
    return ((await target.json<{ Cid: string }>('files/flush'))).Cid
  }

  it('gives the same root for the same content, whatever the run', async () => {
    const other = await createEnv()
    try {
      expect(await build(env)).toBe(await build(other))
      expect(await build(env)).toBe(await build(env))
    } finally {
      await other.cleanup()
    }
  })

  it('pins the flushed root and unpins the one before, and a flush of a path answers that path\'s CID', async () => {
    const first = await build(env)
    expect([...env.node.pins]).toEqual([first])
    await write('/community/postUpdates/86400/a.json', '{"a":2}')
    const second = (await env.json<{ Cid: string }>('files/flush')).Cid
    expect(second).not.toBe(first)
    expect([...env.node.pins]).toEqual([second])
    const directory = (await env.json<{ Cid: string }>('files/flush', { args: ['/community/postUpdates/3600'] })).Cid
    expect(directory).toBe((await stat('/community/postUpdates/3600')).Hash)
  })

  it('keeps what it holds through a repo gc, and drops what it replaced', async () => {
    await build(env)
    const before = env.node.blocks.size
    await write('/community/postUpdates/86400/a.json', '{"a":99}')
    await env.call('repo/gc')
    expect(env.node.blocks.size).toBeLessThanOrEqual(before)
    expect(await read('/community/postUpdates/86400/a.json')).toBe('{"a":99}')
    expect(await read('/community/postUpdates/86400/b.json')).toBe('{"b":2}')
  })

  it('covers many writes with fewer flushes and loses none', async () => {
    await Promise.all(Array.from({ length: 24 }, (_, index) => write(`/many/${index}.txt`, `file ${index}`)))
    const names = (await env.json<{ Entries: Array<{ Name: string }> }>('files/ls', { args: ['/many'] })).Entries
    expect(names).toHaveLength(24)
    expect(env.node.calls.filter((call) => call.startsWith('POST /orivon/pin/')).length).toBeLessThan(24)
    expect(env.node.pins.size).toBe(1)
  })

  it('opens the same tree after a restart, from the root kept in the state file', async () => {
    const root = await build(env)
    const restarted = await createKuboFacade({ node: createNodeClient({ base: 'http://node.test', key: NODE_KEY, fetch: env.node.fetch }), statePath: env.statePath, gateway: GATEWAY })
    const answer = await restarted.handle(new Request('http://127.0.0.1:5001/api/v0/files/flush', { method: 'POST' }))
    expect(await answer.json()).toEqual({ Cid: root })
    const file = await restarted.handle(new Request('http://127.0.0.1:5001/api/v0/files/read?arg=%2Fcommunity%2FpostUpdates%2F3600%2Fc.json', { method: 'POST' }))
    expect(await file.text()).toBe('{"c":3}')
  })

  it('starts empty when the kept root is gone from the node', async () => {
    await build(env)
    env.node.blocks.clear()
    env.node.pins.clear()
    const restarted = await createKuboFacade({ node: createNodeClient({ base: 'http://node.test', key: NODE_KEY, fetch: env.node.fetch }), statePath: env.statePath, gateway: GATEWAY })
    const answer = await restarted.handle(new Request('http://127.0.0.1:5001/api/v0/files/flush', { method: 'POST' }))
    expect(await answer.json()).toEqual({ Cid: EMPTY_DIRECTORY })
  })

  it('tries again to unpin a replaced root that could not be unpinned', async () => {
    const first = await build(env)
    const real = env.node.fetch
    let refuse = true
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (refuse && init?.method === 'DELETE' && String(input).includes('/orivon/pin/')) return new Response('node busy', { status: 503 })
      return real(input, init)
    }) as typeof fetch
    const second = await createKuboFacade({ node: createNodeClient({ base: 'http://node.test', key: NODE_KEY, fetch: flaky }), statePath: env.statePath, gateway: GATEWAY })
    const writeVia = (path: string, content: string): Promise<Response> => {
      const form = new FormData()
      form.append('file', new Blob([content]))
      return second.handle(new Request(`http://127.0.0.1:5001/api/v0/files/write?arg=${encodeURIComponent(path)}&create=true&truncate=true`, { method: 'POST', body: form }))
    }
    expect((await writeVia('/community/new.txt', 'n')).status).toBe(500)
    expect(env.node.pins.has(first)).toBe(true)
    refuse = false
    expect((await writeVia('/community/newer.txt', 'n')).status).toBe(200)
    expect(env.node.pins.size).toBe(1)
    expect(env.node.pins.has(first)).toBe(false)
  })
})

describe('a directory past the sharding threshold', () => {
  const names = Array.from({ length: 3500 }, (_, index) => `post-update-${String(index).padStart(5, '0')}-${'x'.repeat(24)}.json`)

  async function expectedRoot (entries: string[]): Promise<string> {
    const blocks = new Map<string, Uint8Array>()
    const store = {
      put: async (cid: { toString: () => string }, block: Uint8Array) => { blocks.set(cid.toString(), block); return cid },
      get: async () => { throw new Error('unused') },
      has: async () => false
    }
    let root = ''
    for await (const entry of importer(entries.map((name) => ({ path: `big/${name}`, content: bytes('x') })), store as never, { cidVersion: 1, rawLeaves: true })) {
      if (entry.path === 'big') root = entry.cid.toString()
    }
    return root
  }

  async function fill (entries: string[]): Promise<void> {
    await write('/one.txt', 'x')
    await env.call('files/mkdir', { args: ['/big'] })
    for (const name of entries) await env.call('files/cp', { args: ['/one.txt', `/big/${name}`], query: { flush: false } })
    await env.call('files/flush')
  }

  it('builds the same sharded directory a UnixFS importer does, and lists and reads it back through a restart', async () => {
    await fill(names)
    const hash = (await stat('/big')).Hash
    expect(hash).toBe(await expectedRoot(names))
    const rootBlock = env.node.blocks.get(hash) as Uint8Array
    expect(rootBlock.length).toBeLessThan(262_144)
    expect(env.node.blocks.size).toBeGreaterThan(5)

    const restarted = await createKuboFacade({ node: createNodeClient({ base: 'http://node.test', key: NODE_KEY, fetch: env.node.fetch }), statePath: env.statePath, gateway: GATEWAY })
    const listing = await (await restarted.handle(new Request('http://127.0.0.1:5001/api/v0/files/ls?arg=%2Fbig&stream=true', { method: 'POST' }))).text()
    expect(listing.split('\n').filter(Boolean)).toHaveLength(3500)
    const one = await restarted.handle(new Request(`http://127.0.0.1:5001/api/v0/files/read?arg=${encodeURIComponent(`/big/${names[1234]}`)}`, { method: 'POST' }))
    expect(await one.text()).toBe('x')
  })

  it('stays one flat block below the threshold, as the importer builds it', async () => {
    const few = names.slice(0, 200)
    await fill(few)
    expect((await stat('/big')).Hash).toBe(await expectedRoot(few))
    expect((await stat('/big')).Blocks).toBe(200)
  })

  it('adds to and removes from a sharded directory', async () => {
    await fill(names)
    await env.call('files/rm', { args: [`/big/${names[7]}`] })
    await env.call('files/cp', { args: ['/one.txt', '/big/another.json'] })
    const entries = await lines(await env.call('files/ls', { args: ['/big'], query: { stream: true } }))
    expect(entries).toHaveLength(3500)
    expect(await message(await env.call('files/stat', { args: [`/big/${names[7]}`] }))).toBe('file does not exist')
    expect(await read('/big/another.json')).toBe('x')
  })
}, 120_000)
