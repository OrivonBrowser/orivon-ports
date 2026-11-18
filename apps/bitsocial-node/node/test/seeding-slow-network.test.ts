// Seeding when the network is slow: a community whose parts nobody answers must not hold up the others, turning seeding off must not
// wait for a part that is being looked for, and adding a community while a pass runs must not wait for the pass to end.
import { beforeAll, describe, expect, it } from 'vitest'
import { canonical } from '../kubo/ipfs.js'
import { cids, fillCids, MB, passEnds, record, seeder } from './support/seeding-fakes.js'

beforeAll(async () => { await fillCids() })

/** Lets the seeder's promises run: a turn of the queue cannot be awaited while a pin waits. */
const ticks = async (count = 20) => { for (let index = 0; index < count; index++) await new Promise<void>((resolve) => { setImmediate(resolve) }) }

describe('a community that waits on a part nobody answers', () => {
  it('does not keep the others of the same pass from being held', async () => {
    const { made, net, node } = seeder()
    net.records.set('slow.bso', record(0)); net.records.set('fast.bso', record(1)); net.records.set('also.bso', record(2))
    node.hang.add(cids[1]!)
    made.follow(['slow.bso', 'fast.bso', 'also.bso']); made.begin(); made.enable()
    await ticks()
    expect(made.state().communities.find((one) => one.address === 'fast.bso')).toMatchObject({ status: 'holding', pins: 3 })
    expect(made.state().communities.find((one) => one.address === 'also.bso')).toMatchObject({ status: 'holding', pins: 3 })
    expect(made.state().working).toBe(true)
  })
})

describe('turning seeding off while a pass waits', () => {
  it('stops the wait, releases what was held at once, and leaves nothing of the cancelled pass to retry', async () => {
    const { made, net, node, time, warnings } = seeder()
    net.records.set('slow.bso', record(0)); net.records.set('fast.bso', record(1))
    node.hang.add(cids[1]!)
    made.follow(['slow.bso', 'fast.bso']); made.begin(); made.enable()
    await ticks()
    expect(node.pinned.size).toBeGreaterThan(0)
    made.disable()
    await made.settled()
    expect(node.pinned.size).toBe(0)
    expect(node.provided.size).toBe(0)
    expect(made.state()).toMatchObject({ enabled: false, usedBytes: 0, working: false })
    expect(made.state().communities.every((one) => one.error === null)).toBe(true)
    node.hang.clear()
    time.advance(3_600_000)
    await made.settled()
    expect(node.pinned.size).toBe(0)
    expect(warnings.filter((line) => /cancelled/.test(line))).toEqual([])
  })

  it('records what the cancelled pass had already pinned, so that it is released and none of it is left behind', async () => {
    const { made, net, node } = seeder()
    net.records.set('one.bso', record(0))
    node.hang.add(cids[2]!)
    made.follow(['one.bso']); made.begin(); made.enable()
    await ticks()
    expect(node.pinned.has(canonical(cids[0]!))).toBe(true)
    made.disable()
    await made.settled()
    expect(node.pinned.size).toBe(0)
    expect(node.order.filter((line) => line.startsWith('unpin'))).toContain(`unpin ${cids[0]!}`)
  })
})

describe('turning seeding off while the node does not answer a call of the pass', () => {
  it('does not wait for the node to take back a pin that was cut short', async () => {
    const { made, net, node } = seeder()
    net.records.set('one.bso', record(0))
    node.hang.add(cids[2]!)
    node.hangUnpin.add(cids[2]!)
    made.follow(['one.bso']); made.begin(); made.enable()
    await ticks()
    expect(node.pinned.size).toBeGreaterThan(0)
    made.disable()
    await made.settled()
    expect(node.pinned.size).toBe(0)
    expect(made.state()).toMatchObject({ enabled: false, usedBytes: 0, working: false })
    expect(node.order).toContain(`unpin ${cids[2]!}`)
  })

  it('ends the read of the node\'s pins that waits, and releases what the pass had pinned', async () => {
    const { made, net, node } = seeder()
    net.records.set('one.bso', record(0))
    node.hangPinsFrom = 4
    made.follow(['one.bso']); made.begin(); made.enable()
    await ticks()
    expect(node.pinned.size).toBeGreaterThan(0)
    made.disable()
    await made.settled()
    expect(node.pinned.size).toBe(0)
    expect(made.state()).toMatchObject({ enabled: false, usedBytes: 0, working: false })
  })
})

describe('turning seeding off while the node does not answer an announce', () => {
  it('ends the announce that is waiting, releases what was held and has the node drop the blocks', async () => {
    const { made, net, node } = seeder()
    net.records.set('one.bso', record(0))
    node.hangProvide.add(cids[1]!)
    made.follow(['one.bso']); made.begin(); made.enable()
    await ticks()
    expect(made.state().working).toBe(true)
    expect(node.pinned.size).toBeGreaterThan(0)
    const gcs = node.gcs
    made.disable()
    await made.settled()
    expect(node.pinned.size).toBe(0)
    expect(node.provided.size).toBe(0)
    expect(node.gcs).toBe(gcs + 1)
    expect(made.state()).toMatchObject({ enabled: false, usedBytes: 0, working: false })
  })

  it('goes on to the rest of the community when the node does not answer an announce within its time, and holds it', async () => {
    const { made, net, node } = seeder({ timing: { provideMs: 20 } })
    net.records.set('one.bso', record(0))
    node.hangProvide.add(cids[1]!)
    made.follow(['one.bso']); made.begin(); made.enable()
    await new Promise<void>((resolve) => { setTimeout(resolve, 150) })
    await ticks()
    expect(made.state().communities[0]).toMatchObject({ status: 'holding', pins: 3 })
    expect(node.provided.has(cids[2]!)).toBe(true)
  })
})

describe('communities that have no record', () => {
  it('are looked at three at a time, each let go when its wait is over, so a long list does not keep a loop running for each', async () => {
    const { made, net, time } = seeder()
    made.follow(Array.from({ length: 8 }, (_, index) => `dead${String(index)}.bso`)); made.begin(); made.enable()
    await ticks()
    expect(net.active).toBe(3)
    await passEnds(made, time)
    expect(net.peak).toBe(3)
    expect(net.active).toBe(0)
    expect(made.state().communities.every((one) => one.status === 'waiting')).toBe(true)
  })
})

describe('a community that is slow to open', () => {
  it('does not hold up the others, gives up on it after the wait, and says it is starting', async () => {
    const { made, net, node, time } = seeder()
    net.records.set('slow.bso', record(0)); net.records.set('fast.bso', record(1))
    net.slowOpen.add('slow.bso')
    made.follow(['slow.bso', 'fast.bso']); made.begin(); made.enable()
    await ticks()
    expect(made.state().communities.find((one) => one.address === 'fast.bso')).toMatchObject({ status: 'holding', pins: 3 })
    await passEnds(made, time)
    expect(made.state().working).toBe(false)
    expect(made.state().lastRun).toMatchObject({ communities: 2, holding: 1 })
    expect(made.state().communities.find((one) => one.address === 'slow.bso')).toMatchObject({ status: 'starting', pins: 0 })
    expect(node.pinned.size).toBe(3)
  })

  it('does not hold up turning seeding off', async () => {
    const { made, net, node } = seeder()
    net.records.set('slow.bso', record(0)); net.records.set('fast.bso', record(1))
    net.slowOpen.add('slow.bso')
    made.follow(['slow.bso', 'fast.bso']); made.begin(); made.enable()
    await ticks()
    expect(node.pinned.size).toBe(3)
    made.disable()
    await made.settled()
    expect(node.pinned.size).toBe(0)
    expect(made.state()).toMatchObject({ enabled: false, usedBytes: 0 })
  })
})

describe('turning seeding off while communities are slow to stop', () => {
  it('releases what was held without waiting for a community to finish stopping', async () => {
    const { made, net, node } = seeder()
    net.records.set('a.bso', record(0)); net.records.set('b.bso', record(1))
    made.follow(['a.bso', 'b.bso']); made.begin(); made.enable()
    await made.settled()
    expect(node.pinned.size).toBe(6)
    net.slowStop = true
    made.disable()
    await made.settled()
    expect(node.pinned.size).toBe(0)
    expect([...new Set(net.stopped)].sort()).toEqual(['a.bso', 'b.bso'])
  })
})

describe('adding a community while a pass waits', () => {
  it('holds the new one without waiting for the part the pass is looking for', async () => {
    const { made, net, node } = seeder()
    net.records.set('slow.bso', record(0)); net.records.set('new.bso', record(1))
    node.hang.add(cids[1]!)
    made.follow(['slow.bso']); made.begin(); made.enable()
    await ticks()
    expect(made.state().working).toBe(true)
    made.add('new.bso')
    await ticks()
    expect(made.state().communities.find((one) => one.address === 'new.bso')).toMatchObject({ status: 'holding', pins: 3 })
    expect(node.pinned.has(canonical(cids[3]!))).toBe(true)
  })
})

describe('communities looked at together', () => {
  it('never hold more than the limit, whichever finishes first, and leave the rest named as over it', async () => {
    const sizes = { [cids[0]!]: MB, [cids[1]!]: MB / 2, [cids[2]!]: MB / 2, [cids[3]!]: MB, [cids[4]!]: MB / 2, [cids[5]!]: MB / 2 }
    const { made, net } = seeder({ sizes })
    net.records.set('a.bso', record(0)); net.records.set('b.bso', record(1))
    made.setLimit(2 * MB)
    made.follow(['a.bso', 'b.bso']); made.begin(); made.enable()
    await made.settled()
    expect(made.state().usedBytes).toBeLessThanOrEqual(2 * MB)
    expect(made.state().communities.map((one) => one.status).sort()).toContain('over-limit')
  })
})

describe('the last check', () => {
  it('counts a community that was held by a look of its own as held, not as it was when the pass ended', async () => {
    const { made, net, time } = seeder()
    made.add('late.bso'); made.begin(); made.enable()
    await passEnds(made, time)
    expect(made.state().lastRun).toMatchObject({ communities: 1, holding: 0 })
    expect(made.state().communities[0]).toMatchObject({ status: 'waiting' })
    net.records.set('late.bso', record(0))
    time.advance(121_000)
    await made.settled()
    expect(made.state().communities[0]).toMatchObject({ status: 'holding' })
    expect(made.state().lastRun).toMatchObject({ communities: 1, holding: 1 })
  })
})
