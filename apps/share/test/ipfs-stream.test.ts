import { describe, expect, it, vi } from 'vitest'
import { cidFor, DAG_PB, parseCid, readCidBytes } from '../page/src/ipfs/cid.js'
import { decodeNode, encodeNode, encodeUnixfs } from '../page/src/ipfs/dagpb.js'
import { readCar, writeCar } from '../page/src/ipfs/car.js'
import { createBatcher } from '../page/src/ipfs/car-batches.js'
import { readCarStream, TooLargeError } from '../page/src/ipfs/car-stream.js'
import { listTree, mapLimit, readFileBlob } from '../page/src/ipfs/dagwalk.js'
import { describeBlock } from '../page/src/ipfs/dagread.js'
import { fetchBlock, fetchBlocks, fetchFileBlob } from '../page/src/ipfs/gateway.js'
import { MAX_DIRECTORY_ENTRIES, directoryProblem, importContent, importDirectory, importTree } from '../page/src/ipfs/unixfs.js'

type BlobPart = string | Blob | ArrayBuffer | Uint8Array

// Every CID below was printed by Kubo 0.43.1 on a throwaway repository:
// `ipfs add --only-hash --cid-version=1 -Q [--chunker=size-N] <file>` and `ipfs add -r --cid-version=1 -Q <dir>`.
const CHUNK_16: Record<number, string> = {
  175: 'bafybeif5ypme7igodosqg6hy5xjsekgqeuyh54cp4wtsbi7q3hm4oems4m',
  30276: 'bafybeidackigmofotyqzgov2sl3fhft36b5xbs6iot3z47ghfih2xmapvi',
  30277: 'bafybeibw62jjmmnjx6t23caigmpg65vbu3swak3vohb6mznynyltxmvxzi',
  60553: 'bafybeicfrry3hdpr3hqfobetc7dbevsxjmh3w24lwehppkvtzpfq76fc2m'
}
const CHUNK_1024: Record<number, string> = {
  174: 'bafybeibod2h4t23kavvmzspxv2l75of7z7nbmdnqiy4viydisdh7lxcaii',
  175: 'bafybeigsjadij6xlwivyz5d4p7t5m4qstnivicpechudbokz6xlofzfpmy'
}
const MIX_CID = 'bafybeihbtej2hpamcgqyxdozpfihcn62pxkrrftvxhuu6lbw3mx2zynjm4'
const UNICODE_CID = 'bafybeihd6jrxkgqqyzrhmpcsmncsij2saf3w6ojdonoeht3tmddnhnbi34'
/** 900 empty files with names of 255 characters: 261,900 bytes of links, the most Kubo keeps flat here. */
const WIDE_NAMES_CID = 'bafybeihmrsos2s6jext4jjcow7rsbfjjtr6pr3hrhscx74ccbimdonul6m'
/** Kubo turns the same directory with 901 entries (262,191 bytes of links) into a HAMT shard; at exactly 262,144 it keeps it flat. */
const WIDE_NAMES_SHARDED = 'bafybeicvaaixs4kvw5b3jdaax6ewvvrtr5mqmxwwh454budm2ft3wecdh4'

const text = new TextEncoder()
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b))

function pattern (size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7 + (i >>> 18)) & 255
  return bytes
}

const MIX: Record<string, Uint8Array> = {
  'index.html': text.encode('<h1>Hi</h1>\n'),
  'assets/app.js': text.encode('console.log(1)\n'),
  'assets/big.bin': pattern(700_000),
  'docs/readme.md': text.encode('# readme\n'),
  'docs/sub/deep.txt': text.encode('deep\n'),
  'empty.txt': new Uint8Array(0),
  'video/clip.bin': pattern(3_000_000)
}
const mixFiles = () => Object.entries(MIX).map(([path, bytes]) => ({ path, content: new Blob([bytes as BlobPart]) }))

async function collect (files: { path: string, content: Blob | Uint8Array }[]) {
  const blocks = new Map<string, Uint8Array>()
  const imported = await importTree(files, (cid, bytes) => { blocks.set(cid, bytes.slice()) })
  return { ...imported, blocks }
}

describe('importContent from a Blob', () => {
  it('makes the CIDs Kubo makes for files of 175, 30,276 and 30,277 leaves: one, two and three levels', async () => {
    for (const [leaves, cid] of Object.entries(CHUNK_16)) {
      const imported = await importContent(new Blob([pattern(Number(leaves) * 16) as BlobPart]), () => {}, { chunkSize: 16 })
      expect(imported.cid, `${leaves} leaves`).toBe(cid)
    }
    for (const [leaves, cid] of Object.entries(CHUNK_1024)) {
      expect((await importContent(new Blob([pattern(Number(leaves) * 1024) as BlobPart]), () => {}, { chunkSize: 1024 })).cid).toBe(cid)
    }
  }, 60_000)

  it('builds the tree balanced: a full node of 174 links, then a root over two', async () => {
    const blocks = new Map<string, Uint8Array>()
    const third = await importContent(new Blob([pattern(30_277 * 16) as BlobPart]), (cid, bytes) => { blocks.set(cid, bytes.slice()) }, { chunkSize: 16 })
    expect(third.blocks).toBe(30_455)
    const top = decodeNode(blocks.get(third.cid)!)
    expect(top.links).toHaveLength(2)
    const full = await importContent(new Blob([pattern(30_276 * 16) as BlobPart]), (cid, bytes) => { blocks.set(cid, bytes.slice()) }, { chunkSize: 16 })
    expect(decodeNode(blocks.get(full.cid)!).links).toHaveLength(174)
  }, 60_000)

  it('matches importFile for the sizes DecentraWiki tested, and reads a Blob in windows of 1 MiB', async () => {
    const slice = vi.spyOn(Blob.prototype, 'slice')
    try {
      const blob = new Blob([pattern(3_000_000) as BlobPart])
      const imported = await importContent(blob, () => {})
      expect(imported.cid).toBe('bafybeic5tlhnr3fcticci3x3sybhhall6f6xn6oewmqvrxbecvl2oa5skm')
      const widths = slice.mock.calls.map(([start, end]) => (end as number) - (start as number))
      expect(Math.max(...widths)).toBeLessThanOrEqual(1_048_576)
      expect(widths.length).toBeGreaterThanOrEqual(3)
    } finally {
      slice.mockRestore()
    }
  })

  it('hands each block over as it is made and keeps none', async () => {
    const seen: number[] = []
    const imported = await importContent(new Blob([pattern(1_500_000) as BlobPart]), (_cid, bytes) => { seen.push(bytes.length) })
    expect(seen.slice(0, 5)).toEqual([262_144, 262_144, 262_144, 262_144, 262_144])
    expect(imported.blocks).toBe(seen.length)
    expect(imported.bytes).toBe(1_500_000)
  })

  it('reports the bytes it has read, stops when told to and notices a file that shrank', async () => {
    const read: number[] = []
    await importContent(new Blob([pattern(2_500_000) as BlobPart]), () => {}, { onBytes: (n) => read.push(n) })
    expect(read.reduce((a, b) => a + b, 0)).toBe(2_500_000)
    const controller = new AbortController()
    controller.abort()
    await expect(importContent(new Blob([pattern(10) as BlobPart]), () => {}, { signal: controller.signal })).rejects.toThrow()
    const shrunk = { size: 100, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(10) }) } as unknown as Blob
    await expect(importContent(shrunk, () => {})).rejects.toThrow('changed while')
  })
})

describe('importTree matches Kubo', () => {
  it('a folder of nested directories, files over a chunk, and an empty file', async () => {
    const imported = await collect(mixFiles())
    expect(imported.cid).toBe(MIX_CID)
    expect(imported.bytes).toBe(Object.values(MIX).reduce((n, b) => n + b.length, 0))
    const legacy = await importDirectory(Object.entries(MIX).map(([path, bytes]) => ({ path, bytes })))
    expect(legacy.cid).toBe(MIX_CID)
  })

  it('names with accents and non-Latin letters', async () => {
    const imported = await collect([{ path: 'ñandú.txt', content: text.encode('a') }, { path: '日本語.txt', content: text.encode('b') }])
    expect(imported.cid).toBe(UNICODE_CID)
  })

  it('gives a block that two files share to the sink each time', async () => {
    const seen = new Map<string, number>()
    await importTree([{ path: 'a', content: text.encode('same') }, { path: 'b', content: text.encode('same') }], (cid) => { seen.set(cid, (seen.get(cid) ?? 0) + 1) })
    expect([...seen.values()].sort()).toEqual([1, 2])
  })

  it('keeps a directory flat up to the edge where Kubo shards it, and refuses from there', async () => {
    const wide = (count: number) => Array.from({ length: count }, (_, i) => ({ path: String(i).padStart(5, '0').padEnd(255, 'x'), content: new Uint8Array(0) }))
    expect((await collect(wide(900))).cid).toBe(WIDE_NAMES_CID)
    await expect(collect(wide(901))).rejects.toThrow('too long together')
    expect(WIDE_NAMES_SHARDED).not.toBe(WIDE_NAMES_CID)
  })

  it('counts the bytes of a name, not its letters, and 36 bytes for each link', () => {
    expect(directoryProblem('', Array.from({ length: 1000 }, (_, i) => `n${i}`))).toBeNull()
    expect(directoryProblem('', Array.from({ length: 1001 }, (_, i) => `n${i}`))).toContain('holds 1001 items')
    expect(MAX_DIRECTORY_ENTRIES).toBe(1000)
    // A name of 3 + 84 letters of 3 bytes each is 255 bytes: 900 of them with their links are 261,900 bytes, 901 are 262,191.
    const names = (count: number) => Array.from({ length: count }, (_, i) => `${String(i).padStart(3, '0')}${'日'.repeat(84)}`)
    expect(directoryProblem('docs', names(900))).toBeNull()
    expect(directoryProblem('docs', names(901))).toContain('"docs"')
    expect(directoryProblem('docs', names(901))).toContain('256 KiB')
  })

  it('names the folder in the message', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ path: `photos/2026/${i}`, content: new Uint8Array(0) }))
    await expect(collect(many)).rejects.toThrow('"photos/2026" holds 1001 items')
  })
})

describe('createBatcher', () => {
  async function blocksOf (count: number, size: number) {
    const out: [string, Uint8Array][] = []
    for (let i = 0; i < count; i++) {
      const bytes = new Uint8Array(size).fill(i % 251)
      bytes[0] = i & 255
      bytes[1] = i >> 8
      out.push([(await cidFor(0x55, bytes)).string, bytes])
    }
    return out
  }

  it('cuts batches under the limit and gives each its own header naming its first block', async () => {
    const batches: { blob: Blob, blocks: number }[] = []
    const blocks = await blocksOf(10, 1000)
    const batcher = createBatcher({ batchBytes: 3000, header: 'each', rootFor: (first) => first, onBatch: (blob, info) => { batches.push({ blob, blocks: info.blocks }) } })
    for (const [cid, bytes] of blocks) await batcher.sink(cid, bytes)
    await batcher.finish()
    expect(batches.length).toBeGreaterThan(3)
    expect(batches.every((b) => b.blob.size <= 3000)).toBe(true)
    let at = 0
    for (const batch of batches) {
      const read = await readCar(new Uint8Array(await batch.blob.arrayBuffer()))
      expect([...read.keys()]).toEqual(blocks.slice(at, at + batch.blocks).map(([cid]) => cid))
      at += batch.blocks
    }
    expect(at).toBe(10)
    expect(batcher.blocks).toBe(10)
  })

  it('makes one CAR of the whole share when only the first batch carries a header', async () => {
    const parts: Blob[] = []
    const blocks = await blocksOf(8, 900)
    const root = blocks[7]![0]
    const batcher = createBatcher({ batchBytes: 2500, header: 'first', rootFor: () => root, onBatch: (blob) => { parts.push(blob) } })
    for (const [cid, bytes] of blocks) await batcher.sink(cid, bytes)
    await batcher.finish()
    expect(parts.length).toBeGreaterThan(2)
    const whole = await readCar(new Uint8Array(await new Blob(parts).arrayBuffer()), root)
    expect(whole.size).toBe(8)
  })

  it('leaves out a block it has been given before, and a batch with nothing in it is not sent', async () => {
    const sent: number[] = []
    const blocks = await blocksOf(2, 100)
    const batcher = createBatcher({ batchBytes: 100_000, header: 'each', rootFor: (first) => first, onBatch: (_blob, info) => { sent.push(info.blocks) } })
    await batcher.finish()
    for (const [cid, bytes] of [...blocks, ...blocks]) await batcher.sink(cid, bytes)
    await batcher.finish()
    expect(sent).toEqual([2])
  })

  it('waits for a batch to be taken before it makes the next', async () => {
    const order: string[] = []
    const blocks = await blocksOf(4, 1000)
    const batcher = createBatcher({
      batchBytes: 1500, header: 'each', rootFor: (first) => first,
      onBatch: async () => { order.push('start'); await new Promise((resolve) => setTimeout(resolve, 5)); order.push('end') }
    })
    for (const [cid, bytes] of blocks) await batcher.sink(cid, bytes)
    await batcher.finish()
    expect(order).toEqual(['start', 'end', 'start', 'end', 'start', 'end', 'start', 'end'])
  })
})

/** A CAR as a stream in pieces of `piece` bytes. */
function streamOf (bytes: Uint8Array, piece: number) {
  let at = 0
  return new ReadableStream<Uint8Array>({
    pull (controller) {
      if (at >= bytes.length) { controller.close(); return }
      controller.enqueue(bytes.slice(at, at + piece))
      at += piece
    }
  })
}

describe('readCarStream', () => {
  async function site () {
    const imported = await collect(mixFiles())
    return { ...imported, car: writeCar(imported.cid, imported.blocks) }
  }

  it('gives every block, whatever size the pieces arrive in', async () => {
    const small = await collect([{ path: 'a.txt', content: text.encode('hello') }, { path: 'b/c.bin', content: pattern(1000) }])
    const smallCar = writeCar(small.cid, small.blocks)
    for (const piece of [1, 7, 1000, smallCar.length]) {
      const seen = new Map<string, Uint8Array>()
      for await (const block of readCarStream(streamOf(smallCar, piece), { expectedRoot: small.cid })) seen.set(block.cid, block.data)
      expect([...seen.keys()].sort(), `pieces of ${piece}`).toEqual([...small.blocks.keys()].sort())
    }
    const { cid, blocks, car } = await site()
    const seen = new Map<string, Uint8Array>()
    for await (const block of readCarStream(streamOf(car, 70_000), { expectedRoot: cid })) seen.set(block.cid, block.data)
    expect([...seen.keys()].sort()).toEqual([...blocks.keys()].sort())
  })

  it('counts what it has read and stops at a limit', async () => {
    const { car } = await site()
    const totals: number[] = []
    for await (const block of readCarStream(streamOf(car, 5000), { onBytes: (n) => totals.push(n) })) void block
    expect(totals[totals.length - 1]).toBe(car.length)
    await expect((async () => { for await (const block of readCarStream(streamOf(car, 5000), { maxBytes: 100_000 })) void block })()).rejects.toBeInstanceOf(TooLargeError)
  })

  it('refuses a wrong block, a wrong root, another hash and a CAR cut short', async () => {
    const { cid, car } = await site()
    const run = async (bytes: Uint8Array, root?: string) => { for await (const block of readCarStream(streamOf(bytes, 4096), root === undefined ? {} : { expectedRoot: root })) void block }
    const tampered = car.slice()
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 1)
    await expect(run(tampered)).rejects.toThrow('does not match its address')
    await expect(run(car, 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')).rejects.toThrow('is for')
    await expect(run(car.slice(0, car.length - 3), cid)).rejects.toThrow('ends in the middle')
    await expect(run(car.slice(0, 10))).rejects.toThrow()
    await expect(run(new Uint8Array(0))).rejects.toThrow('invalid header')
  })
})

/** A fetch that answers from a table, and records what was asked. */
function gatewayFetch (answers: Record<string, () => Response | Promise<Response>>, asked: string[] = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    asked.push(url)
    const handler = answers[new URL(url).origin]
    if (!handler) throw new Error(`no handler for ${url}`)
    if (init?.signal?.aborted) throw init.signal.reason
    return handler()
  }) as typeof fetch
}

describe('streamed gateway reads', () => {
  const gateways = ['https://one.example', 'https://two.example/']

  async function site () {
    const imported = await collect(mixFiles())
    const tree = await listTree({ block: async (cid) => imported.blocks.get(cid)! }, imported.cid)
    return { ...imported, tree }
  }

  /** The blocks of one file: its node and everything below it. */
  function fileBlocks (blocks: Map<string, Uint8Array>, cid: string, out = new Map<string, Uint8Array>()) {
    const block = blocks.get(cid)!
    out.set(cid, block)
    if (parseCid(cid).codec === DAG_PB) for (const link of decodeNode(block).links) fileBlocks(blocks, readCidBytes(link.hash).cid.string, out)
    return out
  }

  it('reads a file from the first gateway and reports bytes as they come', async () => {
    const { blocks, tree } = await site()
    const clip = tree.find((f) => f.path === 'video/clip.bin')!
    const car = writeCar(clip.cid, fileBlocks(blocks, clip.cid))
    const asked: string[] = []
    const progress: number[] = []
    const fetchImpl = gatewayFetch({ 'https://one.example': () => new Response(streamOf(car, 30_000), { headers: { 'content-length': String(car.length) } }) }, asked)
    const result = await fetchFileBlob(clip.cid, { gateways, fetchImpl, onProgress: (n) => progress.push(n) })
    expect(same(new Uint8Array(await result.blob.arrayBuffer()), MIX['video/clip.bin']!)).toBe(true)
    expect(asked[0]).toBe(`https://one.example/ipfs/${clip.cid}?format=car&dag-scope=entity`)
    expect(progress.length).toBeGreaterThan(10)
    expect(progress[progress.length - 1]).toBe(car.length)
  })

  it('reads one block, and only that', async () => {
    const { cid, blocks } = await site()
    const asked: string[] = []
    const fetchImpl = gatewayFetch({ 'https://one.example': () => new Response(writeCar(cid, new Map([[cid, blocks.get(cid)!]]))) }, asked)
    const block = await fetchBlock(cid, { gateways, fetchImpl })
    expect(same(block, blocks.get(cid)!)).toBe(true)
    expect(asked[0]).toContain('dag-scope=block')
  })

  it('goes on to the next gateway after an error, a wrong block or a missing block, and says what each said', async () => {
    const { cid, blocks } = await site()
    const good = writeCar(cid, new Map([[cid, blocks.get(cid)!]]))
    const bad = good.slice()
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1
    const other = await importContent(text.encode('other'), () => {})
    const wrong = writeCar(other.cid, new Map([[other.cid, text.encode('other')]]))
    for (const first of [() => new Response('boom', { status: 500 }), () => new Response(bad), () => new Response(wrong), () => new Response('', { status: 404 })]) {
      const result = await fetchBlocks(cid, { gateways, scope: 'block', fetchImpl: gatewayFetch({ 'https://one.example': first, 'https://two.example': () => new Response(good) }) })
      expect(result.gateway).toBe('https://two.example/')
    }
    const failure = await fetchBlocks(cid, { gateways, scope: 'block', fetchImpl: gatewayFetch({ 'https://one.example': () => new Response('', { status: 404 }), 'https://two.example': () => new Response(bad) }) }).catch((e: Error) => e)
    expect((failure as Error).message).toContain('one.example: it does not have this')
    expect((failure as Error).message).toContain('two.example: Block')
  })

  it('refuses an answer over the limit from its stated length or as it grows, and does not try another gateway', async () => {
    const { cid, blocks } = await site()
    const car = writeCar(cid, blocks)
    const asked: string[] = []
    await expect(fetchBlocks(cid, { gateways, maxBytes: 1000, fetchImpl: gatewayFetch({ 'https://one.example': () => new Response(car, { headers: { 'content-length': String(car.length) } }), 'https://two.example': () => new Response(car) }, asked) })).rejects.toBeInstanceOf(TooLargeError)
    await expect(fetchBlocks(cid, { gateways, maxBytes: 1000, fetchImpl: gatewayFetch({ 'https://one.example': () => new Response(streamOf(car, 500)), 'https://two.example': () => new Response(car) }, asked) })).rejects.toBeInstanceOf(TooLargeError)
    expect(asked.every((url) => url.startsWith('https://one.example'))).toBe(true)
  })

  it('stops when told to and when a gateway goes quiet', async () => {
    const { cid } = await site()
    const controller = new AbortController()
    const hang = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })) as unknown as typeof fetch
    const pending = fetchBlocks(cid, { gateways, fetchImpl: hang, signal: controller.signal, timeoutMs: 60_000 })
    setTimeout(() => controller.abort(new DOMException('Cancelled.', 'AbortError')), 10)
    await expect(pending).rejects.toThrow('Cancelled')
    const quiet = await fetchBlocks(cid, { gateways: ['https://one.example'], fetchImpl: hang, timeoutMs: 20 }).catch((e: Error) => e)
    expect((quiet as Error).message).toContain('no answer in')
  })
})

describe('walking a DAG through a block source', () => {
  async function site () {
    const imported = await collect(mixFiles())
    const asked: string[] = []
    const source = { block: async (cid: string) => { asked.push(cid); const block = imported.blocks.get(cid); if (!block) throw new Error('missing block'); return block } }
    return { ...imported, source, asked }
  }

  it('lists every file with its path and size, sorted by path', async () => {
    const { cid, source } = await site()
    const files = await listTree(source, cid)
    expect(files.map((f) => f.path)).toEqual(Object.keys(MIX).sort())
    for (const file of files) expect(file.size, file.path).toBe(MIX[file.path]!.length)
  })

  it('asks for the node of a file of several blocks and not for a file of one', async () => {
    const { cid, source, asked } = await site()
    await listTree(source, cid)
    const small = (await collect(mixFiles())).blocks
    const rawFiles = [...small.keys()].filter((c) => parseCid(c).codec === 0x55)
    expect(asked.filter((c) => rawFiles.includes(c))).toEqual([])
  })

  it('reads a file back, whole, in any number of levels', async () => {
    const { cid, source } = await site()
    const files = await listTree(source, cid)
    for (const file of files) expect(same(new Uint8Array(await (await readFileBlob(source, file.cid)).arrayBuffer()), MIX[file.path]!), file.path).toBe(true)
    const blocks = new Map<string, Uint8Array>()
    const deep = await importContent(new Blob([pattern(200 * 16) as BlobPart]), (c, b) => { blocks.set(c, b.slice()) }, { chunkSize: 16 })
    const tall = await importContent(new Blob([pattern(30_277 * 4) as BlobPart]), (c, b) => { blocks.set(c, b.slice()) }, { chunkSize: 4 })
    const from = { block: async (c: string) => blocks.get(c)! }
    expect(same(new Uint8Array(await (await readFileBlob(from, deep.cid)).arrayBuffer()), pattern(200 * 16))).toBe(true)
    expect(same(new Uint8Array(await (await readFileBlob(from, tall.cid)).arrayBuffer()), pattern(30_277 * 4))).toBe(true)
  }, 60_000)

  it('uses the Blob a source offers for a leaf, and reports the bytes', async () => {
    const { cid, source } = await site()
    const clip = (await listTree(source, cid)).find((f) => f.path === 'video/clip.bin')!
    const asBlob = vi.fn(async () => null as Blob | null)
    const got: number[] = []
    await readFileBlob({ ...source, blob: asBlob }, clip.cid, { onBytes: (n) => got.push(n) })
    expect(asBlob).toHaveBeenCalled()
    expect(got.reduce((a, b) => a + b, 0)).toBe(3_000_000)
  })

  it('refuses a file whose size is not what its node says', async () => {
    const { source, blocks } = await site()
    const clip = (await listTree(source, MIX_CID)).find((f) => f.path === 'video/clip.bin')!
    const node = decodeNode(blocks.get(clip.cid)!)
    const lying = encodeNode(node.links, encodeUnixfs({ type: 2, filesize: 3_000_001, blocksizes: [] }))
    const lyingCid = (await cidFor(DAG_PB, lying)).string
    await expect(readFileBlob({ block: async (c) => c === lyingCid ? lying : blocks.get(c)! }, lyingCid)).rejects.toThrow('says 3000001')
  })

  it('refuses a name that could leave the folder, a sharded folder, and an address that is a file', async () => {
    const make = async (links: { name: string, bytes: Uint8Array }[], type = 1) => {
      const leaf = text.encode('x')
      const leafCid = await cidFor(0x55, leaf)
      const node = encodeNode(links.map((l) => ({ hash: leafCid.bytes, name: l.name, tsize: 1 })), encodeUnixfs({ type, blocksizes: [] }))
      const cid = (await cidFor(DAG_PB, node)).string
      return { cid, block: async (c: string) => c === cid ? node : leaf }
    }
    for (const name of ['..', 'a/b', 'a\\b', '']) {
      const bad = await make([{ name, bytes: new Uint8Array(1) }])
      await expect(listTree(bad, bad.cid), JSON.stringify(name)).rejects.toThrow('cannot be opened safely')
    }
    const sharded = await make([{ name: '00', bytes: new Uint8Array(1) }], 5)
    await expect(listTree(sharded, sharded.cid)).rejects.toThrow('stored in many parts')
    const file = await importContent(text.encode('x'), () => {})
    await expect(listTree({ block: async () => text.encode('x') }, file.cid)).rejects.toThrow('is a file')
  })

  it('caps the files it will list', async () => {
    const { cid, source } = await site()
    await expect(listTree(source, cid, { maxFiles: 3 })).rejects.toThrow('more than 3 files')
  })

  it('runs at most the allowed number at once, in order, and stops at the first failure', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 2)); running--; return n * 2 })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16])
    expect(peak).toBe(3)
    await expect(mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('two'); return n })).rejects.toThrow('two')
  })
})
