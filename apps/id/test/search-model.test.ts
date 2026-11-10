import { describe, expect, it } from 'vitest'
import { selector, toChecksumAddress } from '../site/sdk/abi.js'
import { toHex } from '../site/sdk/bytes.js'
import { ADDRESSES, salesStatus } from '../site/sdk/orivonid.js'
import { DECOY_COUNT, SEARCH_WORDS } from '../site/register-decoys.js'
import { checkRegistration } from '../site/register-reads.js'
import { REASONS } from '../site/register-reasons.js'
import { ChainError } from '../site/sdk/chain.js'
import { askAboutName, readingOf, SALES_RETRY, salesLine, salesReason, salesUnknown, searchView, TYPING_WORDS, type Reading } from '../site/search-model.js'
import { fakeMarket } from './support/fake-market.ts'
import { harness } from './support/flow-harness.ts'
import type { World } from './support/fake-registry.ts'

const ALICE = toChecksumAddress('0x' + 'a1'.repeat(20))
const BOB = toChecksumAddress('0x' + 'b0'.repeat(20))
const OPEN = { open: true, daiAboveFloor: true, daiRevert: null, beneficiary: ADDRESSES.safe, beneficiaryRevert: null, reachable: { ethToR0: true, r0ToR1: true } }
const UNCHECKED: Reading = { kind: 'unchecked' }
const read = (holder: string | null, reason: string | null = null): Reading => ({ kind: 'read', holder, reason })
const view = (input: string, reading: Reading, asked: string | null, account: string | null = null) => searchView({ input, reading, asked, account })

describe('searchView', () => {
  it('asks for a name while there is none, and says the problem in words while it is wrong', () => {
    expect(view('', UNCHECKED, null)).toMatchObject({ state: 'empty', canCheck: false })
    expect(view('ab', UNCHECKED, null)).toMatchObject({ state: 'problem', tone: 'bad', headline: 'A name needs at least 3 characters.', canCheck: false })
  })

  it('judges the format and gives the price from what was typed alone, before the node is asked', () => {
    expect(view('Alice', UNCHECKED, null)).toMatchObject({ state: 'unchecked', name: 'alice.v1.orivonid.eth', priceText: '10 DAI', canCheck: true })
    expect(view('abc', UNCHECKED, null).headline).toBe('abc.v1.orivonid.eth costs 800 DAI.')
    expect(view('abcd', UNCHECKED, null).priceText).toBe('200 DAI')
    expect(view('Orivon', UNCHECKED, null)).toMatchObject({ state: 'problem', canCheck: false })
  })

  it('shows what the node said only for the name it was asked about', () => {
    expect(view('bob', read(null), 'alice').state).toBe('unchecked')
    expect(view('bob', read(null), 'bob').state).toBe('available')
    expect(view('bob', { kind: 'reading' }, null).state).toBe('unchecked')
  })

  it('waits while the node is asked, and may not be asked again meanwhile', () => {
    expect(view('alice', { kind: 'reading' }, 'alice')).toMatchObject({ state: 'reading', canCheck: false, headline: 'Looking up alice.v1.orivonid.eth…' })
  })

  it('says a free name is available at its price, and that the registration panel takes it from there', () => {
    expect(view('abc', read(null), 'abc')).toMatchObject({ state: 'available', tone: 'ok', canCheck: false, priceText: '800 DAI', headline: 'abc.v1.orivonid.eth is available.' })
  })

  it('says a held name is taken, or that it is the connected address\'s own', () => {
    expect(view('alice', read(BOB), 'alice', ALICE)).toMatchObject({ state: 'taken', canCheck: false, words: REASONS['taken']?.words })
    expect(view('alice', read(ALICE.toLowerCase()), 'alice', ALICE)).toMatchObject({ state: 'mine', tone: 'ok', canCheck: false })
    expect(view('alice', read(ALICE), 'alice', null).state).toBe('taken')
  })

  it('says why a free name cannot be bought now, with the registration\'s own words, and lets the person ask again', () => {
    expect(view('alice', read(null, 'daiBelowFloor'), 'alice')).toMatchObject({
      state: 'closed', tone: 'warn', canCheck: true, words: REASONS['daiBelowFloor']?.words
    })
  })

  it('says a failed read in words and keeps the name and price', () => {
    expect(view('alice', { kind: 'failed', words: 'The node took too long to answer.' }, 'alice')).toMatchObject({
      state: 'unreadable', tone: 'warn', words: 'The node took too long to answer.', priceText: '10 DAI', canCheck: true
    })
  })
})

describe('what the registration check leaves, read as an answer about the name', () => {
  it('reads the check in progress, a name that is ready, and nothing else a registration passes through', () => {
    expect(readingOf({ phase: 'checking', what: 'name' })).toEqual({ kind: 'reading' })
    expect(readingOf({ phase: 'ready', label: 'abc' })).toEqual(read(null))
    for (const phase of ['idle', 'committing', 'maturing', 'done']) expect(readingOf({ phase })).toEqual(UNCHECKED)
    expect(readingOf({ phase: 'failed', reason: 'unknownOutcome', during: 'revealing' })).toEqual(UNCHECKED)
  })

  it('reads who holds a name that is taken, and that a free name is shut, or free and stopped by the account alone', () => {
    expect(readingOf({ phase: 'failed', during: 'checking', reason: 'taken', holder: BOB })).toEqual(read(BOB))
    for (const reason of ['daiBelowFloor', 'noBeneficiary', 'v1Unreachable', 'salesClosed']) expect(readingOf({ phase: 'failed', during: 'checking', reason })).toEqual(read(null, reason))
    for (const reason of ['notEnoughDai', 'receiverRefuses', 'resolverBlocked']) expect(readingOf({ phase: 'failed', during: 'checking', reason })).toEqual(read(null))
  })

  it('reads a node that could not answer as a failed look-up, with the reason in words', () => {
    const state = { phase: 'failed', during: 'checking', reason: 'timeout', detail: 'slow' }
    expect(readingOf(state)).toEqual({ kind: 'failed', words: `${REASONS['timeout']?.words} Check the name again.` })
    expect(readingOf({ ...state, reason: 'somethingNew' })).toEqual({ kind: 'failed', words: 'slow Check the name again.' })
  })
})

const GET_OWNER = toHex(selector('getOwner(uint256)'))

/** A registration over a fake market whose every call to the node is noted. */
function watched() {
  const market = fakeMarket({ account: ALICE, dai: 1000n * 10n ** 18n })
  const calls: string[] = []
  const call = market.chain.call.bind(market.chain)
  market.chain.call = async (tx, ...rest) => { calls.push(toHex(tx.data ?? new Uint8Array(0))); return await call(tx, ...rest) }
  const h = harness({ account: ALICE, market })
  return { h, calls, owners: () => calls.filter((one) => one.startsWith(GET_OWNER)).length }
}

describe('what asks the node about a name', () => {
  const connect = async () => ALICE as string | null

  it('is not typing: every key is judged here, and the node is asked nothing', () => {
    const { calls } = watched()
    for (const typed of ['a', 'ab', 'abc', 'abc-', 'abc-d', 'abc-de']) view(typed, UNCHECKED, null)
    expect(calls).toEqual([])
  })

  it('is the button: one check for the name, which asks about a name of 3 letters among 7 others', async () => {
    const { h, owners } = watched()
    expect(await askAboutName({ input: 'Abc', connect, check: (label) => h.flow.check(label) })).toEqual({ asked: true, label: 'abc' })
    expect(owners()).toBe(1 + DECOY_COUNT)
    expect(readingOf(h.states.at(-1) ?? {})).toEqual(read(null))
  }, 60_000)

  it('asks about a longer name alone', async () => {
    const { h, owners } = watched()
    await askAboutName({ input: 'alice', connect, check: (label) => h.flow.check(label) })
    expect(owners()).toBe(1)
  })

  it('asks nothing for a name that is not one, or when the wallet shares no address', async () => {
    const { h, calls } = watched()
    for (const input of ['', 'ab', 'orivon', 'Ünï']) {
      expect(await askAboutName({ input, connect, check: (label) => h.flow.check(label) }), input).toEqual({ asked: false, why: 'format' })
    }
    expect(await askAboutName({ input: 'alice', connect: async () => null, check: (label) => h.flow.check(label) })).toEqual({ asked: false, why: 'noAddress' })
    expect(calls).toEqual([])
  })

  it('says, beside the search, that nothing is looked up while typing and how a short name is hidden', () => {
    expect(TYPING_WORDS).toContain('Nothing is looked up while you type')
    expect(SEARCH_WORDS).toContain('7 other names')
  })
})

describe('the sales line and the reason it gives', () => {
  it('agrees with the reason a registration check gives, for every way the sale can be shut', async () => {
    const worlds: [string, Partial<World>][] = [
      ['daiBelowFloor', { registrar: { daiAboveFloor: false } }],
      ['noBeneficiary', { registrar: { beneficiary: 'revert' } }],
      ['v1Unreachable', { r0ToR1: ALICE }],
      ['v1Unreachable', { ethToR0: ALICE }]
    ]
    for (const [reason, change] of worlds) {
      const market = fakeMarket({ account: ALICE, world: { names: {}, resolvers: {}, registrar: {}, ...change } })
      const sales = await salesStatus(market.chain)
      const checked = await checkRegistration(market.chain, 'alice', ALICE)
      expect(checked, reason).toMatchObject({ ok: false, reason })
      expect(salesReason(sales), reason).toBe(reason)
      expect(salesLine({ kind: 'read', sales })).toEqual({ words: REASONS[reason]?.words, retry: false })
    }
  })

  it('is open when the registrar sells, and waits while it is not known', () => {
    expect(salesReason(OPEN)).toBeNull()
    expect(salesLine({ kind: 'read', sales: OPEN })).toEqual({ words: 'Sales are open.', retry: false })
    expect(salesLine({ kind: 'reading' })).toEqual({ words: 'Checking whether sales are open…', retry: false })
  })
})

describe('a read of the sales status that fails', () => {
  it('is unknown, in words, with a way to ask again, and never says sales are open or shut', () => {
    for (const [reason, why] of [['timeout', 'the node took too long to answer'], ['unavailable', 'the Ethereum node did not answer'], ['limit', 'the Ethereum node did not answer']] as const) {
      const unknown = salesUnknown(new ChainError(reason, 'x'))
      expect(unknown, reason).toEqual({ kind: 'unknown', retry: true, words: `Could not check whether sales are open: ${why}.` })
      expect(salesLine(unknown), reason).toEqual({ words: `Could not check whether sales are open: ${why}.`, retry: true })
    }
    expect(salesUnknown(new Error('boom'))).toMatchObject({ kind: 'unknown', retry: true })
    expect(SALES_RETRY).toBe('Check again')
  })

  it('says Orivon is not letting the page read, and offers no retry that would be refused again', () => {
    const unknown = salesUnknown(new ChainError('declined', 'the person did not allow it'))
    expect(unknown).toEqual({ kind: 'unknown', retry: false, words: 'Could not check whether sales are open: Orivon is not letting this page read Ethereum.' })
  })

  it('is what a refused `salesStatus` becomes, not a line that stays on "Checking"', async () => {
    const market = fakeMarket({ account: ALICE })
    market.chain.call = async () => { throw new ChainError('declined', 'the person did not allow it') }
    const outcome = await salesStatus(market.chain).then(() => null, (error: unknown) => salesUnknown(error))
    expect(outcome).not.toBeNull()
    expect(salesLine(outcome as never).words).not.toContain('Checking')
  })
})
