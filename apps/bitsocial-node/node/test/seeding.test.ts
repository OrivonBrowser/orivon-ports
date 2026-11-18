// The seeding scheduler against a stand-in node and stand-in communities: off until turned on, the space limit, a community added
// or taken out, what a changed record replaces, and the gc of exactly what seeding kept when it is turned off.
import { beforeAll, describe, expect, it } from 'vitest'
import { canonical } from '../kubo/ipfs.js'
import { pinsOf } from '../worker/seeding-pins.js'
import { blank, normalise, seedingStore } from '../worker/seeding-store.js'
import * as realFs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cids, clockOf, fakeNetwork, fakeNode, fillCids, MB, memoryStore, passEnds, record, seeder } from './support/seeding-fakes.js'

beforeAll(async () => { await fillCids() })

describe('what a record asks a seeder to keep', () => {
  it('is the record, each first page, the page after it and the post updates, and the topic', () => {
    const got = pinsOf({ updateCid: cids[0]!, posts: { pageCids: { hot: cids[1]! }, pages: { hot: { nextCid: cids[2]! } } }, postUpdates: { 86400: cids[3]! }, pubsubTopic: 'topic' })
    expect(got.pins.map((pin) => pin.name)).toEqual(['record', 'page hot', 'next page hot', 'post updates 86400'])
    expect(got.topic).toBe('topic')
  })

  it('takes one pin for a CID named twice, and leaves out text that is no CID', () => {
    const got = pinsOf({ updateCid: cids[0]!, posts: { pageCids: { hot: cids[0]!, new: 'not a cid' } } })
    expect(got.pins).toHaveLength(1)
  })

  it('stops at a number of pins no honest record reaches, and takes a topic only when it is a short text', () => {
    const postUpdates = Object.fromEntries(cids.map((cid, index) => [String(index), cid]))
    expect(pinsOf({ postUpdates: { ...postUpdates, ...Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`x${String(index)}`, cids[0]!])) } }).pins.length).toBeLessThanOrEqual(64)
    expect(pinsOf({ pubsubTopic: 'x'.repeat(300) }).topic).toBeNull()
  })
})

describe('seeding, off by default', () => {
  it('opens nothing and holds nothing until it is turned on, even with communities listed', async () => {
    const { made, net, node } = seeder()
    made.add('one.bso')
    made.begin()
    await made.settled()
    expect(made.state()).toMatchObject({ enabled: false, usedBytes: 0 })
    expect(net.opened).toEqual([])
    expect(node.pinned.size).toBe(0)
  })

  it('pins the record and the pages of a followed community, announces them, joins its topic and counts the bytes', async () => {
    const { made, net, node } = seeder({ sizes: { [cids[0]!]: 1_000, [cids[1]!]: 2_000, [cids[2]!]: 3_000 } })
    net.records.set('one.bso', record(0))
    made.follow(['one.bso'])
    made.begin()
    made.enable()
    await made.settled()
    expect(node.pinned.size).toBe(3)
    expect([...node.provided].sort()).toEqual([cids[0]!, cids[1]!, cids[2]!].sort())
    expect(node.joined).toEqual(['topic-0'])
    expect(made.state().communities[0]).toMatchObject({ address: 'one.bso', origin: 'followed', status: 'holding', bytes: 6_000, pins: 3, topic: true })
    expect(made.state().usedBytes).toBe(6_000)
  })

  it('says it is waiting for a community whose record has not come yet, and holds it once the record arrives', async () => {
    const { made, net, node, time } = seeder()
    made.add('late.bso')
    made.begin()
    made.enable()
    await passEnds(made, time)
    expect(made.state().communities[0]?.status).toBe('waiting')
    net.records.set('late.bso', record(1))
    time.advance(121_000)
    await made.settled()
    expect(made.state().communities[0]?.status).toBe('holding')
    expect(node.pinned.size).toBe(3)
  })
})

describe('the space limit', () => {
  const limit = 2 * MB
  const bigSizes = () => ({ [cids[0]!]: MB, [cids[1]!]: MB / 2, [cids[2]!]: MB / 2, [cids[3]!]: MB, [cids[4]!]: MB / 2, [cids[5]!]: MB / 2 })

  it('held one at a time, holds communities in list order while they fit, and leaves out the one that does not, with nothing of it kept', async () => {
    const { made, net, node } = seeder({ sizes: bigSizes(), timing: { lanes: 1 } })
    net.records.set('a.bso', record(0)); net.records.set('b.bso', record(1))
    made.setLimit(limit)
    made.follow(['a.bso', 'b.bso'])
    made.begin()
    made.enable()
    await made.settled()
    const rows = made.state().communities
    expect(rows[0]).toMatchObject({ address: 'a.bso', status: 'holding', bytes: 2 * MB })
    expect(rows[1]).toMatchObject({ address: 'b.bso', status: 'over-limit', bytes: 0 })
    expect(made.state().usedBytes).toBe(2 * MB)
    expect([...node.pinned.keys()].map((cid) => cid)).not.toContain(canonical(cids[3]!))
  })

  it('looks at the communities the person added before the ones the app follows, whatever the list order', async () => {
    const { made, net } = seeder({ timing: { lanes: 1 } })
    for (const [index, address] of ['f1.bso', 'f2.bso', 'mine.bso'].entries()) net.records.set(address, record(index))
    made.follow(['f1.bso', 'f2.bso'])
    made.add('mine.bso')
    made.begin()
    made.enable()
    await made.settled()
    expect(net.opened.slice(0, 3)).toEqual(['mine.bso', 'f1.bso', 'f2.bso'])
  })

  it('refuses an update that would pass the limit and keeps what was held, and does not ask again until something changes', async () => {
    const { made, net, node, time } = seeder({ sizes: { ...bigSizes(), [cids[8]!]: 3 * MB } })
    net.records.set('a.bso', record(0))
    made.setLimit(limit)
    made.add('a.bso')
    made.begin()
    made.enable()
    await made.settled()
    net.records.set('a.bso', { ...record(0, 2), posts: { pageCids: { hot: cids[8]!, new: cids[2]! } } })
    time.advance(600_000)
    await made.settled()
    expect(made.state().communities[0]).toMatchObject({ status: 'over-limit', bytes: 2 * MB })
    expect(node.pinned.has(canonical(cids[8]!))).toBe(false)
    expect(node.pinned.has(canonical(cids[1]!))).toBe(true)
    const pinsBefore = node.order.length
    time.advance(600_000)
    await made.settled()
    expect(node.order.length).toBe(pinsBefore)
    made.setLimit(8 * MB)
    await made.settled()
    expect(made.state().communities[0]?.status).toBe('holding')
    expect(node.pinned.has(canonical(cids[8]!))).toBe(true)
  })

  it('lowering the limit below what is held lets go of the last communities on the list, and the node drops their blocks', async () => {
    const { made, net, node } = seeder({ sizes: bigSizes() })
    net.records.set('a.bso', record(0)); net.records.set('b.bso', record(1))
    made.follow(['a.bso', 'b.bso'])
    made.begin()
    made.enable()
    await made.settled()
    expect(made.state().usedBytes).toBe(4 * MB)
    const gcs = node.gcs
    made.setLimit(2 * MB)
    await made.settled()
    expect(made.state().usedBytes).toBe(2 * MB)
    expect(made.state().communities.map((row) => row.status)).toEqual(['holding', 'over-limit'])
    expect(node.gcs).toBe(gcs + 1)
  })

  it('refuses a limit that is not a whole number of bytes between 1 MB and 1 TB', () => {
    const { made } = seeder()
    for (const bad of [0, 1000, -5, 1.5, '2GB', null, 1024 ** 4 + 1]) expect(() => made.setLimit(bad)).toThrow(/space limit/)
  })
})

describe('the list a person changes', () => {
  it('starts following a community that is added, and lets go of one that is removed: unpin, unprovide, leave the topic, then gc', async () => {
    const { made, net, node } = seeder()
    net.records.set('a.bso', record(0)); net.records.set('b.bso', record(1))
    made.add('a.bso'); made.begin(); made.enable()
    await made.settled()
    made.add('b.bso')
    await made.settled()
    expect(node.pinned.size).toBe(6)
    node.order.length = 0
    const gcs = node.gcs
    made.remove('a.bso')
    await made.settled()
    expect(node.pinned.size).toBe(3)
    expect(net.stopped).toContain('a.bso')
    expect(node.provided.size).toBe(3)
    expect(node.order.filter((line) => line.startsWith('unpin'))).toHaveLength(3)
    expect(node.gcs).toBe(gcs + 1)
    expect(made.state().communities.map((row) => row.address)).toEqual(['b.bso'])
  })

  it('keeps a community that was followed and then removed out of the list when the app sends its subscriptions again; adding it brings it back', async () => {
    const { made } = seeder()
    made.follow(['a.bso', 'b.bso'])
    made.remove('a.bso')
    made.follow(['a.bso', 'b.bso'])
    expect(made.state().communities.map((row) => row.address)).toEqual(['b.bso'])
    expect(made.state().ignored).toEqual(['a.bso'])
    made.add('a.bso')
    expect(made.state().communities.map((row) => row.address).sort()).toEqual(['a.bso', 'b.bso'])
    expect(made.state().ignored).toEqual([])
  })

  it('replaces the followed communities with what the app sends and keeps the ones a person added', () => {
    const { made } = seeder()
    made.add('mine.bso')
    made.follow(['a.bso', 'b.bso'])
    made.follow(['b.bso', 'c.bso'])
    expect(made.state().communities.map((row) => [row.address, row.origin])).toEqual([['b.bso', 'followed'], ['c.bso', 'followed'], ['mine.bso', 'added']])
  })

  it('refuses an address that cannot be a community, and a list that is not a list', () => {
    const { made } = seeder()
    for (const bad of ['', '../x', 'a/b', 7, null]) expect(() => made.add(bad)).toThrow(/address/)
    expect(() => made.follow('a.bso')).toThrow(/list/)
    expect(() => made.follow(['ok.bso', '..'])).toThrow(/address/)
  })

  it('takes a change of the list before the node is ready and acts on it at begin', async () => {
    const { made, net } = seeder()
    made.add('a.bso'); made.enable()
    await made.settled()
    expect(net.opened).toEqual([])
    net.records.set('a.bso', record(0))
    made.begin()
    await made.settled()
    expect(made.state().communities[0]?.status).toBe('holding')
  })
})

describe('what a changed record replaces', () => {
  it('pins the new page and lets go of the old one, with a gc, once the new one is held', async () => {
    const { made, net, node, time } = seeder()
    net.records.set('a.bso', record(0))
    made.add('a.bso'); made.begin(); made.enable()
    await made.settled()
    net.records.set('a.bso', { ...record(0, 2), posts: { pageCids: { hot: cids[10]!, new: cids[2]! } } })
    node.order.length = 0
    const gcs = node.gcs
    time.advance(600_000)
    await made.settled()
    expect(node.order[0]).toBe(`pin ${cids[10]!}`)
    expect(node.pinned.has(canonical(cids[1]!))).toBe(false)
    expect(node.pinned.has(canonical(cids[10]!))).toBe(true)
    expect(node.gcs).toBe(gcs + 1)
    expect(made.state().communities[0]).toMatchObject({ status: 'holding', pins: 3 })
  })

  it('keeps the old pages and says why when a new page cannot be fetched, then tries again after a pause that doubles', async () => {
    const { made, net, node, time, warnings } = seeder()
    net.records.set('a.bso', record(0))
    made.add('a.bso'); made.begin(); made.enable()
    await made.settled()
    net.records.set('a.bso', { ...record(0, 2), posts: { pageCids: { hot: cids[10]!, new: cids[2]! } } })
    node.failPin = cids[10]!
    time.advance(600_000)
    await made.settled()
    expect(made.state().communities[0]).toMatchObject({ status: 'error', error: expect.stringContaining('cannot fetch') as string })
    expect(node.pinned.has(canonical(cids[1]!))).toBe(true)
    expect(warnings.some((line) => line.includes('cannot fetch'))).toBe(true)
    node.failPin = null
    time.advance(59_000)
    await made.settled()
    expect(made.state().communities[0]?.status).toBe('error')
    time.advance(2_000)
    await made.settled()
    expect(made.state().communities[0]).toMatchObject({ status: 'holding', error: null })
  })
})

describe('a part nobody has', () => {
  it('does not stop the rest of a community being held, and is asked for again after a pause', async () => {
    const { made, net, node, time } = seeder()
    net.records.set('a.bso', { ...record(0), postUpdates: { 86400: cids[20]! } })
    node.unfindable = cids[20]!
    made.add('a.bso'); made.begin(); made.enable()
    await made.settled()
    expect(made.state().communities[0]).toMatchObject({ status: 'holding', pins: 3, error: 'Not found yet: post updates 86400' })
    expect(node.pinned.has(canonical(cids[0]!))).toBe(true)
    expect(node.pinned.has(canonical(cids[20]!))).toBe(false)
    node.unfindable = null
    time.advance(61_000)
    await made.settled()
    expect(made.state().communities[0]).toMatchObject({ status: 'holding', pins: 4, error: null })
    expect(node.pinned.has(canonical(cids[20]!))).toBe(true)
  })

  it('treats a part that no provider answered in time the same way, and shows a community that is not fully held as not updated yet', async () => {
    const { made, net, node } = seeder()
    net.records.set('a.bso', { ...record(0), postUpdates: { 86400: cids[20]! } })
    node.timesOut = cids[20]!
    made.add('a.bso'); made.begin(); made.enable()
    await made.settled()
    expect(made.state().communities[0]).toMatchObject({ status: 'holding', pins: 3, error: 'Not found yet: post updates 86400' })
    net.records.set('b.bso', record(1))
    node.failPin = cids[3]!
    made.add('b.bso')
    await made.settled()
    expect(made.state().communities[1]).toMatchObject({ status: 'error', updatedAt: null })
  })

  it('still fails a community whose record cannot be found, as that is what a reader needs first', async () => {
    const { made, net, node } = seeder()
    net.records.set('a.bso', record(0))
    node.unfindable = cids[0]!
    made.add('a.bso'); made.begin(); made.enable()
    await made.settled()
    expect(made.state().communities[0]).toMatchObject({ status: 'error' })
  })
})

describe('turning seeding off', () => {
  it('unpins and unprovides everything seeding made, has the node drop the blocks, and keeps the list', async () => {
    const { made, net, node } = seeder()
    net.records.set('a.bso', record(0)); net.records.set('b.bso', record(1))
    made.follow(['a.bso', 'b.bso']); made.begin(); made.enable()
    await made.settled()
    expect(node.pinned.size).toBe(6)
    const gcs = node.gcs
    made.disable()
    await made.settled()
    expect(node.pinned.size).toBe(0)
    expect(node.provided.size).toBe(0)
    expect(node.gcs).toBe(gcs + 1)
    expect([...new Set(net.stopped)].sort()).toEqual(['a.bso', 'b.bso'])
    expect(made.state()).toMatchObject({ enabled: false, usedBytes: 0 })
    expect(made.state().communities).toHaveLength(2)
  })

  it('never unpins what it did not pin: a root the node already held for another reason stays pinned and uncounted', async () => {
    const { made, net, node } = seeder()
    node.pinned.set(canonical(cids[1]!), 500)
    net.records.set('a.bso', record(0))
    made.add('a.bso'); made.begin(); made.enable()
    await made.settled()
    expect(made.state().usedBytes).toBe(200)
    made.disable()
    await made.settled()
    expect([...node.pinned.keys()]).toEqual([canonical(cids[1]!)])
  })

  it('keeps a pin that two followed communities share until the last one lets go', async () => {
    const { made, net, node } = seeder()
    net.records.set('a.bso', record(0))
    net.records.set('b.bso', { ...record(1), updateCid: cids[0]! })
    made.follow(['a.bso', 'b.bso']); made.begin(); made.enable()
    await made.settled()
    made.remove('a.bso')
    await made.settled()
    expect(node.pinned.has(canonical(cids[0]!))).toBe(true)
    made.remove('b.bso')
    await made.settled()
    expect(node.pinned.size).toBe(0)
  })

  it('takes a hosted community out of its work and never unpins anything of it', async () => {
    const { made, net, node, setHosted } = seeder({ hosted: [{ address: 'mine.bso' }] })
    net.records.set('mine.bso', record(0)); net.records.set('theirs.bso', record(1))
    node.pinned.set(canonical(cids[1]!), 10)
    made.follow(['mine.bso', 'theirs.bso']); made.begin(); made.enable()
    await made.settled()
    expect(net.opened).not.toContain('mine.bso')
    expect(net.opened).toContain('theirs.bso')
    expect(made.state().communities.map((row) => row.status)).toEqual(['hosted', 'holding'])
    setHosted([{ address: 'mine.bso' }, { address: 'theirs.bso' }])
    made.run()
    await made.settled()
    expect(made.state().communities.map((row) => row.status)).toEqual(['hosted', 'hosted'])
    expect(node.pinned.has(canonical(cids[1]!))).toBe(true)
    expect(node.pinned.has(canonical(cids[4]!))).toBe(false)
  })
})

describe('what is kept across a restart', () => {
  it('shows what was held before the node asks anything, resumes on begin, and turns off cleanly with what the first run pinned', async () => {
    const store = memoryStore()
    const first = seeder({ store })
    first.net.records.set('a.bso', record(0))
    first.made.add('a.bso'); first.made.begin(); first.made.enable()
    await first.made.settled()
    await first.made.stop()
    const second = seeder({ store, node: first.node })
    expect(second.made.state()).toMatchObject({ enabled: true, usedBytes: 300 })
    second.net.records.set('a.bso', record(0))
    second.made.begin()
    await second.made.settled()
    expect(second.made.state().communities[0]?.status).toBe('holding')
    expect(first.node.pinned.size).toBe(3)
    second.made.disable()
    await second.made.settled()
    expect(first.node.pinned.size).toBe(0)
  })

  it('writes its state as a file and reads it back, and reads a damaged one as a seeding that is off', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bitsocial-seeding-'))
    try {
      const store = seedingStore({ directory: dir, fs: realFs as never })
      expect(store.read()).toMatchObject({ enabled: false, communities: [] })
      store.write({ ...blank(), enabled: true, communities: [{ address: 'a.bso', origin: 'added', addedAt: 5 }] })
      expect(store.read()).toMatchObject({ enabled: true, communities: [{ address: 'a.bso', origin: 'added' }] })
      realFs.writeFileSync(join(dir, 'state.json'), '{ not json')
      expect(store.read()).toMatchObject({ enabled: false })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('reads a file for its shape only: a limit out of bounds and an address that is a path are left out', () => {
    const got = normalise({ enabled: true, limitBytes: 5, communities: [{ address: '../x' }, { address: 'ok.bso', origin: 'added' }], held: { '../y': { pins: [] } } })
    expect(got).toMatchObject({ enabled: true, limitBytes: blank().limitBytes })
    expect(got.communities.map((one) => one.address)).toEqual(['ok.bso'])
    expect(got.held).toEqual({})
  })
})

describe('the node announces fewer roots than seeding holds', () => {
  it('holds the community anyway and says the table is full', async () => {
    const { made, net, node, warnings } = seeder()
    node.provideError = 507
    net.records.set('a.bso', record(0))
    made.add('a.bso'); made.begin(); made.enable()
    await made.settled()
    expect(made.state().communities[0]).toMatchObject({ status: 'holding', pins: 3 })
    expect(warnings.some((line) => line.includes('table of announced blocks is full'))).toBe(true)
  })
})
