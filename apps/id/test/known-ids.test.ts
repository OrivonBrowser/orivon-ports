import { describe, expect, it } from 'vitest'
import { forgetId, MAX_KNOWN, readIdName, readKnown, rememberFinished, rememberIds } from '../site/known-ids.js'
import { harness } from './support/flow-harness.ts'
import { HOLDER } from './support/attribution.ts'

const memory = () => {
  const map = new Map<string, string>()
  return { map, get: (key: string) => map.get(key) ?? null, set: (key: string, value: string) => { map.set(key, value) } }
}
const ALICE = HOLDER
const KEY = `orivonid.known.v1.${ALICE.toLowerCase()}`

describe('the IDs this device remembers', () => {
  it('keeps what it is given for an address, once each, in the order it learned them, whatever the case of the address', () => {
    const store = memory()
    expect(readKnown(store, ALICE)).toEqual([])
    expect(rememberIds(store, ALICE, ['alice', 'bob-1'])).toEqual(['alice', 'bob-1'])
    expect(rememberIds(store, ALICE.toLowerCase(), ['alice', 'carol'])).toEqual(['alice', 'bob-1', 'carol'])
    expect(readKnown(store, ALICE)).toEqual(['alice', 'bob-1', 'carol'])
    expect(readKnown(store, '0x' + '12'.repeat(20))).toEqual([])
  })

  it('writes nothing when there is nothing new, and refuses a label the registrar would not sell', () => {
    const store = memory()
    rememberIds(store, ALICE, ['alice'])
    const before = store.map.get(KEY)
    store.map.set(KEY, before + ' ')
    rememberIds(store, ALICE, ['alice'])
    expect(store.map.get(KEY)).toBe(before + ' ')
    expect(rememberIds(store, ALICE, ['Not A Label', 'a.b', '', 'ab'])).toEqual(['alice'])
  })

  it('forgets one ID and leaves the others', () => {
    const store = memory()
    rememberIds(store, ALICE, ['alice', 'bob-1'])
    expect(forgetId(store, ALICE, 'alice')).toEqual(['bob-1'])
    expect(readKnown(store, ALICE)).toEqual(['bob-1'])
    expect(forgetId(store, ALICE, 'nobody')).toEqual(['bob-1'])
  })

  it('keeps at most MAX_KNOWN, dropping the oldest', () => {
    const store = memory()
    const labels = Array.from({ length: MAX_KNOWN + 5 }, (_, index) => `name${String(index).padStart(3, '0')}`)
    const kept = rememberIds(store, ALICE, labels)
    expect(kept).toHaveLength(MAX_KNOWN)
    expect(kept[0]).toBe('name005')
    expect(kept.at(-1)).toBe(labels.at(-1))
  })

  it('treats anything else in its place as no list', () => {
    const store = memory()
    for (const bad of ['not json', 'null', '[]', '{"version":2,"labels":["alice"]}', '{"version":1,"labels":"alice"}', '{"labels":["alice"]}']) {
      store.map.set(KEY, bad)
      expect(readKnown(store, ALICE), bad).toEqual([])
    }
    store.map.set(KEY, JSON.stringify({ version: 1, labels: ['alice', 5, null, 'Not A Label', 'alice', 'x.y'] }))
    expect(readKnown(store, ALICE)).toEqual(['alice'])
  })

  it('never throws on a store that does', () => {
    const broken = { get: () => { throw new Error('blocked') }, set: () => { throw new Error('blocked') } }
    expect(readKnown(broken, ALICE)).toEqual([])
    expect(() => rememberIds(broken, ALICE, ['alice'])).not.toThrow()
    expect(() => forgetId(broken, ALICE, 'alice')).not.toThrow()
  })
})

describe('the name a person types to add an ID', () => {
  it('takes the label alone, or the whole name under either suffix, in any case', () => {
    for (const typed of ['alice', ' Alice ', 'alice.v1.orivonid.eth', 'ALICE.V1.ORIVONID.ETH', 'alice.orv', 'Alice.ORV']) {
      expect(readIdName(typed), typed).toEqual({ kind: 'label', label: 'alice' })
    }
  })

  it('accepts a label the registrar reserves, because the Safe may have given it away', () => {
    expect(readIdName('orivon.orv')).toEqual({ kind: 'label', label: 'orivon' })
  })

  it('says what is wrong, in words, for nothing, a name outside ASCII, another name and a label the registrar would refuse', () => {
    expect(readIdName('')).toEqual({ kind: 'empty' })
    expect(readIdName('   ')).toEqual({ kind: 'empty' })
    for (const typed of ['café', 'alice.eth', 'alice.bob.orv', 'alice.v1.orivonid.eth.', 'a', '-alice', 'al ice', 'https://alice.orv', '.orv', 'alice.v1.orivonid.eth/x']) {
      const read = readIdName(typed)
      expect(read.kind, typed).toBe('problem')
      expect((read as { words: string }).words.length, typed).toBeGreaterThan(10)
    }
  })
})

describe('a registration that finishes', () => {
  it('is remembered for its owner, once the chain says the name is theirs, and not before', async () => {
    const store = memory()
    const seen: string[][] = []
    const h = harness({ account: ALICE, onState: (state) => { rememberFinished(store, state); seen.push(readKnown(store, ALICE)) } })
    expect((await h.flow.check('alice'))['phase']).toBe('ready')
    const done = await h.flow.start()
    expect(done['phase']).toBe('done')
    expect(readKnown(store, ALICE)).toEqual(['alice'])
    const firstDone = h.states.findIndex((state) => state['phase'] === 'done')
    expect(seen.slice(0, firstDone).every((known) => known.length === 0)).toBe(true)
  })

  it('is not remembered when the registration fails, or for any other state', async () => {
    const store = memory()
    const h = harness({ account: ALICE, dai: 1n, onState: (state) => rememberFinished(store, state) })
    expect((await h.flow.check('alice'))['phase']).toBe('failed')
    rememberFinished(store, { phase: 'ready', label: 'alice', owner: ALICE })
    rememberFinished(store, { phase: 'done', label: 7, owner: ALICE })
    rememberFinished(store, { phase: 'done', label: 'alice' })
    expect(readKnown(store, ALICE)).toEqual([])
  })
})
