import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readCar, writeCar } from '../page/src/ipfs/car.js'
import { importDirectory } from '../page/src/ipfs/unixfs.js'

type Row = { wiki: string, cid: string, car: Blob, at: number }
const mem = vi.hoisted(() => ({ settings: new Map<string, unknown>(), hosted: new Map<string, unknown>() }))
vi.mock('../page/src/store.js', () => ({
  getSetting: async (key: string, fallback: unknown) => mem.settings.has(key) ? mem.settings.get(key) : fallback,
  setSetting: async (key: string, value: unknown) => { mem.settings.set(key, value) },
  getHosted: async (wiki: string) => mem.hosted.get(wiki),
  putHosted: async (row: Row) => { mem.hosted.set(row.wiki, row) },
  listHosted: async () => [...mem.hosted.values()]
}))

const { HOST_BUDGET_BYTES, HOST_WIKIS_DEFAULT, NODE_BATCH_BYTES, NODE_FEATURES, carBatches, createHosting } = await import('../page/src/publish/hosting.js')

const NODE = 'http://127.0.0.1:5181'
const FEATURES = ['serve', 'listen', 'provide', 'relay']
const CIRCUIT = '/ip4/152.228.138.30/tcp/4003/p2p/12D3KooWRelay/p2p-circuit/p2p/12D3KooWpage'

/** A version of a wiki as the editor makes one: a folder with a page of `size` bytes, its address, and its CAR. */
async function version(seed: number, size = 2000) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed * 7 + (i >>> 18)) & 255)
  const { cid, blocks } = await importDirectory([{ path: 'index.html', bytes }])
  const car = new Blob([writeCar(cid, blocks)])
  return { cid, blocks, car }
}

type Call = { method: string, path: string, key: string | null, body: Blob | string | undefined, type: string | null }

/** A node as Orivon's will answer, and what it was asked. */
function fakeNode(options: { features?: string[], alive?: () => boolean, listening?: () => boolean, status?: () => object | undefined, blocks?: (n: number) => Response | Promise<Response>, provided?: (cid: string) => object } = {}) {
  const calls: Call[] = []
  let blocks = 0
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const headers = new Headers(init.headers)
    if (options.alive?.() === false) throw new TypeError('fetch failed')
    calls.push({ method: init.method ?? 'GET', path: url.pathname, key: headers.get('x-orivon-key'), body: init.body as Blob | string | undefined, type: headers.get('content-type') })
    if (url.pathname === '/health') return new Response('ok', { headers: { 'x-orivon-node-features': (options.features ?? FEATURES).join(', ') } })
    if (url.pathname === '/blocks') return (await options.blocks?.(++blocks)) ?? Response.json({ roots: [], blocks: 1 })
    if (url.pathname === '/provide') return Response.json(options.provided?.(JSON.parse(String(init.body)).cid) ?? {}, { status: 202 })
    if (url.pathname.startsWith('/provide/')) return new Response('', { status: 200 })
    if (url.pathname === '/status') {
      if (options.listening?.() === false) return new Response('not found', { status: 404 })
      const status = options.status?.()
      if (status === undefined) throw new TypeError('fetch failed')
      return Response.json(status)
    }
    return new Response('no', { status: 404 })
  }
  const paths = () => calls.map((call) => `${call.method} ${call.path}`)
  return { fetchImpl, calls, paths }
}

const STATUS = { peer: 'p', listen: [], external: [], relays: [], reachability: 'unknown', providing: [] }

function setup(options: { node?: ReturnType<typeof fakeNode>, features?: string[], available?: boolean, stop?: () => Promise<boolean>, ports?: number[] } & Record<string, unknown> = {}) {
  const { node = fakeNode({ status: () => STATUS }), features = FEATURES, available = true, stop = async () => true, ports = [], ...extra } = options
  vi.stubGlobal('fetch', node.fetchImpl)
  mem.settings.set('hostWikis', true)
  const started: Array<Record<string, unknown>> = []
  let running = 5181
  let up = false
  const launcher = {
    start: vi.fn(async (o: Record<string, unknown>) => { started.push(o); up = true; running = ports[started.length - 1] ?? 5181; return { base: NODE, peer: '12D3KooWpage', port: running } }),
    find: vi.fn(async () => up ? { base: NODE, peer: '12D3KooWpage', port: running } : null),
    stop: vi.fn(stop)
  }
  const options2 = { launcher: async () => launcher as never, buildInfo: async () => ({ ipfsNode: 'bafy', nodeFeatures: features }), available: () => available, pollMs: 0, ...extra }
  const made = createHosting(options2)
  /** Another tab of the editor: its own page state, the same node, the same stored settings and wikis. */
  const another = () => createHosting(options2)
  return { made, another, node, launcher, started }
}

type Spy = { mock: { calls: unknown[][] }, mockRestore: () => void, mockClear: () => void }
let errors: Spy
let warns: Spy
const errorLines = () => errors.mock.calls.map((call) => String(call[0]))

beforeEach(() => {
  mem.settings.clear()
  mem.hosted.clear()
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  errors.mockRestore()
  warns.mockRestore()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('what hosting asks of the node and the page', () => {
  it('is on until Settings turns it off, and the defaults are named in one place', async () => {
    expect(HOST_WIKIS_DEFAULT).toBe(true)
    expect(HOST_BUDGET_BYTES).toBe(200 * 1024 * 1024)
    expect(NODE_BATCH_BYTES).toBe(32 * 1024 * 1024)
    expect(NODE_FEATURES).toEqual(['listen', 'provide', 'relay'])
    const { made, node, launcher } = setup()
    mem.settings.delete('hostWikis')
    expect(await made.enabled()).toBe(true)
    mem.settings.set('hostWikis', false)
    const v = await version(1)
    expect(await made.enabled()).toBe(false)
    expect(await made.host('w', v.cid, v.car)).toBe(false)
    await made.resume()
    expect(await made.node()).toBeNull()
    expect(launcher.start).not.toHaveBeenCalled()
    expect(node.calls).toEqual([])
    expect(mem.hosted.size).toBe(0)
  })

  it('is never started by a page without Orivon\'s sockets, nor for a node that lacks the features', async () => {
    const off = setup({ available: false })
    expect(await off.made.node()).toBeNull()
    expect(await off.made.enabled()).toBe(false)
    expect(off.launcher.start).not.toHaveBeenCalled()
    expect(errorLines()).toEqual([])

    for (const features of [[], ['listen'], ['serve', 'listen', 'provide']]) {
      const old = setup({ features })
      expect(await old.made.node()).toBeNull()
      expect(old.launcher.start).not.toHaveBeenCalled()
    }
    expect(errorLines()).toEqual(Array(3).fill('[decentrawiki] hosting is unavailable: the IPFS node this editor shipped has no listen, provide and relay features'))
  })

  it('asks the running node what it can do, and uses it only if it lists listen, provide and relay', async () => {
    const liar = setup({ node: fakeNode({ features: ['serve', 'listen'], status: () => STATUS }) })
    expect(await liar.made.node()).toBeNull()
    expect(liar.started).toHaveLength(1)
    expect(errorLines()).toEqual(['[decentrawiki] hosting is unavailable: the running IPFS node does not list listen, provide and relay'])
    const { made, started, node } = setup()
    const first = await made.node()
    expect(first).toMatchObject({ base: NODE, peer: '12D3KooWpage' })
    expect(first!.key).toMatch(/^[0-9a-f]{64}$/)
    expect(await made.node()).toBe(first)
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ key: first!.key, listen: true })
    expect(node.paths()).toEqual(['GET /health', 'GET /status'])
    expect(node.calls.every((call) => call.key === first!.key)).toBe(true)
  })

  it('writes a start that failed as one console.error line, and tries again on the next call', async () => {
    const { made, launcher } = setup()
    launcher.start.mockRejectedValueOnce(new Error('Your IPFS node could not start: it ended (code 1): bind failed'))
    expect(await made.node()).toBeNull()
    expect(await made.node()).not.toBeNull()
    expect(errorLines()).toEqual(['[decentrawiki] hosting could not start the IPFS node: Your IPFS node could not start: it ended (code 1): bind failed'])
    expect(launcher.start).toHaveBeenCalledTimes(2)
  })

  it('ends a node that was started for publishing only and starts one that hosts, when the page started it', async () => {
    let restarted = false
    const node = fakeNode({ listening: () => restarted, status: () => STATUS })
    const { made, launcher, started } = setup({ node, stop: async () => { restarted = true; return true } })
    expect(await made.node()).not.toBeNull()
    expect(launcher.stop).toHaveBeenCalledWith(5181)
    expect(started).toHaveLength(2)
    expect(errorLines()).toEqual([])
  })

  it('starts the host on the next port when it cannot end a node that publishes only, as after a reload or in another tab', async () => {
    let ready: ReturnType<typeof setup> | undefined
    const node = fakeNode({ listening: () => (ready?.started.length ?? 0) >= 2, status: () => STATUS })
    ready = setup({ node, stop: async () => false, ports: [5181, 5182] })
    const { made, launcher, started } = ready
    expect(await made.node()).toMatchObject({ port: 5182 })
    expect(launcher.stop).toHaveBeenCalledWith(5181)
    expect(started).toHaveLength(2)
    expect(started[1]).toMatchObject({ listen: true, port: 5182 })
    expect(errorLines()).toEqual([])
    expect(mem.settings.get('nodePort')).toBe(5182)
  })

  it('does not host on a node another tab started without hosting, when no other port holds a host, and says so', async () => {
    const node = fakeNode({ listening: () => false })
    const { made, launcher, started } = setup({ node, stop: async () => false })
    expect(await made.node()).toBeNull()
    expect(launcher.stop).toHaveBeenCalledTimes(1)
    expect(started).toHaveLength(2)
    expect(errorLines()).toEqual(['[decentrawiki] hosting is unavailable: the IPFS node running in another tab of the editor was started without hosting; close the editor\'s other tabs'])
  })
})

describe('giving the node a wiki', () => {
  it('keeps the version, hands the node its blocks as a CAR, and has it announce the address', async () => {
    const { made, node } = setup()
    const v = await version(1)
    expect(await made.host('wiki-a', v.cid, new Uint8Array(await v.car.arrayBuffer()))).toBe(true)
    const row = mem.hosted.get('wiki-a') as Row
    expect(row).toMatchObject({ wiki: 'wiki-a', cid: v.cid })
    expect(row.car).toBeInstanceOf(Blob)
    expect(node.paths()).toEqual(['GET /health', 'GET /status', 'POST /blocks', 'POST /provide'])
    const sent = node.calls.find((call) => call.path === '/blocks')!
    expect(sent.type).toBe('application/vnd.ipld.car')
    expect((await readCar(new Uint8Array(await (sent.body as Blob).arrayBuffer()), v.cid)).size).toBe(v.blocks.size)
    const provide = node.calls.find((call) => call.path === '/provide')!
    expect(provide.type).toBe('application/json')
    expect(JSON.parse(provide.body as string)).toEqual({ cid: v.cid })
    expect(made.stateOf('wiki-a')).toBe('starting')
    expect(made.stateOf('nobody')).toBe('off')
    expect(made.holds(v.cid)).toBe(true)
  })

  it('cuts a CAR above the batch size into batches that each hold whole blocks under the same header', async () => {
    const { made, node } = setup({ batchBytes: 700_000 })
    const v = await version(2, 2_000_000)
    await made.host('w', v.cid, v.car)
    const sent = node.calls.filter((call) => call.path === '/blocks')
    expect(sent.length).toBeGreaterThan(2)
    const seen = new Map<string, Uint8Array>()
    for (const call of sent) {
      const batch = call.body as Blob
      expect(batch.size).toBeLessThanOrEqual(700_000)
      for (const [cid, data] of await readCar(new Uint8Array(await batch.arrayBuffer()), v.cid)) seen.set(cid, data)
    }
    expect([...seen.keys()].sort()).toEqual([...v.blocks.keys()].sort())
    expect(node.calls.at(-1)!.path).toBe('/provide')
  })

  it('splits a CAR in whole sections, leaves a small one alone and refuses a cut-off one', async () => {
    const v = await version(3, 600_000)
    expect(await carBatches(v.car, v.car.size)).toEqual([v.car])
    const batches = await carBatches(v.car, 300_000)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.every((batch) => batch.size <= 300_000)).toBe(true)
    const cut = new Blob([new Uint8Array(await v.car.arrayBuffer()).subarray(0, v.car.size - 10)])
    await expect(carBatches(cut, 300_000)).rejects.toThrow(/cut off/)
  })

  it('replaces a wiki\'s version with its next, and has the node stop announcing the one before', async () => {
    const { made, node } = setup()
    const one = await version(1)
    const two = await version(2)
    await made.host('w', one.cid, one.car)
    await made.host('w', two.cid, two.car)
    expect((mem.hosted.get('w') as Row).cid).toBe(two.cid)
    expect(mem.hosted.size).toBe(1)
    const tail = node.calls.slice(-3).map((call) => `${call.method} ${call.path}`)
    expect(tail).toEqual([`DELETE /provide/${one.cid}`, 'POST /blocks', 'POST /provide'])
    expect(made.stateOf('w')).toBe('starting')
    expect(made.summary()).toMatchObject({ wikis: 1 })
  })

  it('sends nothing again for the same version, and not the blocks the page already handed over to publish', async () => {
    const { made, node } = setup()
    const v = await version(1)
    await made.node()
    expect(made.holds(v.cid)).toBe(false)
    made.markHeld(v.cid, v.car.size)
    await made.host('w', v.cid, v.car)
    expect(node.paths()).toEqual(['GET /health', 'GET /status', 'POST /provide'])
    await made.host('w', v.cid, v.car)
    expect(node.paths().filter((path) => path === 'POST /provide')).toHaveLength(1)
  })

  it('says in words that the node is full, and when it refuses a wiki, in the console and with no key', async () => {
    const full = setup({ node: fakeNode({ status: () => STATUS, blocks: () => new Response('table full', { status: 507 }) }) })
    const v = await version(1)
    expect(await full.made.host('w', v.cid, v.car)).toBe(false)
    expect(full.made.stateOf('w')).toBe('off')
    expect(errorLines()).toEqual(['[decentrawiki] hosting could not host a wiki: the IPFS node\'s memory is full, which another tab of the editor may have filled (Your IPFS node refused it: table full)'])

    errors.mockClear()
    const leaking = setup({ node: fakeNode({ status: () => STATUS, blocks: () => new Response(`bad key ${'ab'.repeat(32)}`, { status: 400 }) }) })
    expect(await leaking.made.host('w', v.cid, v.car)).toBe(false)
    expect(errorLines()).toHaveLength(1)
    expect(errorLines()[0]).toMatch(/^\[decentrawiki\] hosting /)
    expect(errorLines()[0]).not.toContain('ab'.repeat(32))
    expect(errorLines()[0]).toContain('<key>')
  })

  it('never throws out of host(): a version it cannot keep is a console line and false', async () => {
    const v = await version(1)
    const broken = createHosting({
      storage: { getSetting: async () => true, getHosted: async () => undefined, putHosted: async () => { throw new Error('QuotaExceededError') }, listHosted: async () => [] },
      available: () => true, pollMs: 0, launcher: async () => ({ start: async () => ({ base: NODE, peer: 'p', port: 5181 }) }) as never, buildInfo: async () => ({ nodeFeatures: FEATURES })
    })
    expect(await broken.host('w', v.cid, v.car)).toBe(false)
    expect(errorLines()).toEqual(['[decentrawiki] hosting could not keep a wiki to host: QuotaExceededError'])
    expect(broken.stateOf('w')).toBe('off')
  })

  it('does not announce a wiki that was forgotten while the node was still taking its blocks', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { made, node } = setup({ node: fakeNode({ status: () => STATUS, blocks: async () => { await gate; return Response.json({ roots: [], blocks: 1 }) } }) })
    const v = await version(1)
    const giving = made.host('w', v.cid, v.car)
    await vi.waitFor(() => { expect(node.calls.some((call) => call.path === '/blocks')).toBe(true) })
    const forgetting = made.forget('w')
    release()
    await giving
    await forgetting
    expect(node.calls.filter((call) => call.method === 'POST' && call.path === '/provide')).toHaveLength(0)
    expect(made.stateOf('w')).toBe('off')
  })
})

describe('resuming and stopping', () => {
  async function stored<K extends string>(...entries: Array<[K, number, number]>) {
    const made = {} as Record<K, { cid: string, size: number }>
    for (const [wiki, at, seed] of entries) {
      const v = await version(seed, 1000 * seed)
      mem.hosted.set(wiki, { wiki, cid: v.cid, car: v.car, at })
      made[wiki] = { cid: v.cid, size: v.car.size }
    }
    return made
  }
  const provided = (calls: Call[]) => calls.filter((call) => call.method === 'POST' && call.path === '/provide').map((call) => JSON.parse(call.body as string).cid as string)

  it('gives the node every stored version, the newest first, without publishing again', async () => {
    const { a, b, c } = await stored(['a', 100, 1], ['b', 300, 2], ['c', 200, 3])
    const { made, node } = setup()
    await made.resume()
    expect(provided(node.calls)).toEqual([b.cid, c.cid, a.cid])
    expect(node.calls.filter((call) => call.path === '/blocks')).toHaveLength(3)
    expect(made.summary()).toMatchObject({ running: true, wikis: 3 })
  })

  it('starts no node when nothing is stored', async () => {
    const { made, launcher } = setup()
    await made.resume()
    expect(launcher.start).not.toHaveBeenCalled()
  })

  it('stops giving the node wikis once its memory budget is used, and skips the oldest', async () => {
    const { mid, new: newest } = await stored(['old', 100, 1], ['mid', 200, 2], ['new', 300, 3])
    const { made, node } = setup({ budget: newest.size + mid.size + 10 })
    await made.resume()
    expect(provided(node.calls)).toEqual([newest.cid, mid.cid])
    expect(made.stateOf('old')).toBe('off')
    expect(made.summary()).toMatchObject({ wikis: 2, unplaced: 1 })
    expect(errorLines()).toHaveLength(1)
    expect(errorLines()[0]).toMatch(/^\[decentrawiki\] hosting could not host a wiki: the IPFS node's memory budget of \d+ MiB is used$/)
  })

  it('hands the node nothing more in a run once it says it is full, whoever filled it', async () => {
    await stored(['a', 100, 1], ['b', 200, 2])
    const { made, node } = setup({ node: fakeNode({ status: () => STATUS, blocks: (n) => n === 1 ? new Response('table full', { status: 507 }) : Response.json({ roots: [], blocks: 1 }) }) })
    await made.resume()
    expect(node.calls.filter((call) => call.path === '/blocks')).toHaveLength(1)
    expect(provided(node.calls)).toEqual([])
    expect(made.stateOf('a')).toBe('off')
    expect(made.stateOf('b')).toBe('off')
    expect(made.summary()).toMatchObject({ running: true, wikis: 0, unplaced: 2 })
    expect(errorLines()).toHaveLength(2)
    expect(errorLines()[0]).toMatch(/^\[decentrawiki\] hosting could not host a wiki: the IPFS node's memory is full/)
    expect(errorLines()[1]).toMatch(/^\[decentrawiki\] hosting could not host a wiki: the IPFS node's memory budget of \d+ MiB is used$/)
  })

  it('counts every version it handed the node in a run, replaced ones included, because the node keeps them', async () => {
    const one = await version(1, 3000)
    const two = await version(2, 3000)
    const { made, node } = setup({ budget: one.car.size + two.car.size - 10 })
    await made.host('w', one.cid, one.car)
    expect(await made.host('w', two.cid, two.car)).toBe(false)
    expect(provided(node.calls)).toEqual([one.cid])
    expect(made.stateOf('w')).toBe('off')
    expect(made.summary()).toMatchObject({ wikis: 0, unplaced: 1 })
  })

  it('stops announcing a deleted wiki, and does nothing about one while the node has not started', async () => {
    const quiet = setup()
    await quiet.made.forget('w')
    expect(quiet.node.calls).toEqual([])

    const { made, node } = setup()
    const v = await version(1)
    await made.host('w', v.cid, v.car)
    await made.forget('w')
    expect(node.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/provide/${v.cid}` })
    expect(made.stateOf('w')).toBe('off')
    expect(made.summary().wikis).toBe(0)
  })

  it('stops announcing a wiki deleted in a tab that never started the node, which another tab started', async () => {
    const { made: first, another, node, launcher } = setup({ stop: async () => false })
    const second = another()
    await second.resume()
    expect(second.summary().running).toBe(false)
    expect(launcher.start).not.toHaveBeenCalled()
    const v = await version(1)
    await first.host('w', v.cid, v.car)
    expect(mem.hosted.get('w')).toMatchObject({ cid: v.cid })
    await second.forget('w')
    expect(node.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/provide/${v.cid}`, key: mem.settings.get('nodeKey') })
    expect(launcher.start).toHaveBeenCalledTimes(1)
  })

  it('takes a deleted wiki back with the version read before its row went, in a tab that never placed it', async () => {
    const { made: first, another, node } = setup({ stop: async () => false })
    const second = another()
    const v = await version(1)
    await first.host('w', v.cid, v.car)
    const hosted = await second.hostedVersion('w')
    expect(hosted).toBe(v.cid)
    mem.hosted.delete('w')
    await second.forget('w', hosted)
    expect(node.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/provide/${v.cid}` })
    expect(await second.hostedVersion('w')).toBeUndefined()
  })

  describe('a wiki another tab deletes or replaces while this tab is handing the node its stored versions', () => {
    /** A resume held at the first block it hands the node, and a second tab to change the store from meanwhile. */
    async function heldResume() {
      let open = () => {}
      const gate = new Promise<void>((resolve) => { open = resolve })
      const made = setup({ node: fakeNode({ status: () => STATUS, blocks: async (n) => { if (n === 1) await gate; return Response.json({ roots: [], blocks: 1 }) } }) })
      const resuming = made.made.resume()
      await vi.waitFor(() => { expect(made.node.calls.some((call) => call.path === '/blocks')).toBe(true) })
      /** What the library does in the other tab: reads the version, deletes the wiki, then has the node take it back. */
      const deleteInAnotherTab = async (wiki: string) => {
        const second = made.another()
        const hosted = await second.hostedVersion(wiki)
        mem.hosted.delete(wiki)
        await second.forget(wiki, hosted)
      }
      return { ...made, open, resuming, deleteInAnotherTab }
    }

    it('does not give the node a wiki that went before its turn, and keeps the ones before it', async () => {
      const { a, w } = await stored(['a', 200, 1], ['w', 100, 2])
      const { made, node, open, resuming, deleteInAnotherTab } = await heldResume()
      await deleteInAnotherTab('w')
      expect(node.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/provide/${w.cid}` })
      open()
      await resuming
      expect(provided(node.calls)).toEqual([a.cid])
      expect(node.calls.filter((call) => call.path === '/blocks')).toHaveLength(1)
      expect(made.stateOf('w')).toBe('off')
      expect(made.summary().wikis).toBe(1)
    })

    it('takes back the announcement of a wiki that went while its own blocks were going over', async () => {
      const { w } = await stored(['w', 100, 1])
      const { made, node, open, resuming, deleteInAnotherTab } = await heldResume()
      await deleteInAnotherTab('w')
      open()
      await resuming
      expect(node.paths().slice(-3)).toEqual([`DELETE /provide/${w.cid}`, 'POST /provide', `DELETE /provide/${w.cid}`])
      expect(made.stateOf('w')).toBe('off')
      expect(made.summary().wikis).toBe(0)
    })

    it('takes back the announcement of a version that another tab replaced while its blocks were going over', async () => {
      const { w } = await stored(['w', 100, 1])
      const { made, node, open, resuming } = await heldResume()
      const newer = await version(2)
      mem.hosted.set('w', { wiki: 'w', cid: newer.cid, car: newer.car, at: 200 })
      open()
      await resuming
      expect(node.paths().slice(-2)).toEqual(['POST /provide', `DELETE /provide/${w.cid}`])
      expect(made.summary().wikis).toBe(0)
    })
  })

  it('asks no node about a wiki that was never hosted, or when this editor never made a key', async () => {
    const { made, another, node, launcher } = setup()
    const v = await version(1)
    await made.forget('w')
    mem.hosted.set('w', { wiki: 'w', cid: v.cid, car: v.car, at: 1 })
    await another().forget('w')
    expect(launcher.find).not.toHaveBeenCalled()
    expect(node.calls).toEqual([])
  })

  it('takes back what another tab placed when hosting is turned off, and ends no node that is not this page\'s', async () => {
    const { made: first, another, node, launcher } = setup({ stop: async () => false })
    const second = another()
    const v = await version(1)
    await first.host('w', v.cid, v.car)
    await second.stop()
    expect(node.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([`/provide/${v.cid}`])
    expect(launcher.stop).toHaveBeenCalledWith(5181)
    expect(mem.hosted.size).toBe(1)
  })

  it('keeps the node\'s announcement when another wiki\'s newest version is the same bytes', async () => {
    const { made, node } = setup()
    const v = await version(1)
    await made.host('a', v.cid, v.car)
    await made.host('b', v.cid, v.car)
    await made.forget('a')
    expect(node.calls.filter((call) => call.method === 'DELETE')).toEqual([])
    await made.forget('b')
    expect(node.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1)
  })

  it('turns off by ending every announcement and the node it started, and keeps what it stored for next time', async () => {
    const { a, b } = await stored(['a', 100, 1], ['b', 200, 2])
    const { made, node, launcher, started } = setup()
    await made.resume()
    await made.stop()
    expect(node.calls.filter((call) => call.method === 'DELETE').map((call) => call.path).sort()).toEqual([`/provide/${a.cid}`, `/provide/${b.cid}`].sort())
    expect(launcher.stop).toHaveBeenCalledWith(5181)
    expect(made.summary()).toMatchObject({ running: false, wikis: 0, state: 'off' })
    expect(mem.hosted.size).toBe(2)
    await made.resume()
    expect(started).toHaveLength(2)
    expect(made.summary().wikis).toBe(2)
  })
})

describe('what the node reports', () => {
  it('maps reachability and the place on Orivon\'s relay to the state of each wiki', async () => {
    const a = await version(1)
    const b = await version(2)
    const c = await version(3)
    let status: object = { ...STATUS, reachability: 'private', relays: [], providing: [{ cid: a.cid, announced: 1_700_000_000_000 }, { cid: b.cid, announced: null }, { cid: c.cid, announced: null }] }
    const { made } = setup({ node: fakeNode({ status: () => status }) })
    await made.host('a', a.cid, a.car)
    await made.host('b', b.cid, b.car)
    await made.host('c', c.cid, c.car)
    expect(await made.poll()).toBe(true)
    expect(['a', 'b', 'c'].map((wiki) => made.stateOf(wiki))).toEqual(['announced', 'unreachable', 'unreachable'])
    expect(made.summary()).toMatchObject({ state: 'unreachable', announced: 1, wikis: 3, reachability: 'private', relays: 0 })
    expect(errorLines()).toEqual(['[decentrawiki] hosting cannot reach this computer: it refuses connections and holds no place on Orivon\'s relay'])

    status = { ...STATUS, reachability: 'private', relays: [CIRCUIT], providing: [{ cid: a.cid, announced: 1_700_000_000_000 }, { cid: b.cid, announced: null }, { cid: c.cid, announced: null }] }
    await made.poll()
    expect(['a', 'b', 'c'].map((wiki) => made.stateOf(wiki))).toEqual(['announced', 'starting', 'starting'])
    expect(made.summary()).toMatchObject({ state: 'starting', relays: 1 })

    status = { ...STATUS, reachability: 'public', providing: [a, b, c].map((v) => ({ cid: v.cid, announced: 1_700_000_000_000 })) }
    await made.poll()
    expect(made.summary()).toMatchObject({ state: 'announced', announced: 3, reachability: 'public', relays: 0 })
  })

  it('writes the reachability to the console once for each change, and the files announced with the roots', async () => {
    const v = await version(1)
    let status: object = { ...STATUS, relays: [], reachability: 'unknown', providing: [{ cid: v.cid, announced: null }] }
    const { made } = setup({ node: fakeNode({ status: () => status, provided: () => ({ children: 4, truncated: false }) }) })
    await made.host('w', v.cid, v.car)
    await made.poll()
    await made.poll()
    expect(warns.mock.calls.map((call) => String(call[0]))).toEqual(['[decentrawiki] hosting status: reachability unknown, relay places held 0, wikis announced 0 of 1, files and folders announced with them 4'])
    status = { ...STATUS, relays: [CIRCUIT], reachability: 'private', providing: [{ cid: v.cid, announced: 1_700_000_000_000 }] }
    await made.poll()
    await made.poll()
    expect(String(warns.mock.calls.at(-1)![0])).toBe('[decentrawiki] hosting status: reachability private, relay places held 1, wikis announced 1 of 1, files and folders announced with them 4')
    expect(warns).toHaveBeenCalledTimes(2)
  })

  it('reports a wiki the node\'s table cut short', async () => {
    const v = await version(1)
    const { made } = setup({ node: fakeNode({ status: () => ({ ...STATUS, relays: [CIRCUIT], providing: [{ cid: v.cid, announced: null }] }), provided: () => ({ children: 1023, truncated: true }) }) })
    await made.host('w', v.cid, v.car)
    await made.poll()
    expect(String(warns.mock.calls.at(-1)![0])).toContain(', files and folders announced with them 1023, wikis cut short at the node\'s limit 1')
  })

  it('forgets everything when the node stops answering, says so once, and starts it again for the next wiki', async () => {
    const one = await version(1)
    const two = await version(2)
    let up = true
    const { made, started } = setup({ node: fakeNode({ alive: () => up, status: () => STATUS }) })
    await made.host('a', one.cid, one.car)
    up = false
    expect(await made.poll()).toBe(false)
    expect(made.stateOf('a')).toBe('off')
    expect(made.summary()).toMatchObject({ running: false, wikis: 0 })
    expect(made.holds(one.cid)).toBe(false)
    expect(await made.poll()).toBe(true)
    expect(errorLines()).toEqual(['[decentrawiki] hosting the IPFS node stopped answering'])
    up = true
    await made.host('b', two.cid, two.car)
    expect(started).toHaveLength(2)
    expect(made.summary().wikis).toBe(2)
    expect(made.stateOf('a')).not.toBe('off')
  })

  it('keeps the node when one status call fails and the node still answers, so that turning hosting off takes its announcements back', async () => {
    let failing = false
    const { made, node, launcher, started } = setup({ node: fakeNode({ status: () => failing ? undefined : STATUS }) })
    const v = await version(1)
    await made.host('w', v.cid, v.car)
    failing = true
    expect(await made.poll()).toBe(true)
    expect(made.summary()).toMatchObject({ running: true, wikis: 1 })
    expect(made.holds(v.cid)).toBe(true)
    expect(errorLines()).toEqual(['[decentrawiki] hosting the IPFS node did not answer a status request'])
    failing = false
    await made.stop()
    expect(node.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([`/provide/${v.cid}`])
    expect(launcher.stop).toHaveBeenCalledWith(5181)
    expect(started).toHaveLength(1)
  })

  it('keeps the node when handing it a wiki fails and the node still answers, and takes a deleted wiki back from it', async () => {
    let failed = false
    const blocks = () => {
      if (failed) return Response.json({ roots: [], blocks: 1 })
      failed = true
      throw new TypeError('fetch failed')
    }
    const { made, node, started } = setup({ node: fakeNode({ status: () => STATUS, blocks }) })
    const one = await version(1)
    const two = await version(2)
    expect(await made.host('a', one.cid, one.car)).toBe(false)
    expect(made.summary().running).toBe(true)
    expect(await made.host('b', two.cid, two.car)).toBe(true)
    expect(started).toHaveLength(1)
    await made.forget('b')
    expect(node.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/provide/${two.cid}` })
  })

  it('polls on a timer while hosting, and stops polling when turned off', async () => {
    vi.useFakeTimers()
    const v = await version(1)
    const { made, node } = setup({ pollMs: 1000 })
    await made.host('w', v.cid, v.car)
    const statuses = () => node.calls.filter((call) => call.path === '/status').length
    const before = statuses()
    await vi.advanceTimersByTimeAsync(1100)
    expect(statuses()).toBeGreaterThan(before)
    await made.stop()
    const after = statuses()
    await vi.advanceTimersByTimeAsync(5000)
    expect(statuses()).toBe(after)
  })
})
