import { describe, expect, it } from 'vitest'
import { cidFor, parseCid } from '../page/src/ipfs/cid.js'
import { importTree } from '../page/src/ipfs/unixfs.js'
import { createKeep } from '../page/src/keep/store.js'
import { memoryBackend } from '../page/src/keep/backends.js'
import { createPool } from '../page/src/serve/pool.js'
import { createSeeder, PEERS_PER_SHARE, PEERS_TOTAL } from '../page/src/serve/seeder.js'
import { createLink, FRAME_BYTES } from '../page/src/serve/wire.js'

const text = new TextEncoder()

/** One end of a data channel. */
class FakeChannel extends EventTarget {
  readyState = 'open'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  binaryType = 'blob'
  frames: Uint8Array[] = []
  other: FakeChannel | null = null
  constructor (readonly name: string) { super() }
  send (data: Uint8Array) {
    this.frames.push(data.slice())
    const peer = this.other
    const copy = data.slice().buffer
    setTimeout(() => { if (peer !== null && peer.readyState === 'open') peer.dispatchEvent(Object.assign(new Event('message'), { data: copy })) }, 0)
  }

  close () {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
    const peer = this.other
    if (peer !== null && peer.readyState !== 'closed') setTimeout(() => peer.close(), 0)
  }
}

function pair () {
  const a = new FakeChannel('a')
  const b = new FakeChannel('b')
  a.other = b
  b.other = a
  return [a, b] as const
}

const block = (size: number, seed = 1) => Uint8Array.from({ length: size }, (_, i) => (i * 7 + seed) & 255)
const waitFor = async (condition: () => boolean, ms = 2000) => {
  const until = Date.now() + ms
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

describe('the wire protocol', () => {
  async function linked (answer: (cid: string) => Promise<Uint8Array | null>, maxInFlight?: number) {
    const [a, b] = pair()
    const asked = createLink(a as any)
    const answered = createLink(b as any, { onRequest: answer, ...(maxInFlight === undefined ? {} : { maxInFlight }) })
    return { asked, answered, a, b }
  }

  it('answers a request with the block, however large, in frames of at most 64 KiB', async () => {
    const data = block(262_144)
    const cid = (await cidFor(0x55, data)).string
    const { asked, a, b } = await linked(async () => data)
    const got = await asked.request(parseCid(cid).bytes)
    expect(got).toEqual(data)
    expect(b.frames.length - 1, 'a hello, then the block in frames').toBe(Math.ceil((1 + 4 + 262_144) / (FRAME_BYTES - 5)))
    expect(Math.max(...b.frames.map((frame) => frame.length))).toBeLessThanOrEqual(FRAME_BYTES)
    expect(a.frames.every((frame) => frame.length < 100)).toBe(true)
    expect(asked.downloaded).toBe(262_144)
  })

  it('says none when the peer has not got the block', async () => {
    const { asked } = await linked(async () => null)
    expect(await asked.request(parseCid((await cidFor(0x55, block(10))).string).bytes)).toBeNull()
  })

  it('answers many requests at once, each its own', async () => {
    const blocks = await Promise.all(Array.from({ length: 20 }, async (_, i) => ({ data: block(70_000 + i, i), cid: (await cidFor(0x55, block(70_000 + i, i))).string })))
    const { asked } = await linked(async (cid) => blocks.find((b) => b.cid === cid)?.data ?? null)
    const got = await Promise.all(blocks.map((b) => asked.request(parseCid(b.cid).bytes)))
    got.forEach((data, i) => expect(data, `block ${i}`).toEqual(blocks[i]!.data))
  }, 30_000)

  it('waits while the channel\'s buffer is full and goes on when it empties', async () => {
    const data = block(200_000)
    const [a, b] = pair()
    createLink(b as any, { onRequest: async () => data })
    const asked = createLink(a as any)
    b.bufferedAmount = 2_000_000
    const pending = asked.request(parseCid((await cidFor(0x55, data)).string).bytes)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const sentWhileFull = b.frames.length
    expect(sentWhileFull).toBeLessThanOrEqual(2)
    b.bufferedAmount = 0
    b.dispatchEvent(new Event('bufferedamountlow'))
    expect(await pending).toEqual(data)
    expect(b.frames.length).toBeGreaterThan(sentWhileFull)
  })

  it('ends the link of a peer that asks for more at once than it may, or for something that is not a CID', async () => {
    const stuck: (() => void)[] = []
    const { asked, answered } = await linked(() => new Promise((resolve) => { stuck.push(() => resolve(null)) }), 2)
    const cid = parseCid((await cidFor(0x55, block(5))).string).bytes
    const results = [asked.request(cid), asked.request(cid), asked.request(cid)].map((p) => p.then(() => 'answered', () => 'closed'))
    await waitFor(() => !answered.open)
    stuck.forEach((release) => release())
    expect(await Promise.all(results)).toContain('closed')
    const second = await linked(async () => null)
    await expect(second.asked.request(Uint8Array.of(9, 9, 9))).rejects.toThrow()
    await waitFor(() => !second.answered.open)
  })

  it('ends the link of a peer that speaks another version or sends a frame that is too large', async () => {
    const [a, b] = pair()
    const link = createLink(b as any, {})
    a.send(Uint8Array.of(1, 0, 0, 0, 1, 0, 9))
    await waitFor(() => !link.open)
    const [c, d] = pair()
    const big = createLink(d as any, {})
    c.send(new Uint8Array(FRAME_BYTES + 1))
    await waitFor(() => !big.open)
  })

  it('rejects a request that gets no answer in time, and every one still waiting when the link closes', async () => {
    const [a, b] = pair()
    createLink(b as any, { onRequest: () => new Promise(() => {}) })
    const asked = createLink(a as any)
    const cid = parseCid((await cidFor(0x55, block(3))).string).bytes
    await expect(asked.request(cid, 20)).rejects.toThrow('did not answer')
    const waiting = asked.request(cid, 5000)
    asked.close()
    await expect(waiting).rejects.toThrow('closed')
    await expect(asked.request(cid)).rejects.toThrow('closed')
  })
})

describe('the peers of a receiving page', () => {
  async function swarmOf (...seeds: ((cid: string) => Promise<Uint8Array | null>)[]) {
    const pool = createPool({ waitMs: 50 })
    const links = seeds.map((answer) => {
      const [a, b] = pair()
      createLink(b as any, { onRequest: answer })
      const link = createLink(a as any)
      pool.add(link)
      return link
    })
    return { pool, links }
  }

  it('gets a block from a peer and checks it', async () => {
    const data = block(1000)
    const cid = (await cidFor(0x55, data)).string
    const { pool } = await swarmOf(async () => data)
    expect(await pool.block(cid)).toEqual(data)
    expect(pool.stats).toEqual({ bytes: 1000, blocks: 1 })
  })

  it('drops a peer that sends a wrong block and asks another', async () => {
    const data = block(1000)
    const cid = (await cidFor(0x55, data)).string
    const lie = data.slice()
    lie[5] ^= 1
    const { pool, links } = await swarmOf(async () => lie, async () => data)
    expect(await pool.block(cid)).toEqual(data)
    expect(links.filter((link) => link.open)).toHaveLength(1)
    expect(pool.size).toBe(1)
  })

  it('goes on to the next peer when one has not got the block, and fails when none has', async () => {
    const data = block(500)
    const cid = (await cidFor(0x55, data)).string
    const { pool } = await swarmOf(async () => null, async () => data)
    expect(await pool.block(cid)).toEqual(data)
    const none = await swarmOf(async () => null, async () => null)
    await expect(none.pool.block(cid)).rejects.toThrow('No connected peer has this block')
    await expect(createPool().block(cid)).rejects.toThrow('No peer is connected')
  })

  it('lets only the allowed number of requests wait at once', async () => {
    let waiting = 0
    let peak = 0
    const data = block(200)
    const cid = (await cidFor(0x55, data)).string
    const pool = createPool({ maxInFlight: 3 })
    const [a, b] = pair()
    createLink(b as any, { onRequest: async () => { waiting++; peak = Math.max(peak, waiting); await new Promise((r) => setTimeout(r, 10)); waiting--; return data } })
    pool.add(createLink(a as any))
    await Promise.all(Array.from({ length: 12 }, () => pool.block(cid)))
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(0)
  })

  it('says whether a peer came, and stops waiting when told to', async () => {
    const pool = createPool()
    expect(await pool.hasPeer(20)).toBe(false)
    const [a, b] = pair()
    createLink(b as any, {})
    setTimeout(() => pool.add(createLink(a as any)), 10)
    expect(await pool.hasPeer(1000)).toBe(true)
    const controller = new AbortController()
    const waiting = createPool().hasPeer(5000, controller.signal)
    controller.abort()
    expect(await waiting).toBe(false)
  })

  it('lets every peer go when closed', async () => {
    const { pool, links } = await swarmOf(async () => null, async () => null)
    pool.close()
    expect(links.every((link) => !link.open)).toBe(true)
    const [late] = pair()
    const link = createLink(late as any)
    pool.add(link)
    expect(link.open).toBe(false)
  })
})

describe('a seeder', () => {
  async function keptShare () {
    const keep = createKeep(memoryBackend())
    const files = [{ path: 'a.txt', content: text.encode('hello') }, { path: 'b.txt', content: text.encode('world') }]
    const imported = await importTree(files, () => {})
    await keep.add(imported.cid, { kind: 'files', encrypted: false, bytes: 10, files: 2, online: true }, async (sink) => { await importTree(files, sink) })
    return { keep, root: imported.cid }
  }

  it('answers with blocks of its own share and none that are not', async () => {
    const { keep, root } = await keptShare()
    const total = { links: 0 }
    const seeder = createSeeder({ keep, root, total, onChange: () => {} })
    const hello = (await cidFor(0x55, text.encode('hello'))).string
    expect(await seeder.linkHandlers.onRequest!(hello)).toEqual(text.encode('hello'))
    expect(await seeder.linkHandlers.onRequest!((await cidFor(0x55, text.encode('other'))).string)).toBeNull()
    expect(seeder.stats.uploaded).toBe(5)
    expect(seeder.linkHandlers.maxInFlight).toBe(32)
  })

  it('takes eight peers for a share and twenty-four in all', async () => {
    const { keep, root } = await keptShare()
    const total = { links: 0 }
    const seeder = createSeeder({ keep, root, total, onChange: () => {} })
    const links = Array.from({ length: 10 }, () => {
      const [a, b] = pair()
      createLink(a as any)
      return createLink(b as any)
    })
    for (const link of links.slice(0, PEERS_PER_SHARE)) seeder.attach(link)
    expect(seeder.peers).toBe(8)
    expect(seeder.canAccept()).toBe(false)
    seeder.attach(links[8]!)
    expect(links[8]!.open).toBe(false)
    expect(PEERS_TOTAL).toBe(24)
    const crowded = createSeeder({ keep, root, total: { links: 24 }, onChange: () => {} })
    expect(crowded.canAccept()).toBe(false)
    seeder.closeAll()
    await waitFor(() => links.slice(0, 8).every((link) => !link.open))
  })
})
