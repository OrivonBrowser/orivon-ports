import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRecord, generateNameKey, IPNS_RECORD_TYPE, nameOf } from '../page/src/ipfs/ipns.js'
import { importDirectory, importFile } from '../page/src/ipfs/unixfs.js'
import { namesFile, readNames } from '../relay/names.mjs'
import { CORE_CIDS, KNOWN_CORES } from '../relay/rules.mjs'
import { addPin, pinsFile } from '../relay/store.mjs'

const encoder = new TextEncoder()
const DAY = 24 * 60 * 60 * 1000
const CORE_NAME = 'tiddlywikicore-5.4.1.js'
const PAGE = `\n\n<!doctype html><html><body><script class="tiddlywiki-tiddler-store" type="application/json">[{"title":"$:/plugins/orivon/decentrawiki","text":"{}"}]</script><script src="${CORE_NAME}" onerror="x"></script></body></html>`
const coreBytes = encoder.encode('/* a TiddlyWiki core, for the test */')
const real = { sha: KNOWN_CORES[CORE_NAME], cid: CORE_CIDS[CORE_NAME] }
const wikiFiles = { 'index.html': PAGE, [CORE_NAME]: coreBytes }
/** The editor page's node, and the address Kubo sees it connected from. */
const PEER = '12D3KooWBFpVc6cRWcWt72deRUy5SG2Ezcb4w3XqJF9pxp9WE7ne'
const SEEN_AT = '/ip4/198.51.100.7/tcp/50520'

beforeAll(async () => {
  (KNOWN_CORES as Record<string, string>)[CORE_NAME] = createHash('sha256').update(coreBytes).digest('hex');
  (CORE_CIDS as Record<string, string>)[CORE_NAME] = (await importFile(coreBytes)).cid
})
afterAll(() => {
  (KNOWN_CORES as Record<string, string>)[CORE_NAME] = real.sha;
  (CORE_CIDS as Record<string, string>)[CORE_NAME] = real.cid
})

interface Held { blocks: Map<string, Uint8Array>, files: Map<string, Uint8Array> }

/**
 * A Kubo-compatible HTTP stub with two places a version can be held: the IPFS network, which it reads from
 * at any time, and the editor page's node, which it reads from only while it peers with it.
 */
async function startKubo () {
  const kubo = {
    calls: [] as { verb: string, arg: string }[],
    network: { blocks: new Map(), files: new Map() } as Held,
    page: { blocks: new Map(), files: new Map() } as Held,
    connected: true,
    peered: false,
    gate: undefined as Promise<void> | undefined,
    url: '',
    server: undefined as unknown as Server,
    verbs () { return kubo.calls.map((call) => call.verb) },
    puts () { return kubo.calls.filter((call) => call.verb === 'routing/put') },
    async hold (files: Record<string, Uint8Array | string>, where: 'network' | 'page') {
      const list = Object.entries(files).map(([path, bytes]) => ({ path, bytes: typeof bytes === 'string' ? encoder.encode(bytes) : bytes }))
      const { cid, blocks } = await importDirectory(list)
      for (const [k, v] of blocks) kubo[where].blocks.set(k, v)
      for (const file of list) kubo[where].files.set((await importFile(file.bytes)).cid, file.bytes)
      return cid
    }
  }
  kubo.server = createServer((req, res) => {
    void (async () => {
      for await (const chunk of req) void chunk
      const url = new URL(req.url ?? '/', 'http://kubo')
      const verb = url.pathname.replace('/api/v0/', '')
      const arg = url.searchParams.get('arg') ?? ''
      kubo.calls.push({ verb, arg })
      const json = (body: unknown) => void res.writeHead(200).end(JSON.stringify(body))
      if (verb === 'swarm/peers') return json({ Peers: kubo.connected ? [{ Peer: PEER, Addr: SEEN_AT }] : [] })
      if (verb === 'swarm/peering/ls') return json({ Peers: [] })
      if (verb === 'swarm/peering/add') { kubo.peered = true; return json({ Peers: [] }) }
      if (verb === 'swarm/peering/rm') { kubo.peered = false; return json({ Peers: [] }) }
      if (verb === 'routing/put') return json({ Extra: '', ID: '', Responses: null, Type: 5 })
      if (verb === 'block/get') await kubo.gate
      const field = verb === 'block/get' ? 'blocks' : 'files'
      const found = kubo.network[field].get(arg) ?? (kubo.peered ? kubo.page[field].get(arg) : undefined)
      if (found === undefined) return void res.writeHead(500).end('{"Message":"block was not found locally (offline)","Code":0,"Type":"error"}')
      res.writeHead(200).end(found)
    })()
  })
  await new Promise<void>((resolve) => kubo.server.listen(0, '127.0.0.1', resolve))
  kubo.url = `http://127.0.0.1:${String((kubo.server.address() as { port: number }).port)}`
  return kubo
}

async function newName () {
  const key = await generateNameKey()
  return { key, name: nameOf(key.publicKey) }
}

async function sign (key: { seed: Uint8Array }, cid: string, sequence = 1) {
  return await createRecord({ seed: key.seed, value: `/ipfs/${cid}`, sequence, validity: new Date(Date.now() + 3650 * DAY), ttlMs: 3_600_000 })
}

describe('keeping a name for a version the editor\'s node holds', () => {
  let kubo: Awaited<ReturnType<typeof startKubo>>
  let stateDir = ''
  let base = ''
  let log: ReturnType<typeof vi.spyOn>
  const saved = { ...process.env }
  let nextClient = 1

  beforeAll(async () => {
    kubo = await startKubo()
    stateDir = await mkdtemp(join(tmpdir(), 'dw-relay-peer-'))
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
  beforeEach(async () => {
    await rm(namesFile(stateDir), { force: true })
    await rm(pinsFile(stateDir), { force: true })
    kubo.calls.length = 0
    for (const held of [kubo.network, kubo.page]) { held.blocks.clear(); held.files.clear() }
    kubo.connected = true
    kubo.peered = false
    kubo.gate = undefined
    log.mockClear()
  })

  const client = () => `198.51.100.${String(nextClient++)}`
  async function keep (name: string, record: Uint8Array, query = `&peer=${PEER}`, who = client()) {
    const response = await fetch(`${base}/api/v0/name/keep?arg=${name}${query}`, { method: 'POST', headers: { 'x-forwarded-for': who, 'content-type': IPNS_RECORD_TYPE }, body: record })
    return { status: response.status, text: await response.text() }
  }

  it('says which generation of the relay answers, which is how a deploy of this one is checked', async () => {
    const response = await fetch(`${base}/api/v0/version`, { method: 'POST' })
    expect(JSON.parse(await response.text())).toMatchObject({ Version: 'decentrawiki-relay/3' })
  })

  it('reads the version over a peering with the editor\'s node, then puts the record, and stops peering', async () => {
    const cid = await kubo.hold(wikiFiles, 'page')
    const { key, name } = await newName()
    const record = await sign(key, cid, 3)
    const kept = await keep(name, record)
    expect(kept.status).toBe(200)
    expect(JSON.parse(kept.text)).toMatchObject({ Name: name, Value: `/ipfs/${cid}`, Sequence: 3 })
    expect(kubo.verbs()).toEqual([
      'swarm/peers', 'swarm/peering/ls', 'swarm/peering/add', 'block/get', 'cat', 'cat', 'swarm/peering/rm', 'routing/put'
    ])
    expect(kubo.calls.find((call) => call.verb === 'swarm/peering/add')?.arg).toBe(`${SEEN_AT}/p2p/${PEER}`)
    expect(kubo.calls.find((call) => call.verb === 'swarm/peering/rm')?.arg).toBe(PEER)
    expect(kubo.peered).toBe(false)
    expect(kubo.puts()[0]?.arg).toBe(`/ipns/${name}`)
    const state = await readNames(namesFile(stateDir))
    expect(state.checked.has(cid)).toBe(true)
    expect([...state.names.keys()]).toEqual([name])
  })

  it('reads from the IPFS network when no peer is named, and never touches the peering', async () => {
    const cid = await kubo.hold(wikiFiles, 'network')
    const { key, name } = await newName()
    expect((await keep(name, await sign(key, cid), '')).status).toBe(200)
    expect(kubo.verbs()).toEqual(['block/get', 'cat', 'cat', 'routing/put'])
  })

  it('does not find a version only the editor\'s node holds when no peer is named', async () => {
    const cid = await kubo.hold(wikiFiles, 'page')
    const { key, name } = await newName()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const missing = await keep(name, await sign(key, cid), '')
    error.mockRestore()
    expect(missing.status).toBe(504)
    expect(missing.text).toMatch(/could not find this version on IPFS/)
    expect(kubo.puts()).toHaveLength(0)
  })

  it('reads nothing, and dials nothing, for a version it already knows', async () => {
    const pinned = await kubo.hold(wikiFiles, 'page')
    await addPin(pinsFile(stateDir), { cid: pinned, at: Date.now(), bytes: 1, preexisting: false, expired: false })
    const first = await newName()
    expect((await keep(first.name, await sign(first.key, pinned))).status).toBe(200)
    expect(kubo.verbs()).toEqual(['routing/put'])

    const other = await kubo.hold({ ...wikiFiles, 'favicon.ico': new Uint8Array([0, 0, 1, 0]) }, 'page')
    const second = await newName()
    const third = await newName()
    expect((await keep(second.name, await sign(second.key, other))).status).toBe(200)
    kubo.calls.length = 0
    expect((await keep(third.name, await sign(third.key, other))).status).toBe(200)
    expect(kubo.verbs()).toEqual(['routing/put'])
  })

  it('refuses a peer that is not a node id with 400, before it asks Kubo anything', async () => {
    const cid = await kubo.hold(wikiFiles, 'page')
    const { key, name } = await newName()
    const record = await sign(key, cid)
    for (const query of ['&peer=', '&peer=nope', '&peer=/ip4/198.51.100.7/tcp/4001', `&peer=${PEER}x!`, `&peer=${'Qm'.padEnd(80, 'a')}`]) {
      const refused = await keep(name, record, query)
      expect(refused.status, query).toBe(400)
      expect(JSON.parse(refused.text)).toMatchObject({ Type: 'error', Message: expect.stringContaining('not an IPFS node') })
    }
    expect(kubo.calls).toHaveLength(0)
    expect((await readNames(namesFile(stateDir))).names.size).toBe(0)
  })

  it('says the editor\'s node is not connected, and puts nothing, when it never appears among the peers', async () => {
    const cid = await kubo.hold(wikiFiles, 'page')
    const { key, name } = await newName()
    kubo.connected = false
    const refused = await keep(name, await sign(key, cid))
    expect(refused.status).toBe(409)
    expect(JSON.parse(refused.text).Message).toMatch(/not connected to Orivon's node/)
    expect(kubo.verbs().every((verb) => verb === 'swarm/peers')).toBe(true)
    expect(kubo.puts()).toHaveLength(0)
    expect((await readNames(namesFile(stateDir))).names.size).toBe(0)
  }, 30_000)

  it('stops peering and keeps nothing when the editor\'s node does not hold the version', async () => {
    const { key, name } = await newName()
    const { cid: nowhere } = await importDirectory([{ path: 'index.html', bytes: encoder.encode(PAGE) }])
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = await keep(name, await sign(key, nowhere))
    error.mockRestore()
    expect(failed.status).toBe(504)
    expect(JSON.parse(failed.text).Message).toMatch(/could not read the wiki from the IPFS node in your editor page/)
    expect(kubo.verbs()).toContain('swarm/peering/rm')
    expect(kubo.peered).toBe(false)
    expect(kubo.puts()).toHaveLength(0)
  })

  it('checks what the editor\'s node holds as an upload is checked', async () => {
    const movie = await kubo.hold({ ...wikiFiles, 'movie.mp4': 'x' }, 'page')
    const phish = await kubo.hold({ 'index.html': '<html>phish</html>', [CORE_NAME]: coreBytes }, 'page')
    for (const cid of [movie, phish]) {
      const { key, name } = await newName()
      const refused = await keep(name, await sign(key, cid))
      expect(refused.status).toBe(400)
      expect(refused.text).toMatch(/keeps no name for this version/)
    }
    expect(kubo.peered).toBe(false)
    expect(kubo.puts()).toHaveLength(0)
    expect((await readNames(namesFile(stateDir))).names.size).toBe(0)
  })

  it('still reads one version at a time for a client, and still keeps only so many names a day', async () => {
    const cid = await kubo.hold(wikiFiles, 'page')
    const who = client()
    const first = await newName()
    const second = await newName()
    let release: () => void = () => {}
    kubo.gate = new Promise<void>((resolve) => { release = resolve })
    const slow = keep(first.name, await sign(first.key, cid), `&peer=${PEER}`, who)
    for (let i = 0; i < 100 && !kubo.verbs().includes('block/get'); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    const busy = await keep(second.name, await sign(second.key, cid), `&peer=${PEER}`, who)
    expect(busy.status).toBe(503)
    expect(busy.text).toMatch(/busy/)
    release()
    expect((await slow).status).toBe(200)

    for (let i = 0; i < 19; i++) {
      const { key, name } = await newName()
      expect((await keep(name, await sign(key, cid), `&peer=${PEER}`, who)).status).toBe(200)
    }
    const extra = await newName()
    const limited = await keep(extra.name, await sign(extra.key, cid), `&peer=${PEER}`, who)
    expect(limited.status).toBe(429)
    expect(limited.text).toMatch(/20 names a day/)
  })
})
