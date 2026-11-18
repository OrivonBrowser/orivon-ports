// Each kubo route against the mock node: the shape of the answer, the words of the errors pkc-js matches, and what
// reaches the node.
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeRpcText } from '../kubo/wire.js'
import { bytes, createEnv, lines, textOf } from './support/env.ts'

const HELLO_V0 = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o'

let env: Awaited<ReturnType<typeof createEnv>>
beforeEach(async () => { env = await createEnv() })
afterEach(async () => { await env.cleanup() })

async function failure (response: Response): Promise<{ Message: string, Code: number, Type: string }> {
  expect(response.ok).toBe(false)
  return await response.json() as { Message: string, Code: number, Type: string }
}

describe('add', () => {
  it('adds as ipfs add does: CIDv0, dag-pb, pinned, one line per file', async () => {
    const response = await env.call('add', { body: 'hello world\n', query: { pin: true } })
    expect(await lines(response)).toEqual([{ Name: HELLO_V0, Hash: HELLO_V0, Size: '20' }])
    expect([...env.node.pins]).toEqual([expect.stringMatching(/^bafybei/)])
  })

  it('reads the CIDv1 and raw-leaves options', async () => {
    const [entry] = await lines<{ Hash: string }>(await env.call('add', { body: 'hello world\n', query: { 'cid-version': 1, 'raw-leaves': true } }))
    expect(entry?.Hash).toMatch(/^bafkrei/)
  })

  it('stores nothing with only-hash and pins nothing with pin=false', async () => {
    const [hashed] = await lines<{ Hash: string }>(await env.call('add', { body: 'hello world\n', query: { 'only-hash': true } }))
    expect(hashed?.Hash).toBe(HELLO_V0)
    expect(env.node.blocks.size).toBe(0)
    await env.call('add', { body: 'x', query: { pin: false } })
    expect(env.node.pins.size).toBe(0)
  })

  it('splits a large file into 256 KiB blocks that cat reads back whole', async () => {
    const big = new Uint8Array(700_000).map((_, index) => index % 251)
    const [entry] = await lines<{ Hash: string }>(await env.call('add', { body: big }))
    const read = await env.call('cat', { args: [entry?.Hash ?? ''] })
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(big)
    expect(env.node.blocks.size).toBe(4)
  })

  it('wraps in a directory when asked, naming the wrapper last', async () => {
    const out = await lines<{ Name: string, Hash: string }>(await env.call('add', { body: 'a', filename: 'a.txt', query: { 'wrap-with-directory': true } }))
    expect(out.map((entry) => entry.Name)).toEqual(['a.txt', ''])
  })

  it('refuses a hash it cannot compute', async () => {
    expect((await failure(await env.call('add', { body: 'a', query: { hash: 'blake3' } }))).Message).toMatch(/only sha2-256/)
  })
})

describe('blocks, content and pins', () => {
  it('block/put answers the CIDv1 kubo does and pins on request', async () => {
    const answer = await env.json<{ Key: string, Size: number }>('block/put', { body: 'raw bytes', query: { format: 'raw', mhtype: 'sha2-256', version: 1, pin: true } })
    expect(answer.Key).toMatch(/^bafkrei/)
    expect(answer.Size).toBe(9)
    expect(env.node.pins.has(answer.Key)).toBe(true)
  })

  it('block/rm streams one line per block, naming a missing one unless forced', async () => {
    const { Key } = await env.json<{ Key: string }>('block/put', { body: 'x' })
    expect(await lines(await env.call('block/rm', { args: [Key] }))).toEqual([{ Hash: Key }])
    expect(await lines(await env.call('block/rm', { args: [Key] }))).toEqual([{ Hash: Key, Error: 'blockstore: block not found' }])
    expect(await lines(await env.call('block/rm', { args: [Key], query: { force: true } }))).toEqual([{ Hash: Key }])
  })

  it('block/rm stops the provide that holds a block and removes it, as a kubo whose provide holds nothing does', async () => {
    const { Key } = await env.json<{ Key: string }>('block/put', { body: 'a comment' })
    await env.call('routing/provide', { args: [Key] })
    expect(await lines(await env.call('block/rm', { args: [Key], query: { force: true } }))).toEqual([{ Hash: Key }])
    expect(env.node.blocks.size).toBe(0)
  })

  it('block/rm answers a pinned block with an error line of its own, never a failed call, and keeps it', async () => {
    const { Key } = await env.json<{ Key: string }>('block/put', { body: 'a pinned comment', query: { pin: true } })
    const answer = await env.call('block/rm', { args: [Key], query: { force: true } })
    expect(answer.status).toBe(200)
    expect(await lines(answer)).toEqual([{ Hash: Key, Error: 'pinned: kept by a pin' }])
    expect(env.node.blocks.size).toBe(1)
  })

  it('cat answers "file does not exist" for what the node cannot find, and honours offset and length', async () => {
    const [entry] = await lines<{ Hash: string }>(await env.call('add', { body: 'hello world\n' }))
    expect(textOf(new Uint8Array(await (await env.call('cat', { args: [entry?.Hash ?? ''], query: { offset: 6, length: 5 } })).arrayBuffer()))).toBe('world')
    expect((await failure(await env.call('cat', { args: [`${entry?.Hash}/nope`] }))).Message).toBe('file does not exist')
  })

  it('resolve answers the path of a CID', async () => {
    expect(await env.json('resolve', { args: [`/ipfs/${HELLO_V0}`] })).toEqual({ Path: `/ipfs/${HELLO_V0}` })
  })

  it('pin/ls words an unpinned path as kubo does, and lists pins as a map or a stream', async () => {
    const [entry] = await lines<{ Hash: string }>(await env.call('add', { body: 'hello world\n' }))
    const other = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
    expect((await failure(await env.call('pin/ls', { args: [other] }))).Message).toBe(`path '${other}' is not pinned`)
    expect((await failure(await env.call('pin/ls', { args: [`/ipfs/${entry?.Hash}`, `/ipfs/${other}`] }))).Message).toMatch(/is not pinned/)
    const keys = (await env.json<{ Keys: Record<string, { Type: string }> }>('pin/ls', { args: [entry?.Hash ?? ''] })).Keys
    expect(Object.values(keys)).toEqual([{ Type: 'recursive' }])
    expect(await lines(await env.call('pin/ls', { query: { stream: true } }))).toEqual([{ Cid: expect.any(String), Type: 'recursive' }])
  })

  it('pin/rm unpins, and words an unpinned one as "not pinned or pinned indirectly"', async () => {
    const [entry] = await lines<{ Hash: string }>(await env.call('add', { body: 'hello world\n' }))
    expect(await env.json('pin/rm', { args: [entry?.Hash ?? ''], query: { recursive: true } })).toEqual({ Pins: [entry?.Hash] })
    expect(env.node.pins.size).toBe(0)
    expect((await failure(await env.call('pin/rm', { args: [entry?.Hash ?? ''] }))).Message).toBe('not pinned or pinned indirectly')
  })

  it('repo/stat has the size and the object count, repo/gc streams the blocks it drops', async () => {
    await env.call('block/put', { body: 'unpinned' })
    await env.call('add', { body: 'hello world\n' })
    const stat = await env.json<{ RepoSize: number, NumObjects: number }>('repo/stat', { query: { 'size-only': true } })
    expect(stat.RepoSize).toBeGreaterThan(0)
    expect(stat.NumObjects).toBe(2)
    const dropped = await lines<{ Key: { '/': string } }>(await env.call('repo/gc', { query: { quiet: true } }))
    expect(dropped).toHaveLength(1)
    expect(env.node.blocks.has(dropped[0]?.Key['/'] ?? '')).toBe(false)
    expect(env.node.blocks.size).toBe(1)
  })

  it('routing/provide streams one event and the provide reaches the node', async () => {
    expect(await lines(await env.call('routing/provide', { args: [HELLO_V0], query: { recursive: true } }))).toHaveLength(1)
    expect(env.node.provided).toHaveLength(1)
  })

  it('retries a pin the node answers with 429', async () => {
    env.node.failNextPins(3)
    await env.call('add', { body: 'hello world\n' })
    expect(env.node.pins.size).toBe(1)
  })
})

describe('keys and names', () => {
  async function keyBytes (): Promise<Uint8Array> {
    return privateKeyToProtobuf(await generateKeyPair('Ed25519'))
  }

  it('key/import answers the name in the base asked for and refuses a second import with kubo\'s words', async () => {
    const key = await keyBytes()
    const answer = await env.json<{ Name: string, Id: string }>('key/import', { args: ['community'], query: { 'ipns-base': 'b58mh' }, body: key })
    expect(answer.Name).toBe('community')
    expect(answer.Id).toMatch(/^12D3Koo/)
    expect((await failure(await env.call('key/import', { args: ['community'], body: key }))).Message).toBe("key with name 'community' already exists")
    await env.call('key/import', { args: ['other'], body: await keyBytes() })
    const listed = await env.json<{ Keys: Array<{ Name: string, Id: string }> }>('key/list')
    expect(listed.Keys.find((one) => one.Name === 'other')?.Id).toMatch(/^k51/)
  })

  it('key/rm removes, and words a missing key as kubo does', async () => {
    await env.call('key/import', { args: ['community'], body: await keyBytes() })
    expect((await env.json<{ Keys: unknown[] }>('key/rm', { args: ['community'], query: { 'ipns-base': 'b58mh' } })).Keys).toHaveLength(1)
    expect((await failure(await env.call('key/rm', { args: ['community'] }))).Message).toBe('no key by the given name was found')
  })

  it('name/publish records the value under the key and name/resolve reads one hop or the whole chain', async () => {
    const { Id } = await env.json<{ Id: string }>('key/import', { args: ['a'], query: { 'ipns-base': 'b58mh' }, body: await keyBytes() })
    const second = await env.json<{ Id: string }>('key/import', { args: ['b'], query: { 'ipns-base': 'b58mh' }, body: await keyBytes() })
    const published = await env.json<{ Name: string, Value: string }>('name/publish', { args: [`/ipfs/${HELLO_V0}`], query: { key: 'a', 'allow-offline': true, resolve: true, ttl: '20000ms', lifetime: '24h', 'ipns-base': 'b58mh' } })
    expect(published).toEqual({ Name: Id, Value: `/ipfs/${HELLO_V0}` })
    await env.call('name/publish', { args: [`/ipns/${Id}`], query: { key: 'b' } })
    expect(await env.json('name/resolve', { args: [second.Id], query: { recursive: false, nocache: true } })).toEqual({ Path: `/ipns/${Id}` })
    expect(await env.json('name/resolve', { args: [second.Id] })).toEqual({ Path: `/ipfs/${HELLO_V0}` })
    expect((await failure(await env.call('name/resolve', { args: ['12D3KooWNothingHere'] }))).Message).toMatch(/could not resolve name/)
    expect((await failure(await env.call('name/publish', { args: [`/ipfs/${HELLO_V0}`], query: { key: 'missing' } }))).Message).toBe('no key by the given name was found')
  })

  it('routing/put hands a signed record to the node', async () => {
    const { Id } = await env.json<{ Id: string }>('key/import', { args: ['a'], query: { 'ipns-base': 'b58mh' }, body: await keyBytes() })
    expect(await lines(await env.call('routing/put', { args: [`/ipns/${Id}`], body: bytes('signed record'), query: { 'allow-offline': true } }))).toHaveLength(1)
    expect(textOf(env.node.rawRecords.get(Id) ?? new Uint8Array())).toBe('signed record')
    expect(env.node.calls).toContain('routing/put allowOffline=true')
  })

  it('routing/put waits for the network unless the caller allows the node to be offline, as kubo does', async () => {
    const { Id } = await env.json<{ Id: string }>('key/import', { args: ['a'], query: { 'ipns-base': 'b58mh' }, body: await keyBytes() })
    await lines(await env.call('routing/put', { args: [`/ipns/${Id}`], body: bytes('signed record') }))
    expect(env.node.calls).toContain('routing/put allowOffline=unset')
  })
})

describe('pubsub', () => {
  it('streams messages in kubo\'s multibase form and unsubscribes when the reader goes away', async () => {
    const topic = 'a-topic'
    const controller = new AbortController()
    const url = new URL('http://127.0.0.1:5001/api/v0/pubsub/sub')
    url.searchParams.set('arg', encodeRpcText(topic))
    const response = await env.facade.handle(new Request(url, { method: 'POST', signal: controller.signal }))
    expect(env.node.subscribed()).toEqual([topic])
    env.node.deliver(topic, bytes('hi'))
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const message = JSON.parse(textOf((await reader.read()).value ?? new Uint8Array())) as { from: string, data: string, seqno: string, topicIDs: string[] }
    expect(message.data).toBe(`u${Buffer.from('hi').toString('base64url')}`)
    expect(message.seqno).toMatch(/^u/)
    expect(message.topicIDs).toEqual([encodeRpcText(topic)])
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(env.node.subscribed()).toEqual([])
  })

  it('publishes the body to the topic, lists topics and peers', async () => {
    const topic = encodeRpcText('chat')
    await env.call('pubsub/pub', { args: [topic], body: bytes('payload') })
    expect(env.node.published).toEqual([{ topic: 'chat', data: bytes('payload') }])
    env.node.peers.push('12D3KooWPeer')
    expect(await env.json('pubsub/peers', { args: [topic] })).toEqual({ Strings: ['12D3KooWPeer'] })
    expect(await env.json('pubsub/ls')).toEqual({ Strings: [] })
  })
})

describe('node information and configuration', () => {
  it('id and swarm/addrs list the node\'s own addresses with and without its peer suffix', async () => {
    const id = await env.json<{ ID: string, Addresses: string[] }>('id')
    expect(id.ID).toMatch(/^12D3Koo/)
    expect(id.Addresses).toContain(`/ip4/127.0.0.1/tcp/4001/p2p/${id.ID}`)
    expect(await env.json('swarm/addrs')).toEqual({ Addrs: { [id.ID]: ['/ip4/127.0.0.1/tcp/4001', '/ip4/203.0.113.7/tcp/4001'] } })
  })

  it('swarm/peers lists the peers the node is connected to, with an address each', async () => {
    env.node.peers.push('12D3KooWPeer')
    expect((await env.json<{ Peers: Array<{ Peer: string, Addr: string }> }>('swarm/peers')).Peers).toEqual([expect.objectContaining({ Peer: '12D3KooWPeer', Addr: '/ip4/127.0.0.1/tcp/4001' })])
  })

  it('config answers Addresses.Gateway with the facade\'s gateway, and stores what is set', async () => {
    expect(await env.json('config', { args: ['Addresses.Gateway'] })).toEqual({ Key: 'Addresses.Gateway', Value: '/ip4/127.0.0.1/tcp/5001' })
    expect((await env.json<{ Value: unknown }>('config', { args: ['Routing'] })).Value).toEqual({})
    const routing = { Type: 'custom', Routers: { one: { Type: 'http', Parameters: { Endpoint: 'https://router.example' } } } }
    await env.call('config', { args: ['Routing', JSON.stringify(routing)], query: { json: true } })
    await env.call('config', { args: ['Provide.DHT.SweepEnabled', 'false'], query: { json: true } })
    expect(await env.json('config', { args: ['Routing'] })).toEqual({ Key: 'Routing', Value: routing })
    expect(env.facade.getConfig('Provide.DHT.SweepEnabled')).toBe(false)
    expect((await failure(await env.call('config', { args: ['No.Such.Key'] }))).Message).toMatch(/no.such.key|No\.Such\.Key/i)
  })

  it('shutdown is accepted and does nothing', async () => {
    const response = await env.call('shutdown')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect((await env.call('id')).status).toBe(200)
  })

  it('version answers a version string', async () => {
    expect((await env.json<{ Version: string }>('version')).Version).toMatch(/\d/)
  })
})

describe('what the facade refuses', () => {
  it('answers a command outside the surface as not implemented, in kubo\'s error shape', async () => {
    const response = await env.call('dag/get', { args: ['bafy'] })
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({ Message: expect.stringMatching(/not implemented/), Code: 0, Type: 'error' })
  })

  it('answers only POST on the API', async () => {
    expect((await env.facade.handle(new Request('http://127.0.0.1:5001/api/v0/id'))).status).toBe(405)
  })

  it('refuses a request from a web page and one without the key, when a key is set', async () => {
    const guarded = await createEnv({ apiKey: 'secret' })
    try {
      const open = (headers: Record<string, string>): Promise<Response> => guarded.facade.handle(new Request('http://127.0.0.1:5001/api/v0/id', { method: 'POST', headers }))
      expect((await open({})).status).toBe(401)
      expect((await open({ authorization: 'Bearer secret' })).status).toBe(200)
      expect((await open({ authorization: 'Bearer secret', origin: 'https://evil.example' })).status).toBe(403)
    } finally {
      await guarded.cleanup()
    }
  })

  it('words a node failure as a kubo error and keeps working', async () => {
    const response = await env.call('block/put', { query: { format: 'zip' }, body: 'x' })
    expect((await failure(response)).Type).toBe('error')
    expect((await env.call('id')).status).toBe(200)
  })
})
