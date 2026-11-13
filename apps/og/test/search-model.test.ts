import { describe, expect, it } from 'vitest'
import { toChecksumAddress, ZERO_ADDRESS } from '../site/sdk/abi.js'
import { CENSUS_FORMAT, type Census } from '../site/resolver/og-census.js'
import { inspectOg } from '../site/resolver/og-names.js'
import { IMPLEMENTATION, UPGRADES, WRAPPER } from '../site/resolver/og-pins.js'
import { createSession } from '../site/resolver/og-tail.js'
import { describeName, failureWords, recordRows, searchView } from '../site/search-model.js'
import { menuOf } from '../site/manage-model.js'
import { NO_ACTIONS_WORDS, standingWords } from '../site/manage-words.js'
import { rowOf } from '../site/names-model.js'
import { fakeChain, FIRST_BLOCK, worldOf, type NameState } from './support/og-world.ts'
import { VECTORS } from './support/og-vectors.ts'

const vector = (id: string) => VECTORS.find((one) => one.id === id)!
const census = (): Census => ({ format: CENSUS_FORMAT, block: FIRST_BLOCK - 1_000, blockHash: `0x${'00'.repeat(32)}`, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names: {} })
const ME = toChecksumAddress(`0x${'a1'.repeat(20)}`)
const OTHER = toChecksumAddress(`0x${'b2'.repeat(20)}`)
const CID = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const ZERO_WORD = `0x${'0'.repeat(64)}`

async function read (id: string, account: string | null, facts: Record<string, unknown> = {}, change?: (state: NameState) => void) {
  const one = vector(id)
  const world = worldOf(one, { spread: 300 })
  change?.(world.names[one.label]!)
  const inspection = await inspectOg(fakeChain(world).chain, one.label, { session: createSession(), census: census() }, { latest: true })
  const base = { key: inspection.key, ...inspection.reads, waitForWrap: ZERO_ADDRESS, wrapEnabled: true, ...facts }
  return describeName({ label: one.label, inspection, facts: base as never, account })
}

describe('typing', () => {
  it('shows nothing for an empty field, the name rule for a name that breaks it, and a name that can be checked otherwise', () => {
    expect(searchView({ input: '', lookup: null, account: null })).toMatchObject({ state: 'empty', canCheck: false, label: null })
    expect(searchView({ input: '  ', lookup: null, account: null })).toMatchObject({ state: 'empty' })
    const dotted = searchView({ input: 'sub.harbor', lookup: null, account: null })
    expect(dotted).toMatchObject({ state: 'problem', tone: 'bad', canCheck: false })
    expect(dotted.words).toMatch(/no dots/)
    expect(searchView({ input: 'Harbor', lookup: null, account: null }).words).toMatch(/Use "harbor"/)
    expect(searchView({ input: 'harbor', lookup: null, account: null })).toMatchObject({ state: 'typed', label: 'harbor', canCheck: true })
  })

  it('takes a trailing .og as part of the field and ignores a read that belongs to another name', () => {
    expect(searchView({ input: 'harbor.og', lookup: null, account: null }).label).toBe('harbor')
    expect(searchView({ input: 'harbor', lookup: { kind: 'reading', label: 'other' }, account: null }).state).toBe('typed')
    expect(searchView({ input: 'harbor', lookup: { kind: 'reading', label: 'harbor' }, account: null })).toMatchObject({ state: 'reading', canCheck: false })
    expect(searchView({ input: 'harbor', lookup: { kind: 'failed', label: 'harbor', words: 'No answer.' }, account: null })).toMatchObject({ state: 'failed', tone: 'warn', words: 'No answer.' })
  })
})

describe('the four states of a name', () => {
  it('free: nobody holds it and nothing is left on it', async () => {
    const view = await read('free-label', null)
    expect(view).toMatchObject({ state: 'free', tone: 'ok', offer: 'register', holder: null, rows: [], controller: null })
    expect(view.headline).toMatch(/is free\.$/)
  })

  it('held, not wrapped: by whom, and whether it is the connected account', async () => {
    const theirs = await read('unwrapped-passes', ME)
    expect(theirs).toMatchObject({ state: 'held', mine: false, offer: null, tone: 'bad' })
    expect(theirs.headline).toMatch(/held by 0x[0-9a-f…]+, not wrapped/i)
    expect(theirs.words).toMatch(/cannot be registered/)
    const owner = vector('unwrapped-passes').state.registryOwner
    const mine = await read('unwrapped-passes', owner)
    expect(mine).toMatchObject({ state: 'held', mine: true, offer: 'continue', tone: 'neutral' })
    expect(mine.words).toMatch(/your name/)
  })

  it('held and wrapped: the token\'s holder is the holder', async () => {
    const one = vector('wrapped-passes')
    const holder = one.state.ownerOf!
    expect(await read('wrapped-passes', OTHER)).toMatchObject({ state: 'wrapped', mine: false, offer: null, holder })
    expect(await read('wrapped-passes', holder)).toMatchObject({ state: 'wrapped', mine: true, offer: null })
  })

  it('stranded in the wrapper: no token, and a way out only for the account the wrapper waits for', async () => {
    const waiting = await read('stranded-in-wrapper', ME, { waitForWrap: ME })
    expect(waiting).toMatchObject({ state: 'stranded', tone: 'warn', offer: 'finish', holder: WRAPPER })
    expect(waiting.words).toMatch(/no token/)
    expect(waiting.words).toMatch(/Finish wrapping/)
    const bystander = await read('stranded-in-wrapper', OTHER, { waitForWrap: ME })
    expect(bystander).toMatchObject({ state: 'stranded', offer: null })
    expect(bystander.words).toMatch(/Only that address/)
    expect(await read('stranded-in-wrapper', null, { waitForWrap: ME })).toMatchObject({ offer: null })
  })

  it('a stuck name that waits for another address has nothing to offer, and its page says who can finish it', async () => {
    const view = await read('stranded-in-wrapper', OTHER, { waitForWrap: ME })
    const row = rowOf({ view, account: OTHER, primary: null })
    const menu = menuOf({ view, account: OTHER })
    expect(row.state).toBe('stranded')
    expect(menu).toEqual([])
    const standing = standingWords({ view, holds: row.state !== 'lost', actions: menu.length })
    expect(standing).toMatch(/waiting for 0xA1A1…a1a1 to finish wrapping it/)
    expect(standing).toMatch(/Only that address can finish/)
    expect(NO_ACTIONS_WORDS).toMatch(/Nothing is offered/)
  })

  it('says nothing under the chips of a name that offers something to do, and the whole standing of a name that is not the account\'s', async () => {
    const mine = await read('stranded-in-wrapper', ME, { waitForWrap: ME })
    const menu = menuOf({ view: mine, account: ME })
    expect(menu.length).toBeGreaterThan(0)
    expect(standingWords({ view: mine, holds: true, actions: menu.length })).toBeNull()
    expect(standingWords({ view: mine, holds: false, actions: 0 })).toBe(mine.words)
  })

  it('free again with a previous holder\'s state left behind: records and a controller, none of which count', async () => {
    const view = await read('free-label', ME, {}, (state) => {
      state.controller = OTHER
      state.values = { 'content.ipfs': CID }
    })
    expect(view).toMatchObject({ state: 'reReserved', tone: 'ok', offer: 'register' })
    expect(view.headline).toMatch(/previous holder/)
    expect(view.rows).toEqual([expect.objectContaining({ key: 'content.ipfs', counts: false, reason: 'left-behind', value: CID })])
    expect(view.rows[0]?.words).toMatch(/previous holder wrote it/)
    const onlyController = await read('free-label', ME, {}, (state) => { state.controller = OTHER })
    expect(onlyController.state).toBe('reReserved')
  })
})

describe('the records and why each counts', () => {
  it('lists a record that counts as counting, with the rule\'s words', async () => {
    const view = await read('unwrapped-passes', null)
    expect(view.rows).toEqual([expect.objectContaining({ key: 'content.ipfs', label: 'IPFS site', counts: true, reason: 'passes' })])
    expect(view.rows[0]?.words).toMatch(/^Counts: /)
  })

  it('says in plain words why a record does not count, for each reason the rule gives', async () => {
    const cases: [string, string, RegExp][] = [
      ['unwrapped-sellers-leftover', 'set-before-the-last-holder-change', /written before the name last changed hands/],
      ['wrapped-controller-not-holder', 'controller-is-not-the-holder', /controller is another account than its holder/],
      ['new-controller-after-record', 'set-before-the-last-NewController', /controller changed after it was written/]
    ]
    for (const [id, reason, words] of cases) {
      const view = await read(id, null)
      expect(view.rows, id).toEqual([expect.objectContaining({ counts: false, reason })])
      expect(view.rows[0]?.words, id).toMatch(words)
      expect(view.rows[0]?.words, id).toMatch(/^Does not count: /)
    }
  })

  it('shows a controller that is not the holder, and no records are listed for a key with no value', async () => {
    const view = await read('wrapped-controller-not-holder', null)
    expect(view.controller).toMatch(/^Controller: 0x/)
    expect((await read('unwrapped-no-records-mainnet', null)).rows).toEqual([])
  })

  it('shows the records as not checked when the resolver contract changed, with the reason in the resolver\'s words', async () => {
    const one = vector('unwrapped-passes')
    const world = worldOf(one, { spread: 300 })
    world.implementation = `0x${'cd'.repeat(20)}`
    const inspection = await inspectOg(fakeChain(world).chain, one.label, { session: createSession(), census: census() }, { latest: true })
    const rows = recordRows(inspection)
    expect(rows).toEqual([expect.objectContaining({ counts: false, reason: 'unverified' })])
    const view = describeName({ label: one.label, inspection, facts: { key: inspection.key, ...inspection.reads, waitForWrap: ZERO_ADDRESS, wrapEnabled: true } as never, account: null })
    expect(view.refusal).toMatch(/runs code this resolver was not built for/)
  })
})

describe('failureWords', () => {
  it('says what to do about a refusal by the person, a refusal by the resolver, and a node that did not answer', () => {
    expect(failureWords({ reason: 'declined' })).toMatch(/close every tab/i)
    expect(failureWords(Object.assign(new Error('The resolver contract was upgraded.'), { name: 'OgRefusal' }))).toBe('The resolver contract was upgraded.')
    expect(failureWords(new Error('boom'))).toMatch(/node did not answer/)
  })
})
