import { describe, expect, it, vi } from 'vitest'
import { ChainError, type Chain, type LogFilter } from '../site/sdk/chain.js'
import { CENSUS_FORMAT, type Census, type NameEntry } from '../site/resolver/og-census.js'
import { inspectOg, MAX_WARM_NAMES, resolveOg, warmUp } from '../site/resolver/og-names.js'
import { IMPLEMENTATION, PROXY, SOURCE, TOPICS, UPGRADES } from '../site/resolver/og-pins.js'
import { createSession, FINISH_RESERVE_MS, OgRefusal, scanLogs, WINDOW, windowsOf, type Scan } from '../site/resolver/og-tail.js'
import { fakeChain, FIRST_BLOCK, worldOf, type Faults, type World } from './support/og-world.ts'
import { VECTORS } from './support/og-vectors.ts'

const NAME = VECTORS.find((vector) => vector.id === 'unwrapped-passes')!
const CHECKPOINT = FIRST_BLOCK - 1_000
const census = (names: Record<string, NameEntry> = {}, block = CHECKPOINT): Census => ({ format: CENSUS_FORMAT, block, blockHash: `0x${'00'.repeat(32)}`, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names })
const PASSING = { ownerDefault: null, records: [{ type: 'ipfs', value: NAME.state.values['content.ipfs'] }], provenance: { by: SOURCE, proven: false } }

/** A chain whose every log query takes `perWindowMs` of a clock the session reads. */
function clocked (world: World, perWindowMs: number, faults: Faults = {}) {
  let t = 1_000_000
  const hook = faults.logs
  const made = fakeChain(world, { faults: { ...faults, logs: (filter) => { t += perWindowMs; return hook?.(filter) } } })
  return { ...made, now: () => t }
}

/** The windows a name's scan and the upgrade scan ask over a tail of `blocks`: the same ranges, twice. */
const longWorld = (blocks: number) => worldOf(NAME, { spread: 300, head: FIRST_BLOCK + blocks })

describe('windowsOf', () => {
  it('covers a range in windows of 1024, both ends counted', () => {
    expect(windowsOf(10, 9)).toEqual([])
    expect(windowsOf(10, 10)).toEqual([[10, 10]])
    expect(windowsOf(1, WINDOW)).toEqual([[1, WINDOW]])
    expect(windowsOf(1, WINDOW + 1)).toEqual([[1, WINDOW], [WINDOW + 1, WINDOW + 1]])
    expect(windowsOf(5, 5 + 3 * WINDOW - 1)).toHaveLength(3)
  })
})

describe('the budget of a call', () => {
  it('answers when the tail fits in the time the call has', async () => {
    const world = worldOf(NAME, { spread: 300 })
    const { chain, now } = clocked(world, 100)
    const answer = await resolveOg(chain, `${NAME.label}.og`, { session: createSession({ now }), census: census(), deadlineAt: now() + 30_000 })
    expect(answer).toMatchObject({ records: PASSING.records })
  })

  it('refuses in words, and never answers in part, when the tail is too long for the time the call has', async () => {
    const { chain, asked, now } = clocked(longWorld(150_000), 1_000)
    const failure = await resolveOg(chain, `${NAME.label}.og`, { session: createSession({ now }), census: census(), deadlineAt: now() + 30_000 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OgRefusal)
    expect(failure).toMatchObject({ code: 'unavailable', message: expect.stringMatching(/Still checking .* of \d+ stretches of the chain are left.*try again shortly/) })
    const windows = windowsOf(CHECKPOINT + 1, FIRST_BLOCK + 150_000).length
    expect(asked.logs.length).toBeGreaterThan(0)
    expect(asked.logs.length).toBeLessThan(2 * windows)
  })

  it('keeps what a call read, so asking again finishes the tail without asking for a window twice', async () => {
    const { chain, asked, now } = clocked(longWorld(150_000), 1_000)
    const session = createSession({ now })
    let refusals = 0
    let answer
    while (answer === undefined && refusals < 20) {
      try {
        answer = await resolveOg(chain, `${NAME.label}.og`, { session, census: census(), deadlineAt: now() + 30_000 })
      } catch (error) {
        expect(error).toBeInstanceOf(OgRefusal)
        refusals++
      }
    }
    expect(refusals).toBeGreaterThan(0)
    expect(answer).toMatchObject({ records: PASSING.records })
    const asks = asked.logs.map((filter) => JSON.stringify([filter.address, filter.topics, filter.fromBlock, filter.toBlock]))
    expect(new Set(asks).size).toBe(asks.length)
  })

  it('refuses before asking for anything when less time is left than the call keeps for itself', async () => {
    const { chain, asked, now } = clocked(worldOf(NAME, { spread: 300 }), 10)
    await expect(resolveOg(chain, `${NAME.label}.og`, { session: createSession({ now }), census: census(), deadlineAt: now() + FINISH_RESERVE_MS - 500 })).rejects.toBeInstanceOf(OgRefusal)
    expect(asked.logs).toEqual([])
  })

  it('stops waiting for a window another call is reading when its own time is up', async () => {
    const world = worldOf(NAME, { spread: 300 })
    const made = fakeChain(world)
    const stuck = new Promise<never>(() => {})
    const chain = { ...made.chain, getLogs: () => stuck } as typeof made.chain
    const started = Date.now()
    await expect(resolveOg(chain, `${NAME.label}.og`, { session: createSession(), census: census(), deadlineAt: Date.now() + FINISH_RESERVE_MS + 150 })).rejects.toBeInstanceOf(OgRefusal)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('stops when the asker leaves, with the reason the asker gave', async () => {
    const controller = new AbortController()
    const world = longWorld(40_000)
    const made = fakeChain(world, { faults: { logs: () => { controller.abort(new Error('the asker left')); return undefined } } })
    await expect(resolveOg(made.chain, `${NAME.label}.og`, { session: createSession(), census: census(), signal: controller.signal })).rejects.toThrow('the asker left')
  })

  it('says what it is doing as it goes, a stretch at a time', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 3_000 })
    const lines: string[] = []
    await resolveOg(fakeChain(world).chain, `${NAME.label}.og`, { session: createSession(), census: census(), progress: (line) => { lines.push(line) } })
    expect(lines[0]).toBe('Reading the name')
    expect(lines.some((line) => /^Checking the recent history of \S+\.og: \d+ of \d+$/.test(line))).toBe(true)
    expect(lines.some((line) => /^Checking the resolver contract for upgrades: \d+ of \d+$/.test(line))).toBe(true)
  })
})

describe('the windows of one page', () => {
  it('asks the node once for a window, whoever needs it and however many lookups there are', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 5_000 })
    const { chain, asked } = fakeChain(world)
    const session = createSession()
    await resolveOg(chain, `${NAME.label}.og`, { session, census: census() })
    const first = asked.logs.length
    expect(first).toBeGreaterThan(0)
    await resolveOg(chain, `${NAME.label}.og`, { session, census: census() })
    expect(asked.logs.length).toBe(first)
  })

  it('makes the one upgrade scan for every name, and a scan of its own for each', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 5_000 })
    const other = VECTORS.find((vector) => vector.id === 'unwrapped-leftover-rewritten')!
    Object.assign(world.names, worldOf(other, { spread: 300 }).names)
    world.logs.push(...worldOf(other, { spread: 300 }).logs)
    const { chain, asked } = fakeChain(world)
    const session = createSession()
    await resolveOg(chain, `${NAME.label}.og`, { session, census: census() })
    await resolveOg(chain, `${other.label}.og`, { session, census: census() })
    const windows = windowsOf(CHECKPOINT + 1, world.head).length
    const upgrades = asked.logs.filter((filter) => filter.topics?.[0] === TOPICS.upgraded)
    expect(upgrades).toHaveLength(windows)
    expect(asked.logs.length - upgrades.length).toBe(2 * windows)
  })

  it('asks again for a window that failed, and for no other', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 5_000 })
    let failing = true
    const { chain, asked } = fakeChain(world, { faults: { logs: () => failing ? new ChainError('unavailable', 'down') : undefined } })
    const session = createSession()
    await expect(resolveOg(chain, `${NAME.label}.og`, { session, census: census() })).rejects.toMatchObject({ reason: 'unavailable' })
    failing = false
    const before = asked.logs.length
    await expect(resolveOg(chain, `${NAME.label}.og`, { session, census: census() })).resolves.toMatchObject({ records: PASSING.records })
    expect(asked.logs.length - before).toBeGreaterThan(0)
  })
})

describe('the block every read is pinned to', () => {
  const blocksOf = (asked: ReturnType<typeof fakeChain>['asked']) => ({
    reads: new Set(asked.calls.map((call) => call.block)),
    storage: new Set(asked.storage.map((read) => read.block)),
    logsEnd: Math.max(...asked.logs.map((filter) => Number(filter.toBlock)))
  })

  it('is the safe block, for the state, the implementation slot and the end of every log range', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 3_000, safe: FIRST_BLOCK + 2_000 })
    const { chain, asked } = fakeChain(world)
    const answer = await resolveOg(chain, `${NAME.label}.og`, { session: createSession(), census: census() })
    const { reads, storage, logsEnd } = blocksOf(asked)
    expect([...reads]).toEqual([FIRST_BLOCK + 2_000])
    expect([...storage]).toEqual([FIRST_BLOCK + 2_000])
    expect(logsEnd).toBe(FIRST_BLOCK + 2_000)
    expect(answer.provenance.block).toBe(FIRST_BLOCK + 2_000)
  })

  it('is the latest block for a node that names no safe block', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 3_000, safe: null })
    const { chain, asked } = fakeChain(world)
    await resolveOg(chain, `${NAME.label}.og`, { session: createSession(), census: census() })
    expect([...blocksOf(asked).reads]).toEqual([FIRST_BLOCK + 3_000])
  })

  it('is the latest block for a name this page has just written, which the safe block does not show yet', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 3_000, safe: FIRST_BLOCK + 2_000 })
    const { chain, asked } = fakeChain(world)
    const session = createSession()
    session.written.set(NAME.label, FIRST_BLOCK + 2_900)
    await resolveOg(chain, `${NAME.label}.og`, { session, census: census() })
    expect([...blocksOf(asked).reads]).toEqual([FIRST_BLOCK + 3_000])
  })

  it('is never before the census checkpoint', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 3_000, safe: CHECKPOINT - 50 })
    const { chain, asked } = fakeChain(world)
    await resolveOg(chain, `${NAME.label}.og`, { session: createSession(), census: census() })
    expect([...blocksOf(asked).reads]).toEqual([CHECKPOINT])
  })

  it('has no log range wider than 1024 blocks, and no query of more than one address list or one string per topic', async () => {
    const { chain, asked } = fakeChain(worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 40_000 }))
    await resolveOg(chain, `${NAME.label}.og`, { session: createSession(), census: census() })
    for (const filter of asked.logs) {
      expect(Number(filter.toBlock) - Number(filter.fromBlock) + 1).toBeLessThanOrEqual(WINDOW)
      expect([filter.address].flat().length).toBeLessThanOrEqual(32)
      for (const topic of filter.topics ?? []) expect(topic === null || typeof topic === 'string').toBe(true)
    }
  })
})

describe('the read-ahead when the page starts', () => {
  const entryFor = (): NameEntry => ({ holder: `0x${'11'.repeat(20)}`, wrapped: false, id: null, holderChange: null, newController: null, keys: {} })

  it('reads the upgrade scan and the recent history of the census names, so the first lookup asks for nothing', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 5_000 })
    const { chain, asked } = fakeChain(world)
    const session = createSession()
    const loaded = census({ [NAME.label]: entryFor() })
    await warmUp(chain, { session, census: loaded })
    const warmed = asked.logs.length
    expect(warmed).toBeGreaterThan(0)
    await resolveOg(chain, `${NAME.label}.og`, { session, census: loaded })
    expect(asked.logs.length).toBe(warmed)
  })

  it('stops starting reads at its own deadline, and says why a part stopped', async () => {
    const { chain, now } = clocked(longWorld(150_000), 1_000)
    const lines: string[] = []
    await warmUp(chain, { session: createSession({ now }), census: census({ [NAME.label]: entryFor() }), deadlineAt: now() + 10_000 }, (line) => { lines.push(line) })
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join(' ')).toMatch(/stopped: Still checking/)
  })

  it('never throws: a node that cannot be asked ends the read-ahead and the lookups that follow ask again', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 5_000 })
    const lines: string[] = []
    const { chain } = fakeChain(world, { faults: { logs: () => new ChainError('unavailable', 'down') } })
    await expect(warmUp(chain, { session: createSession(), census: census({ [NAME.label]: entryFor() }) }, (line) => { lines.push(line) })).resolves.toBeUndefined()
    expect(lines.length).toBeGreaterThan(0)
  })

  it('reads the history of no more than 64 census names', async () => {
    const names = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`name${index}`, entryFor()]))
    const { chain, asked } = fakeChain(worldOf(NAME, { spread: 300 }))
    await warmUp(chain, { session: createSession(), census: census(names) })
    expect(MAX_WARM_NAMES).toBe(64)
    expect(asked.calls).toHaveLength(MAX_WARM_NAMES)
  })
})

describe('the pace of the windows', () => {
  /** A node that answers one log query at a time, `service.ms` each, on the fake timers: a light client a page asks through its queue. */
  function serialNode (world: World, service: { ms: number }) {
    const made = fakeChain(world)
    let line: Promise<unknown> = Promise.resolve()
    let asked = 0
    const chain = {
      ...made.chain,
      getLogs: (filter: LogFilter) => {
        asked++
        const turn = line.then(() => new Promise((resolve) => setTimeout(resolve, service.ms))).then(() => made.chain.getLogs(filter))
        line = turn.catch(() => {})
        return turn
      }
    } as Chain
    return { chain, asked: () => asked }
  }

  /** One lookup with the 30 seconds a call has, on the fake timers: what it did and how many windows it asked for. */
  async function call (chain: Chain, session: ReturnType<typeof createSession>, asked: () => number) {
    const before = asked()
    const attempt = resolveOg(chain, `${NAME.label}.og`, { session, census: census(), deadlineAt: Date.now() + 30_000 }).then(() => 'answered', (error: unknown) => error instanceof OgRefusal ? 'refused' : String(error))
    await vi.advanceTimersByTimeAsync(31_000)
    return { outcome: await attempt, started: asked() - before }
  }

  it('does not let one slow stretch stop every later lookup: each call may start a round of windows, so the tail is read call by call', async () => {
    vi.useFakeTimers()
    try {
      const { chain, asked } = serialNode(longWorld(30 * WINDOW), { ms: 3_000 })
      const session = createSession()
      const calls = []
      do calls.push(await call(chain, session, asked)); while (calls.at(-1)?.outcome === 'refused' && calls.length < 12)
      expect(calls.at(-1)?.outcome, JSON.stringify(calls)).toBe('answered')
      // A round is eight windows a scan; the last refusal may have fewer left to start.
      for (const { started } of calls.slice(0, -2)) expect(started, JSON.stringify(calls)).toBeGreaterThanOrEqual(8)
      expect(calls.at(-2)?.started, JSON.stringify(calls)).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers in one call once the node is fast again, though it was slow before: what it learned is not kept for good', async () => {
    vi.useFakeTimers()
    try {
      const service = { ms: 3_000 }
      const { chain, asked } = serialNode(longWorld(30 * WINDOW), service)
      const session = createSession()
      expect((await call(chain, session, asked)).outcome).toBe('refused')
      expect((await call(chain, session, asked)).outcome).toBe('refused')
      service.ms = 20
      expect((await call(chain, session, asked)).outcome).toBe('answered')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the turns of the windows on one page', () => {
  /** A node whose answers the test gives one by one. */
  function manualNode () {
    const asked: { filter: LogFilter, release: () => void }[] = []
    const chain = { getLogs: (filter: LogFilter) => new Promise((resolve) => { asked.push({ filter, release: () => { resolve([]) } }) }) } as unknown as Chain
    return { chain, asked }
  }
  const scanOf = (id: string, windows: number): Scan => ({ id, address: PROXY, topics: [id === 'a' ? TOPICS.upgraded : id === 'b' ? TOPICS.changed : TOPICS.newController], from: 1, to: windows * WINDOW, accept: () => true })
  const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }
  const topicsOf = (asked: { filter: LogFilter }[]) => asked.map(({ filter }) => filter.topics?.[0])

  it('has no more windows in flight than the page may have open, whoever wants them', async () => {
    const { chain, asked } = manualNode()
    const session = createSession()
    void scanLogs(chain, session, scanOf('a', 20), { call: {}, final: 20 * WINDOW }).catch(() => {})
    void scanLogs(chain, session, scanOf('b', 20), { call: {}, final: 20 * WINDOW }).catch(() => {})
    await settle()
    expect(asked).toHaveLength(8)
  })

  it('gives the next turn to the call holding the fewest windows, so a long call does not keep a short one waiting', async () => {
    const { chain, asked } = manualNode()
    const session = createSession()
    void scanLogs(chain, session, scanOf('a', 20), { call: {}, final: 20 * WINDOW }).catch(() => {})
    await settle()
    void scanLogs(chain, session, scanOf('b', 3), { call: {}, final: 3 * WINDOW }).catch(() => {})
    await settle()
    expect(topicsOf(asked)).toEqual(Array(8).fill(TOPICS.upgraded))
    for (let freed = 0; freed < 3; freed++) { asked[freed]!.release(); await settle() }
    expect(topicsOf(asked).slice(8)).toEqual(Array(3).fill(TOPICS.changed))
    asked[3]!.release()
    await settle()
    expect(topicsOf(asked).slice(11)).toEqual([TOPICS.upgraded])
  })

  it('gives the page\'s own read-ahead the turns no lookup wants', async () => {
    const { chain, asked } = manualNode()
    const session = createSession()
    void scanLogs(chain, session, scanOf('a', 20), { call: { background: true }, final: 20 * WINDOW }).catch(() => {})
    await settle()
    void scanLogs(chain, session, scanOf('b', 3), { call: {}, final: 3 * WINDOW }).catch(() => {})
    await settle()
    for (let freed = 0; freed < 3; freed++) { asked[freed]!.release(); await settle() }
    expect(topicsOf(asked).slice(8)).toEqual(Array(3).fill(TOPICS.changed))
  })

  it('stops waiting for a turn when the asker leaves', async () => {
    const { chain } = manualNode()
    const session = createSession()
    void scanLogs(chain, session, scanOf('a', 20), { call: {}, final: 20 * WINDOW }).catch(() => {})
    await settle()
    const controller = new AbortController()
    const waiting = scanLogs(chain, session, scanOf('b', 3), { call: {}, final: 3 * WINDOW, signal: controller.signal }).catch((error: unknown) => error)
    await settle()
    controller.abort(new Error('the asker left'))
    const left = await Promise.race([waiting, new Promise((resolve) => setTimeout(() => { resolve('still waiting') }, 500))])
    expect(left).toMatchObject({ message: 'the asker left' })
  })
})

describe('the windows a page keeps', () => {
  const blocks = (asked: ReturnType<typeof fakeChain>['asked']) => asked.logs.map((filter) => Number(filter.toBlock))

  it('keeps no window that ends above the safe block when it was read at the latest block, and asks for it again', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 3_000, safe: FIRST_BLOCK + 2_000 })
    const { chain, asked } = fakeChain(world)
    const session = createSession()
    const lookup = { session, census: census() }
    await inspectOg(chain, NAME.label, lookup, { latest: true })
    const first = blocks(asked).length
    await inspectOg(chain, NAME.label, lookup, { latest: true })
    const second = blocks(asked).slice(first)
    // Two scans over four windows: the two below the safe block are kept, the two above it are read again.
    expect(first).toBe(8)
    expect(second.sort((a, b) => a - b)).toEqual([FIRST_BLOCK + 2_072, FIRST_BLOCK + 2_072, FIRST_BLOCK + 3_000, FIRST_BLOCK + 3_000])
  })

  it('keeps every window of a lookup pinned to the safe block', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 3_000, safe: FIRST_BLOCK + 2_000 })
    const { chain, asked } = fakeChain(world)
    const lookup = { session: createSession(), census: census() }
    await inspectOg(chain, NAME.label, lookup)
    const first = asked.logs.length
    await inspectOg(chain, NAME.label, lookup)
    expect(asked.logs.length).toBe(first)
  })

  it('does not keep a window within 64 blocks of the latest block when the node names no safe block', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 3_000, safe: null })
    const { chain, asked } = fakeChain(world)
    const lookup = { session: createSession(), census: census() }
    await inspectOg(chain, NAME.label, lookup)
    const first = blocks(asked).length
    await inspectOg(chain, NAME.label, lookup)
    expect(blocks(asked).slice(first).sort()).toEqual([FIRST_BLOCK + 3_000, FIRST_BLOCK + 3_000])
  })
})
