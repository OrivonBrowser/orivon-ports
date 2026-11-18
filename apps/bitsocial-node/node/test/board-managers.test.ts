// Keeping each board's manager running: started once the person turned it on and at every Worker start, one at a time, started
// again with a pause that grows while it keeps failing, never in the way of another board's, stopped with the Worker, and every
// line it writes free of the RPC's key. The manager itself is a stand-in; the config folder is real.
import * as fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boardConfigStore } from '../worker/board-config.js'
import { MANAGER_DEFAULTS, NotFoundError, superviseBoardManagers } from '../worker/board-managers.js'

const KEY = 'supervisor-key-0123456789abcdef'
const RPC = `ws://127.0.0.1:9138/${KEY}`

const settle = async (): Promise<void> => { for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0)) }

/** A clock that only moves when the test says: a pause ends when it has been advanced past. */
function fakeClock () {
  let at = 1_000_000
  let ids = 0
  const timers: Array<{ at: number, run: () => void, id: number }> = []
  return {
    now: () => at,
    after: (ms: number, run: () => void) => { const timer = { at: at + ms, run, id: ids++ }; timers.push(timer); return () => { const found = timers.indexOf(timer); if (found >= 0) timers.splice(found, 1) } },
    /** The pauses that are waiting, as milliseconds from now. */
    waiting: () => timers.map((timer) => timer.at - at).sort((a, b) => a - b),
    async advance (ms: number) {
      const until = at + ms
      for (;;) {
        await settle()
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        timers.splice(timers.indexOf(due), 1)
        at = Math.max(at, due.at)
        due.run()
      }
      at = until
      await settle()
    }
  }
}

interface Started { options: Record<string, any>, stops: number, stopImpl: () => Promise<void> }

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bitsocial-board-managers-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function setup (options: { boards?: Array<Record<string, unknown>>, global?: Record<string, unknown>, hosted?: Array<{ address: string, started?: boolean }>, startFails?: (address: string, attempt: number) => Error | null, timing?: Record<string, number> } = {}) {
  const store = boardConfigStore({ directory: dir, fs: fs as never })
  for (const board of options.boards ?? []) store.writeBoard(board as never)
  if (options.global !== undefined) store.writeGlobal(options.global as never)
  const clock = fakeClock()
  const started: Started[] = []
  const attempts = new Map<string, number>()
  const lines: string[] = []
  const log: string[] = []
  const running = new Set<string>()
  let overlapped = false
  let inStart = 0
  const hosted = options.hosted ?? (options.boards ?? []).map((board) => ({ address: String(board['address']), started: true }))
  const managers = superviseBoardManagers({
    start: async (given) => {
      inStart += 1
      if (inStart > 1) overlapped = true
      try {
        await Promise.resolve()
        const address = String(given['communityAddress'])
        const attempt = (attempts.get(address) ?? 0) + 1
        attempts.set(address, attempt)
        const failure = options.startFails?.(address, attempt) ?? null
        if (failure !== null) throw failure
        const entry: Started = { options: given, stops: 0, stopImpl: async () => {} }
        entry.stopImpl = async () => { entry.stops += 1; running.delete(address) }
        started.push(entry)
        running.add(address)
        return { stop: () => entry.stopImpl() }
      } finally { inStart -= 1 }
    },
    resolve: (board, config, directory) => ({
      communityAddress: board['address'], pkcRpcUrl: config['rpcUrl'] ?? 'ws://localhost:9138', boardDir: `${directory}/boards/${String(board['address'])}`,
      perPage: board['perPage'] ?? config['defaults']?.perPage, pages: board['pages'] ?? config['defaults']?.pages, bumpLimit: board['bumpLimit'] ?? config['defaults']?.bumpLimit,
      archivePurgeSeconds: board['archivePurgeSeconds'] ?? config['defaults']?.archivePurgeSeconds, userAgent: config['userAgent']
    }),
    store, rpcUrl: RPC, hosted: () => hosted, clock,
    log: (line) => { log.push(line) }, warn: (line) => { lines.push(line) },
    redact: (text) => text.split(KEY).join('<key>'),
    timing: { retryMs: 5_000, maxRetryMs: 40_000, stableMs: 60_000, stopWaitMs: 1_000, ...options.timing }
  })
  return { managers, store, clock, started, attempts, lines, running, hosted, overlapped: () => overlapped }
}

describe('at the start of the Worker', () => {
  it('starts the manager of each board that is on, with the limits the config and the defaults give, against the Worker\'s own RPC', async () => {
    const { managers, started, running } = setup({
      boards: [{ address: 'a.bso', perPage: 3, bumpLimit: 50 }, { address: 'b.bso' }, { address: 'off.bso', enabled: false }],
      global: { userAgent: 'agent/1', defaults: { pages: 2, archivePurgeSeconds: 30 } }
    })
    managers.begin()
    await settle()
    expect([...running].sort()).toEqual(['a.bso', 'b.bso'])
    const a = started.find((one) => one.options['communityAddress'] === 'a.bso')!
    expect(a.options).toMatchObject({ pkcRpcUrl: RPC, perPage: 3, pages: 2, bumpLimit: 50, archivePurgeSeconds: 30, userAgent: 'agent/1', boardDir: `${dir}/boards/a.bso` })
    expect(managers.boards().map((board) => [board.address, board.state, board.enabled])).toEqual([['a.bso', 'running', true], ['b.bso', 'running', true], ['off.bso', 'off', false]])
  })

  it('starts them one at a time: each opens a connection and loads a community', async () => {
    const { managers, overlapped, started } = setup({ boards: [{ address: 'a.bso' }, { address: 'b.bso' }, { address: 'c.bso' }] })
    managers.begin()
    await settle()
    expect(started).toHaveLength(3)
    expect(overlapped()).toBe(false)
  })

  it('names what it could not read and starts the rest', async () => {
    const { managers, running, lines, store } = setup({ boards: [{ address: 'a.bso' }] })
    fs.mkdirSync(join(store.directory, 'boards', 'bad.bso'), { recursive: true })
    fs.writeFileSync(join(store.directory, 'boards', 'bad.bso', 'config.json'), 'not json')
    managers.begin()
    await settle()
    expect([...running]).toEqual(['a.bso'])
    expect(lines.some((line) => /config: .*bad\.bso.*not JSON/.test(line))).toBe(true)
  })

  it('lists the boards the node hosts that have no manager, and the managed ones', async () => {
    const { managers } = setup({ boards: [{ address: 'a.bso' }], hosted: [{ address: 'a.bso', started: true }, { address: 'free.bso', started: false }] })
    managers.begin()
    await settle()
    expect(managers.boards().map((board) => ({ address: board.address, hosted: board.hosted, started: board.started, managed: board.managed, state: board.state }))).toEqual([
      { address: 'a.bso', hosted: true, started: true, managed: true, state: 'running' },
      { address: 'free.bso', hosted: true, started: false, managed: false, state: 'off' }
    ])
  })

  it('reports each board\'s effective limits, its capacity, and the threads it archived, never its key', async () => {
    const { managers, store } = setup({ boards: [{ address: 'a.bso', perPage: 2, pages: 3 }], global: { defaults: { bumpLimit: 10 } } })
    fs.writeFileSync(join(store.directory, 'boards', 'a.bso', 'state.json'), JSON.stringify({ signers: { 'a.bso': { privateKey: 'SECRET' } }, archivedThreads: { c1: { archivedTimestamp: 1 } } }))
    managers.begin()
    await settle()
    const board = managers.board('a.bso')
    expect(board).toMatchObject({ config: { perPage: 2, pages: 3 }, effective: { perPage: 2, pages: 3, bumpLimit: 10, archivePurgeSeconds: MANAGER_DEFAULTS.archivePurgeSeconds }, capacity: 6, archivedThreads: 1 })
    expect(JSON.stringify(board)).not.toContain('SECRET')
  })
})

describe('when a manager does not start', () => {
  it('starts it again after a pause that doubles with each failure and stops growing at the cap, naming the reason', async () => {
    const { managers, clock, attempts, lines } = setup({ boards: [{ address: 'a.bso' }], startFails: (_address, attempt) => (attempt <= 6 ? new Error('Community a.bso not found') : null) })
    managers.begin()
    await settle()
    expect(attempts.get('a.bso')).toBe(1)
    expect(managers.board('a.bso')).toMatchObject({ state: 'backoff', failures: 1, lastError: 'Community a.bso not found', nextAttemptAt: clock.now() + 5_000 })
    for (const pause of [5_000, 10_000, 20_000, 40_000, 40_000]) await clock.advance(pause)
    expect(attempts.get('a.bso')).toBe(6)
    await clock.advance(40_000)
    expect(attempts.get('a.bso')).toBe(7)
    expect(managers.board('a.bso').state).toBe('running')
    expect(lines.filter((line) => /did not start/.test(line)).map((line) => /trying again in (\d+) s/.exec(line)?.[1])).toEqual(['5', '10', '20', '40', '40', '40'])
  })

  it('does not hold the other boards up', async () => {
    const { managers, running } = setup({ boards: [{ address: 'a.bso' }, { address: 'b.bso' }], startFails: (address) => (address === 'a.bso' ? new Error('no') : null) })
    managers.begin()
    await settle()
    expect([...running]).toEqual(['b.bso'])
  })

  it('never lets the manager\'s own error out, whatever it throws, and leaves the key out of what it writes', async () => {
    const { managers, lines, clock } = setup({ boards: [{ address: 'a.bso' }], startFails: () => new Error(`connect failed to ${RPC}`) })
    managers.begin()
    await settle()
    await clock.advance(5_000)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).not.toContain(KEY)
    expect(lines.join('\n')).toContain('ws://127.0.0.1:9138/<key>')
    expect(managers.board('a.bso').lastError).not.toContain(KEY)
  })

  it('survives a start that throws before it returns a promise', async () => {
    const store = boardConfigStore({ directory: dir, fs: fs as never })
    store.writeBoard({ address: 'a.bso' })
    const clock = fakeClock()
    const lines: string[] = []
    const managers = superviseBoardManagers({ start: (() => { throw new Error('sync') }) as never, resolve: () => ({}), store, rpcUrl: RPC, clock, warn: (line) => { lines.push(line) } })
    managers.begin()
    await settle()
    expect(managers.boards()[0]).toMatchObject({ state: 'backoff', lastError: 'sync' })
    await managers.stop()
  })
})

describe('when a running manager loses its RPC connection', () => {
  it('stops it, waits, and starts it again', async () => {
    const { managers, clock, started } = setup({ boards: [{ address: 'a.bso' }] })
    managers.begin()
    await settle()
    started[0]!.options['onRpcDisconnect']()
    await settle()
    expect(started[0]!.stops).toBe(1)
    expect(managers.board('a.bso')).toMatchObject({ state: 'backoff', lastError: 'its RPC connection closed' })
    await clock.advance(5_000)
    expect(started).toHaveLength(2)
    expect(managers.board('a.bso').state).toBe('running')
  })

  it('counts a manager that ran a long time as a first failure again, not a growing one', async () => {
    const { managers, clock, started } = setup({ boards: [{ address: 'a.bso' }] })
    managers.begin()
    await settle()
    started[0]!.options['onRpcDisconnect']()
    await clock.advance(5_000)
    await clock.advance(100_000)
    started[1]!.options['onRpcDisconnect']()
    await settle()
    expect(managers.board('a.bso')).toMatchObject({ failures: 1, nextAttemptAt: clock.now() + 5_000 })
  })

  it('ignores the late word of a manager that is already gone', async () => {
    const { managers, clock, started } = setup({ boards: [{ address: 'a.bso' }] })
    managers.begin()
    await settle()
    const stale = started[0]!.options['onRpcDisconnect']
    stale()
    await clock.advance(5_000)
    expect(started).toHaveLength(2)
    stale()
    await settle()
    expect(managers.board('a.bso').state).toBe('running')
    expect(started[1]!.stops).toBe(0)
  })

  it('is not stopped by a manager that cannot be stopped: it is given a while, then left', async () => {
    const { managers, clock, started, lines } = setup({ boards: [{ address: 'a.bso' }] })
    managers.begin()
    await settle()
    started[0]!.stopImpl = () => new Promise(() => {})
    started[0]!.options['onRpcDisconnect']()
    await clock.advance(1_000)
    expect(lines.some((line) => /stopping it: did not stop in time/.test(line))).toBe(true)
    await clock.advance(5_000)
    expect(started).toHaveLength(2)
  })
})

describe('turning a manager on and off', () => {
  it('turns one on for a board the node hosts, writes its config and starts it', async () => {
    const { managers, store, running } = setup({ hosted: [{ address: 'new.bso', started: true }] })
    managers.begin()
    const board = await managers.enable('new.bso', { perPage: 5 })
    await settle()
    expect(board).toMatchObject({ address: 'new.bso', managed: true, enabled: true })
    expect(store.load().boards).toEqual([{ address: 'new.bso', perPage: 5 }])
    expect([...running]).toEqual(['new.bso'])
    expect(managers.board('new.bso').state).toBe('running')
  })

  it('refuses a board the node does not host, and an address that is a path, writing nothing', async () => {
    const { managers, store } = setup({ hosted: [{ address: 'a.bso' }] })
    managers.begin()
    await expect(managers.enable('other.bso')).rejects.toBeInstanceOf(NotFoundError)
    await expect(managers.enable('../x')).rejects.toThrow(/board address/)
    expect(() => managers.board('other.bso')).toThrow(NotFoundError)
    expect(fs.existsSync(join(store.directory, 'boards'))).toBe(false)
  })

  it('turns one off: the manager is stopped, the config says so and keeps its limits, and nothing starts it again', async () => {
    const { managers, store, started, clock, running } = setup({ boards: [{ address: 'a.bso', perPage: 2 }] })
    managers.begin()
    await settle()
    const board = await managers.disable('a.bso')
    expect(board).toMatchObject({ state: 'off', enabled: false, managed: true })
    expect(started[0]!.stops).toBe(1)
    expect([...running]).toEqual([])
    expect(store.load().boards).toEqual([{ address: 'a.bso', perPage: 2, enabled: false }])
    await clock.advance(600_000)
    expect(started).toHaveLength(1)
  })

  it('turns a board back on: the `enabled` key goes, the limits stay, the manager starts', async () => {
    const { managers, store, started } = setup({ boards: [{ address: 'a.bso', perPage: 2, enabled: false }] })
    managers.begin()
    await settle()
    expect(started).toHaveLength(0)
    await managers.enable('a.bso')
    await settle()
    expect(started).toHaveLength(1)
    expect(store.load().boards).toEqual([{ address: 'a.bso', perPage: 2 }])
  })

  it('turns off a board that was waiting to start again, and it does not start', async () => {
    const { managers, clock, attempts } = setup({ boards: [{ address: 'a.bso' }], startFails: () => new Error('no') })
    managers.begin()
    await settle()
    await managers.disable('a.bso')
    await clock.advance(600_000)
    expect(attempts.get('a.bso')).toBe(1)
    expect(clock.waiting()).toEqual([])
  })
})

describe('changing a board\'s config', () => {
  it('writes it and starts the running manager again with the new limits, at once', async () => {
    const { managers, store, started } = setup({ boards: [{ address: 'a.bso', perPage: 2 }] })
    managers.begin()
    await settle()
    const board = await managers.configure('a.bso', { perPage: 8, bumpLimit: 40 })
    await settle()
    expect(board.config).toEqual({ perPage: 8, bumpLimit: 40 })
    expect(started).toHaveLength(2)
    expect(started[0]!.stops).toBe(1)
    expect(started[1]!.options).toMatchObject({ perPage: 8, bumpLimit: 40 })
    expect(store.load().boards).toEqual([{ address: 'a.bso', perPage: 8, bumpLimit: 40 }])
    expect(managers.board('a.bso')).toMatchObject({ restarts: 1, failures: 0 })
  })

  it('takes a field back to the default with null', async () => {
    const { managers, store } = setup({ boards: [{ address: 'a.bso', perPage: 2, pages: 4 }] })
    managers.begin()
    await settle()
    await managers.configure('a.bso', { perPage: null })
    expect(store.load().boards).toEqual([{ address: 'a.bso', pages: 4 }])
  })

  it('sets limits for a hosted board with no manager without turning one on', async () => {
    const { managers, store, started } = setup({ hosted: [{ address: 'free.bso' }] })
    managers.begin()
    const board = await managers.configure('free.bso', { pages: 3 })
    await settle()
    expect(board).toMatchObject({ managed: true, enabled: false, config: { pages: 3 } })
    expect(started).toHaveLength(0)
    expect(store.load().boards).toEqual([{ address: 'free.bso', pages: 3, enabled: false }])
  })

  it('refuses a value the manager would not take, and leaves the file as it was', async () => {
    const { managers, store } = setup({ boards: [{ address: 'a.bso', perPage: 2 }] })
    managers.begin()
    await settle()
    await expect(managers.configure('a.bso', { perPage: -3 })).rejects.toThrow(/perPage must be a positive integer/)
    await expect(managers.configure('a.bso', { enabled: false })).rejects.toThrow(/enabled is not a setting/)
    expect(store.load().boards).toEqual([{ address: 'a.bso', perPage: 2 }])
  })

  it('changes the defaults, keeps the rest of global.json, and starts every running manager again', async () => {
    const { managers, store, started } = setup({ boards: [{ address: 'a.bso' }, { address: 'b.bso', enabled: false }], global: { userAgent: 'agent/1', defaults: { pages: 2 } } })
    managers.begin()
    await settle()
    const answer = await managers.configureDefaults({ perPage: 9 })
    await settle()
    expect(answer).toEqual({ set: { pages: 2, perPage: 9 }, effective: { ...MANAGER_DEFAULTS, pages: 2, perPage: 9 } })
    expect(store.load().global).toEqual({ userAgent: 'agent/1', defaults: { pages: 2, perPage: 9 } })
    expect(started).toHaveLength(2)
    expect(started[1]!.options).toMatchObject({ perPage: 9, pages: 2 })
  })
})

describe('when the manager moves a board', () => {
  it('renames the board\'s folder and config as it asks, and follows the new address', async () => {
    const { managers, store, started } = setup({ boards: [{ address: 'hash12345', perPage: 2 }], hosted: [{ address: 'hash12345' }, { address: 'name.bso' }] })
    managers.begin()
    await settle()
    started[0]!.options['onAddressChange']('hash12345', 'name.bso')
    expect(store.load().boards).toEqual([{ address: 'name.bso', perPage: 2 }])
    expect(managers.board('name.bso')).toMatchObject({ managed: true, state: 'running', config: { perPage: 2 } })
    expect(managers.boards().filter((board) => board.managed).map((board) => board.address)).toEqual(['name.bso'])
  })
})

describe('when the Worker stops', () => {
  it('stops every manager and every pause, and starts nothing after', async () => {
    const { managers, clock, started, attempts } = setup({ boards: [{ address: 'a.bso' }, { address: 'b.bso' }, { address: 'c.bso' }], startFails: (address) => (address === 'c.bso' ? new Error('no') : null) })
    managers.begin()
    await settle()
    expect(clock.waiting()).not.toEqual([])
    await managers.stop()
    expect(started.map((one) => one.stops)).toEqual([1, 1])
    expect(clock.waiting()).toEqual([])
    await clock.advance(600_000)
    expect(attempts.get('c.bso')).toBe(1)
    await expect(managers.enable('a.bso')).resolves.toBeDefined()
    await settle()
    expect(started).toHaveLength(2)
  })

  it('does not wait for ever on a manager that will not stop', async () => {
    const { managers, clock, started } = setup({ boards: [{ address: 'a.bso' }] })
    managers.begin()
    await settle()
    started[0]!.stopImpl = () => new Promise(() => {})
    let done = false
    const stopping = managers.stop().then(() => { done = true })
    await clock.advance(1_000)
    await clock.advance(5_000)
    await stopping
    expect(done).toBe(true)
  })
})
