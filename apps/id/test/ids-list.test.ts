import { describe, expect, it } from 'vitest'
import { addId, coverageWords, forget, listIds } from '../site/ids-list.js'
import { readKnown, rememberIds } from '../site/known-ids.js'
import { readCache } from '../site/me-model.js'
import { ChainError } from '../site/sdk/chain.js'
import { FIRST_BLOCK, SCAN_WINDOW } from '../site/sdk/orivonid.js'
import { fakeRegistry, type Event, type World } from './support/fake-registry.ts'
import { HOLDER as ALICE } from './support/attribution.ts'

const BOB = '0x' + 'b0'.repeat(20)
const RES = '0x' + '7e'.repeat(20)
const HEAD = FIRST_BLOCK + 40_000
const world: World = {
  names: { alice: { owner: ALICE, resolver: RES }, carol: { owner: ALICE }, dave: { owner: BOB }, orivon: { owner: BOB } },
  resolvers: { [RES]: { addr: ALICE } },
  registrar: {}
}
const memory = () => {
  const map = new Map<string, string>()
  return { map, get: (key: string) => map.get(key) ?? null, set: (key: string, value: string) => { map.set(key, value) } }
}
const appOf = (events: Event[] = [], head = HEAD) => {
  const fake = fakeRegistry(world, events, head)
  const store = memory()
  return { app: { chain: fake.chain, store } as never, store, fake }
}

describe('listIds', () => {
  it('lists what the scan finds, remembers it, and keeps the scan for the next visit', async () => {
    const { app, store } = appOf([{ block: HEAD - 100, kind: 'registered', label: 'alice', owner: ALICE }])
    const found = await listIds(app, ALICE)
    expect(found.names.map((one) => one.label)).toEqual(['alice'])
    expect(readKnown(store, ALICE)).toEqual(['alice'])
    expect(readCache(store, ALICE)).toMatchObject({ held: ['alice'], lastBlock: HEAD - 16 })
  })

  it('lists a remembered ID the scan cannot see, and keeps it remembered while the chain still gives it to the address', async () => {
    const { app, store } = appOf()
    rememberIds(store, ALICE, ['carol'])
    expect((await listIds(app, ALICE)).names.map((one) => one.label)).toEqual(['carol'])
    expect(readKnown(store, ALICE)).toEqual(['carol'])
  })

  it('shows a remembered ID the chain no longer gives to the address as lapsed, until it is forgotten', async () => {
    const { app, store } = appOf()
    rememberIds(store, ALICE, ['dave', 'carol'])
    const found = await listIds(app, ALICE)
    expect(found.names.map((one) => one.label)).toEqual(['carol'])
    expect(found.lapsed.map((one) => one.label)).toEqual(['dave'])
    expect(readKnown(store, ALICE)).toEqual(['dave', 'carol'])
    forget(app, ALICE, 'dave')
    expect((await listIds(app, ALICE)).lapsed).toEqual([])
  })

  it('throws when the chain cannot be asked about a name, as before', async () => {
    const { app, store, fake } = appOf()
    rememberIds(store, ALICE, ['carol'])
    fake.chain.call = async () => { throw new ChainError('unavailable', 'down') }
    await expect(listIds(app, ALICE)).rejects.toMatchObject({ reason: 'unavailable' })
  })
})

describe('adding an ID by its name', () => {
  it('adds an ID the address holds, checked on chain, and remembers it', async () => {
    const { app, store } = appOf()
    const added = await addId(app, ALICE, 'Alice.orv', new Set())
    expect(added).toMatchObject({ kind: 'added', label: 'alice' })
    expect(added.words).toContain('alice.v1.orivonid.eth')
    expect(readKnown(store, ALICE)).toEqual(['alice'])
  })

  it('adds an ID that is held but cannot sign in yet, so the list can say why', async () => {
    const { app, store } = appOf()
    expect(await addId(app, ALICE, 'carol', new Set())).toMatchObject({ kind: 'added', label: 'carol' })
    expect(readKnown(store, ALICE)).toEqual(['carol'])
  })

  it('says who holds an ID another address holds, adds nothing, and says when nobody does', async () => {
    const { app, store } = appOf()
    const other = await addId(app, ALICE, 'dave.v1.orivonid.eth', new Set())
    expect(other.kind).toBe('notHeld')
    expect(other.words).toContain('0xB0B0')
    expect(other.words).toContain('not by this address')
    const nobody = await addId(app, ALICE, 'nobodyhere', new Set())
    expect(nobody).toMatchObject({ kind: 'notHeld' })
    expect(nobody.words).toContain('no holder')
    expect(readKnown(store, ALICE)).toEqual([])
  })

  it('reads nothing for what is not a name, or is already listed', async () => {
    const { app, fake } = appOf()
    expect(await addId(app, ALICE, '', new Set())).toMatchObject({ kind: 'empty' })
    expect(await addId(app, ALICE, 'a.b.c', new Set())).toMatchObject({ kind: 'problem' })
    expect(await addId(app, ALICE, 'alice', new Set(['alice']))).toMatchObject({ kind: 'already' })
    expect(fake.callCount()).toBe(0)
  })

  it('does not call a node that would not answer a refusal, and adds nothing', async () => {
    const { app, store, fake } = appOf()
    fake.chain.call = async () => { throw new ChainError('unavailable', 'down') }
    const added = await addId(app, ALICE, 'alice', new Set())
    expect(added.kind).toBe('unreadable')
    expect(added.words).toContain('Nothing was added')
    expect(readKnown(store, ALICE)).toEqual([])
  })
})

describe('what the page says of the history it could not see', () => {
  const sees = { complete: true, failed: false, unnamed: 0, blocks: 100_000 }

  it('says nothing when it saw all of it', () => {
    expect(coverageWords(sees)).toBeNull()
  })

  it('says how far back it looked, and that an older ID is listed only when this device has seen it or it is added', () => {
    const said = coverageWords({ ...sees, complete: false, blocks: SCAN_WINDOW })
    expect(said?.tone).toBe('info')
    expect(said?.title).toBe('This page looked back about 10 hours in the registry.')
    expect(said?.lines.join(' ')).toMatch(/Add it by name/)
    expect(coverageWords({ ...sees, complete: false, blocks: 7_200 * 2 })?.title).toContain('about 2 days')
  })

  it('says a range could not be read as a warning, never as a reason to try again, and still points to adding by name', () => {
    const said = coverageWords({ ...sees, complete: false, failed: true, blocks: 0 })
    expect(said?.tone).toBe('warn')
    expect(said?.title).toBe('Your node could not show the registry’s recent activity.')
    const all = `${said?.title} ${said?.lines.join(' ')}`
    expect(all).not.toMatch(/try again/i)
    expect(all).toMatch(/add it by name/)
  })

  it('counts the IDs it could see were sent to the address and could not name', () => {
    expect(coverageWords({ ...sees, unnamed: 1 })?.lines.join(' ')).toContain('An ID was sent to this address that this page cannot name')
    expect(coverageWords({ ...sees, complete: false, unnamed: 3, blocks: SCAN_WINDOW })?.lines.join(' ')).toContain('3 IDs were sent')
  })
})
