import { describe, expect, it } from 'vitest'
import { isAddress, toChecksumAddress, ZERO_ADDRESS } from '../site/sdk/abi.js'
import { ChainError } from '../site/sdk/chain.js'
import { labelhash } from '../site/sdk/ens.js'
import {
  ADDRESSES, attribution, FIRST_BLOCK, isReserved, isValidLabel, labelId, labelProblem, namesOf, nameOf, normalizeInput, ownerOf,
  price, records, recordsAt, REORG_MARGIN, RESERVED, salesStatus
} from '../site/sdk/orivonid.js'
import { fakeRegistry, OWNER_ROLES, type World } from './support/fake-registry.ts'
import { LABEL_CASES } from './support/labels.ts'

const address = (n: number) => toChecksumAddress('0x' + n.toString(16).padStart(40, '0'))
const ALICE = address(0xa11ce)
const BOB = address(0xb0b)
const RES_A = address(0x7e51)
const RES_B = address(0x7e52)
const DAI = 10n ** 18n

const emptyWorld = (): World => ({ names: {}, resolvers: {}, registrar: {} })

describe('the constants', () => {
  it('are EIP-55 addresses', () => {
    for (const [name, value] of Object.entries(ADDRESSES)) expect(isAddress(value), name).toBe(true)
    expect(ADDRESSES.r1).toBe('0xDD1DecE58Eb7a5CebF8c1e0834b7eD4096e7ED20')
  })

  it('list the seventeen reserved labels, each valid, none twice', () => {
    expect(RESERVED).toHaveLength(17)
    expect(new Set(RESERVED).size).toBe(17)
    for (const label of RESERVED) expect(isValidLabel(label), label).toBe(true)
  })
})

describe('normalizeInput', () => {
  it('trims and lower-cases ASCII', () => {
    expect(normalizeInput('  Alice\t')).toEqual({ ok: true, label: 'alice' })
    expect(normalizeInput('A-B1')).toEqual({ ok: true, label: 'a-b1' })
  })

  it('refuses nothing, an empty line, and anything outside ASCII, with a reason', () => {
    expect(normalizeInput('')).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeInput(' \n ')).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeInput(undefined)).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeInput('café')).toEqual({ ok: false, reason: 'notAscii' })
    expect(normalizeInput('a​b')).toEqual({ ok: false, reason: 'notAscii' })
  })

  it('refuses a letter that would lower-case into ASCII, instead of folding it', () => {
    expect('K'.toLowerCase()).toBe('k')
    expect(normalizeInput('Kelvin')).toEqual({ ok: false, reason: 'notAscii' })
  })
})

describe('the label rules', () => {
  it('give the registrar\'s answer on every case of the shared table', () => {
    for (const [label, valid] of LABEL_CASES) expect(isValidLabel(label), JSON.stringify(label)).toBe(valid)
  })

  it('name the first reason a page can word', () => {
    const reasons: [string, string | null][] = [
      ['ab', 'tooShort'], ['a'.repeat(64), 'tooLong'], ['-abc', 'edgeHyphen'], ['abc-', 'edgeHyphen'], ['ab--c', 'doubleHyphen'],
      ['Abc', 'badCharacter'], ['a.b', 'badCharacter'], ['0x' + 'a'.repeat(40), 'addressLike'], ['abc', null]
    ]
    for (const [label, reason] of reasons) expect(labelProblem(label), label).toBe(reason)
  })

  it('know the reserved labels, case-sensitively', () => {
    for (const label of RESERVED) expect(isReserved(label)).toBe(true)
    expect(isReserved('alice')).toBe(false)
    expect(isReserved('Orivon')).toBe(false)
  })

  it('price by length in DAI, as the registrar does for any string', () => {
    expect(price('abc')).toBe(800n * DAI)
    expect(price('abcd')).toBe(200n * DAI)
    expect(price('abcde')).toBe(10n * DAI)
    expect(price('a'.repeat(63))).toBe(10n * DAI)
    expect(price('ab')).toBe(10n * DAI)
    expect(price('')).toBe(10n * DAI)
  })

  it('file a label under the hash of its text', () => {
    expect(labelId('orivon')).toBe(BigInt(labelhash('orivon')))
    expect(nameOf('alice')).toBe('alice.v1.orivonid.eth')
  })
})

describe('salesStatus', () => {
  it('is open when DAI holds, the name pays someone, and v1 is reachable', async () => {
    const { chain } = fakeRegistry({ ...emptyWorld(), registrar: { beneficiary: BOB } })
    expect(await salesStatus(chain)).toEqual({
      open: true, daiAboveFloor: true, daiRevert: null, beneficiary: BOB, beneficiaryRevert: null, reachable: { ethToR0: true, r0ToR1: true }
    })
  })

  it('gives the revert reason of a pause, and closes', async () => {
    const { chain } = fakeRegistry({ ...emptyWorld(), registrar: { daiAboveFloor: 'revert', beneficiary: 'revert' } })
    expect(await salesStatus(chain)).toMatchObject({
      open: false, daiAboveFloor: null, daiRevert: 'Uniswap: OLD', beneficiary: null, beneficiaryRevert: 'no beneficiary'
    })
  })

  it('closes while DAI is below the floor, or either pointer to v1 is wrong', async () => {
    expect((await salesStatus(fakeRegistry({ ...emptyWorld(), registrar: { daiAboveFloor: false } }).chain))).toMatchObject({ open: false, daiAboveFloor: false })
    expect((await salesStatus(fakeRegistry({ ...emptyWorld(), registrar: {}, ethToR0: BOB }).chain)).reachable).toEqual({ ethToR0: false, r0ToR1: true })
    expect((await salesStatus(fakeRegistry({ ...emptyWorld(), registrar: {}, r0ToR1: BOB }).chain))).toMatchObject({ open: false, reachable: { ethToR0: true, r0ToR1: false } })
  })

  it('does not call a node that could not answer a closed sale', async () => {
    const { chain } = fakeRegistry(emptyWorld())
    const down = { ...chain, call: async () => { throw new ChainError('unavailable', 'down') } }
    await expect(salesStatus(down as never)).rejects.toMatchObject({ reason: 'unavailable' })
  })
})

describe('ownerOf', () => {
  it('names the holder, or null for a label nobody holds', async () => {
    const { chain } = fakeRegistry({ ...emptyWorld(), names: { alice: { owner: ALICE } } })
    expect(await ownerOf(chain, 'alice')).toBe(ALICE)
    expect(await ownerOf(chain, 'carol')).toBeNull()
  })
})

describe('attribution', () => {
  const world = (name: Partial<World['names'][string]> = {}, resolver: World['resolvers'][string] = { addr: ALICE }): World => ({
    ...emptyWorld(), names: { alice: { owner: ALICE, resolver: RES_A, ...name } }, resolvers: { [RES_A]: resolver }
  })

  it('holds when R1 names the holder, nobody else has a role, and the name resolves to the holder', async () => {
    const found = await attribution(fakeRegistry(world()).chain, 'alice', ALICE)
    expect(found).toEqual({
      label: 'alice', address: ALICE, ok: true,
      owner: { ok: true, owner: ALICE },
      roles: { ok: true, roleCount: OWNER_ROLES, roles: OWNER_ROLES, problem: null },
      forward: { ok: true, resolver: RES_A, address: ALICE, problem: null },
      records: { ok: true, resolver: RES_A, problem: null }
    })
  })

  it('takes an address in any case and reports it checksummed', async () => {
    expect((await attribution(fakeRegistry(world()).chain, 'alice', ALICE.toLowerCase())).ok).toBe(true)
    await expect(attribution(fakeRegistry(world()).chain, 'alice', 'alice.eth')).rejects.toThrow(TypeError)
  })

  it('fails (a) for another holder, and says who holds it', async () => {
    const found = await attribution(fakeRegistry(world()).chain, 'alice', BOB)
    expect(found.ok).toBe(false)
    expect(found.owner).toEqual({ ok: false, owner: ALICE })
    expect(found.forward.problem).toBe('differentAddress')
  })

  it('fails (b) while a second account holds any role on the name', async () => {
    const found = await attribution(fakeRegistry(world({ roleCount: 2n << 20n })).chain, 'alice', ALICE)
    expect(found.roles).toEqual({ ok: false, roleCount: 2n << 20n, roles: OWNER_ROLES, problem: null })
    expect(found.owner.ok && found.forward.ok).toBe(true)
    expect(found.ok).toBe(false)
  })

  it('fails (c) with the reason: no resolver, a resolver that fails, no address, or another address', async () => {
    const problem = async (w: World) => (await attribution(fakeRegistry(w).chain, 'alice', ALICE)).forward
    expect(await problem(world({ resolver: undefined }))).toEqual({ ok: false, resolver: null, address: null, problem: 'noResolver' })
    expect(await problem(world({}, { reverts: true }))).toMatchObject({ ok: false, resolver: RES_A, problem: 'resolverFailed' })
    expect(await problem({ ...world(), resolvers: {} })).toMatchObject({ ok: false, problem: 'resolverFailed' })
    expect(await problem(world({}, { addr: null }))).toMatchObject({ ok: false, address: null, problem: 'noAddress' })
    expect(await problem(world({}, { addr: BOB }))).toEqual({ ok: false, resolver: RES_A, address: BOB, problem: 'differentAddress' })
  })

  it('reads a resolver that does not declare ENSIP-10 by calling it directly', async () => {
    expect((await attribution(fakeRegistry(world({}, { addr: ALICE, extended: false })).chain, 'alice', ALICE)).ok).toBe(true)
  })

  it('fails every clause for a label the registrar would refuse, and for the zero address', async () => {
    const { chain, callCount } = fakeRegistry(world())
    const refused = await attribution(chain, 'Alice', ALICE)
    expect(refused).toMatchObject({ ok: false, owner: { ok: false }, roles: { ok: false }, forward: { ok: false, problem: 'invalidLabel' }, records: { ok: false, problem: 'invalidLabel' } })
    expect((await attribution(chain, 'alice', ZERO_ADDRESS)).ok).toBe(false)
    expect(callCount()).toBe(0)
  })

  it('does not hold for a label nobody owns, even though no role is held by anyone', async () => {
    const found = await attribution(fakeRegistry(emptyWorld()).chain, 'nobody', ALICE)
    expect(found.roles.ok).toBe(true)
    expect(found.ok).toBe(false)
  })
})

describe('records', () => {
  const world = (resolver: World['resolvers'][string]): World => ({
    ...emptyWorld(), names: { alice: { owner: ALICE, resolver: RES_A } }, resolvers: { [RES_A]: resolver }
  })

  it('reads the address, the text records asked for, and the contenthash', async () => {
    const { chain } = fakeRegistry(world({ addr: ALICE, texts: { url: 'https://example.org', 'eth.orivonstack.id.not-before': '1700000000' }, contenthash: '0xe3010170' }))
    const got = await records(chain, 'alice', ['url', 'eth.orivonstack.id.not-before', 'avatar'])
    expect(got).toEqual({
      resolver: RES_A, addr: ALICE,
      texts: { url: 'https://example.org', 'eth.orivonstack.id.not-before': '1700000000', avatar: null },
      contenthash: new Uint8Array([0xe3, 1, 1, 0x70]), failed: []
    })
  })

  it('answers empty for a label with no resolver, an unregistered label and a refused label', async () => {
    const empty = { resolver: null, addr: null, texts: { url: null }, contenthash: null, failed: [] }
    const { chain } = fakeRegistry({ ...emptyWorld(), names: { bare: { owner: ALICE } } })
    expect(await records(chain, 'bare', ['url'])).toEqual(empty)
    expect(await records(chain, 'nobody', ['url'])).toEqual(empty)
    expect(await records(chain, 'Bad Label', ['url'])).toEqual(empty)
  })

  it('lists the records a resolver failed to answer instead of failing them all', async () => {
    const got = await records(fakeRegistry(world({ reverts: true })).chain, 'alice', ['url'])
    expect(got).toMatchObject({ resolver: RES_A, addr: null, contenthash: null, failed: ['addr', 'contenthash', 'text:url'] })
  })

  it('answers an unset address as null', async () => {
    expect((await records(fakeRegistry(world({ addr: null })).chain, 'alice', [])).addr).toBeNull()
  })
})

describe('recordsAt asks the records together', () => {
  const SEL = { supports: '01ffc9a7', resolve: '9061b923', multicall: 'ac9650d8', aggregate3: '82ad56cb' }
  const world = (resolver: World['resolvers'][string], multicall3 = false): World => ({
    ...emptyWorld(), multicall3, names: { alice: { owner: ALICE, resolver: RES_A } }, resolvers: { [RES_A]: resolver }
  })
  const selectors = (fake: ReturnType<typeof fakeRegistry>) => fake.callLog.map((one) => one.selector)
  const KEYS = ['url', 'description', 'avatar', 'com.github', 'com.twitter', 'org.telegram', 'email', 'eth.orivonstack.id.not-before']
  const TEXTS = { url: 'https://example.org', description: 'Builds things.', 'eth.orivonstack.id.not-before': '1700000000' }
  const EXPECTED = {
    resolver: RES_A, addr: ALICE, contenthash: new Uint8Array([0xe3, 1, 1, 0x70]), failed: [] as string[],
    texts: { url: 'https://example.org', description: 'Builds things.', avatar: null, 'com.github': null, 'com.twitter': null, 'org.telegram': null, email: null, 'eth.orivonstack.id.not-before': '1700000000' }
  }
  const resolver = { addr: ALICE, texts: TEXTS, contenthash: '0xe3010170' }

  it('reads all of them in one call of the resolver\'s multicall, through resolve for an extended resolver: two calls, whatever the number of keys', async () => {
    const fake = fakeRegistry(world({ ...resolver, multicall: true }))
    expect(await recordsAt(fake.chain, RES_A, 'alice', KEYS)).toEqual(EXPECTED)
    expect(selectors(fake)).toEqual([SEL.supports, SEL.resolve])
    const few = fakeRegistry(world({ ...resolver, multicall: true }))
    await recordsAt(few.chain, RES_A, 'alice', ['url'])
    expect(few.callCount()).toBe(fake.callCount())
  })

  it('calls the multicall of a resolver that does not declare ENSIP-10 directly', async () => {
    const fake = fakeRegistry(world({ ...resolver, extended: false, multicall: true }))
    expect(await recordsAt(fake.chain, RES_A, 'alice', KEYS)).toEqual(EXPECTED)
    expect(selectors(fake)).toEqual([SEL.supports, SEL.multicall])
  })

  it('lists a record the resolver fails inside the batch as that record\'s failure and reads the rest', async () => {
    const fake = fakeRegistry(world({ ...resolver, multicall: true, badTexts: ['avatar'] }))
    expect(await recordsAt(fake.chain, RES_A, 'alice', KEYS)).toEqual({ ...EXPECTED, failed: ['text:avatar'] })
    expect(selectors(fake)).toEqual([SEL.supports, SEL.resolve])
  })

  it('asks Multicall3 when the resolver has no multicall, once and with each call allowed to fail on its own', async () => {
    const fake = fakeRegistry(world({ ...resolver, badTexts: ['url'] }, true))
    expect(await recordsAt(fake.chain, RES_A, 'alice', KEYS)).toEqual({ ...EXPECTED, texts: { ...EXPECTED.texts, url: null }, failed: ['text:url'] })
    expect(selectors(fake)).toEqual([SEL.supports, SEL.resolve, SEL.aggregate3])
    expect(fake.callLog[2]?.to).toBe('0xcA11bde05977b3631167028862bE2a173976CA11')
  })

  it('asks Multicall3 when a Multicallable resolver stops its whole multicall at one failed record, which is how the record is found', async () => {
    const fake = fakeRegistry(world({ ...resolver, extended: false, multicall: true, badTexts: ['email'] }, true))
    expect(await recordsAt(fake.chain, RES_A, 'alice', KEYS)).toEqual({ ...EXPECTED, failed: ['text:email'] })
    expect(selectors(fake)).toEqual([SEL.supports, SEL.multicall, SEL.aggregate3])
  })

  it('asks one record at a time when the resolver has no multicall and the chain has no Multicall3', async () => {
    const fake = fakeRegistry(world({ ...resolver, badTexts: ['url'] }))
    expect(await recordsAt(fake.chain, RES_A, 'alice', KEYS)).toEqual({ ...EXPECTED, texts: { ...EXPECTED.texts, url: null }, failed: ['text:url'] })
    const asked = selectors(fake)
    expect(asked.slice(0, 3)).toEqual([SEL.supports, SEL.resolve, SEL.aggregate3])
    expect(asked.slice(3)).toEqual(Array(KEYS.length + 2).fill(SEL.resolve))
  })

  it('does not hide a node that could not be asked behind a failed record', async () => {
    const fake = fakeRegistry(world({ ...resolver, multicall: true }))
    const limited = { ...fake.chain, call: async () => { throw new ChainError('limit', 'too many requests') } } as typeof fake.chain
    await expect(recordsAt(limited, RES_A, 'alice', KEYS)).rejects.toMatchObject({ reason: 'limit' })
    let asked = 0
    const dies = { ...fake.chain, call: async (...args: Parameters<typeof fake.chain.call>) => {
      if (++asked === 2) throw new ChainError('timeout', 'no answer')
      return await fake.chain.call(...args)
    } } as typeof fake.chain
    await expect(recordsAt(dies, RES_A, 'alice', KEYS)).rejects.toMatchObject({ reason: 'timeout' })
    expect(asked).toBe(2)
  })

  it('answers the same through every way to read', async () => {
    const ways = [
      world({ ...resolver, multicall: true }), world({ ...resolver, extended: false, multicall: true }),
      world(resolver, true), world({ ...resolver, extended: false }, true), world(resolver), world({ ...resolver, extended: false })
    ]
    for (const one of ways) expect(await recordsAt(fakeRegistry(one).chain, RES_A, 'alice', KEYS), JSON.stringify(one.resolvers)).toEqual(EXPECTED)
  })
})

describe('namesOf', () => {
  const F = FIRST_BLOCK
  const base: World = {
    ...emptyWorld(),
    names: {
      alice: { owner: ALICE, resolver: RES_A }, carol: { owner: ALICE }, dave: { owner: BOB, resolver: RES_B }, bob1: { owner: BOB }, orivon: { owner: ADDRESSES.safe }
    },
    resolvers: { [RES_A]: { addr: ALICE }, [RES_B]: { addr: BOB } }
  }

  it('reads R1\'s logs in ranges of at most 1024 blocks, three kinds at a time, up to the head', async () => {
    const fake = fakeRegistry(base, [], F + 2500)
    await namesOf(fake.chain, ALICE)
    const ranges = fake.logQueries.map((query) => [query.fromBlock, query.toBlock])
    expect([...new Set(ranges.map(String))]).toEqual([[F, F + 1023], [F + 1024, F + 2047], [F + 2048, F + 2500]].map(String))
    expect(fake.logQueries.filter((query) => query.fromBlock === F).map((query) => query.topic0)).toHaveLength(3)
    expect(Math.max(...fake.logQueries.map((query) => query.toBlock - query.fromBlock + 1))).toBe(1024)
  })

  it('finds a name registered to the address, one sent to it singly and in a batch, and ignores the rest', async () => {
    const fake = fakeRegistry(base, [
      { block: F, kind: 'registered', label: 'alice', owner: ALICE },
      { block: F, kind: 'registered', label: 'dave', owner: BOB },
      { block: F + 1, kind: 'registered', label: 'carol', owner: BOB },
      { block: F + 3, kind: 'registered', label: 'bob1', owner: BOB },
      { block: F + 5, kind: 'single', to: ALICE, label: 'carol' }
    ], F + 10)
    const found = await namesOf(fake.chain, ALICE)
    expect(found.names.map((name) => name.label)).toEqual(['alice', 'carol'])
    expect(found.names.map((name) => name.attribution.ok)).toEqual([true, false])
    const batched = fakeRegistry({ ...base, names: { ...base.names, bob1: { owner: ALICE } } }, [
      { block: F, kind: 'registered', label: 'bob1', owner: BOB },
      { block: F + 2, kind: 'registered', label: 'carol', owner: BOB },
      { block: F + 4, kind: 'batch', to: ALICE, labels: ['bob1', 'carol'] }
    ], F + 10)
    expect((await namesOf(batched.chain, ALICE)).names.map((name) => name.label)).toEqual(['bob1', 'carol'])
  })

  it('drops a name the address no longer holds, and lists the Safe\'s reserved names as held but not usable', async () => {
    const events = [
      { block: F, kind: 'registered' as const, label: 'dave', owner: ALICE },
      { block: F, kind: 'registered' as const, label: 'orivon', owner: ADDRESSES.safe, sender: ADDRESSES.safe }
    ]
    expect((await namesOf(fakeRegistry(base, events, F + 5).chain, ALICE)).names).toEqual([])
    const safe = (await namesOf(fakeRegistry(base, events, F + 5).chain, ADDRESSES.safe)).names
    expect(safe.map((name) => [name.label, name.attribution.ok, name.attribution.forward.problem])).toEqual([['orivon', false, 'noResolver']])
  })

  it('keeps the labels it found and goes on from where it stopped, less a margin for replaced blocks', async () => {
    const events = [{ block: F + 3, kind: 'registered' as const, label: 'alice', owner: ALICE }]
    const first = fakeRegistry(base, events, F + 2000)
    const one = await namesOf(first.chain, ALICE)
    expect(one.cache).toMatchObject({ version: 1, address: ALICE.toLowerCase(), lastBlock: F + 2000 - REORG_MARGIN, held: ['alice'] })
    expect(JSON.parse(JSON.stringify(one.cache))).toEqual(one.cache)

    const later = fakeRegistry(base, [...events, { block: F + 2100, kind: 'single', to: ALICE, label: 'carol' }, { block: F + 2100, kind: 'registered', label: 'carol', owner: BOB }], F + 2200)
    const two = await namesOf(later.chain, ALICE, { cache: one.cache })
    expect(Math.min(...later.logQueries.map((query) => query.fromBlock))).toBe(F + 2000 - REORG_MARGIN + 1)
    expect(two.names.map((name) => name.label)).toEqual(['alice', 'carol'])
    expect(two.cache.lastBlock).toBe(F + 2200 - REORG_MARGIN)
  })

  it('learns a label from the cache when its token is sent later', async () => {
    const registeredEarly = fakeRegistry(base, [{ block: F + 1, kind: 'registered', label: 'carol', owner: BOB }], F + 100)
    const cache = (await namesOf(registeredEarly.chain, ALICE)).cache
    expect(cache.held).toEqual([])
    const sentLater = fakeRegistry(base, [{ block: F + 1, kind: 'registered', label: 'carol', owner: BOB }, { block: F + 200, kind: 'single', to: ALICE, label: 'carol' }], F + 300)
    expect((await namesOf(sentLater.chain, ALICE, { cache })).names.map((name) => name.label)).toEqual(['carol'])
  })

  it('starts over when the cache belongs to another address or version', async () => {
    const events = [{ block: F + 1, kind: 'registered' as const, label: 'alice', owner: ALICE }]
    const cache = (await namesOf(fakeRegistry(base, events, F + 100).chain, ALICE)).cache
    const fake = fakeRegistry(base, events, F + 100)
    await namesOf(fake.chain, BOB, { cache })
    expect(Math.min(...fake.logQueries.map((query) => query.fromBlock))).toBe(F)
    const stale = fakeRegistry(base, events, F + 100)
    await namesOf(stale.chain, ALICE, { cache: { ...cache, version: 0 } as never })
    expect(Math.min(...stale.logQueries.map((query) => query.fromBlock))).toBe(F)
  })

  it('ignores a log whose label does not hash to its own label hash', async () => {
    const fake = fakeRegistry(base, [{ block: F + 1, kind: 'registered', label: 'alice', owner: ALICE }], F + 10)
    const real = fake.chain.getLogs
    fake.chain.getLogs = async (filter) => (await real(filter)).map((log) => ({ ...log, topics: log.topics.map((topic, index) => index === 2 ? '0x' + '22'.repeat(32) : topic) }))
    expect((await namesOf(fake.chain, ALICE)).names).toEqual([])
  })
})
