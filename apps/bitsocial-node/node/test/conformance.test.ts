// The facade driven by the real kubo-rpc-client (the version pkc-js 0.0.132 pins) through the fetch hook, with the
// options pkc-js passes, plus pkc-js's raw requests. SURFACE.md lists each call and where pkc-js makes it.
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { create } from 'kubo-rpc-client'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installFetchHook } from '../kubo/index.js'
import { API, createEnv } from './support/env.ts'

const HELLO_V0 = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o'
const URL_BASE = `${API}/api/v0`

let env: Awaited<ReturnType<typeof createEnv>>
let restore: () => void
const client = create({ url: URL_BASE })

beforeAll(async () => {
  env = await createEnv()
  restore = installFetchHook(globalThis, API, env.facade)
})
afterAll(async () => {
  restore()
  await env.cleanup()
})

async function collect<T> (iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

describe('content', () => {
  it('add({ pin: true }) answers the CIDv0 ipfs add does', async () => {
    const added = await client.add('hello world\n', { pin: true })
    expect(added.cid.toString()).toBe(HELLO_V0)
    expect(added.size).toBe(20)
  })

  it('add of a Uint8Array and of JSON text, like pkc-js\'s pages and community records', async () => {
    const json = JSON.stringify({ updatedAt: 1, posts: [] })
    const added = await client.add(json, { pin: true })
    expect(added.cid.version).toBe(0)
    const read = await collect(client.cat(added.cid, { length: 1_000_000, timeout: '15000ms' }))
    expect(new TextDecoder().decode(Buffer.concat(read))).toBe(json)
  })

  it('block.put with raw, sha2-256, version 1 and pin, then routing.provide with recursive', async () => {
    const data = new TextEncoder().encode('pubsub topic block')
    const cid = await client.block.put(data, { format: 'raw', mhtype: 'sha2-256', version: 1, pin: true })
    expect(cid.equals(CID.createV1(0x55, await sha256.digest(data)))).toBe(true)
    expect(env.node.pins.has(cid.toString())).toBe(true)
    const events = await collect(client.routing.provide(cid, { recursive: true }))
    expect(events.length).toBeGreaterThan(0)
  })

  it('block.rm yields one result per block', async () => {
    const cid = await client.block.put(new TextEncoder().encode('to remove'), { format: 'raw', version: 1 })
    const removed = await collect(client.block.rm([cid]))
    expect(removed.map((one) => one.cid.toString())).toEqual([cid.toString()])
    expect(removed[0]?.error).toBeUndefined()
  })

  it('cat fails for a CID the node does not have, not hangs', async () => {
    await expect(collect(client.cat(CID.parse('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'), { timeout: '2000ms' }))).rejects.toThrow()
  })
})

describe('pins and the repo', () => {
  it('pin.ls with paths lists a pinned CID and rejects an unpinned one with "is not pinned"', async () => {
    const { cid } = await client.add('pinned content', { pin: true })
    const listed = await collect(client.pin.ls({ paths: cid }))
    expect(listed.map((one) => one.cid.toString())).toEqual([cid.toV1().toString()])
    const unpinned = CID.parse('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')
    await expect(collect(client.pin.ls({ paths: unpinned }))).rejects.toThrow(/is not pinned/)
  })

  it('pin.rm with recursive, then "not pinned" on a second try', async () => {
    const { cid } = await client.add('to unpin', { pin: true })
    await client.pin.rm(cid, { recursive: true })
    await expect(client.pin.rm(cid, { recursive: true })).rejects.toThrow(/^not pinned/)
  })

  it('repo.stat with size-only and repo.gc with quiet', async () => {
    const stat = await client.repo.stat({ searchParams: new URLSearchParams({ 'size-only': 'true' }) })
    expect(Number(stat.repoSize)).toBeGreaterThan(0)
    const { cid } = await client.add('collected by repo.gc', { pin: false })
    const results = await collect(client.repo.gc({ quiet: true }))
    expect(results.map((one) => one.cid?.toString())).toContain(cid.toV1().toString())
  })
})

describe('the mutable file system', () => {
  it('files.write, files.stat, files.flush, files.mv and files.rm as pkc-js calls them', async () => {
    const options = { timeout: 60_000, create: true, truncate: true, parents: true, flush: true }
    await client.files.write('/community/postUpdates/86400/post.json', new TextEncoder().encode('{"cid":"x"}'), options)
    const bucket = await client.files.stat('/community/postUpdates/86400')
    expect(bucket.blocks).not.toBe(0)
    expect(bucket.type).toBe('directory')
    expect(typeof bucket.cid.toString()).toBe('string')
    const hashOnly = await client.files.stat('/community', { hash: true })
    expect(hashOnly.cid.toString()).toMatch(/^bafybei/)
    const flushed = await client.files.flush('/community/postUpdates')
    expect(flushed.toString()).toMatch(/^bafybei/)

    await client.files.mv('/community', '/renamed')
    await expect(client.files.stat('/community')).rejects.toThrow(/file does not exist/)
    await expect(client.files.mv('/community', '/again')).rejects.toThrow(/file does not exist/)

    await client.files.rm(['/renamed', '/not-there'], { recursive: true, force: true } as never)
    await expect(client.files.stat('/renamed')).rejects.toThrow(/file does not exist/)
  })

  it('files.read, files.ls, files.mkdir and files.cp work as the client sends them', async () => {
    await client.files.mkdir('/docs/inner', { parents: true })
    await client.files.write('/docs/a.txt', 'abc', { create: true, parents: true, flush: true })
    expect(new TextDecoder().decode(Buffer.concat(await collect(client.files.read('/docs/a.txt'))))).toBe('abc')
    const entries = await collect(client.files.ls('/docs'))
    expect(entries.map((entry) => `${entry.name}:${entry.type}`).sort()).toEqual(['a.txt:file', 'inner:directory'])
    const { cid } = await client.add('copied in', { pin: true })
    await client.files.cp(cid, '/docs/copied.txt')
    expect(new TextDecoder().decode(Buffer.concat(await collect(client.files.read('/docs/copied.txt'))))).toBe('copied in')
  })
})

describe('keys, names and routing', () => {
  it('imports a key by a raw request, publishes under it, resolves one hop and removes it', async () => {
    const key = privateKeyToProtobuf(await generateKeyPair('Ed25519'))
    const form = new FormData()
    form.append('file', new Blob([Uint8Array.from(key)]))
    const imported = await fetch(`${URL_BASE}/key/import?arg=community-key&ipns-base=b58mh`, { method: 'POST', body: form, headers: {} })
    expect(imported.status).toBe(200)
    const { Id } = await imported.json() as { Id: string }
    const again = await fetch(`${URL_BASE}/key/import?arg=community-key&ipns-base=b58mh`, { method: 'POST', body: form })
    expect(again.status).toBe(500)

    const added = await client.add('record target', { pin: true })
    const published = await client.name.publish(`/ipfs/${added.cid.toString()}`, { key: 'community-key', allowOffline: true, resolve: true, ttl: '20000ms' } as never)
    expect(published.name).toMatch(/^k51/)
    expect((await client.key.list()).find((one) => one.name === 'community-key')?.id).toBe(published.name)
    expect(published.value).toBe(`/ipfs/${added.cid.toString()}`)
    const resolved = await collect(client.name.resolve(Id, { nocache: true, recursive: false } as never))
    expect(resolved.at(-1)).toBe(`/ipfs/${added.cid.toString()}`)
    expect((await collect(client.name.resolve(published.name, { nocache: true, recursive: false } as never))).at(-1)).toBe(`/ipfs/${added.cid.toString()}`)
    await expect(collect(client.name.resolve('12D3KooWNoSuchName', { nocache: true, recursive: false } as never))).rejects.toThrow()

    await collect(client.routing.put(`/ipns/${Id}`, new TextEncoder().encode('signed'), { allowOffline: true } as never))
    expect((await client.key.list()).map((one) => one.name)).toContain('community-key')
    await client.key.rm('community-key')
    await expect(client.key.rm('community-key')).rejects.toThrow(/no key by the given name was found/)
  })

  it('config.get answers the gateway and Routing, and the raw config set and shutdown are accepted', async () => {
    const gateway = await client.config.get('Addresses.Gateway') as string
    expect(gateway).toBe('/ip4/127.0.0.1/tcp/5001')
    const parts = gateway.split('/').filter(Boolean)
    expect(`http://${parts[1]}:${parts[3]}`).toBe(API)
    const routing = await client.config.get('Routing') as { Routers?: unknown }
    expect(routing.Routers).toBeUndefined()
    const value = { Type: 'custom', Routers: { one: { Type: 'http', Parameters: { Endpoint: 'https://r.example' } } } }
    expect((await fetch(`${URL_BASE}/config?arg=Routing&arg=${JSON.stringify(value)}&json=true`, { method: 'POST' })).status).toBe(200)
    expect(await client.config.get('Routing')).toEqual(value)
    expect((await fetch(`${URL_BASE}/config?arg=Provide.DHT.SweepEnabled&arg=false&json=true`, { method: 'POST' })).status).toBe(200)
    expect((await fetch(`${URL_BASE}/shutdown`, { method: 'POST' })).status).toBe(200)
    expect((await client.id()).id.toString()).toMatch(/^12D3Koo/)
  })

  it('serves a signed record on the gateway the config names, with and without an Accept header', async () => {
    const key = privateKeyToProtobuf(await generateKeyPair('Ed25519'))
    const form = new FormData()
    form.append('file', new Blob([Uint8Array.from(key)]))
    const { Id } = await (await fetch(`${URL_BASE}/key/import?arg=gw-key&ipns-base=b58mh`, { method: 'POST', body: form })).json() as { Id: string }
    await collect(client.routing.put(`/ipns/${Id}`, new TextEncoder().encode('raw record'), { allowOffline: true } as never))
    for (const headers of [undefined, { Accept: 'application/vnd.ipfs.ipns-record' }]) {
      const response = await fetch(`${API}/ipns/${Id}?format=ipns-record`, headers === undefined ? {} : { headers })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/vnd.ipfs.ipns-record')
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('raw record')
    }
    expect((await fetch(`${API}/ipns/12D3KooWNoSuchName?format=ipns-record`)).status).toBe(404)
  })
})

describe('the node and pubsub', () => {
  it('id, swarm.addrs and swarm.peers', async () => {
    const id = await client.id()
    const addrs = await client.swarm.addrs()
    const own = addrs.filter((one) => one.id.toString() === id.id.toString())
    expect(own.flatMap((one) => one.addrs.map(String))).toContain('/ip4/127.0.0.1/tcp/4001')
    expect(await client.swarm.peers()).toEqual([])
  })

  it('pubsub.subscribe delivers a message, ls and peers answer, unsubscribe leaves, publish reaches the node', async () => {
    const received: Uint8Array[] = []
    const errors: unknown[] = []
    const handler = (message: { data: Uint8Array }): void => { received.push(message.data) }
    await client.pubsub.subscribe('challenge-topic', handler, { onError: (error: unknown) => errors.push(error) } as never)
    expect(env.node.subscribed()).toContain('challenge-topic')
    env.node.deliver('challenge-topic', new TextEncoder().encode('hello'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received.map((data) => new TextDecoder().decode(data))).toEqual(['hello'])
    expect(await client.pubsub.ls()).toContain('challenge-topic')
    env.node.peers.push('12D3KooWPeerOne')
    expect((await client.pubsub.peers('challenge-topic')).map(String)).toEqual(['12D3KooWPeerOne'])

    await client.pubsub.publish('challenge-topic', new TextEncoder().encode('reply'))
    expect(env.node.published.at(-1)).toEqual({ topic: 'challenge-topic', data: new TextEncoder().encode('reply') })

    await client.pubsub.unsubscribe('challenge-topic', handler)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(env.node.subscribed()).not.toContain('challenge-topic')
    expect(errors).toEqual([])
  })
})
