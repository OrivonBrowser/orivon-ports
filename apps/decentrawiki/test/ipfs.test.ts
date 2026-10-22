import { describe, expect, it } from 'vitest'
import {
  DAG_PB, RAW, base32Encode, cidFor, decodeVarint, encodeVarint, parseCid
} from '../page/src/ipfs/cid.js'
import { encodeNode, encodeUnixfs, UNIXFS_FILE } from '../page/src/ipfs/dagpb.js'
import { importDirectory, importFile } from '../page/src/ipfs/unixfs.js'
import { listDirectory, readCar, readPath, writeCar } from '../page/src/ipfs/car.js'
import { fetchVerified } from '../page/src/ipfs/gateway.js'

/** Changes one byte of a block's data, so its hash no longer matches its CID. */
function flipLastByte (bytes: Uint8Array): void {
  const last = bytes.length - 1
  bytes[last] = (bytes[last] ?? 0) ^ 1
}

// The expected CIDs come from Kubo 0.43.1 on a throwaway repository:
// `ipfs add --cid-version=1 -Q --only-hash <file>` for files and
// `ipfs add -r --cid-version=1 -Q --only-hash <dir>` for directories.
const FILE_CIDS: Record<number, string> = {
  0: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
  1: 'bafkreigkgwdvr5wspzwpiutssn4xpj2i7wedshnwphhnu7ohx4pqaxxipe',
  1000: 'bafkreicqs7t5lbzvf5ijobrk4z47g662labnt6dvvoquzdfu2gqyrlnbpe',
  262144: 'bafkreigtb2zed6k6pq34amzfdj4ovylbble3alojsysuiikydagtlammdm',
  262145: 'bafybeihlgjyersgemzowh4ciuk3uxlsihtkmji3zxmypv2yirmdyuejzza',
  3_000_000: 'bafybeic5tlhnr3fcticci3x3sybhhall6f6xn6oewmqvrxbecvl2oa5skm',
  45_613_056: 'bafybeib3ia45xd33ri2yl77vqtohksrzdge4valapnvuaitd4gcvw6gi5y',
  46_000_000: 'bafybeidrhnqe6ypgbjrkbjw55sm6xqomgis6o6iizmfp5245stjh4f2g2q'
}
const DIR_CIDS = {
  flat: 'bafybeiek6rgo53nnksskarhmyk2ussqywifoxhs45j7y3l4mlis5nlqziu',
  nested: 'bafybeifz3byhjib7ajvphrntbyjqorw57phgoympbcpx33t25zi3lmwlni',
  unicode: 'bafybeibuuhpqrrlqn5z22putfdhx3olnk7ywjffyt3udfz43g6pl2i6svu',
  order: 'bafybeihdbemkfnxalusqus6uswv2i47uuktogl34okf26p2vcajjuq3zlq'
}
// `ipfs add --cid-version=0 -Q --only-hash` of "Hello\n", then `ipfs cid base32` of it.
const HELLO_V0 = 'QmY9cxiHqTFoWamkQVkpmmqzBrY3hCBEL2XNu3NtX74Fuu'
const HELLO_V1 = 'bafybeierygapfancqypsshj2jh4oesqczz75r7mplry3tvwucftekwqczq'

const text = new TextEncoder()

function pattern (size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7 + (i >>> 18)) & 255
  return bytes
}

type Tree = Record<string, string | Uint8Array>

function files (tree: Tree) {
  return Object.entries(tree).map(([path, content]) => ({
    path, bytes: typeof content === 'string' ? text.encode(content) : content
  }))
}

// The same trees, written to disk and added with Kubo to get DIR_CIDS.
const TREES: Record<keyof typeof DIR_CIDS, Tree> = {
  flat: { 'index.html': '<h1>Hello</h1>\n', 'style.css': 'body { margin: 0 }\n', 'empty.txt': '', 'big.bin': pattern(300000) },
  nested: {
    'index.html': '<a href="static/a b.html">x</a>\n',
    'static/a b.html': 'a b\n',
    'static/img/logo.bin': pattern(1000),
    'static/img/deep/x.txt': 'deep\n',
    'about/index.html': 'about\n'
  },
  unicode: {
    'índice.html': 'i\n', '日本語/ページ.html': 'jp\n', 'emoji-😀.txt': 'e\n', 'a b.txt': 'sp\n', 'Ä.txt': 'A\n', 'z.txt': 'z\n'
  },
  order: {
    'B.txt': 'B', 'a.txt': 'a', '_c.txt': 'c', 'Z.txt': 'Z', 'é.txt': 'é', 'e.txt': 'e', '10.txt': '10', '9.txt': '9',
    'a-b.txt': 'ab1', 'a.b.txt': 'ab2', 'ab.txt': 'ab3', 'docs/x.txt': 'x', 'docs-old.txt': 'o', 'docs.txt': 'd'
  }
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b))

describe('cid', () => {
  it('round-trips varints', () => {
    for (const n of [0, 1, 127, 128, 300, 16384, 2 ** 32 + 5, Number.MAX_SAFE_INTEGER]) {
      const bytes = encodeVarint(n)
      expect(decodeVarint(bytes)).toEqual({ value: n, length: bytes.length })
    }
    expect(Array.from(encodeVarint(300))).toEqual([0xac, 0x02])
    expect(() => decodeVarint(Uint8Array.of(0x80))).toThrow('truncated')
  })

  it('parses a CIDv1 and rebuilds its string', async () => {
    const cid = parseCid(FILE_CIDS[1]!)
    expect(cid).toMatchObject({ version: 1, codec: RAW, hashCode: 0x12 })
    expect(cid.string).toBe(FILE_CIDS[1])
    expect(cid.string).toBe('b' + base32Encode(cid.bytes))
    expect((await cidFor(RAW, Uint8Array.of(7))).string).toBe(FILE_CIDS[1])
  })

  it('parses a CIDv0 into its CIDv1 form', () => {
    const cid = parseCid(HELLO_V0)
    expect(cid).toMatchObject({ version: 0, codec: DAG_PB, hashCode: 0x12 })
    expect(cid.digest).toHaveLength(32)
    expect(cid.string).toBe(HELLO_V1)
    expect(parseCid(HELLO_V1).digest).toEqual(cid.digest)
  })

  it('rejects things that are not CIDs', () => {
    expect(() => parseCid('QmNotACid')).toThrow()
    expect(() => parseCid('zb2rhe5P4gXftAwvA4eXQ5HJwsER2owDyS9sKaQRRVQPn93bA')).toThrow('unsupported CID')
    expect(() => parseCid(FILE_CIDS[1]!.slice(0, -3))).toThrow()
    expect(() => parseCid('b0000')).toThrow('base32')
  })
})

describe('importFile matches Kubo', () => {
  for (const size of [0, 1, 1000, 262144, 262145, 3_000_000, 45_613_056, 46_000_000]) {
    it(`${size} bytes`, async () => {
      const bytes = pattern(size)
      const imported = await importFile(bytes)
      expect(imported.cid).toBe(FILE_CIDS[size])
      for (const [cid, block] of imported.blocks) {
        expect(cid).toBe((await cidFor(parseCid(cid).codec, block)).string)
      }
      expect(same(readPath(imported.blocks, imported.cid, ''), bytes)).toBe(true)
    }, 60_000)
  }

  it('makes one raw block for a one-chunk file and a two-level tree past 174 chunks', async () => {
    expect((await importFile(pattern(262144))).blocks.size).toBe(1)
    const exact = await importFile(pattern(45_613_056))
    expect(exact.blocks.size).toBe(175)
    const taller = await importFile(pattern(46_000_000))
    const root = taller.blocks.get(taller.cid)!
    expect(taller.blocks.size).toBe(179)
    expect(root.length).toBeLessThan(200)
  }, 60_000)

  it('reads a CIDv0-era file whose bytes sit inside the dag-pb node', async () => {
    const data = text.encode('Hello\n')
    const node = encodeNode([], encodeUnixfs({ type: UNIXFS_FILE, data, filesize: data.length, blocksizes: [] }))
    const cid = await cidFor(DAG_PB, node)
    expect(cid.string).toBe(HELLO_V1)
    expect(readPath(new Map([[cid.string, node]]), HELLO_V0, '')).toEqual(data)
  })
})

describe('importDirectory matches Kubo', () => {
  for (const name of Object.keys(DIR_CIDS) as (keyof typeof DIR_CIDS)[]) {
    it(`${name} directory`, async () => {
      const imported = await importDirectory(files(TREES[name]))
      expect(imported.cid).toBe(DIR_CIDS[name])
      for (const [path, content] of Object.entries(TREES[name])) {
        const expected = typeof content === 'string' ? text.encode(content) : content
        expect(same(readPath(imported.blocks, imported.cid, path), expected)).toBe(true)
      }
    })
  }

  it('sorts entries by UTF-8 bytes, not by locale', async () => {
    const { cid, blocks } = await importDirectory(files(TREES.order))
    expect(listDirectory(blocks, cid).map((entry) => entry.name)).toEqual([
      '10.txt', '9.txt', 'B.txt', 'Z.txt', '_c.txt', 'a-b.txt', 'a.b.txt', 'a.txt', 'ab.txt',
      'docs', 'docs-old.txt', 'docs.txt', 'e.txt', 'é.txt'
    ])
  })

  it('walks nested directories by name', async () => {
    const { cid, blocks } = await importDirectory(files(TREES.nested))
    expect(listDirectory(blocks, cid).map((entry) => entry.name)).toEqual(['about', 'index.html', 'static'])
    expect(new TextDecoder().decode(readPath(blocks, cid, 'static/a b.html'))).toBe('a b\n')
    expect(new TextDecoder().decode(readPath(blocks, cid, '/static/img/deep/x.txt'))).toBe('deep\n')
    expect(() => readPath(blocks, cid, 'static/missing.html')).toThrow('no entry named')
    expect(() => readPath(blocks, cid, 'static')).toThrow('is a directory')
    expect(() => readPath(blocks, cid, 'index.html/x')).toThrow('not a directory')
    expect(() => readPath(blocks, cid, '../x')).toThrow('not allowed')
  })

  it('rejects bad paths and oversized directories', async () => {
    const one = (path: string) => importDirectory([{ path, bytes: Uint8Array.of(1) }])
    await expect(one('../x')).rejects.toThrow('not allowed')
    await expect(one('a/./x')).rejects.toThrow('not allowed')
    await expect(one('a//x')).rejects.toThrow('empty path segment')
    await expect(one('/x')).rejects.toThrow('absolute')
    await expect(one('')).rejects.toThrow('must not be empty')
    await expect(importDirectory([...files({ a: 'x' }), ...files({ a: 'y' })])).rejects.toThrow('duplicate path')
    await expect(importDirectory(files({ a: 'x', 'a/b': 'y' }))).rejects.toThrow('both a file and a directory')
    await expect(importDirectory(files({ 'a/b': 'y', a: 'x' }))).rejects.toThrow('both a file and a directory')
    const many = Array.from({ length: 1001 }, (_, i) => ({ path: `f${i}`, bytes: Uint8Array.of(1) }))
    await expect(importDirectory(many)).rejects.toThrow('more than 1000')
  })
})

describe('CAR', () => {
  it('round-trips and keeps every block', async () => {
    const imported = await importDirectory(files(TREES.nested))
    const car = writeCar(imported.cid, imported.blocks)
    const blocks = await readCar(car, imported.cid)
    expect([...blocks.keys()].sort()).toEqual([...imported.blocks.keys()].sort())
    for (const [cid, block] of imported.blocks) expect(same(blocks.get(cid)!, block)).toBe(true)
  })

  it('writes the header Kubo writes', async () => {
    const { cid, blocks } = await importDirectory(files(TREES.flat))
    const car = writeCar(cid, blocks)
    const size = decodeVarint(car)
    const header = car.subarray(size.length, size.length + size.value)
    const root = parseCid(cid).bytes
    expect(Array.from(header.subarray(0, 13))).toEqual([
      0xa2, 0x65, ...text.encode('roots'), 0x81, 0xd8, 0x2a, 0x58, root.length + 1, 0
    ])
    expect(Array.from(header.subarray(-9))).toEqual([0x67, ...text.encode('version'), 0x01])
  })

  it('accepts a CIDv0 name for the root', async () => {
    const data = text.encode('Hello\n')
    const node = encodeNode([], encodeUnixfs({ type: UNIXFS_FILE, data, filesize: data.length, blocksizes: [] }))
    const blocks = new Map([[HELLO_V1, node]])
    expect((await readCar(writeCar(HELLO_V1, blocks), HELLO_V0)).size).toBe(1)
  })

  it('rejects a tampered block, a wrong root, truncation and other hashes', async () => {
    const imported = await importDirectory(files(TREES.nested))
    const car = writeCar(imported.cid, imported.blocks)

    const tampered = car.slice()
    flipLastByte(tampered)
    await expect(readCar(tampered, imported.cid)).rejects.toThrow('does not match its CID')

    await expect(readCar(car, FILE_CIDS[1]!)).rejects.toThrow('do not include')
    await expect(readCar(car.slice(0, car.length - 3), imported.cid)).rejects.toThrow('truncated')
    await expect(readCar(car.slice(0, 10), imported.cid)).rejects.toThrow('truncated')
    await expect(readCar(new Uint8Array(0), imported.cid)).rejects.toThrow()

    const digest = new Uint8Array(64)
    const sha512 = Uint8Array.of(1, RAW, 0x13, 64, ...digest)
    const foreign = new Map([['b' + base32Encode(sha512), Uint8Array.of(1, 2, 3)]])
    await expect(readCar(writeCar(imported.cid, foreign), imported.cid)).rejects.toThrow('other than sha2-256')
  })

  it('throws when a needed block is missing', async () => {
    const imported = await importDirectory(files(TREES.nested))
    const blocks = new Map(imported.blocks)
    const entry = listDirectory(blocks, imported.cid).find((e) => e.name === 'static')!
    blocks.delete(entry.cid)
    expect(() => readPath(blocks, imported.cid, 'static/a b.html')).toThrow('missing block')
    expect(() => readPath(blocks, imported.cid, 'index.html')).not.toThrow()
  })
})

describe('fetchVerified', () => {
  const gateways = ['https://one.example', 'https://two.example/']

  async function site () {
    const imported = await importDirectory(files(TREES.nested))
    return { imported, car: writeCar(imported.cid, imported.blocks) }
  }

  function fakeFetch (handlers: Record<string, () => Response | Promise<Response>>, seen: { url: string, accept: string | null }[] = []) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      seen.push({ url, accept: new Headers(init?.headers).get('accept') })
      const host = new URL(url).origin
      const handler = handlers[host]
      if (!handler) throw new Error(`no handler for ${host}`)
      return handler()
    }) as typeof fetch
  }

  it('skips a failing gateway and verifies the next', async () => {
    const { imported, car } = await site()
    const seen: { url: string, accept: string | null }[] = []
    const fetchImpl = fakeFetch({
      'https://one.example': () => new Response('boom', { status: 500 }),
      'https://two.example': () => new Response(car)
    }, seen)
    const result = await fetchVerified(imported.cid, 'static/a b.html', { gateways, fetchImpl })
    expect(new TextDecoder().decode(result.bytes)).toBe('a b\n')
    expect(result.gateway).toBe('https://two.example/')
    expect(seen.map((s) => s.url)).toEqual([
      `https://one.example/ipfs/${imported.cid}/static/a%20b.html?format=car&dag-scope=entity`,
      `https://two.example/ipfs/${imported.cid}/static/a%20b.html?format=car&dag-scope=entity`
    ])
    expect(seen[0]!.accept).toBe('application/vnd.ipld.car')
  })

  it('defaults to index.html', async () => {
    const { imported, car } = await site()
    const seen: { url: string, accept: string | null }[] = []
    const fetchImpl = fakeFetch({ 'https://one.example': () => new Response(car) }, seen)
    const result = await fetchVerified(imported.cid, undefined, { gateways, fetchImpl })
    expect(new TextDecoder().decode(result.bytes)).toContain('static/a b.html')
    expect(seen[0]!.url).toContain('/index.html?')
  })

  it('skips a gateway whose CAR carries a wrong block', async () => {
    const { imported, car } = await site()
    const bad = car.slice()
    flipLastByte(bad)
    const fetchImpl = fakeFetch({
      'https://one.example': () => new Response(bad),
      'https://two.example': () => new Response(car)
    })
    const result = await fetchVerified(imported.cid, 'about/index.html', { gateways, fetchImpl })
    expect(new TextDecoder().decode(result.bytes)).toBe('about\n')
    expect(result.gateway).toBe('https://two.example/')
  })

  it('lists every reason when all gateways fail', async () => {
    const { imported, car } = await site()
    const bad = car.slice()
    flipLastByte(bad)
    const fetchImpl = fakeFetch({
      'https://one.example': () => new Response(bad),
      'https://two.example': () => new Response('nope', { status: 404 })
    })
    const failure = await fetchVerified(imported.cid, 'about/index.html', { gateways, fetchImpl }).catch((e: Error) => e)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('https://one.example: ')
    expect(message).toContain('does not match its CID')
    expect(message).toContain('https://two.example/: HTTP 404')
  })

  it('accepts a CAR whose header root is the terminal file, as real gateways send', async () => {
    const { imported } = await site()
    const aboutDir = listDirectory(imported.blocks, imported.cid).find((e) => e.name === 'about')!.cid
    const fileCid = listDirectory(imported.blocks, aboutDir)[0]!.cid
    const pathBlocks = new Map([
      [imported.cid, imported.blocks.get(imported.cid)!],
      [aboutDir, imported.blocks.get(aboutDir)!],
      [fileCid, imported.blocks.get(fileCid)!]
    ])
    const car = writeCar(fileCid, pathBlocks)
    const fetchImpl = fakeFetch({ 'https://one.example': () => new Response(car) })
    const result = await fetchVerified(imported.cid, 'about/index.html', { gateways: ['https://one.example'], fetchImpl })
    expect(new TextDecoder().decode(result.bytes)).toBe('about\n')
    const bad = car.slice()
    flipLastByte(bad)
    const rejected = await fetchVerified(imported.cid, 'about/index.html', {
      gateways: ['https://one.example'], fetchImpl: fakeFetch({ 'https://one.example': () => new Response(bad) })
    }).catch((e: Error) => e)
    expect((rejected as Error).message).toContain('does not match its CID')
  })

  it('rejects a CAR that lacks a block on the path, and times a stuck gateway out', async () => {
    const { imported, car } = await site()
    const other = await importFile(text.encode('other'))
    const otherCar = writeCar(other.cid, other.blocks)
    const stuck = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })) as unknown as typeof fetch
    const missing = await fetchVerified(imported.cid, 'index.html', {
      gateways: ['https://one.example'], fetchImpl: fakeFetch({ 'https://one.example': () => new Response(otherCar) })
    }).catch((e: Error) => e)
    expect((missing as Error).message).toContain('missing block')

    const calls: string[] = []
    const mixed = ((url: string, init?: RequestInit) => {
      calls.push(url)
      return url.startsWith('https://one.example') ? stuck(url, init) : Promise.resolve(new Response(car))
    }) as unknown as typeof fetch
    const result = await fetchVerified(imported.cid, 'about/index.html', { gateways, fetchImpl: mixed, timeoutMs: 20 })
    expect(result.gateway).toBe('https://two.example/')
    expect(calls).toHaveLength(2)
  })

  it('fetches a root that is itself a file with an empty path', async () => {
    const file = await importFile(pattern(1000))
    const fetchImpl = fakeFetch({ 'https://one.example': () => new Response(writeCar(file.cid, file.blocks)) })
    const seen = await fetchVerified(file.cid, '', { gateways: ['https://one.example'], fetchImpl })
    expect(same(seen.bytes, pattern(1000))).toBe(true)
  })
})
