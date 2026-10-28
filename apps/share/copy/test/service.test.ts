import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { readCar, writeCar } from '../../page/src/ipfs/car.js'
import { importTree } from '../../page/src/ipfs/unixfs.js'
import { blockedFile, pinsFile, readBlocked, readPins } from '../store.mjs'

/** A share as the page keeps it: the blocks of a directory built the way Kubo's `add -r --cid-version=1` builds it. */
async function shareOf (files: Record<string, string | Uint8Array>) {
  const blocks = new Map<string, Uint8Array>()
  const tree = Object.entries(files).map(([path, content]) => ({ path, content: new Blob([content]) }))
  const { cid } = await importTree(tree, async (blockCid: string, bytes: Uint8Array) => { blocks.set(blockCid, bytes) })
  return { cid, blocks, car: writeCar(cid, blocks) }
}

/** A share of fresh random bytes, so that no two tests (or runs) make the same address. */
const randomShare = async (size = 700_000) => await shareOf({ 'note.txt': randomBytes(16).toString('hex'), 'data.bin': randomBytes(size) })

const SERVICE = fileURLToPath(new URL('../copy.mjs', import.meta.url))
const EXPIRE = fileURLToPath(new URL('../expire.mjs', import.meta.url))
const KEY = 'test-account-key'
const DAY = 24 * 60 * 60 * 1000
const run = promisify(execFile)

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch { /* already gone */ }
  }
})

/** A Kubo-compatible RPC API that pins in memory: the node, or the account when it is given a key. */
interface Fake { url: string, pinned: Set<string>, imports: string[], removals: string[], failImport: boolean, key: string | null, seen: string[] }

async function fakeRpc (key: string | null): Promise<Fake> {
  const fake: Fake = { url: '', pinned: new Set(), imports: [], removals: [], failImport: false, key, seen: [] }
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    fake.seen.push(String(req.headers.authorization ?? ''))
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(`${JSON.stringify(body)}\n`) }
    if (key !== null && req.headers.authorization !== `Bearer ${key}`) return json(403, { Message: 'no key' })
    const arg = url.searchParams.get('arg') ?? ''
    if (url.pathname === '/api/v0/pin/ls') return fake.pinned.has(arg) ? json(200, { Keys: { [arg]: { Type: 'recursive' } } }) : json(500, { Message: `path '${arg}' is not pinned` })
    if (url.pathname === '/api/v0/pin/rm') {
      fake.removals.push(arg)
      return fake.pinned.delete(arg) ? json(200, { Pins: [arg] }) : json(500, { Message: `${arg} is not pinned` })
    }
    if (url.pathname === '/api/v0/dag/import') {
      void new Response(req as never, { headers: req.headers as never, method: 'POST', duplex: 'half' } as never).formData().then(async (form) => {
        if (fake.failImport) return json(500, { Message: 'disk full' })
        const car = new Uint8Array(await (form.get('file') as File).arrayBuffer())
        const name = (form.get('file') as File).name.replace(/\.car$/, '')
        await readCar(car, name)
        fake.imports.push(name)
        fake.pinned.add(name)
        json(200, { Root: { Cid: { '/': name }, PinErrorMsg: '' } })
      })
      return
    }
    json(404, { Message: 'no such call' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return fake
}

interface Running { base: string, dir: string, node: Fake, account: Fake, env: Record<string, string>, child: ChildProcess }

/** The service as systemd runs it: its own process, its settings in the environment, and fakes for the node and the account. */
async function start (limits: Record<string, string> = {}): Promise<Running> {
  const dir = await mkdtemp(join(tmpdir(), 'share-copy-service-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const [node, account] = [await fakeRpc(null), await fakeRpc(KEY)]
  const env = { ...process.env, PORT: '0', STATE_DIR: dir, FILEBASE_KEY: KEY, FILEBASE_RPC: account.url, KUBO_RPC: node.url, ...limits } as Record<string, string>
  const child = spawn(process.execPath, [SERVICE], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanups.push(() => { child.kill('SIGKILL') })
  const base = await new Promise<string>((resolve, reject) => {
    let pending = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text: string) => {
      pending += text
      const match = /listening on (\S+)/.exec(pending)
      if (match?.[1] != null) resolve(`http://${match[1]}`)
    })
    child.on('exit', (code) => { reject(new Error(`the service stopped with ${String(code)}`)) })
  })
  return { base, dir, node, account, env, child }
}

const post = async (url: string, body?: Uint8Array, client = '203.0.113.9') => await fetch(url, { method: 'POST', ...(body === undefined ? {} : { body: new Blob([body]) }), headers: { 'x-forwarded-for': client, ...(body ? { 'content-type': 'application/vnd.ipld.car' } : {}) } })
const keep = async (s: Running, cid: string, car: Uint8Array, client?: string) => await post(`${s.base}/api/v0/keep?arg=${cid}`, car, client)
const status = async (s: Running, cid: string, size: number, client?: string) => await post(`${s.base}/api/v0/status?arg=${cid}&size=${size}`, undefined, client)

describe('the copy service', () => {
  it('keeps a share on the node and on the account, and answers with the address and the day it ends', async () => {
    const s = await start()
    const share = await randomShare()
    expect(await (await status(s, share.cid, share.car.length)).json()).toMatchObject({ Hash: share.cid, KeptUntil: null })
    const response = await keep(s, share.cid, share.car)
    expect(response.status).toBe(200)
    const answer = await response.json() as { Hash: string, KeptUntil: string, Size: string }
    expect(answer.Hash).toBe(share.cid)
    expect(Date.parse(answer.KeptUntil)).toBeGreaterThan(Date.now() + 29 * DAY)
    expect(Date.parse(answer.KeptUntil)).toBeLessThan(Date.now() + 31 * DAY)
    expect(s.node.imports).toEqual([share.cid])
    expect(s.account.imports).toEqual([share.cid])
    expect(s.node.seen.every((header) => header === '')).toBe(true)
    expect(s.account.seen.every((header) => header === `Bearer ${KEY}`)).toBe(true)
    const pin = (await readPins(pinsFile(s.dir))).get(share.cid)
    expect(pin).toMatchObject({ kubo: true, filebase: true, expired: false, bytes: Number(answer.Size) })
    expect(await (await status(s, share.cid, share.car.length)).json()).toMatchObject({ Hash: share.cid, KeptUntil: answer.KeptUntil })
  }, 30_000)

  it('refuses a CAR that is not the address it is sent under, and imports nothing', async () => {
    const s = await start()
    const [share, other] = [await randomShare(), await randomShare()]
    const response = await keep(s, other.cid, share.car)
    expect(response.status).toBe(400)
    expect(((await response.json()) as { Message: string }).Message).toMatch(/not a share Orivon's server can keep/)
    const tampered = share.car.slice()
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
    expect((await keep(s, share.cid, tampered)).status).toBe(400)
    expect(s.node.imports).toEqual([])
    expect(s.account.imports).toEqual([])
    expect((await readPins(pinsFile(s.dir))).size).toBe(0)
  }, 30_000)

  it('refuses a share over the limit before it reads the body, in the words the page shows', async () => {
    const s = await start({ CAR_BYTES: '100000' })
    const share = await randomShare()
    const response = await keep(s, share.cid, share.car)
    expect(response.status).toBe(413)
    expect(((await response.json()) as { Message: string }).Message).toMatch(/too large for Orivon's server/)
    expect((await status(s, share.cid, share.car.length)).status).toBe(413)
    expect(s.node.imports).toEqual([])
  }, 30_000)

  it('keeps what one address may send in a day, and what the server holds at once', async () => {
    const daily = await start({ DAY_BYTES: '1200000' })
    const [one, two] = [await randomShare(500_000), await randomShare(500_000)]
    expect((await keep(daily, one.cid, one.car)).status).toBe(200)
    const third = await randomShare(500_000)
    expect((await keep(daily, two.cid, two.car)).status).toBe(200)
    const over = await keep(daily, third.cid, third.car)
    expect(over.status).toBe(429)
    expect(((await over.json()) as { Message: string }).Message).toMatch(/a day from one address/)
    expect((await keep(daily, third.cid, third.car, '198.51.100.4')).status).toBe(200)

    const live = await start({ LIVE_BYTES: '900000' })
    const [a, b] = [await randomShare(500_000), await randomShare(500_000)]
    expect((await keep(live, a.cid, a.car)).status).toBe(200)
    const full = await keep(live, b.cid, b.car, '198.51.100.4')
    expect(full.status).toBe(503)
    expect(((await full.json()) as { Message: string }).Message).toMatch(/no room for another copy/)
    expect(live.node.imports).toEqual([a.cid])
  }, 60_000)

  it('keeps a share once: the same share sent again is answered as kept, with the same day', async () => {
    const s = await start()
    const share = await randomShare()
    const first = await (await keep(s, share.cid, share.car)).json() as { KeptUntil: string }
    const again = await keep(s, share.cid, share.car)
    expect(again.status).toBe(200)
    expect(((await again.json()) as { KeptUntil: string }).KeptUntil).toBe(first.KeptUntil)
    expect(s.node.imports).toEqual([share.cid])
    expect(s.account.imports).toEqual([share.cid])
  }, 30_000)

  it('never unpins what the node or the account held before the service saw it, and does not pin it again', async () => {
    const s = await start()
    const share = await randomShare()
    s.node.pinned.add(share.cid)
    expect((await keep(s, share.cid, share.car)).status).toBe(200)
    expect(s.node.imports).toEqual([])
    expect(s.account.imports).toEqual([share.cid])
    expect(await readPins(pinsFile(s.dir))).toMatchObject(new Map([[share.cid, { kubo: false, filebase: true }]]))
    await appendFile(pinsFile(s.dir), `\n${JSON.stringify({ cid: share.cid, dropped: true })}\n${JSON.stringify({ cid: share.cid, at: Date.now() - 31 * DAY, bytes: 5, kubo: false, filebase: true, expired: false })}\n`)
    await run(process.execPath, [EXPIRE], { env: s.env })
    expect(s.node.removals).toEqual([])
    expect(s.account.removals).toEqual([share.cid])
    expect(s.node.pinned.has(share.cid)).toBe(true)
  }, 30_000)

  it('undoes a copy that one of the two could not take, and says so', async () => {
    const s = await start()
    s.account.failImport = true
    const share = await randomShare()
    const response = await keep(s, share.cid, share.car)
    expect(response.status).toBe(502)
    expect(((await response.json()) as { Message: string }).Message).toMatch(/could not keep the share right now/)
    expect(s.node.pinned.has(share.cid)).toBe(false)
    expect((await readPins(pinsFile(s.dir))).has(share.cid)).toBe(false)
    s.account.failImport = false
    expect((await keep(s, share.cid, share.car)).status).toBe(200)
  }, 30_000)

  it('is free for a sender again as soon as it has its answer, whether the answer was a copy or a refusal', async () => {
    const s = await start()
    for (let i = 0; i < 6; i++) {
      const share = await randomShare(2_000)
      expect((await keep(s, share.cid, share.car)).status).toBe(200)
      expect((await keep(s, share.cid, new Uint8Array([1, 2, 3]))).status).toBe(200)
      const other = await randomShare(2_000)
      expect((await keep(s, other.cid, share.car)).status).toBe(400)
    }
  }, 60_000)

  it('ends copies after their month, and takes one down at once, for good', async () => {
    const s = await start()
    const [old, fresh, bad] = [await randomShare(), await randomShare(), await randomShare()]
    for (const share of [old, fresh, bad]) expect((await keep(s, share.cid, share.car)).status).toBe(200)
    const pins = pinsFile(s.dir)
    const lines = (await readFile(pins, 'utf8')).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as { cid: string, at: number })
    const aged = lines.map((l) => (l.cid === old.cid ? { ...l, at: Date.now() - 31 * DAY } : l)).map((l) => JSON.stringify(l)).join('\n')
    await rm(pins)
    await appendFile(pins, `${aged}\n`)
    await run(process.execPath, [EXPIRE], { env: s.env })
    expect(s.node.pinned.has(old.cid)).toBe(false)
    expect(s.account.pinned.has(old.cid)).toBe(false)
    expect(s.node.pinned.has(fresh.cid)).toBe(true)
    expect((await readPins(pins)).get(old.cid)?.expired).toBe(true)

    await run(process.execPath, [EXPIRE, bad.cid], { env: s.env })
    expect(s.node.pinned.has(bad.cid)).toBe(false)
    expect(s.account.pinned.has(bad.cid)).toBe(false)
    expect([...await readBlocked(blockedFile(s.dir))]).toEqual([bad.cid])
    const refused = await keep(s, bad.cid, bad.car)
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as { Message: string }).Message).toMatch(/does not keep this share/)
    expect((await status(s, bad.cid, bad.car.length)).status).toBe(403)
    expect(s.node.imports.filter((cid) => cid === bad.cid)).toHaveLength(1)
    expect((await keep(s, fresh.cid, fresh.car)).status).toBe(200)
  }, 60_000)

  it('keeps a share again after its month, as a fresh copy', async () => {
    const s = await start()
    const share = await randomShare()
    expect((await keep(s, share.cid, share.car)).status).toBe(200)
    const pins = pinsFile(s.dir)
    const [line] = (await readFile(pins, 'utf8')).split('\n').filter((l) => l.trim() !== '')
    await rm(pins)
    await appendFile(pins, `${JSON.stringify({ ...JSON.parse(line as string), at: Date.now() - 31 * DAY })}\n`)
    await run(process.execPath, [EXPIRE], { env: s.env })
    expect(s.node.pinned.has(share.cid)).toBe(false)
    const again = await keep(s, share.cid, share.car)
    expect(again.status).toBe(200)
    expect(Date.parse(((await again.json()) as { KeptUntil: string }).KeptUntil)).toBeGreaterThan(Date.now() + 29 * DAY)
    expect(s.node.imports).toEqual([share.cid, share.cid])
    expect((await readPins(pins)).get(share.cid)?.expired).toBe(false)
  }, 30_000)

  it('asks for an address and a size, and answers the other calls plainly', async () => {
    const s = await start()
    expect((await post(`${s.base}/api/v0/keep?arg=nonsense`, new Uint8Array([1]))).status).toBe(400)
    expect((await post(`${s.base}/api/v0/add`)).status).toBe(404)
    const share = await randomShare()
    const noLength = await fetch(`${s.base}/api/v0/keep?arg=${share.cid}`, { method: 'POST', body: new ReadableStream({ start (c) { c.enqueue(share.car); c.close() } }), duplex: 'half', headers: { 'content-type': 'application/vnd.ipld.car' } } as RequestInit)
    expect(noLength.status).toBe(411)
    expect(await (await post(`${s.base}/api/v0/version`)).json()).toMatchObject({ Version: 'share-copy/1' })
    expect((await fetch(`${s.base}/health`)).status).toBe(200)
    expect(writeCar(share.cid, share.blocks).length).toBe(share.car.length)
  }, 30_000)
})
