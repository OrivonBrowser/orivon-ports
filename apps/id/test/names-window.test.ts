import { describe, expect, it } from 'vitest'
import { toChecksumAddress } from '../site/sdk/abi.js'
import { ChainError } from '../site/sdk/chain.js'
import { ADDRESSES, FIRST_BLOCK, namesOf, REORG_MARGIN, SCAN_WINDOW } from '../site/sdk/orivonid.js'
import { fakeRegistry, type Event, type World } from './support/fake-registry.ts'

const address = (n: number) => toChecksumAddress('0x' + n.toString(16).padStart(40, '0'))
const ALICE = address(0xa11ce)
const BOB = address(0xb0b)
const RES_A = address(0x7e51)
const F = FIRST_BLOCK
const LONG_AFTER = F + 40_000

const base: World = {
  names: {
    alice: { owner: ALICE, resolver: RES_A }, carol: { owner: ALICE }, dave: { owner: BOB }, orivon: { owner: ALICE }
  },
  resolvers: { [RES_A]: { addr: ALICE } },
  registrar: {}
}

/** A registry whose chain says it is Orivon's light client (the fake's own kind) or a wallet's node. */
const registry = (events: Event[], head: number, kind: 'orivon' | 'eip1193' = 'orivon') => {
  const fake = fakeRegistry(base, events, head)
  Object.assign(fake.chain, { kind })
  return fake
}
const ranges = (fake: ReturnType<typeof registry>) => [...new Set(fake.logQueries.map((query) => `${query.fromBlock}-${query.toBlock}`))]

describe('the scan inside Orivon', () => {
  it('reads only the last SCAN_WINDOW blocks, in ranges of at most 1024, and says it looked back that far', async () => {
    const fake = registry([], LONG_AFTER)
    const found = await namesOf(fake.chain, ALICE)
    const asked = fake.logQueries.map((query) => [query.fromBlock, query.toBlock] as const)
    expect(Math.min(...asked.map(([from]) => from))).toBe(LONG_AFTER - SCAN_WINDOW + 1)
    expect(Math.max(...asked.map(([, to]) => to))).toBe(LONG_AFTER)
    expect(Math.max(...asked.map(([from, to]) => to - from + 1))).toBe(1024)
    expect(found.coverage).toEqual({ complete: false, failed: false, unnamed: 0, blocks: SCAN_WINDOW })
    expect(found.cache).toMatchObject({ firstBlock: LONG_AFTER - SCAN_WINDOW + 1, lastBlock: LONG_AFTER - REORG_MARGIN })
  })

  it('reads from the registry\'s first block when the head is nearer than the window, and says the history is whole', async () => {
    const fake = registry([{ block: F + 5, kind: 'registered', label: 'alice', owner: ALICE }], F + SCAN_WINDOW - 1)
    const found = await namesOf(fake.chain, ALICE)
    expect(Math.min(...fake.logQueries.map((query) => query.fromBlock))).toBe(F)
    expect(found.coverage.complete).toBe(true)
    expect(found.names.map((one) => one.label)).toEqual(['alice'])
  })

  it('does not find a name registered before the window, and lists it once it is remembered', async () => {
    const events: Event[] = [{ block: F + 5, kind: 'registered', label: 'alice', owner: ALICE }]
    const alone = await namesOf(registry(events, LONG_AFTER).chain, ALICE)
    expect(alone.names).toEqual([])
    const remembered = await namesOf(registry(events, LONG_AFTER).chain, ALICE, { known: ['alice'] })
    expect(remembered.names.map((one) => [one.label, one.attribution.ok])).toEqual([['alice', true]])
    expect(remembered.lapsed).toEqual([])
  })

  it('checks a remembered name on chain every time: one the address lost comes back as lapsed, not listed', async () => {
    const fake = registry([], LONG_AFTER)
    const found = await namesOf(fake.chain, ALICE, { known: ['dave', 'alice'] })
    expect(found.names.map((one) => one.label)).toEqual(['alice'])
    expect(found.lapsed.map((one) => [one.label, one.attribution.owner])).toEqual([['dave', { ok: false, owner: BOB }]])
    expect(fake.callLog.some((call) => call.to === ADDRESSES.r1)).toBe(true)
  })

  it('lists a remembered name that is held but cannot sign in, with its attribution saying why', async () => {
    const found = await namesOf(registry([], LONG_AFTER).chain, ALICE, { known: ['carol'] })
    expect(found.names.map((one) => [one.label, one.attribution.ok, one.attribution.forward.problem])).toEqual([['carol', false, 'noResolver']])
  })

  it('ignores a remembered label that is not a label', async () => {
    const found = await namesOf(registry([], LONG_AFTER).chain, ALICE, { known: ['Not A Label', '', 'a.b'] })
    expect(found.names).toEqual([])
    expect(found.lapsed).toEqual([])
  })

  it('names a token of the Safe\'s reserved labels sent in the window, with no registration to read', async () => {
    const events: Event[] = [{ block: LONG_AFTER - 100, kind: 'single', to: ALICE, label: 'orivon' }]
    const found = await namesOf(registry(events, LONG_AFTER).chain, ALICE)
    expect(found.names.map((one) => one.label)).toEqual(['orivon'])
    expect(found.coverage.unnamed).toBe(0)
  })

  it('counts a token sent in the window whose label it cannot name, keeps the count, and names it once the person adds the label', async () => {
    const events: Event[] = [{ block: LONG_AFTER - 100, kind: 'single', to: ALICE, label: 'carol' }]
    const first = await namesOf(registry(events, LONG_AFTER).chain, ALICE)
    expect(first.names).toEqual([])
    expect(first.coverage.unnamed).toBe(1)
    const later = await namesOf(registry([], LONG_AFTER + 50).chain, ALICE, { cache: first.cache })
    expect(later.coverage.unnamed).toBe(1)
    const named = await namesOf(registry([], LONG_AFTER + 50).chain, ALICE, { cache: first.cache, known: ['carol'] })
    expect(named.names.map((one) => one.label)).toEqual(['carol'])
    expect(named.coverage.unnamed).toBe(0)
    expect(named.cache.held).toEqual(['carol'])
  })

  it('goes on from the cache, and keeps how far back it has read without a gap', async () => {
    const first = await namesOf(registry([], LONG_AFTER).chain, ALICE)
    const fake = registry([], LONG_AFTER + 2000)
    const second = await namesOf(fake.chain, ALICE, { cache: first.cache })
    expect(Math.min(...fake.logQueries.map((query) => query.fromBlock))).toBe(LONG_AFTER - REORG_MARGIN + 1)
    expect(second.coverage.blocks).toBe(SCAN_WINDOW + 2000)
    expect(second.cache.firstBlock).toBe(first.cache.firstBlock)
  })

  it('starts the window again when the cache stops short of it, keeps what the cache held, and says it has a gap', async () => {
    const early = await namesOf(registry([{ block: F + 5, kind: 'registered', label: 'alice', owner: ALICE }], F + 500).chain, ALICE)
    expect(early.cache.held).toEqual(['alice'])
    const fake = registry([], LONG_AFTER)
    const found = await namesOf(fake.chain, ALICE, { cache: early.cache })
    expect(Math.min(...fake.logQueries.map((query) => query.fromBlock))).toBe(LONG_AFTER - SCAN_WINDOW + 1)
    expect(found.names.map((one) => one.label)).toEqual(['alice'])
    expect(found.coverage).toMatchObject({ complete: false, failed: false })
    expect(found.cache.firstBlock).toBe(LONG_AFTER - SCAN_WINDOW + 1)
  })

  it('never asks for a history the light client would refuse', async () => {
    const fake = registry([], LONG_AFTER)
    await namesOf(fake.chain, ALICE, { known: ['alice'] })
    expect(Math.min(...fake.logQueries.map((query) => query.fromBlock))).toBeGreaterThan(LONG_AFTER - SCAN_WINDOW)
    expect(ranges(fake)).toHaveLength(3)
  })
})

describe('a range the node will not give', () => {
  /** A chain that refuses every log read older than `since`, as a node that is no archive does. */
  const refusing = (events: Event[], head: number, since: number, kind: 'orivon' | 'eip1193' = 'orivon') => {
    const fake = registry(events, head, kind)
    const real = fake.chain.getLogs
    let refused = 0
    fake.chain.getLogs = async (filter) => {
      if (Number(filter.fromBlock) < since) { refused++; throw new ChainError('unavailable', 'no provider can answer this call now') }
      return await real(filter)
    }
    return { fake, refused: () => refused }
  }

  it('is not a failure of the call: the remembered names are still listed and the coverage says what is missing', async () => {
    const { fake, refused } = refusing([], LONG_AFTER, LONG_AFTER - 500)
    const found = await namesOf(fake.chain, ALICE, { known: ['alice'] })
    expect(found.coverage.failed).toBe(true)
    expect(found.coverage.complete).toBe(false)
    expect(found.names.map((one) => one.label)).toEqual(['alice'])
    expect(refused()).toBeGreaterThan(0)
  })

  it('asks the range once more, and reads past a flaky one without calling it a failure', async () => {
    const events: Event[] = [{ block: LONG_AFTER - 2000, kind: 'registered', label: 'alice', owner: ALICE }]
    const fake = registry(events, LONG_AFTER)
    const real = fake.chain.getLogs
    let first = true
    fake.chain.getLogs = async (filter) => {
      if (first) { first = false; throw new ChainError('unavailable', 'the first read of the scan fails') }
      return await real(filter)
    }
    const found = await namesOf(fake.chain, ALICE)
    expect(found.coverage.failed).toBe(false)
    expect(found.names.map((one) => one.label)).toEqual(['alice'])
  })

  it('does not move the cache past a range it could not read, so the next visit reads it again', async () => {
    const { fake } = refusing([], LONG_AFTER, LONG_AFTER - 500)
    const found = await namesOf(fake.chain, ALICE)
    expect(found.cache.lastBlock).toBeLessThan(LONG_AFTER - SCAN_WINDOW)
    const healed = registry([], LONG_AFTER + 10)
    const again = await namesOf(healed.chain, ALICE, { cache: found.cache })
    expect(again.coverage.failed).toBe(false)
    expect(again.cache.lastBlock).toBe(LONG_AFTER + 10 - REORG_MARGIN)
  })

  it('keeps the labels the readable ranges showed, even when another range failed', async () => {
    const events: Event[] = [{ block: LONG_AFTER - 100, kind: 'registered', label: 'alice', owner: ALICE }]
    const { fake } = refusing(events, LONG_AFTER, LONG_AFTER - 1500)
    const found = await namesOf(fake.chain, ALICE)
    expect(found.coverage.failed).toBe(true)
    expect(found.names.map((one) => one.label)).toEqual(['alice'])
  })

  it('stops a whole-history scan at the first range it cannot read, and still lists what is remembered', async () => {
    const { fake, refused } = refusing([], LONG_AFTER, LONG_AFTER, 'eip1193')
    const found = await namesOf(fake.chain, ALICE, { known: ['alice'] })
    expect(found.coverage).toMatchObject({ failed: true, complete: false })
    expect(refused()).toBe(6)
    expect(found.names.map((one) => one.label)).toEqual(['alice'])
  })

  it('still fails when the registry cannot be asked about a name', async () => {
    const fake = registry([], LONG_AFTER)
    fake.chain.call = async () => { throw new ChainError('unavailable', 'the node is down') }
    await expect(namesOf(fake.chain, ALICE, { known: ['alice'] })).rejects.toMatchObject({ reason: 'unavailable' })
  })
})

describe('the scan outside Orivon', () => {
  it('reads the whole history from the registry\'s first block, and says it is whole', async () => {
    const events: Event[] = [{ block: F + 5, kind: 'registered', label: 'alice', owner: ALICE }]
    const fake = registry(events, LONG_AFTER, 'eip1193')
    const found = await namesOf(fake.chain, ALICE)
    expect(Math.min(...fake.logQueries.map((query) => query.fromBlock))).toBe(F)
    expect(found.names.map((one) => one.label)).toEqual(['alice'])
    expect(found.coverage).toEqual({ complete: true, failed: false, unnamed: 0, blocks: LONG_AFTER - F + 1 })
  })

  it('reads again from the start when the cache was made by a windowed scan and does not reach the first block', async () => {
    const windowed = await namesOf(registry([], LONG_AFTER).chain, ALICE)
    const fake = registry([{ block: F + 5, kind: 'registered', label: 'alice', owner: ALICE }], LONG_AFTER, 'eip1193')
    const found = await namesOf(fake.chain, ALICE, { cache: windowed.cache })
    expect(Math.min(...fake.logQueries.map((query) => query.fromBlock))).toBe(F)
    expect(found.names.map((one) => one.label)).toEqual(['alice'])
    expect(found.coverage.complete).toBe(true)
  })
})
