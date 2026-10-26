// The page's side of the backend, against a fake fork, fake files and a fake lock manager: that it
// writes the install tree once, forks with the environment upstream's main sets, holds messages
// until the backend says it is ready, relays both ways, reports a failure the renderer can show,
// lets one page run the backend, and ends it with the page.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createBackend } from './backend-client.js'
import { busyFailure, deniedFailure, installDirFor } from './plan.js'

const ROOT = '/orivon/app'
const STAMP = 'abcdef0123456789'
const PACK = new TextEncoder().encode('DBMIGRATION')
const INSTALL = JSON.stringify({ stamp: STAMP, files: ['default-db.sqlite', 'migrations/1_a.sql'], sizes: [2, 9] })

class FakeChild extends EventEmitter {
  sent: unknown[] = []
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  send (message: unknown): void { this.sent.push(message) }
  kill (): void { this.killed = true }
}

function world (options: { served?: string, held?: boolean, existing?: Record<string, Uint8Array>, pack?: Uint8Array, deniedFiles?: boolean, writeDelay?: boolean, throwing?: boolean, forkThrows?: boolean } = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(options.existing ?? {}))
  const dirs: string[] = []
  const removed: string[] = []
  const forks: Array<{ path: string, args: string[], options: any, child: FakeChild }> = []
  const logs: string[] = []
  const requests: string[] = []
  const seen: unknown[] = []
  const reports: Array<{ phase: string, done: number, total: number }> = []
  const marks: string[] = []
  let lockHeld = options.held === true
  let denyFiles = options.deniedFiles === true
  let inFlight = 0
  let peak = 0
  let calls = 0
  const backend = createBackend({
    root: ROOT,
    stamp: STAMP,
    serverPath: '/server.mjs',
    fork: (path: string, args: string[], forkOptions: unknown) => {
      if (options.forkThrows === true) throw new Error('no worker')
      const child = new FakeChild()
      forks.push({ path, args, options: forkOptions, child })
      return child
    },
    files: {
      mkdir: async (path: string) => {
        if (denyFiles) throw Object.assign(new Error('orivon: connection denied by capability grant (fs is not granted to this origin)'), { code: 'denied' })
        dirs.push(path)
      },
      writeFile: async (path: string, bytes: Uint8Array) => {
        calls += 1
        inFlight += 1
        peak = Math.max(peak, inFlight)
        if (options.writeDelay === true) await new Promise((resolve) => setTimeout(resolve, 5))
        files.set(path, bytes)
        inFlight -= 1
      },
      readFile: async (path: string) => {
        const bytes = files.get(path)
        if (bytes === undefined) throw new Error('ENOENT')
        return bytes
      },
      readdir: async () => ['old-stamp', STAMP],
      rm: async (path: string) => { removed.push(path); files.delete(path) }
    },
    fetch: async (url: string) => {
      requests.push(url)
      const body = url === 'install/install.json' ? new TextEncoder().encode(options.served ?? INSTALL) : options.pack ?? PACK
      return { ok: true, status: 200, text: async () => new TextDecoder().decode(body), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }
    },
    locks: {
      request: (_name: string, _options: unknown, callback: (lock: object | null) => unknown) => {
        const grant = lockHeld ? null : {}
        lockHeld = true
        void callback(grant)
        return Promise.resolve()
      }
    },
    sleep: async () => {},
    newId: () => 'id1',
    log: (text: string) => { logs.push(text) },
    mark: (name: string) => { if (options.throwing === true) throw new TypeError('Illegal invocation'); marks.push(name) },
    progress: (report: { phase: string, done: number, total: number }) => { if (options.throwing === true) throw new TypeError('Illegal invocation'); reports.push(report) }
  })
  backend.listen('message', (message: unknown) => { seen.push(message) })
  const tick = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }
  return { backend, files, dirs, removed, forks, logs, requests, seen, reports, marks, tick, settle, grant: () => { denyFiles = false }, peak: () => peak, writes: () => calls }
}

describe('starting', () => {
  it('writes the install tree, makes the directories and forks the backend with upstream\'s environment', async () => {
    const w = world()
    w.backend.post({ id: 1, name: 'ping', args: [] })
    await w.settle()
    expect(w.files.has(`${ROOT}/${installDirFor(STAMP)}/default-db.sqlite`)).toBe(true)
    expect(w.files.has(`${ROOT}/${installDirFor(STAMP)}/migrations/1_a.sql`)).toBe(true)
    expect(w.dirs).toEqual(expect.arrayContaining([`${ROOT}/actual-data`, `${ROOT}/actual-documents`, `${ROOT}/actual-imports`]))
    expect(w.forks).toHaveLength(1)
    expect(w.forks[0]?.path).toBe('/server.mjs')
    expect(w.forks[0]?.options.env).toMatchObject({ ACTUAL_DATA_DIR: `${ROOT}/actual-data`, ACTUAL_DOCUMENT_DIR: `${ROOT}/actual-documents` })
    expect(w.forks[0]?.options.serialization).toBe('advanced')
  })

  it('writes the marker last, so a run cut short is written again', async () => {
    const w = world()
    w.backend.post({ id: 1 })
    await w.settle()
    const order = [...w.files.keys()]
    expect(order[order.length - 1]).toBe(`${ROOT}/${installDirFor(STAMP)}/install.json`)
  })

  it('does not write a tree that is already there, and removes the other builds\' trees', async () => {
    const stored = new TextEncoder().encode(INSTALL)
    const w = world({ existing: { [`${ROOT}/${installDirFor(STAMP)}/install.json`]: stored } })
    w.backend.post({ id: 1 })
    await w.settle()
    expect(w.requests).toEqual([])
    expect(w.writes()).toBe(0)
    expect(w.removed).toContain(`${ROOT}/actual-install/old-stamp`)
    expect(w.removed).not.toContain(`${ROOT}/actual-install/${STAMP}`)
  })

  it('clears the files an earlier session picked', async () => {
    const w = world()
    w.backend.post({ id: 1 })
    await w.settle()
    expect(w.removed).toContain(`${ROOT}/actual-imports`)
  })

  it('reports a mixed deployment and ends the backend it had started', async () => {
    const w = world({ served: JSON.stringify({ stamp: 'ffffffffffffffff', files: ['x'], sizes: [1] }) })
    w.backend.post({ id: 1 })
    await w.settle()
    expect(w.seen[0]).toMatchObject({ type: 'app-init-failure', BackendInitFailure: true })
    expect((w.seen[0] as { message: string }).message).toMatch(/two different builds/)
    expect((w.forks[0]?.child as FakeChild).killed).toBe(true)
  })

  it('starts one backend however many messages arrive before it is ready', async () => {
    const w = world()
    w.backend.post({ id: 1 })
    w.backend.post({ id: 2 })
    await w.settle()
    expect(w.forks).toHaveLength(1)
  })
})

describe('the first start', () => {
  it('writes each file from the pack with its own bytes', async () => {
    const w = world()
    w.backend.post({ id: 1 })
    await w.settle()
    expect(new TextDecoder().decode(w.files.get(`${ROOT}/${installDirFor(STAMP)}/default-db.sqlite`))).toBe('DB')
    expect(new TextDecoder().decode(w.files.get(`${ROOT}/${installDirFor(STAMP)}/migrations/1_a.sql`))).toBe('MIGRATION')
    expect(w.requests.sort()).toEqual(['install/install.json', 'install/pack.bin'])
  })

  it('forks the backend before the files are written and holds messages until both are done', async () => {
    const w = world({ writeDelay: true })
    w.backend.post({ id: 1 })
    await w.tick()
    expect(w.forks).toHaveLength(1)
    const child = w.forks[0]?.child as FakeChild
    child.emit('message', { type: 'orivon-ready' })
    expect(child.sent).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(child.sent).toEqual([{ id: 1 }])
  })

  it('starts when the page loads, with no message to answer', async () => {
    const w = world()
    w.backend.warm()
    await w.settle()
    expect(w.forks).toHaveLength(1)
    expect(w.seen).toEqual([])
    ;(w.forks[0]?.child as FakeChild).emit('message', { type: 'orivon-ready' })
    w.backend.post({ id: 1 })
    expect((w.forks[0]?.child as FakeChild).sent).toEqual([{ id: 1 }])
  })

  it('writes several files at once and stays within the lanes', async () => {
    const names = Array.from({ length: 30 }, (_, i) => `migrations/${String(i)}.sql`)
    const served = JSON.stringify({ stamp: STAMP, files: names, sizes: names.map(() => 1) })
    const w = world({ served, writeDelay: true, pack: new Uint8Array(30) })
    w.backend.post({ id: 1 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(w.writes()).toBe(31)
    expect(w.peak()).toBeGreaterThan(1)
    expect(w.peak()).toBeLessThanOrEqual(8)
  })

  it('reports progress: starting, each file written, then ready once the backend answers too', async () => {
    const w = world()
    w.backend.post({ id: 1 })
    await w.settle()
    expect(w.reports.map((r: { phase: string }) => r.phase)).toEqual(['starting', 'install', 'install', 'install'])
    expect(w.reports[3]).toEqual({ phase: 'install', done: 2, total: 2 })
    ;(w.forks[0]?.child as FakeChild).emit('message', { type: 'orivon-ready' })
    expect(w.reports[w.reports.length - 1]).toEqual({ phase: 'ready', done: 0, total: 0 })
    expect(w.marks).toEqual(['actual:fork', 'actual:installed', 'actual:ready'])
  })
})

describe('a status line or a mark that throws', () => {
  it('does not stop the start', async () => {
    const w = world({ throwing: true })
    w.backend.post({ id: 1 })
    await w.settle()
    expect(w.forks).toHaveLength(1)
    expect(w.seen).toEqual([])
    ;(w.forks[0]?.child as FakeChild).emit('message', { type: 'orivon-ready' })
    expect((w.forks[0]?.child as FakeChild).sent).toEqual([{ id: 1 }])
  })

  it('tells the renderer when the start itself throws, instead of leaving it waiting', async () => {
    const w = world({ forkThrows: true })
    w.backend.post({ id: 1 })
    await w.settle()
    expect(w.seen[0]).toMatchObject({ type: 'app-init-failure', message: 'no worker' })
  })
})

describe('a page without the files grant', () => {
  it('starts nothing, takes no lock and says why when the renderer speaks', async () => {
    const w = world({ deniedFiles: true })
    w.backend.warm()
    await w.settle()
    expect(w.forks).toHaveLength(0)
    expect(w.seen).toEqual([])
    w.backend.post({ id: 1 })
    await w.settle()
    expect(w.forks).toHaveLength(0)
    expect(w.seen).toEqual([deniedFailure()])
  })

  it('starts the backend on the next message once the grant has arrived, and does not stay failed', async () => {
    const w = world({ deniedFiles: true })
    w.backend.post({ id: 1 })
    await w.settle()
    expect(w.seen).toEqual([deniedFailure()])
    w.grant()
    w.backend.post({ id: 2 })
    await w.settle()
    expect(w.forks).toHaveLength(1)
    ;(w.forks[0]?.child as FakeChild).emit('message', { type: 'orivon-ready' })
    expect((w.forks[0]?.child as FakeChild).sent).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('does not fork when asked to restart without the grant', async () => {
    const w = world({ deniedFiles: true })
    w.backend.restart()
    await w.settle()
    expect(w.forks).toHaveLength(0)
  })
})

describe('the conversation', () => {
  async function ready () {
    const w = world()
    w.backend.post({ id: 1, name: 'first' })
    w.backend.post({ id: 2, name: 'second' })
    await w.settle()
    const child = w.forks[0]?.child as FakeChild
    return { w, child }
  }

  it('holds the renderer\'s messages until the backend says it is ready, then sends them in order', async () => {
    const { w, child } = await ready()
    expect(child.sent).toEqual([])
    child.emit('message', { type: 'orivon-ready' })
    expect(child.sent).toEqual([{ id: 1, name: 'first' }, { id: 2, name: 'second' }])
    w.backend.post({ id: 3, name: 'third' })
    expect(child.sent[2]).toEqual({ id: 3, name: 'third' })
  })

  it('relays replies and pushes to the renderer, and never the ready message', async () => {
    const { w, child } = await ready()
    child.emit('message', { type: 'orivon-ready' })
    child.emit('message', { type: 'reply', id: 1, result: 5 })
    child.emit('message', { type: 'push', name: 'x', args: {} })
    expect(w.seen).toEqual([{ type: 'reply', id: 1, result: 5 }, { type: 'push', name: 'x', args: {} }])
  })

  it('tells the renderer when the backend cannot start, and answers later messages with the same failure', async () => {
    const { w, child } = await ready()
    const failure = { type: 'app-init-failure', BackendInitFailure: true, message: 'no space' }
    child.emit('message', failure)
    expect(w.seen).toEqual([failure])
    w.backend.post({ id: 9 })
    expect(w.seen).toEqual([failure, failure])
    expect(child.sent).toEqual([])
  })

  it('reports an exit nobody asked for, once', async () => {
    const { w, child } = await ready()
    child.emit('message', { type: 'orivon-ready' })
    child.emit('close', 3)
    child.emit('close', 3)
    expect(w.seen).toHaveLength(1)
    expect(w.seen[0]).toMatchObject({ type: 'app-init-failure', message: 'The backend process exited unexpectedly (exit code 3)' })
  })

  it('reports an error event as a failure', async () => {
    const { w, child } = await ready()
    child.emit('error', new Error('could not fork'))
    expect(w.seen[0]).toMatchObject({ type: 'app-init-failure', message: 'could not fork' })
  })

  it('logs the backend\'s output', async () => {
    const { w, child } = await ready()
    child.stdout.emit('data', 'hello')
    child.stderr.emit('data', new TextEncoder().encode('oops'))
    expect(w.logs).toEqual(['hello', 'oops'])
  })

  it('ignores a listener for any name but message', async () => {
    const w = world()
    const heard: unknown[] = []
    w.backend.listen('other', (message: unknown) => { heard.push(message) })
    w.backend.post({ id: 1 })
    await w.settle()
    ;(w.forks[0]?.child as FakeChild).emit('message', { type: 'push' })
    expect(heard).toEqual([])
  })
})

describe('one backend at a time', () => {
  it('gives a second page the failure that says another tab is open, and forks nothing', async () => {
    const w = world({ held: true })
    w.backend.post({ id: 1 })
    await w.settle()
    expect(w.forks).toHaveLength(0)
    expect(w.seen).toEqual([busyFailure()])
    expect(w.files.size).toBe(0)
  })
})

describe('ending', () => {
  it('stops the backend with the page and does not report it as a failure', async () => {
    const w = world()
    w.backend.post({ id: 1 })
    await w.settle()
    const child = w.forks[0]?.child as FakeChild
    child.emit('message', { type: 'orivon-ready' })
    w.backend.stop()
    expect(child.killed).toBe(true)
    child.emit('close', null)
    expect(w.seen).toEqual([])
  })

  it('restarts with a fresh backend and sends what waited', async () => {
    const w = world()
    w.backend.post({ id: 1 })
    await w.settle()
    const first = w.forks[0]?.child as FakeChild
    first.emit('message', { type: 'orivon-ready' })
    w.backend.restart()
    w.backend.post({ id: 2 })
    await w.settle()
    expect(first.killed).toBe(true)
    expect(w.forks).toHaveLength(2)
    const second = w.forks[1]?.child as FakeChild
    second.emit('message', { type: 'orivon-ready' })
    expect(second.sent).toEqual([{ id: 2 }])
  })

  it('clears an earlier failure when it restarts', async () => {
    const w = world()
    w.backend.post({ id: 1 })
    await w.settle()
    ;(w.forks[0]?.child as FakeChild).emit('message', { type: 'app-init-failure', message: 'x' })
    w.backend.restart()
    await w.settle()
    expect(w.forks).toHaveLength(2)
  })
})

describe('importFile', () => {
  it('copies a picked file into a directory of its own and returns the path the backend reads it at', async () => {
    const w = world()
    const bytes = new Uint8Array([1, 2, 3])
    const handle = { name: 'my budget.zip', stat: async () => ({ size: 3 }), read: async (opts: { position: number, length: number }) => { expect(opts).toEqual({ position: 0, length: 3 }); return bytes } }
    const path = await w.backend.importFile(handle)
    expect(path).toBe(`${ROOT}/actual-imports/id1/my budget.zip`)
    expect(w.files.get(path)).toBe(bytes)
    expect(w.dirs).toContain(`${ROOT}/actual-imports/id1`)
  })

  it('copies an empty file without reading it', async () => {
    const w = world()
    const handle = { name: 'e.csv', stat: async () => ({ size: 0 }), read: async () => { throw new Error('must not read') } }
    const path = await w.backend.importFile(handle)
    expect(w.files.get(path)?.length).toBe(0)
  })
})
