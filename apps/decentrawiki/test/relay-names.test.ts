import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cidFor, DAG_PB, RAW } from '../page/src/ipfs/cid.js'
import { createRecord, generateNameKey, IPNS_RECORD_TYPE, nameOf } from '../page/src/ipfs/ipns.js'
import { importDirectory, importFile } from '../page/src/ipfs/unixfs.js'
import { kuboClient } from '../relay/from-node.mjs'
import {
  addBlocked, addChecked, addEnded, addKeep, judgeKeep, lapsedNames, liveNames, namesFile, readNames, republishNames, roomFor
} from '../relay/names.mjs'
import { boundaryOf, CORE_CIDS, KNOWN_CORES, parseMultipart, Refusal } from '../relay/rules.mjs'
import { addPin, KEEP_DAYS, pinsFile, readPins } from '../relay/store.mjs'

const encoder = new TextEncoder()
const DAY = 24 * 60 * 60 * 1000
const run = promisify(execFile)
const relayDir = fileURLToPath(new URL('../relay/', import.meta.url))
const CORE_NAME = 'tiddlywikicore-5.4.1.js'
const PAGE = `\n\n<!doctype html><html><body><script class="tiddlywiki-tiddler-store" type="application/json">[{"title":"$:/plugins/orivon/decentrawiki","text":"{}"}]</script><script src="${CORE_NAME}" onerror="x"></script></body></html>`
const coreBytes = encoder.encode('/* a TiddlyWiki core, for the test */')
const real = { sha: KNOWN_CORES[CORE_NAME], cid: CORE_CIDS[CORE_NAME] }

beforeAll(async () => {
  (KNOWN_CORES as Record<string, string>)[CORE_NAME] = createHash('sha256').update(coreBytes).digest('hex');
  (CORE_CIDS as Record<string, string>)[CORE_NAME] = (await importFile(coreBytes)).cid
})
afterAll(() => {
  (KNOWN_CORES as Record<string, string>)[CORE_NAME] = real.sha;
  (CORE_CIDS as Record<string, string>)[CORE_NAME] = real.cid
})

async function refusal (promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Refusal) return error
    throw error
  }
  throw new Error('accepted what should be refused')
}

/** A dag-pb sha2-256 CIDv1, which is what a wiki's folder is. */
async function wikiCid (seed: string) {
  return (await cidFor(DAG_PB, encoder.encode(seed))).string
}

async function newName () {
  const key = await generateNameKey()
  return { key, name: nameOf(key.publicKey) }
}

interface SignOptions { sequence?: number, validFor?: number, now?: number, value?: string }
async function sign (key: { seed: Uint8Array }, cid: string, { sequence = 1, validFor = 3650 * DAY, now = Date.now(), value }: SignOptions = {}) {
  return await createRecord({ seed: key.seed, value: value ?? `/ipfs/${cid}`, sequence, validity: new Date(now + validFor), ttlMs: 3_600_000 })
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dw-names-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('the record of kept names', () => {
  it('keeps what it adds across reads, the newest keep line of a name standing', async () => {
    const file = namesFile(dir)
    const { key, name } = await newName()
    const cid = await wikiCid('one')
    await addKeep(file, { name, cid, sequence: 1, record: await sign(key, cid), at: 10 })
    await addKeep(file, { name, cid: await wikiCid('two'), sequence: 2, record: await sign(key, cid, { sequence: 2 }), at: 20 })
    const state = await readNames(file)
    expect([...state.names.keys()]).toEqual([name])
    const kept = state.names.get(name)
    expect(kept).toMatchObject({ sequence: 2, at: 20, ended: false, cid: await wikiCid('two') })
  })

  it('stores the record\'s bytes exactly', async () => {
    const file = namesFile(dir)
    const { key, name } = await newName()
    const cid = await wikiCid('bytes')
    const record = await sign(key, cid)
    await addKeep(file, { name, cid, sequence: 1, record, at: 1 })
    expect((await readNames(file)).names.get(name)?.record).toEqual(record)
  })

  it('survives a line cut short, a line of nonsense and a record that is not base64', async () => {
    const file = namesFile(dir)
    const { key, name } = await newName()
    const cid = await wikiCid('cut')
    await addKeep(file, { name, cid, sequence: 1, record: await sign(key, cid), at: 1 })
    await appendFile(file, '{"name":"k51cut","cid":"bafy","sequence":1,"rec\n')
    await appendFile(file, 'null\n42\n')
    await appendFile(file, `${JSON.stringify({ name: 'k51bad', cid: 'bafy', sequence: 1, record: '***', at: 1 })}\n`)
    await appendFile(file, '{"name":"k51tail')
    expect([...(await readNames(file)).names.keys()]).toEqual([name])
  })

  it('ends a name with a line of its own, and a later keep revives it', async () => {
    const file = namesFile(dir)
    const { key, name } = await newName()
    const cid = await wikiCid('end')
    await addKeep(file, { name, cid, sequence: 1, record: await sign(key, cid), at: 1 })
    await addEnded(file, name, 2)
    await addEnded(file, 'k51unknown', 2)
    expect((await readNames(file)).names.get(name)?.ended).toBe(true)
    expect((await readNames(file)).names.has('k51unknown')).toBe(false)
    await addKeep(file, { name, cid, sequence: 2, record: await sign(key, cid, { sequence: 2 }), at: 3 })
    expect((await readNames(file)).names.get(name)).toMatchObject({ ended: false, sequence: 2 })
  })

  it('holds the versions checked and the versions blocked', async () => {
    const file = namesFile(dir)
    await addChecked(file, 'bafychecked', 1)
    await addBlocked(file, 'bafyblocked', 1)
    const state = await readNames(file)
    expect([...state.checked]).toEqual(['bafychecked'])
    expect([...state.blocked]).toEqual(['bafyblocked'])
    expect((await readNames(join(dir, 'missing.jsonl'))).names.size).toBe(0)
  })
})

describe('whether a name is kept', () => {
  const now = Date.now()
  const pins = new Map()
  const empty = async () => await readNames(namesFile(dir))

  it('accepts a record that stays valid long enough and points at one folder', async () => {
    const { key, name } = await newName()
    const cid = await wikiCid('ok')
    const judged = await judgeKeep({ name, body: await sign(key, cid, { sequence: 7 }), state: await empty(), pins, now })
    expect(judged).toMatchObject({ name, cid, sequence: 7, needsRead: true, already: undefined })
  })

  it('names the canonical form of a name written another way', async () => {
    const { key, name } = await newName()
    const cid = await wikiCid('canonical')
    const judged = await judgeKeep({ name: `  ${name}  `, body: await sign(key, cid), state: await empty(), pins, now })
    expect(judged.name).toBe(name)
  })

  it('refuses what is not a name, not a record, or not signed by the name\'s key, in the IPNS words', async () => {
    const { key, name } = await newName()
    const cid = await wikiCid('refuse')
    const state = await empty()
    const body = await sign(key, cid)
    const bad = await refusal(judgeKeep({ name: 'k51hello', body, state, pins, now }))
    expect(bad.status).toBe(400)
    expect(bad.message).toMatch(/not an IPNS name/)
    expect((await refusal(judgeKeep({ name, body: encoder.encode('not a record'), state, pins, now }))).message).toMatch(/not a usable IPNS record|IPNS record/)
    const other = await newName()
    const wrongKey = await refusal(judgeKeep({ name: other.name, body, state, pins, now }))
    expect(wrongKey.status).toBe(400)
    expect(wrongKey.message).toMatch(/not signed by the key that owns this name/)
    const ran = await refusal(judgeKeep({ name, body: await sign(key, cid, { validFor: -DAY }), state, pins, now }))
    expect(ran).toMatchObject({ status: 400 })
    expect(ran.message).toMatch(/ran out at/)
  })

  it('refuses a record that runs out before the days the name is kept', async () => {
    const { key, name } = await newName()
    const cid = await wikiCid('short')
    const state = await empty()
    const short = await refusal(judgeKeep({ name, body: await sign(key, cid, { validFor: (KEEP_DAYS - 1) * DAY, now }), state, pins, now }))
    expect(short.status).toBe(400)
    expect(short.message).toMatch(/sooner than the 30 days/)
    const enough = await judgeKeep({ name, body: await sign(key, cid, { validFor: (KEEP_DAYS + 1) * DAY, now }), state, pins, now })
    expect(enough.cid).toBe(cid)
  })

  it('refuses a value that is not exactly /ipfs/ and the CIDv1 of one folder', async () => {
    const { key, name } = await newName()
    const state = await empty()
    const cid = await wikiCid('values')
    const raw = (await cidFor(RAW, encoder.encode('a file'))).string
    const values = [
      `/ipfs/${cid}/index.html`, `/ipfs/${cid}/`, `/ipns/${name}`, cid, '/ipfs/', '/ipfs/notacid',
      `/ipfs/${raw}`, '/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
    ]
    for (const value of values) {
      const refused = await refusal(judgeKeep({ name, body: await sign(key, cid, { value }), state, pins, now }))
      expect([value, refused.status]).toEqual([value, 400])
      expect(refused.message).toMatch(/does not point at a wiki/)
    }
  })

  it('refuses a version taken down, ahead of the name\'s history', async () => {
    const { key, name } = await newName()
    const cid = await wikiCid('blocked')
    const file = namesFile(dir)
    await addKeep(file, { name, cid: await wikiCid('other'), sequence: 9, record: await sign(key, cid, { sequence: 9 }), at: now })
    await addBlocked(file, cid)
    const gone = await refusal(judgeKeep({ name, body: await sign(key, cid, { sequence: 1 }), state: await empty(), pins, now }))
    expect(gone.status).toBe(410)
    expect(gone.message).toMatch(/taken down/)
  })

  it('refuses a lower sequence than the live name\'s, naming it, and a different record at the same one', async () => {
    const { key, name } = await newName()
    const cid = await wikiCid('history')
    const file = namesFile(dir)
    const stored = await sign(key, cid, { sequence: 5 })
    await addKeep(file, { name, cid, sequence: 5, record: stored, at: now - DAY })
    const state = await empty()
    const older = await refusal(judgeKeep({ name, body: await sign(key, cid, { sequence: 4 }), state, pins, now }))
    expect(older.status).toBe(409)
    expect(older.message).toMatch(/newer version of this name was published already.*sequence 5/)
    const clash = await refusal(judgeKeep({ name, body: await sign(key, await wikiCid('different'), { sequence: 5 }), state, pins, now }))
    expect(clash.status).toBe(409)
    expect(clash.message).toMatch(/same sequence/)
    const newer = await judgeKeep({ name, body: await sign(key, cid, { sequence: 6 }), state, pins, now })
    expect(newer.sequence).toBe(6)
  })

  it('accepts the very record it keeps already, as already kept, with nothing to read', async () => {
    const { key, name } = await newName()
    const cid = await wikiCid('same')
    const file = namesFile(dir)
    const record = await sign(key, cid, { sequence: 3 })
    await addKeep(file, { name, cid, sequence: 3, record, at: now - DAY })
    const judged = await judgeKeep({ name, body: record, state: await empty(), pins, now })
    expect(judged.already).toMatchObject({ name, at: now - DAY, sequence: 3 })
    expect(judged.needsRead).toBe(false)
  })

  it('keeps a name that was ended, or whose days are over, again from the same record or a newer one, never an older one', async () => {
    const { key, name } = await newName()
    const cid = await wikiCid('revive')
    const file = namesFile(dir)
    const stored = await sign(key, cid, { sequence: 5 })
    await addKeep(file, { name, cid, sequence: 5, record: stored, at: now - (KEEP_DAYS + 1) * DAY })
    const lapsed = await judgeKeep({ name, body: stored, state: await empty(), pins, now })
    expect(lapsed.already).toBeUndefined()
    await addKeep(file, { name, cid, sequence: 5, record: stored, at: now - DAY })
    await addEnded(file, name)
    const replayed = await refusal(judgeKeep({ name, body: await sign(key, cid, { sequence: 2 }), state: await empty(), pins, now }))
    expect(replayed.status).toBe(409)
    expect(replayed.message).toMatch(/newer version of this name was published already.*sequence 5/)
    const newer = await judgeKeep({ name, body: await sign(key, cid, { sequence: 6 }), state: await empty(), pins, now })
    expect(newer.sequence).toBe(6)
  })

  it('reads a version unless it is a free pin whose month is not over, or was checked before', async () => {
    const { key, name } = await newName()
    const cid = await wikiCid('reads')
    const body = await sign(key, cid)
    const pin = { cid, at: now, bytes: 1, preexisting: false, expired: false }
    expect((await judgeKeep({ name, body, state: await empty(), pins: new Map(), now })).needsRead).toBe(true)
    expect((await judgeKeep({ name, body, state: await empty(), pins: new Map([[cid, pin]]), now })).needsRead).toBe(false)
    expect((await judgeKeep({ name, body, state: await empty(), pins: new Map([[cid, { ...pin, expired: true }]]), now })).needsRead).toBe(true)
    await addChecked(namesFile(dir), cid)
    expect((await judgeKeep({ name, body, state: await empty(), pins: new Map(), now })).needsRead).toBe(false)
  })
})

describe('which names are live', () => {
  const now = Date.now()

  async function keep (file: string, label: string, options: { at?: number, validFor?: number, sequence?: number } = {}) {
    const { key, name } = await newName()
    const cid = await wikiCid(label)
    const record = await sign(key, cid, { validFor: options.validFor ?? 3650 * DAY, now: options.at ?? now, sequence: options.sequence ?? 1 })
    await addKeep(file, { name, cid, sequence: options.sequence ?? 1, record, at: options.at ?? now })
    return { name, cid }
  }

  it('republishes the newest record of each name that is not ended, not past its days, not blocked and still valid', async () => {
    const file = namesFile(dir)
    const live = await keep(file, 'live', { at: now - DAY })
    const ended = await keep(file, 'ended')
    await addEnded(file, ended.name)
    const old = await keep(file, 'old', { at: now - KEEP_DAYS * DAY })
    const blocked = await keep(file, 'blocked')
    await addBlocked(file, blocked.cid)
    const ran = await keep(file, 'ran', { at: now - 2 * DAY, validFor: DAY })
    const state = await readNames(file)
    expect(liveNames(state, now).map((entry) => entry.name)).toEqual([live.name])
    expect(lapsedNames(state, now).map((entry) => entry.name).sort()).toEqual([old.name, blocked.name, ran.name].sort())
  })

  it('has room for one more name until the cap, and always for a live name already kept', async () => {
    const file = namesFile(dir)
    const first = await keep(file, 'first')
    await keep(file, 'second')
    const state = await readNames(file)
    expect(roomFor(state, 'k51new', now, 3)).toBe(true)
    expect(roomFor(state, 'k51new', now, 2)).toBe(false)
    expect(roomFor(state, first.name, now, 2)).toBe(true)
  })
})

/** A Kubo-compatible HTTP stub: what it holds, and every call it got. */
interface Call { verb: string, arg: string, body: Uint8Array, contentType: string }
async function startKubo () {
  const kubo = {
    calls: [] as Call[],
    blocks: new Map<string, Uint8Array>(),
    files: new Map<string, Uint8Array>(),
    failPuts: false,
    gate: undefined as Promise<void> | undefined,
    url: '',
    server: undefined as unknown as Server,
    puts () { return kubo.calls.filter((call) => call.verb === 'routing/put') },
    async hold (files: Record<string, Uint8Array | string>) {
      const list = Object.entries(files).map(([path, bytes]) => ({ path, bytes: typeof bytes === 'string' ? encoder.encode(bytes) : bytes }))
      const { cid, blocks } = await importDirectory(list)
      for (const [k, v] of blocks) kubo.blocks.set(k, v)
      for (const file of list) kubo.files.set((await importFile(file.bytes)).cid, file.bytes)
      return cid
    }
  }
  kubo.server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const url = new URL(req.url ?? '/', 'http://kubo')
      const verb = url.pathname.replace('/api/v0/', '')
      const arg = url.searchParams.get('arg') ?? ''
      kubo.calls.push({ verb, arg, body: new Uint8Array(Buffer.concat(chunks)), contentType: String(req.headers['content-type'] ?? '') })
      const found = verb === 'block/get' ? kubo.blocks.get(arg) : verb === 'cat' ? kubo.files.get(arg) : undefined
      if (verb === 'routing/put') {
        await kubo.gate
        if (kubo.failPuts) return void res.writeHead(500).end('{"Message":"routing: offline","Code":0,"Type":"error"}')
        return void res.writeHead(200).end('{"Extra":"","ID":"","Responses":null,"Type":5}\n')
      }
      if (found === undefined) return void res.writeHead(500).end('{"Message":"block was not found locally (offline)","Code":0,"Type":"error"}')
      res.writeHead(200).end(found)
    })()
  })
  await new Promise<void>((resolve) => kubo.server.listen(0, '127.0.0.1', resolve))
  kubo.url = `http://127.0.0.1:${String((kubo.server.address() as { port: number }).port)}`
  return kubo
}

describe('putting the names back', () => {
  let kubo: Awaited<ReturnType<typeof startKubo>>
  beforeEach(async () => { kubo = await startKubo() })
  afterEach(() => { kubo.server.close() })

  it('puts every live name back with its record as the file part, and ends the lapsed ones', async () => {
    const file = namesFile(dir)
    const now = Date.now()
    const a = await newName()
    const b = await newName()
    const old = await newName()
    const cid = await wikiCid('republish')
    const recordA = await sign(a.key, cid)
    await addKeep(file, { name: a.name, cid, sequence: 1, record: recordA, at: now - DAY })
    await addKeep(file, { name: b.name, cid, sequence: 1, record: await sign(b.key, cid), at: now - 2 * DAY })
    await addKeep(file, { name: old.name, cid, sequence: 1, record: await sign(old.key, cid), at: now - (KEEP_DAYS + 1) * DAY })
    const summary = await republishNames({ kubo: kuboClient(kubo.url), file, now })
    expect(summary).toEqual({ republished: 2, failed: 0, ended: 1 })
    const puts = kubo.puts()
    expect(puts.map((put) => put.arg).sort()).toEqual([`/ipns/${a.name}`, `/ipns/${b.name}`].sort())
    const sent = puts.find((put) => put.arg === `/ipns/${a.name}`)
    const parts = parseMultipart(sent?.body ?? new Uint8Array(), boundaryOf(sent?.contentType) ?? '')
    expect(parts).toHaveLength(1)
    expect(parts[0]?.bytes).toEqual(recordA)
    expect((await readNames(file)).names.get(old.name)?.ended).toBe(true)
    expect((await readNames(file)).names.get(a.name)?.ended).toBe(false)
    expect(await republishNames({ kubo: kuboClient(kubo.url), file, now })).toEqual({ republished: 2, failed: 0, ended: 0 })
  })

  it('ends a name whose version was taken down, and logs a failed put and tries it on the next run', async () => {
    const file = namesFile(dir)
    const now = Date.now()
    const a = await newName()
    const b = await newName()
    const cidA = await wikiCid('taken-down')
    const cidB = await wikiCid('failing')
    await addKeep(file, { name: a.name, cid: cidA, sequence: 1, record: await sign(a.key, cidA), at: now })
    await addKeep(file, { name: b.name, cid: cidB, sequence: 1, record: await sign(b.key, cidB), at: now })
    await addBlocked(file, cidA)
    kubo.failPuts = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = await republishNames({ kubo: kuboClient(kubo.url), file, now })
    expect(first).toEqual({ republished: 0, failed: 1, ended: 1 })
    expect(error.mock.calls.flat().join('\n')).toContain(b.name)
    error.mockRestore()
    kubo.failPuts = false
    expect(await republishNames({ kubo: kuboClient(kubo.url), file, now })).toEqual({ republished: 1, failed: 0, ended: 0 })
  })

  it('puts two at a time, and leaves a name taken down while it ran', async () => {
    const file = namesFile(dir)
    const now = Date.now()
    const cid = await wikiCid('pool')
    const names = await Promise.all([1, 2, 3, 4].map(async () => await newName()))
    for (const { key, name } of names) await addKeep(file, { name, cid, sequence: 1, record: await sign(key, cid), at: now })
    let inFlight = 0
    let most = 0
    const slow = async (path: string, options: { timeoutMs: number, maxBytes: number }) => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight--
      return await kuboClient(kubo.url)(path, options)
    }
    expect((await republishNames({ kubo: slow, file, now })).republished).toBe(4)
    expect(most).toBe(2)

    kubo.calls.length = 0
    const takedown = async (path: string, options: { timeoutMs: number, maxBytes: number }) => {
      if (kubo.puts().length === 0) await addEnded(file, names[1]?.name ?? '')
      return await kuboClient(kubo.url)(path, options)
    }
    const summary = await republishNames({ kubo: takedown, file, now, atOnce: 1 })
    expect(summary.republished).toBe(3)
    expect(kubo.puts().map((put) => put.arg)).not.toContain(`/ipns/${names[1]?.name}`)
  })

  it('runs as the timer starts it, and fails only when nothing could be put', async () => {
    const file = namesFile(dir)
    const { key, name } = await newName()
    const cid = await wikiCid('program')
    await addKeep(file, { name, cid, sequence: 1, record: await sign(key, cid), at: Date.now() })
    const env = { ...process.env, STATE_DIR: dir, KUBO_RPC: kubo.url }
    const ok = await run(process.execPath, [join(relayDir, 'republish.mjs')], { env })
    expect(ok.stdout).toContain('[republish] republished 1, failed 0, ended 0')
    kubo.failPuts = true
    await expect(run(process.execPath, [join(relayDir, 'republish.mjs')], { env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('republished 0, failed 1') })
  })
})

describe('takedowns reach the names', () => {
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, STATE_DIR: dir, FILEBASE_KEY: '', FILEBASE_RPC: 'http://127.0.0.1:1', ...extra })
  let filebase: Server
  const removed: string[] = []
  beforeEach(async () => {
    removed.length = 0
    filebase = createServer((req, res) => { removed.push(new URL(req.url ?? '/', 'http://f').searchParams.get('arg') ?? ''); res.writeHead(200).end('{}') })
    await new Promise<void>((resolve) => filebase.listen(0, '127.0.0.1', resolve))
  })
  afterEach(() => { filebase.close() })
  const rpc = () => `http://127.0.0.1:${String((filebase.address() as { port: number }).port)}`

  it('unpins a free pin, blocks every CID named and ends every live name that points at one', async () => {
    const now = Date.now()
    const pinned = await wikiCid('pinned')
    const unpinned = await wikiCid('unpinned')
    const spared = await wikiCid('spared')
    await addPin(pinsFile(dir), { cid: pinned, at: now, bytes: 5, preexisting: false, expired: false })
    const a = await newName()
    const b = await newName()
    const c = await newName()
    for (const [who, cid] of [[a, pinned], [b, unpinned], [c, spared]] as const) {
      await addKeep(namesFile(dir), { name: who.name, cid, sequence: 1, record: await sign(who.key, cid), at: now })
    }
    const done = await run(process.execPath, [join(relayDir, 'expire.mjs'), pinned, unpinned], { env: env({ FILEBASE_KEY: 'k', FILEBASE_RPC: rpc() }) })
    expect(done.stdout).toContain('1 free pin(s) ended')
    expect(done.stdout).toContain('2 CID(s) blocked, 2 name(s) ended')
    expect(done.stderr).toContain('1 of the CIDs named are not live free pins')
    expect(removed).toEqual([pinned])
    const state = await readNames(namesFile(dir))
    expect([...state.blocked].sort()).toEqual([pinned, unpinned].sort())
    expect(state.names.get(a.name)?.ended).toBe(true)
    expect(state.names.get(b.name)?.ended).toBe(true)
    expect(state.names.get(c.name)?.ended).toBe(false)
    expect((await readPins(pinsFile(dir))).get(pinned)?.expired).toBe(true)
  })

  it('blocks a CID that is no free pin even where there is no key to unpin with', async () => {
    const cid = await wikiCid('nokey')
    const done = await run(process.execPath, [join(relayDir, 'expire.mjs'), cid], { env: env() })
    expect(done.stdout).toContain('1 CID(s) blocked')
    expect((await readNames(namesFile(dir))).blocked.has(cid)).toBe(true)
  })

  it('ends the names given to --name at once, with no key, and says so of one it does not keep', async () => {
    const now = Date.now()
    const a = await newName()
    const cid = await wikiCid('byname')
    await addKeep(namesFile(dir), { name: a.name, cid, sequence: 1, record: await sign(a.key, cid), at: now })
    const done = await run(process.execPath, [join(relayDir, 'expire.mjs'), '--name', a.name], { env: env() })
    expect(done.stdout).toContain('1 name(s) ended')
    expect((await readNames(namesFile(dir))).names.get(a.name)?.ended).toBe(true)
    const unknown = (await newName()).name
    await expect(run(process.execPath, [join(relayDir, 'expire.mjs'), '--name', unknown], { env: env() })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('is not a name this relay keeps') })
  })

  it('leaves the names to the republisher in the daily run', async () => {
    const now = Date.now()
    const a = await newName()
    const cid = await wikiCid('daily')
    await addKeep(namesFile(dir), { name: a.name, cid, sequence: 1, record: await sign(a.key, cid), at: now - (KEEP_DAYS + 1) * DAY })
    await run(process.execPath, [join(relayDir, 'expire.mjs')], { env: env({ FILEBASE_KEY: 'k', FILEBASE_RPC: rpc() }) })
    expect((await readNames(namesFile(dir))).names.get(a.name)?.ended).toBe(false)
  })
})

describe('keeping a name through the relay', () => {
  let kubo: Awaited<ReturnType<typeof startKubo>>
  let stateDir = ''
  let base = ''
  let log: ReturnType<typeof vi.spyOn>
  const saved = { ...process.env }
  let nextClient = 1

  beforeAll(async () => {
    kubo = await startKubo()
    stateDir = await mkdtemp(join(tmpdir(), 'dw-relay-http-'))
    Object.assign(process.env, { FILEBASE_KEY: 'test-key', PORT: '0', STATE_DIR: stateDir, KUBO_RPC: kubo.url })
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await import('../relay/relay.mjs')
    for (let waited = 0; base === '' && waited < 5000; waited += 20) {
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(log.mock.calls.flat().join('\n'))?.[1]
      if (port === undefined) await new Promise((resolve) => setTimeout(resolve, 20))
      else base = `http://127.0.0.1:${port}`
    }
    expect(base).not.toBe('')
  })
  afterAll(async () => {
    log.mockRestore()
    Object.assign(process.env, saved)
    kubo.server.close()
    await rm(stateDir, { recursive: true, force: true })
  })
  // The state is files; every test starts from none, and counts as a client of its own.
  beforeEach(async () => {
    await rm(namesFile(stateDir), { force: true })
    await rm(pinsFile(stateDir), { force: true })
    kubo.calls.length = 0
    kubo.failPuts = false
    kubo.gate = undefined
    log.mockClear()
  })

  const client = () => `198.51.100.${String(nextClient++)}`
  async function post (path: string, body: Uint8Array | undefined, who = client()) {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'x-forwarded-for': who, 'content-type': IPNS_RECORD_TYPE }, ...(body === undefined ? {} : { body }) })
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { status: response.status, type: response.headers.get('content-type') ?? '', bytes, text: new TextDecoder().decode(bytes) }
  }
  const keepPath = (name: string) => `/api/v0/name/keep?arg=${name}`
  const recordPath = (name: string) => `/api/v0/name/record?arg=${name}`
  const wikiFiles = { 'index.html': PAGE, [CORE_NAME]: coreBytes }
  async function freePin (cid: string) {
    await addPin(pinsFile(stateDir), { cid, at: Date.now(), bytes: 1, preexisting: false, expired: false })
  }

  it('keeps the name of a free pin without reading anything, with one put holding exactly the record', async () => {
    const cid = await kubo.hold(wikiFiles)
    await freePin(cid)
    const { key, name } = await newName()
    const record = await sign(key, cid, { sequence: 4 })
    const before = Date.now()
    const kept = await post(keepPath(name), record)
    expect(kept.status).toBe(200)
    const answer = JSON.parse(kept.text)
    expect(answer).toMatchObject({ Name: name, Value: `/ipfs/${cid}`, Sequence: 4 })
    expect(Date.parse(answer.KeptUntil)).toBeGreaterThanOrEqual(before + KEEP_DAYS * DAY)
    expect(Date.parse(answer.KeptUntil)).toBeLessThanOrEqual(Date.now() + KEEP_DAYS * DAY)
    expect(kubo.calls.map((call) => call.verb)).toEqual(['routing/put'])
    const put = kubo.puts()[0]
    expect(put?.arg).toBe(`/ipns/${name}`)
    const parts = parseMultipart(put?.body ?? new Uint8Array(), boundaryOf(put?.contentType) ?? '')
    expect(parts).toHaveLength(1)
    expect(parts[0]?.headers['content-disposition']).toMatch(/name="file"/)
    expect(parts[0]?.bytes).toEqual(record)
    expect([...(await readNames(namesFile(stateDir))).names.keys()]).toEqual([name])
    const logged = log.mock.calls.flat().join('\n')
    expect(logged).toContain(name)
    expect(logged).toContain(cid)
    expect(logged).toContain('sequence 4')
  })

  it('reads a version nobody uploaded from IPFS, checks it as an upload is, and reads it only once', async () => {
    const cid = await kubo.hold(wikiFiles)
    const first = await newName()
    const second = await newName()
    expect((await post(keepPath(first.name), await sign(first.key, cid))).status).toBe(200)
    expect(kubo.calls.map((call) => call.verb)).toEqual(['block/get', 'cat', 'cat', 'routing/put'])
    expect((await readNames(namesFile(stateDir))).checked.has(cid)).toBe(true)
    kubo.calls.length = 0
    expect((await post(keepPath(second.name), await sign(second.key, cid))).status).toBe(200)
    expect(kubo.calls.map((call) => call.verb)).toEqual(['routing/put'])
  })

  it('refuses a name that points at something that is not a wiki, and records and puts nothing', async () => {
    const page = await kubo.hold({ 'index.html': '<html>phish</html>', [CORE_NAME]: coreBytes })
    const movie = await kubo.hold({ ...wikiFiles, 'movie.mp4': 'x' })
    for (const cid of [page, movie]) {
      const { key, name } = await newName()
      const refused = await post(keepPath(name), await sign(key, cid))
      expect(refused.status).toBe(400)
      expect(JSON.parse(refused.text)).toMatchObject({ Type: 'error' })
      expect(refused.text).toMatch(/keeps no name for this version/)
    }
    expect(kubo.puts()).toHaveLength(0)
    expect((await readNames(namesFile(stateDir))).names.size).toBe(0)
  })

  it('says so in its own words when the version cannot be found on IPFS', async () => {
    const { key, name } = await newName()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const missing = await post(keepPath(name), await sign(key, await wikiCid('nowhere')))
    error.mockRestore()
    expect(missing.status).toBe(504)
    expect(missing.text).toMatch(/could not find this version on IPFS, so it does not keep its name.*pinned where others can fetch it/)
    expect(missing.text).not.toMatch(/editor page/)
    expect(kubo.puts()).toHaveLength(0)
  })

  it('refuses a lower sequence, and a different record at the same one, and takes a higher one', async () => {
    const cid = await kubo.hold(wikiFiles)
    await freePin(cid)
    const { key, name } = await newName()
    expect((await post(keepPath(name), await sign(key, cid, { sequence: 5 }))).status).toBe(200)
    const older = await post(keepPath(name), await sign(key, cid, { sequence: 4 }))
    expect(older.status).toBe(409)
    expect(older.text).toMatch(/newer version of this name was published already/)
    const clash = await post(keepPath(name), await sign(key, cid, { sequence: 5, validFor: 4000 * DAY }))
    expect(clash.status).toBe(409)
    expect(kubo.puts()).toHaveLength(1)
    expect((await post(keepPath(name), await sign(key, cid, { sequence: 6 }))).status).toBe(200)
    expect(kubo.puts()).toHaveLength(2)
  })

  it('answers an identical record as already kept: the stored time, no second put, no new line', async () => {
    const cid = await kubo.hold(wikiFiles)
    await freePin(cid)
    const { key, name } = await newName()
    const record = await sign(key, cid)
    const first = JSON.parse((await post(keepPath(name), record)).text)
    const again = await post(keepPath(name), record)
    expect(again.status).toBe(200)
    expect(JSON.parse(again.text).KeptUntil).toBe(first.KeptUntil)
    expect(kubo.puts()).toHaveLength(1)
    expect((await readFile(namesFile(stateDir), 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('records nothing when Kubo cannot put the record, and keeps the name when it is tried again', async () => {
    const cid = await kubo.hold(wikiFiles)
    await freePin(cid)
    const { key, name } = await newName()
    const record = await sign(key, cid)
    kubo.failPuts = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = await post(keepPath(name), record)
    error.mockRestore()
    expect(failed.status).toBe(502)
    expect(failed.text).toMatch(/could not publish the name right now/)
    expect(await readFile(namesFile(stateDir), 'utf8').catch(() => '')).toBe('')
    kubo.failPuts = false
    expect((await post(keepPath(name), record)).status).toBe(200)
  })

  it('refuses a name taken down, a bad name and too large a body, and one name at a time', async () => {
    const cid = await kubo.hold(wikiFiles)
    await freePin(cid)
    const { key, name } = await newName()
    await addBlocked(namesFile(stateDir), cid)
    expect((await post(keepPath(name), await sign(key, cid))).status).toBe(410)
    expect((await post(keepPath('k51nope'), await sign(key, cid))).status).toBe(400)
    expect((await post(keepPath(name), new Uint8Array(10241))).status).toBe(413)
    await rm(namesFile(stateDir), { force: true })
    let release: () => void = () => {}
    kubo.gate = new Promise<void>((resolve) => { release = resolve })
    const record = await sign(key, cid)
    const slow = post(keepPath(name), record)
    for (let i = 0; i < 100 && kubo.puts().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await post(keepPath(name), await sign(key, cid, { sequence: 2 }))).status).toBe(429)
    release()
    expect((await slow).status).toBe(200)
  })

  it('answers the newest record held for a name, live or ended, and 404 in Kubo\'s shape when it holds none', async () => {
    const cid = await kubo.hold(wikiFiles)
    await freePin(cid)
    const { key, name } = await newName()
    const record = await sign(key, cid, { sequence: 3 })
    const none = await post(recordPath(name), undefined)
    expect(none.status).toBe(404)
    expect(JSON.parse(none.text)).toMatchObject({ Type: 'error', Message: expect.stringContaining('holds no record') })
    await post(keepPath(name), record)
    const held = await post(recordPath(name), undefined)
    expect(held.status).toBe(200)
    expect(held.type).toBe(IPNS_RECORD_TYPE)
    expect(held.bytes).toEqual(record)
    await addEnded(namesFile(stateDir), name)
    expect((await post(recordPath(name), undefined)).bytes).toEqual(record)
    expect((await post(recordPath('k51nope'), undefined)).status).toBe(400)
  })

  it('keeps a number of names a day for one address, and no more than the live names it can hold', async () => {
    const cid = await kubo.hold(wikiFiles)
    await freePin(cid)
    const who = client()
    for (let i = 0; i < 20; i++) {
      const { key, name } = await newName()
      expect((await post(keepPath(name), await sign(key, cid), who)).status).toBe(200)
    }
    const extra = await newName()
    const limited = await post(keepPath(extra.name), await sign(extra.key, cid), who)
    expect(limited.status).toBe(429)
    expect(limited.text).toMatch(/20 names a day/)
    expect((await post(keepPath(extra.name), await sign(extra.key, cid))).status).toBe(200)

    await rm(namesFile(stateDir), { force: true })
    const live = await newName()
    const record = await sign(live.key, cid)
    await addKeep(namesFile(stateDir), { name: live.name, cid, sequence: 1, record, at: Date.now() })
    for (let i = 0; i < 499; i++) await addKeep(namesFile(stateDir), { name: `k51fake${String(i)}`, cid, sequence: 1, record, at: Date.now() })
    const full = await newName()
    const refused = await post(keepPath(full.name), await sign(full.key, cid))
    expect(refused.status).toBe(503)
    expect(refused.text).toMatch(/as many names as it can/)
    expect((await post(keepPath(live.name), await sign(live.key, cid, { sequence: 2 }))).status).toBe(200)
  })

  it('lists the new endpoints where it refuses another path, and says what it keeps', async () => {
    const other = await post('/api/v0/nope', undefined)
    expect(other.status).toBe(404)
    expect(other.text).toMatch(/\/api\/v0\/name\/keep, \/api\/v0\/name\/record/)
    const version = JSON.parse((await post('/api/v0/version', undefined)).text)
    expect(version.System).toMatch(/IPNS names/)
  })
})
