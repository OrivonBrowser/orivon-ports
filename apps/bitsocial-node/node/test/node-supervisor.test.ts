// Keeping the node running: waiting for /health, giving up on a first start that never works, and starting again
// after an exit with a pause that grows while starts fail.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { lineReader, superviseNode } from '../worker/node-supervisor.js'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = 0
  kill () { this.killed += 1; queueMicrotask(() => { this.emit('exit', null, 'SIGTERM') }); return true }
}

/** A clock whose sleeps end at once and add up, so a run takes no time and shows what it waited for. */
function fakeClock () {
  let at = 0
  const slept: number[] = []
  return { slept, now: () => at, sleep: async (ms: number) => { slept.push(ms); at += ms; await new Promise((resolve) => setTimeout(resolve, 0)) } }
}

function setup (answers: (child: FakeChild, count: number) => boolean, clock: ReturnType<typeof fakeClock> = fakeClock(), beforeLaunch?: () => Promise<unknown>) {
  const children: FakeChild[] = []
  const states: string[] = []
  const supervisor = superviseNode({
    spawn: (() => { const child = new FakeChild(); children.push(child); return child }) as never,
    fetch: (async () => new Response('ok\n', { status: answers(children.at(-1)!, children.length) ? 200 : 503 })) as typeof fetch,
    program: '/bin/ipfs-node', args: ['--serve'], key: 'k', apiPort: 5351, clock,
    timing: { startWaitMs: 100, pollMs: 7, settleMs: 50, maxPauseMs: 400, killWaitMs: 3, firstStartAttempts: 3 },
    ...(beforeLaunch === undefined ? {} : { beforeLaunch }),
    onState: ({ state }) => { states.push(state) }
  })
  return { supervisor, children, states, clock }
}

describe('superviseNode, restart', () => {
  it('ends the running node and starts it again, with other arguments when given, and goes on running', async () => {
    const spawned: string[][] = []
    const children: FakeChild[] = []
    const supervisor = superviseNode({
      spawn: ((_program: string, args: string[]) => { const child = new FakeChild(); children.push(child); spawned.push(args); return child }) as never,
      fetch: (async () => new Response('ok\n')) as typeof fetch,
      program: '/bin/ipfs-node', args: ['--serve'], key: 'k', apiPort: 5351, clock: fakeClock(),
      timing: { startWaitMs: 100, pollMs: 7, settleMs: 50, maxPauseMs: 400, killWaitMs: 3, firstStartAttempts: 3 }
    })
    await supervisor.ready
    supervisor.restart(['--serve', '--relay', '/ip4/198.51.100.4/tcp/4001/p2p/12D3KooWRelay'])
    for (let i = 0; i < 200 && children.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(children[0]!.killed).toBe(1)
    expect(spawned).toEqual([['--serve'], ['--serve', '--relay', '/ip4/198.51.100.4/tcp/4001/p2p/12D3KooWRelay']])
    supervisor.restart()
    for (let i = 0; i < 200 && children.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(spawned[2]).toEqual(spawned[1])
    await supervisor.stop()
  })
})

describe('superviseNode', () => {
  it('is ready once the node answers /health, and says it is up', async () => {
    const { supervisor, children, states } = setup(() => true)
    await supervisor.ready
    expect(children).toHaveLength(1)
    expect(states).toEqual(['starting', 'up'])
    await supervisor.stop()
    expect(children[0]!.killed).toBe(1)
  })

  it('starts the node again after it ends, once the pause has passed, and is up again', async () => {
    const { supervisor, children, states, clock } = setup(() => true)
    await supervisor.ready
    children[0]!.emit('exit', 1, null)
    for (let i = 0; i < 200 && children.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(children).toHaveLength(2)
    expect(states.slice(0, 4)).toEqual(['starting', 'up', 'restarting', 'restarting'])
    expect(clock.slept).toContain(50)
    await supervisor.stop()
  })

  it('runs beforeLaunch ahead of every start, and starts anyway when it fails', async () => {
    const order: string[] = []
    let calls = 0
    const { supervisor, children } = setup((_child, count) => count >= 2, fakeClock(), async () => { calls += 1; order.push(`before ${String(calls)} after ${String(children.length)} children`); if (calls === 1) throw new Error('no') })
    await supervisor.ready
    expect(children).toHaveLength(2)
    expect(order).toEqual(['before 1 after 0 children', 'before 2 after 1 children'])
    await supervisor.stop()
  })

  it('lengthens the pause for each start that fails in a row, and caps it', async () => {
    const { supervisor, children, clock } = setup((_child, count) => count >= 3)
    await supervisor.ready
    expect(children).toHaveLength(3)
    // settleMs 50: after the first failure 100, after the second 200; the poll sleeps are 7, the kill wait 3
    expect(clock.slept.filter((ms) => ms >= 50)).toEqual([100, 200])
    await supervisor.stop()
  })

  it('rejects ready, and says failed, when the first starts all fail', async () => {
    const { supervisor, children, states } = setup(() => false)
    await expect(supervisor.ready).rejects.toThrow(/did not start/)
    expect(children).toHaveLength(3)
    expect(states.at(-1)).toBe('failed')
  })

  it('reports a node that ends before it answers with the last words it wrote', async () => {
    const children: FakeChild[] = []
    const supervisor = superviseNode({
      spawn: (() => { const child = new FakeChild(); children.push(child); queueMicrotask(() => { child.stderr.emit('data', 'Error: No file descriptors available (os error 33)\n'); child.emit('exit', 1, null) }); return child }) as never,
      fetch: (async () => { throw new TypeError('fetch failed') }) as typeof fetch,
      program: '/bin/ipfs-node', args: [], key: 'k', apiPort: 5351, clock: fakeClock(),
      timing: { startWaitMs: 1_000, pollMs: 100, settleMs: 10, maxPauseMs: 20, killWaitMs: 10, firstStartAttempts: 2 }
    })
    await expect(supervisor.ready).rejects.toThrow(/os error 33/)
  })

  it('stops at once during a pause, without waiting it out', async () => {
    // A pause (50 ms or more) that never ends by itself: only the stop can end it.
    const pausing = { slept: [] as number[], now: () => 0, sleep: (ms: number) => (ms >= 50 ? new Promise<void>(() => {}) : Promise.resolve()) }
    const { supervisor, children } = setup(() => true, pausing)
    await supervisor.ready
    children[0]!.emit('exit', 1, null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await supervisor.stop()
    expect(children).toHaveLength(1)
  })
})

describe('lineReader', () => {
  it('gives whole lines whatever the chunks, and the rest at the end', () => {
    const lines: string[] = []
    const reader = lineReader((line) => lines.push(line))
    reader.take('one\ntw')
    reader.take(new TextEncoder().encode('o\nthr'))
    reader.take('ee')
    reader.end()
    expect(lines).toEqual(['one', 'two', 'three'])
  })
})
