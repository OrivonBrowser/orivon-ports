// A stand-in for Orivon's IPFS node, answering its HTTP routes in memory: blocks, pins, files read through the
// UnixFS exporter, IPNS keys and records, and pubsub. It speaks the contract in README.md section The node's routes,
// so the facade runs against it through the real node client, a `fetch` in place of the socket.
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import * as dagPb from '@ipld/dag-pb'
import { exporter, walkPath } from 'ipfs-unixfs-exporter'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'

export const NODE_KEY = 'test-node-key'
export const NODE_PEER = '12D3KooWEscf9jtBwZtaZzgnZ66Kuoe5GthCoD4hxhmcSYwxo4XH'
const CODECS: Record<string, number> = { raw: 0x55, 'dag-pb': 0x70, 'dag-cbor': 0x71 }
const TEXT = new TextEncoder()

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const text = (status: number, body: string): Response => new Response(body, { status, headers: { 'content-type': 'text/plain' } })
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

export interface MockNode {
  fetch: typeof fetch
  blocks: Map<string, Uint8Array>
  pins: Set<string>
  keys: Map<string, { name: string, protobuf: Uint8Array }>
  records: Map<string, { value: string, sequence: number }>
  rawRecords: Map<string, Uint8Array>
  published: Array<{ topic: string, data: Uint8Array }>
  provided: string[]
  calls: string[]
  peers: string[]
  failNextPins: (count: number) => void
  deliver: (topic: string, data: Uint8Array, from?: string) => void
  subscribed: () => string[]
  putBlock: (bytes: Uint8Array, codec?: string) => Promise<CID>
}

export function createMockNode (): MockNode {
  const blocks = new Map<string, Uint8Array>()
  const pins = new Set<string>()
  const keys = new Map<string, { name: string, protobuf: Uint8Array }>()
  const records = new Map<string, { value: string, sequence: number }>()
  const rawRecords = new Map<string, Uint8Array>()
  const published: Array<{ topic: string, data: Uint8Array }> = []
  const provided: string[] = []
  const held = new Set<string>()
  const calls: string[] = []
  const subscribers = new Map<string, Set<(line: string) => void>>()
  const peers: string[] = []
  let busyPins = 0
  let sequence = 0

  const blockstore = {
    async * get (cid: CID): AsyncGenerator<Uint8Array> {
      const bytes = blocks.get(cid.toV1().toString())
      if (bytes === undefined) throw new Error(`block ${cid.toString()} not found`)
      yield bytes
    }
  }

  async function putBlock (bytes: Uint8Array, codec = 'raw'): Promise<CID> {
    const cid = CID.createV1(CODECS[codec] ?? 0x55, await sha256.digest(bytes))
    blocks.set(cid.toString(), bytes)
    return cid
  }

  function reachable (roots: Iterable<string>): Set<string> {
    const seen = new Set<string>()
    const walk = (key: string): void => {
      if (seen.has(key)) return
      const cid = CID.parse(key)
      const bytes = blocks.get(cid.toV1().toString())
      if (bytes === undefined) throw new Error(`missing block ${key}`)
      seen.add(cid.toV1().toString())
      if (cid.code === 0x70) for (const link of dagPb.decode(bytes).Links) walk(link.Hash.toString())
    }
    for (const root of roots) walk(root)
    return seen
  }

  /** The entry a UnixFS path names; a path with more names than the DAG has is not found. */
  async function entryAt (path: string): Promise<Awaited<ReturnType<typeof exporter>>> {
    const names = path.split('/').filter((part) => part !== '').length
    let walked = 0
    for await (const _entry of walkPath(path, blockstore)) walked++
    if (walked < names) throw new Error('no link named in the path')
    return exporter(path, blockstore)
  }

  async function keyName (protobuf: Uint8Array): Promise<string> {
    return peerIdFromPrivateKey(privateKeyFromProtobuf(protobuf)).toString()
  }

  async function handle (request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    calls.push(`${request.method} ${path}`)
    if (request.headers.get('x-orivon-key') !== NODE_KEY) return text(401, 'bad key')
    const tail = (prefix: string): string => decodeURIComponent(path.slice(prefix.length))

    if (path === '/id') return json({ peer: NODE_PEER })
    if (path === '/status') return json({ listen: ['/ip4/127.0.0.1/tcp/4001'], external: ['/ip4/203.0.113.7/tcp/4001'] })

    if (path === '/orivon/block/put' && request.method === 'POST') {
      const bytes = new Uint8Array(await request.arrayBuffer())
      const cid = await putBlock(bytes, url.searchParams.get('codec') ?? 'raw')
      if (url.searchParams.get('pin') === 'true') pins.add(cid.toString())
      return json({ cid: cid.toString(), size: bytes.length })
    }
    if (path.startsWith('/orivon/block/') && request.method === 'DELETE') {
      const key = CID.parse(tail('/orivon/block/')).toV1().toString()
      if (blocks.has(key) && (held.has(key) || [...pins].some((pinned) => CID.parse(pinned).toV1().toString() === key))) return text(409, `${key} is kept by a pin or a provided root; unpin or stop providing it first`)
      return blocks.delete(key) ? json({}) : text(404, 'block not found')
    }
    if (path.startsWith('/ipfs/') && url.searchParams.get('format') === 'raw') {
      const bytes = blocks.get(CID.parse(tail('/ipfs/')).toV1().toString())
      return bytes === undefined ? text(404, 'block not found') : new Response(bytes)
    }
    if (path.startsWith('/orivon/pin/') && request.method === 'POST') {
      if (busyPins > 0) { busyPins--; return text(429, 'a pin is running') }
      const cid = tail('/orivon/pin/')
      try { reachable([cid]) } catch (error) { return text(500, (error as Error).message) }
      pins.add(cid)
      return json({ cid })
    }
    if (path.startsWith('/orivon/pin/') && request.method === 'DELETE') {
      const cid = tail('/orivon/pin/')
      return pins.delete(cid) ? json({}) : text(404, 'not pinned')
    }
    if (path === '/orivon/pins') return json({ pins: [...pins].map((cid) => ({ cid, blocks: 1, bytes: 1 })) })

    if (path.startsWith('/orivon/cat/')) {
      try {
        const entry = await entryAt(tail('/orivon/cat/'))
        if (entry.type === 'directory') return text(400, 'this dag node is a directory')
        const offset = url.searchParams.get('offset')
        const length = url.searchParams.get('length')
        const chunks: Uint8Array[] = []
        for await (const chunk of (entry as { content: (o: object) => AsyncIterable<Uint8Array> }).content({
          ...(offset === null ? {} : { offset: Number(offset) }), ...(length === null ? {} : { length: Number(length) })
        })) chunks.push(chunk)
        return new Response(Buffer.concat(chunks))
      } catch (error) {
        return text(404, /no link named|not found|does not exist/i.test((error as Error).message) ? 'file does not exist' : (error as Error).message)
      }
    }
    if (path.startsWith('/orivon/resolve/')) {
      try {
        return json({ cid: (await entryAt(tail('/orivon/resolve/'))).cid.toString() })
      } catch { return text(404, 'file does not exist') }
    }
    if (path.startsWith('/orivon/ls/')) {
      const entry = await exporter(tail('/orivon/ls/'), blockstore)
      if (entry.type !== 'directory') return text(400, 'not a directory')
      const out = []
      for await (const child of (entry as unknown as { content: () => AsyncIterable<{ name: string, cid: CID, size: bigint, type: string }> }).content()) {
        out.push({ name: child.name, cid: child.cid.toString(), size: Number(child.size), type: child.type })
      }
      return json(out)
    }
    if (path === '/orivon/repo/stat') return json({ repoSize: [...blocks.values()].reduce((sum, bytes) => sum + bytes.length, 0), storageMax: 10_000_000_000, numObjects: blocks.size })
    if (path === '/orivon/repo/gc') {
      const keep = reachable(pins)
      const removed: string[] = []
      for (const key of [...blocks.keys()]) if (!keep.has(key)) { blocks.delete(key); removed.push(key) }
      return json({ removed })
    }
    if (path.startsWith('/orivon/provide/') && request.method === 'DELETE') {
      return held.delete(CID.parse(tail('/orivon/provide/')).toV1().toString()) ? json({}) : text(404, 'not providing it')
    }
    if (path.startsWith('/orivon/provide/')) { provided.push(tail('/orivon/provide/')); held.add(CID.parse(tail('/orivon/provide/')).toV1().toString()); return json({}) }

    if (path === '/orivon/ipns/keys/import') {
      const label = url.searchParams.get('label') ?? ''
      if (keys.has(label)) return text(409, 'key exists')
      const protobuf = new Uint8Array(await request.arrayBuffer())
      const name = await keyName(protobuf)
      keys.set(label, { name, protobuf })
      return json({ label, name })
    }
    if (path === '/orivon/ipns/keys' && request.method === 'POST') {
      const { label } = await request.json() as { label: string }
      if (keys.has(label)) return text(409, 'key exists')
      const protobuf = privateKeyToProtobuf(await generateKeyPair('Ed25519'))
      const name = await keyName(protobuf)
      keys.set(label, { name, protobuf })
      return json({ label, name })
    }
    if (path === '/orivon/ipns/keys') return json([...keys].map(([label, key]) => ({ label, name: key.name })))
    if (path.startsWith('/orivon/ipns/keys/') && request.method === 'DELETE') {
      return keys.delete(tail('/orivon/ipns/keys/')) ? json({}) : text(404, 'no such key')
    }
    if (path === '/orivon/ipns/publish') {
      const body = await request.json() as { label: string, value: string }
      const key = keys.get(body.label)
      if (key === undefined) return text(404, 'no such key')
      const record = { value: body.value, sequence: ++sequence }
      records.set(key.name, record)
      rawRecords.set(key.name, TEXT.encode(JSON.stringify(record)))
      return json({ name: key.name, ...record })
    }
    if (path.startsWith('/orivon/name/resolve/')) {
      const record = records.get(tail('/orivon/name/resolve/'))
      return record === undefined ? text(404, 'could not resolve name') : json({ value: record.value })
    }
    if (path === '/orivon/routing/put') {
      calls.push(`routing/put allowOffline=${url.searchParams.get('allowOffline') ?? 'unset'}`)
      rawRecords.set((url.searchParams.get('key') ?? '').replace('/ipns/', ''), new Uint8Array(await request.arrayBuffer()))
      return json({})
    }
    if (path.startsWith('/ipns/') && url.searchParams.get('format') === 'ipns-record') {
      const record = rawRecords.get(tail('/ipns/'))
      return record === undefined ? text(404, 'no record') : new Response(record, { headers: { 'content-type': 'application/vnd.ipfs.ipns-record' } })
    }

    if (path === '/pubsub/sub') {
      const topic = url.searchParams.get('topic') ?? ''
      let listener: (line: string) => void = () => {}
      const stream = new ReadableStream<Uint8Array>({
        start (controller) {
          listener = (line) => controller.enqueue(TEXT.encode(`${line}\n`))
          subscribers.set(topic, (subscribers.get(topic) ?? new Set()).add(listener))
          request.signal.addEventListener('abort', () => { subscribers.get(topic)?.delete(listener); try { controller.close() } catch { /* closed */ } })
        },
        cancel () { subscribers.get(topic)?.delete(listener) }
      })
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
    }
    if (path === '/pubsub/pub') {
      published.push({ topic: url.searchParams.get('topic') ?? '', data: new Uint8Array(await request.arrayBuffer()) })
      return json({})
    }
    if (path === '/pubsub/ls') return json({ topics: [...subscribers].filter(([, set]) => set.size > 0).map(([topic]) => topic) })
    if (path === '/pubsub/peers') return json({ peers })
    if (path === '/orivon/swarm/peers') return json({ peers: peers.map((peer) => ({ peer, addr: '/ip4/127.0.0.1/tcp/4001' })) })
    return text(404, `no route ${request.method} ${path}`)
  }

  return {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch,
    blocks, pins, keys, records, rawRecords, published, provided, calls, peers, putBlock,
    failNextPins: (count) => { busyPins = count },
    subscribed: () => [...subscribers].filter(([, set]) => set.size > 0).map(([topic]) => topic),
    deliver (topic, data, from = NODE_PEER) {
      for (const listener of subscribers.get(topic) ?? []) {
        listener(JSON.stringify({ from, data: toBase64(data), seqno: toBase64(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1])), topicIDs: [topic] }))
      }
    }
  }
}
