import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WrongPasswordError } from '../page/src/crypto/age.js'
import { writeCar } from '../page/src/ipfs/car.js'
import { cidFor, DAG_PB, parseCid, readCidBytes } from '../page/src/ipfs/cid.js'
import { decodeNode, encodeNode, encodeUnixfs } from '../page/src/ipfs/dagpb.js'
import { importContent, importTree } from '../page/src/ipfs/unixfs.js'
import { manifestText, MANIFEST_NAME } from '../page/src/lib/manifest.js'
import { readZip, writeZip } from '../page/src/lib/zip.js'
import { isEncrypted, kindOf } from '../page/src/receive/classify.js'
import { closeSession, GATEWAYS } from '../page/src/receive/session.js'
import { race } from '../page/src/receive/race.js'

// The password lock is replaced by a stand-in that keeps the password in front of the bytes: what is tested here is
// how a share is read and checked, and the real age is tested in crypto.test.ts.
vi.mock('../page/src/crypto/client.js', async () => {
  const { WrongPasswordError: Wrong } = await import('../page/src/crypto/age.js')
  return {
    encryptBlob: async (blob: Blob, password: string) => new Blob([`FAKE:${password}:`, blob]),
    decryptBlob: async (blob: Blob, password: string) => {
      const head = `FAKE:${password}:`
      if ((await blob.slice(0, head.length).text()) !== head) throw new Wrong()
      return blob.slice(head.length)
    }
  }
})

const { configureReceive, openShare, readPublicFile, zipPublic, closeShare } = await import('../page/src/receive/read.js')
const { unlockShare } = await import('../page/src/receive/unlock.js')
const { encryptBlob } = await import('../page/src/crypto/client.js')

const text = new TextEncoder()
const GATEWAY = 'https://gw.example'

function pattern (size: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7 + seed) & 255)
}

type Published = { root: string, blocks: Map<string, Uint8Array> }

async function publish (files: Record<string, Uint8Array | string>): Promise<Published> {
  const blocks = new Map<string, Uint8Array>()
  const imported = await importTree(Object.entries(files).map(([path, content]) => ({ path, content: typeof content === 'string' ? text.encode(content) : content })), (cid, bytes) => { blocks.set(cid, bytes.slice()) })
  return { root: imported.cid, blocks }
}

/** The blocks of a file: its node and everything below it. */
function below (blocks: Map<string, Uint8Array>, cid: string, out = new Map<string, Uint8Array>()) {
  out.set(cid, blocks.get(cid)!)
  if (parseCid(cid).codec === DAG_PB) for (const link of decodeNode(blocks.get(cid)!).links) below(blocks, readCidBytes(link.hash).cid.string, out)
  return out
}

/** A trustless gateway over some blocks, and the list of what it was asked. */
function gateway (blocks: Map<string, Uint8Array>, asked: string[] = []) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    asked.push(`${url.pathname}${url.search}`)
    const cid = url.pathname.split('/')[2]!
    const block = blocks.get(cid)
    if (block === undefined) return new Response('not found', { status: 404 })
    const scope = url.searchParams.get('dag-scope')
    const info = parseCid(cid).codec === DAG_PB ? decodeNode(block) : null
    const directory = info !== null && info.data !== undefined && info.data[1] === 1
    return new Response(writeCar(cid, scope === 'block' || directory ? new Map([[cid, block]]) : below(blocks, cid)))
  }) as typeof fetch
}

let sessions: string[] = []
function use (share: Published, asked: string[] = []) {
  sessions.push(share.root)
  configureReceive(async () => ({ keep: null, hub: null, gateways: [GATEWAY], fetchImpl: gateway(share.blocks, asked) }))
  return asked
}
afterEach(() => { for (const root of sessions) closeSession(root); sessions = [] })

describe('what a share is, from its shape', () => {
  it('knows a protected share by its two files and nothing else', () => {
    expect(isEncrypted(['share.age', 'HOW-TO-OPEN.txt'])).toBe(true)
    expect(isEncrypted(['HOW-TO-OPEN.txt', 'share.age'])).toBe(true)
    expect(isEncrypted(['share.age'])).toBe(false)
    expect(isEncrypted(['share.age', 'HOW-TO-OPEN.txt', 'a.txt'])).toBe(false)
    expect(isEncrypted([])).toBe(false)
  })

  it('knows a website by its index.html, a folder by its one folder, and calls the rest files', () => {
    expect(kindOf(['index.html', 'css'], ['index.html', 'css/a.css'])).toBe('website')
    expect(kindOf(['photos'], ['photos/1.jpg', 'photos/2.jpg'])).toBe('folder')
    expect(kindOf(['a.txt', 'b'], ['a.txt', 'b/c.txt'])).toBe('files')
    expect(kindOf(['report.pdf'], ['report.pdf'])).toBe('files')
    expect(kindOf(['site'], ['site/index.html'])).toBe('folder')
    expect(kindOf([], [])).toBe('files')
  })
})

describe('opening a public share', () => {
  it('lists the files of a share of files, each with its size, checked against the address', async () => {
    const share = await publish({ 'a.txt': 'hello', 'b/c.txt': 'deep', 'b/big.bin': pattern(700_000) })
    use(share)
    const progress: { text?: string, source?: string }[] = []
    const opened = await openShare(share.root, { onProgress: (p) => progress.push({ ...(p.text === undefined ? {} : { text: p.text }), ...(p.source === undefined ? {} : { source: p.source }) }) })
    expect(opened).toMatchObject({ cid: share.root, encrypted: false, kind: 'files', bytes: 5 + 4 + 700_000 })
    expect(opened.entries).toEqual([{ path: 'a.txt', size: 5 }, { path: 'b/big.bin', size: 700_000 }, { path: 'b/c.txt', size: 4 }])
    expect(Object.keys(opened.cids)).toEqual(['a.txt', 'b/big.bin', 'b/c.txt'])
    expect(progress[0]).toEqual({ text: 'Looking for the share' })
    expect(progress.length, 'the root block, a block for each folder and each file of several blocks').toBeGreaterThanOrEqual(3)
    expect(progress.slice(1).every((p) => p.text === 'Reading the list of files' && p.source === 'gateway')).toBe(true)
  })

  it('tells a website, a folder and a single file apart', async () => {
    const site = await publish({ 'index.html': '<h1>hi', 'css/a.css': 'b{}' })
    use(site)
    expect(await openShare(site.root)).toMatchObject({ kind: 'website', encrypted: false })
    const folder = await publish({ 'photos/1.jpg': 'one', 'photos/2.jpg': 'two' })
    use(folder)
    expect(await openShare(folder.root)).toMatchObject({ kind: 'folder' })
    const single = await publish({ 'report.pdf': pattern(1000) })
    use(single)
    expect(await openShare(single.root)).toMatchObject({ kind: 'files', entries: [{ path: 'report.pdf', size: 1000 }] })
  })

  it('knows a protected share without opening it', async () => {
    const share = await publish({ 'HOW-TO-OPEN.txt': 'how', 'share.age': pattern(300_000) })
    use(share)
    const opened = await openShare(share.root)
    expect(opened).toMatchObject({ encrypted: true, kind: null, entries: [], bytes: 300_000 })
    expect(Object.keys(opened.cids).sort()).toEqual(['HOW-TO-OPEN.txt', 'share.age'])
    const small = await publish({ 'HOW-TO-OPEN.txt': 'how', 'share.age': pattern(300) })
    use(small)
    expect((await openShare(small.root)).bytes).toBe(300)
  })

  it('accepts a link as well as an address', async () => {
    const share = await publish({ 'a.txt': 'hello' })
    use(share)
    const { openShare: viaEngine } = await import('../page/src/engine.js')
    expect((await viaEngine(`https://share.orivonstack.eth.limo/#/${share.root}`)).cid).toBe(share.root)
  })

  it('refuses an address that is a file, not a folder, or a share too large, before reading any file', async () => {
    const lone = await importContent(text.encode('just a file'), () => {})
    await expect(openShare(lone.cid)).rejects.toThrow('single file')
    const big = await publish({ 'a.txt': 'hello' })
    const link = (cid: string, tsize: number) => ({ hash: parseCid(cid).bytes, name: 'huge', tsize })
    const rootNode = encodeNode([link([...big.blocks.keys()][0]!, 2 * 1024 ** 3)], encodeUnixfs({ type: 1, blocksizes: [] }))
    const oversized = (await cidFor(DAG_PB, rootNode)).string
    const blocks = new Map(big.blocks).set(oversized, rootNode)
    const asked = use({ root: oversized, blocks })
    await expect(openShare(oversized)).rejects.toThrow('larger than Share opens')
    expect(asked).toHaveLength(1)
  })

  it('says it could not find a share no gateway has', async () => {
    const lost = await publish({ 'a.txt': 'hello' })
    sessions.push(lost.root)
    configureReceive(async () => ({ keep: null, hub: null, gateways: [GATEWAY], fetchImpl: gateway(new Map()) }))
    await expect(openShare(lost.root)).rejects.toThrow(/No IPFS gateway could give .*gw\.example: it does not have this/)
  })
})

describe('reading its files', () => {
  it('gives a file back byte for byte, with progress that names its source', async () => {
    const share = await publish({ 'a.txt': 'hello', 'big.bin': pattern(900_000, 3) })
    const asked = use(share)
    const opened = await openShare(share.root)
    const progress: { done?: number, total?: number, source?: string }[] = []
    const blob = await readPublicFile(opened, 'big.bin', { onProgress: (p) => progress.push(p) })
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(pattern(900_000, 3))
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every((p) => p.source === 'gateway' && p.total === 900_000)).toBe(true)
    expect(progress.at(-1)).toMatchObject({ done: 900_000, total: 900_000 })
    expect(await (await readPublicFile(opened, 'a.txt')).text()).toBe('hello')
    expect(asked.some((url) => url.includes('dag-scope=entity'))).toBe(true)
    await expect(readPublicFile(opened, 'missing')).rejects.toThrow('no file called missing')
  }, 30_000)

  it('refuses a gateway that sends far more than the file is, and one that sends a wrong block', async () => {
    const share = await publish({ 'big.bin': pattern(400_000) })
    sessions.push(share.root)
    const opened = await (async () => { use(share); return await openShare(share.root) })()
    const entry = opened.cids['big.bin']!
    const padded = new Map(share.blocks)
    const tail = pattern(3_000_000, 9)
    padded.set((await cidFor(0x55, tail)).string, tail)
    const flood = (async () => new Response(writeCar(entry, padded))) as unknown as typeof fetch
    closeShare(share.root)
    configureReceive(async () => ({ keep: null, hub: null, gateways: [GATEWAY], fetchImpl: flood }))
    await expect(readPublicFile(opened, 'big.bin')).rejects.toThrow('larger than')
    const bad = new Map(share.blocks)
    const leaf = [...bad.keys()].find((cid) => parseCid(cid).codec === 0x55)!
    bad.set(leaf, pattern(10))
    closeShare(share.root)
    configureReceive(async () => ({ keep: null, hub: null, gateways: [GATEWAY], fetchImpl: gateway(bad) }))
    await expect(readPublicFile(opened, 'big.bin')).rejects.toThrow(/does not match its address/)
  })

  it('makes one ZIP of every file, with the paths of the share', async () => {
    const share = await publish({ 'index.html': '<h1>hi', 'css/a.css': 'b{}', 'img/logo.bin': pattern(5000) })
    use(share)
    const opened = await openShare(share.root)
    const done: number[] = []
    const zip = await zipPublic(opened, { onProgress: (p) => { done.push(p.done ?? 0) } })
    const entries = await readZip(zip)
    expect(entries.map((e) => e.path)).toEqual(['css/a.css', 'img/logo.bin', 'index.html'])
    expect(await entries[0]!.file.text()).toBe('b{}')
    expect(new Uint8Array(await entries[1]!.file.arrayBuffer())).toEqual(pattern(5000))
    expect(done.at(-1)).toBe(opened.bytes)
  })
})

describe('opening a protected share', () => {
  /** A protected share the way publishing makes it, with the stand-in lock. */
  async function protectedShare (password: string, files: Record<string, string | Uint8Array>, manifest = {}) {
    const entries = Object.entries(files).map(([name, content]) => ({ name, file: new Blob([content as BlobPart]) }))
    const bytes = entries.reduce((n, e) => n + e.file.size, 0)
    const description = new Blob([manifestText({ kind: 'files', title: 'Holiday', message: 'Enjoy', files: entries.length, bytes, now: new Date('2026-10-26T10:00:00Z'), ...manifest })])
    const zip = await writeZip([{ name: MANIFEST_NAME, file: description }, ...entries])
    const age = await encryptBlob(zip, password, {})
    return publish({ 'HOW-TO-OPEN.txt': 'how', 'share.age': new Uint8Array(await age.arrayBuffer()) })
  }

  it('opens it with the password and gives the files, the title and the message', async () => {
    const share = await protectedShare('correct horse', { 'a.txt': 'hello', 'dir/b.bin': pattern(2000) })
    use(share)
    const opened = await openShare(share.root)
    const progress: string[] = []
    const content = await unlockShare(opened, 'correct horse', { onProgress: (p) => progress.push(p.step) })
    expect(content).toMatchObject({ kind: 'files', title: 'Holiday', message: 'Enjoy', created: '2026-10-26T10:00:00.000Z' })
    expect(content.entries.map((e) => [e.path, e.size])).toEqual([['a.txt', 5], ['dir/b.bin', 2000]])
    expect(await content.entries[0]!.file.text()).toBe('hello')
    expect(new Set(progress)).toEqual(new Set(['download']))
    expect((await unlockShare(opened, '  correct horse \n')).entries).toHaveLength(2)
  })

  it('says the password is wrong, and can be tried again', async () => {
    const share = await protectedShare('correct horse', { 'a.txt': 'hello' })
    use(share)
    const opened = await openShare(share.root)
    const failure = await unlockShare(opened, 'wrong password').catch((e: Error) => e)
    expect(failure).toBeInstanceOf(WrongPasswordError)
    expect((failure as Error).name).toBe('WrongPasswordError')
    expect((await unlockShare(opened, 'correct horse')).entries).toHaveLength(1)
  })

  it('says a share is damaged when what the password opens is not what it describes', async () => {
    const wrongCount = await protectedShare('pw pw pw pw', { 'a.txt': 'hello' }, { files: 5 })
    use(wrongCount)
    await expect(unlockShare(await openShare(wrongCount.root), 'pw pw pw pw')).rejects.toMatchObject({ name: 'DamagedShareError' })
    const noDescription = await publish({
      'HOW-TO-OPEN.txt': 'how',
      'share.age': new Uint8Array(await (await encryptBlob(await writeZip([{ name: 'a.txt', file: new Blob(['x']) }]), 'pw pw pw pw', {})).arrayBuffer())
    })
    use(noDescription)
    await expect(unlockShare(await openShare(noDescription.root), 'pw pw pw pw')).rejects.toMatchObject({ name: 'DamagedShareError', message: expect.stringContaining('description is missing') })
    const notZip = await publish({ 'HOW-TO-OPEN.txt': 'how', 'share.age': new Uint8Array(await (await encryptBlob(new Blob(['not a zip file at all, just text']), 'pw pw pw pw', {})).arrayBuffer()) })
    use(notZip)
    await expect(unlockShare(await openShare(notZip.root), 'pw pw pw pw')).rejects.toMatchObject({ name: 'DamagedShareError' })
  })

  it('refuses to unlock a share that has no password', async () => {
    const plain = await publish({ 'a.txt': 'hello' })
    use(plain)
    await expect(unlockShare(await openShare(plain.root), 'x')).rejects.toThrow('not protected')
  })
})

describe('racing two sources', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('takes the first to finish and cancels the rest', async () => {
    const stopped: string[] = []
    const attempt = (name: string, ms: number, headStartMs?: number) => ({
      name, ...(headStartMs === undefined ? {} : { headStartMs }),
      run: (signal: AbortSignal) => new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve(name), ms)
        signal.addEventListener('abort', () => { clearTimeout(timer); stopped.push(name); reject(new Error('stopped')) })
      })
    })
    const pending = race([attempt('peer', 1000), attempt('gateway', 1500, 300)])
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toEqual({ value: 'peer', name: 'peer' })
    expect(stopped).toEqual(['gateway'])
  })

  it('starts the second after its head start, and sooner when the first fails', async () => {
    const started: string[] = []
    const run = (name: string, ms: number, fail = false) => () => { started.push(name); return new Promise<string>((resolve, reject) => setTimeout(() => (fail ? reject(new Error(`${name} failed`)) : resolve(name)), ms)) }
    let pending = race([{ name: 'peer', run: run('peer', 5000) }, { name: 'gateway', headStartMs: 800, run: run('gateway', 100) }])
    await vi.advanceTimersByTimeAsync(799)
    expect(started).toEqual(['peer'])
    await vi.advanceTimersByTimeAsync(1)
    expect(started).toEqual(['peer', 'gateway'])
    await vi.advanceTimersByTimeAsync(100)
    expect((await pending).name).toBe('gateway')
    started.length = 0
    pending = race([{ name: 'peer', run: run('peer', 50, true) }, { name: 'gateway', headStartMs: 5000, run: run('gateway', 10) }])
    await vi.advanceTimersByTimeAsync(50)
    expect(started).toEqual(['peer', 'gateway'])
    await vi.advanceTimersByTimeAsync(10)
    expect((await pending).name).toBe('gateway')
  })

  it('keeps the second waiting while the first is making progress', async () => {
    const started: string[] = []
    let progressing = true
    const pending = race([
      { name: 'peer', run: () => new Promise<string>((resolve) => setTimeout(() => resolve('peer'), 4000)) },
      { name: 'gateway', headStartMs: 500, busy: () => progressing, run: () => { started.push('gateway'); return new Promise<string>(() => {}) } }
    ])
    await vi.advanceTimersByTimeAsync(2000)
    expect(started).toEqual([])
    progressing = false
    await vi.advanceTimersByTimeAsync(500)
    expect(started).toEqual(['gateway'])
    await vi.advanceTimersByTimeAsync(2000)
    expect((await pending).name).toBe('peer')
  })

  it('fails with the reason of the attempt that gave one, when every attempt fails, and stops when told to', async () => {
    const fail = (message: string) => ({ name: message, run: () => Promise.reject(new Error(message)) })
    await expect(race([fail('peer said no'), fail('gateway said no')])).rejects.toThrow('gateway said no')
    const controller = new AbortController()
    const waiting = race([{ name: 'a', run: () => new Promise<string>(() => {}) }], controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow()
    expect(GATEWAYS).toEqual(['https://ipfs.filebase.io', 'https://trustless-gateway.link', 'https://ipfs.orbitor.dev'])
  })
})
