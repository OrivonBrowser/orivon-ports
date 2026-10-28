import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Child = EventEmitter & { stderr: EventEmitter, stdout: EventEmitter, kill: ReturnType<typeof vi.fn> }
const spawned: Array<{ program: string, args: string[], child: Child }> = []

vi.mock('child_process', () => ({
  spawn: (program: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
      kill: vi.fn(() => { child.emit('exit', null, 'SIGTERM') })
    }) as Child
    spawned.push({ program, args, child })
    return child
  }
}))

const KEY = 'ab'.repeat(32)

type Launcher = {
  start: (o: { key: string, port?: number | null, listen?: boolean }) => Promise<{ base: string, peer: string, port: number }>
  find: (o: { key: string, port?: number | null }) => Promise<{ base: string, peer: string, port: number } | null>
  stop: (port: number) => Promise<boolean>
}

/** Answers /id on the ports a node was spawned for, or on `already`. */
function nodesAt(already: number[] = []) {
  vi.stubGlobal('fetch', async (input: string) => {
    const match = /^http:\/\/127\.0\.0\.1:(\d+)\/id$/.exec(String(input))
    const port = match === null ? NaN : Number(match[1])
    const there = already.includes(port) || spawned.some((entry) => entry.args.includes(`127.0.0.1:${port}`) && entry.child.kill.mock.calls.length === 0)
    return there ? Response.json({ peer: '12D3KooWpage' }) : Promise.reject(new TypeError('fetch failed'))
  })
}

async function launcher(): Promise<Launcher> {
  await import('../page/src/node/launch.js')
  return (globalThis as unknown as { decentrawikiNode: Launcher }).decentrawikiNode
}

const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('starting the editor\'s IPFS node', () => {
  beforeEach(() => { spawned.length = 0 })
  afterEach(async () => {
    const { stop } = await launcher()
    for (let port = 5180; port <= 5189; port++) await stop(port)
    vi.unstubAllGlobals()
  })

  it('starts a node that hosts with the DHT, a port to accept connections on and a place on Orivon\'s relay, and never offline', async () => {
    nodesAt()
    const node = await (await launcher()).start({ key: KEY, listen: true })
    expect(node).toMatchObject({ base: 'http://127.0.0.1:5180', peer: '12D3KooWpage', port: 5180 })
    expect(spawned).toHaveLength(1)
    const { program, args } = spawned[0]!
    expect(program).toBe('/bin/ipfs-node')
    expect(value(args, '--routing-mode')).toBe('auto')
    expect(args).not.toContain('offline')
    expect(value(args, '--p2p-port')).toBe('4811')
    expect(args.filter((arg) => arg === '--relay')).toHaveLength(1)
    expect(value(args, '--relay')).toMatch(/^\/ip4\/\d+\.\d+\.\d+\.\d+\/tcp\/\d+\/p2p\/12D3KooW[1-9A-HJ-NP-Za-km-z]+$/)
    expect(args).toEqual(expect.arrayContaining(['--online', '--serve', '--api-key', KEY, '--addr', '127.0.0.1:5180']))
  })

  it('gives each API port its own port for IPFS connections, 4811 to 4820, all inside the manifest\'s grant', async () => {
    nodesAt()
    const { start } = await launcher()
    await start({ key: KEY, listen: true, port: 5189 })
    await start({ key: KEY, listen: true, port: 5183 })
    const grant = JSON.parse(readFileSync(new URL('../orivon.json', import.meta.url), 'utf8')).capabilities.net.tcp.listen.network as string[]
    expect(grant).toEqual(['4811-4820'])
    expect(spawned.map((entry) => [value(entry.args, '--addr'), value(entry.args, '--p2p-port')])).toEqual([['127.0.0.1:5189', '4820'], ['127.0.0.1:5183', '4814']])
  })

  it('starts a node that only publishes without listening, looking anything up or holding a relay place', async () => {
    nodesAt()
    await (await launcher()).start({ key: KEY })
    const { args } = spawned[0]!
    expect(value(args, '--routing-mode')).toBe('offline')
    expect(args).not.toContain('--p2p-port')
    expect(args).not.toContain('--relay')
  })

  it('joins a node already running and starts nothing', async () => {
    nodesAt([5182])
    const node = await (await launcher()).start({ key: KEY, port: 5182, listen: true })
    expect(node.port).toBe(5182)
    expect(spawned).toHaveLength(0)
  })

  it('finds a node already running on the port the editor last used, and starts none when it finds none', async () => {
    nodesAt([5183])
    const { find } = await launcher()
    expect(await find({ key: KEY, port: 5183 })).toEqual({ base: 'http://127.0.0.1:5183', peer: '12D3KooWpage', port: 5183 })
    expect(await find({ key: KEY, port: 5184 })).toBeNull()
    expect(await find({ key: KEY })).toBeNull()
    expect(await find({ key: KEY, port: 4000 })).toBeNull()
    expect(spawned).toHaveLength(0)
  })

  it('ends only a node this page started, and waits until it is gone', async () => {
    nodesAt([5185])
    const { start, stop } = await launcher()
    await start({ key: KEY, listen: true, port: 5181 })
    await start({ key: KEY, listen: true, port: 5185 })
    expect(spawned).toHaveLength(1)
    expect(await stop(5185)).toBe(false)
    expect(await stop(5183)).toBe(false)
    expect(spawned[0]!.child.kill).not.toHaveBeenCalled()
    expect(await stop(5181)).toBe(true)
    expect(spawned[0]!.child.kill).toHaveBeenCalledTimes(1)
    expect(await stop(5181)).toBe(false)
  })

  it('forgets a node that ended by itself, so that stop does not claim it', async () => {
    nodesAt()
    const { start, stop } = await launcher()
    await start({ key: KEY, listen: true, port: 5186 })
    spawned[0]!.child.emit('exit', 1, null)
    expect(await stop(5186)).toBe(false)
    expect(spawned[0]!.child.kill).not.toHaveBeenCalled()
  })
})
