import { describe, expect, it } from 'vitest'
import { ZERO_ADDRESS } from '../site/sdk/abi.js'
import { keyOf } from '../site/resolver/og-name.js'
import { WRAPPER } from '../site/resolver/og-pins.js'
import { chipsOf, classifyAdded, controllerState, labelOfKey, mergeNames, rowOf, ZERO_KEY } from '../site/names-model.js'
import { ACCOUNT, RIVAL } from './support/linagee-world.ts'

const KEY = keyOf('harbor')
const facts = (over: Record<string, unknown> = {}) => ({
  key: KEY, registryOwner: ACCOUNT, nameToId: 0n, idToName: null, ownerOf: null, controller: ACCOUNT, values: {}, waitForWrap: ZERO_ADDRESS, wrapEnabled: true, primary: ZERO_KEY, resolvesTo: ZERO_ADDRESS, ...over
}) as never
const wrapped = (over: Record<string, unknown> = {}) => facts({ registryOwner: WRAPPER, nameToId: 7n, idToName: KEY, ownerOf: ACCOUNT, ...over })
const view = (state: string, over: Record<string, unknown> = {}) => ({
  state, mine: true, openable: true, rows: [], offer: null, headline: 'a headline', facts: facts(), ...over
}) as never

describe('labelOfKey', () => {
  it('reads the label a registry key spells, in any script', () => {
    expect(labelOfKey(KEY)).toBe('harbor')
    expect(labelOfKey(keyOf('日本語'))).toBe('日本語')
    expect(labelOfKey(keyOf('a'.repeat(32)))).toBe('a'.repeat(32))
    expect(labelOfKey(keyOf('Harbor').toUpperCase().replace('0X', '0x'))).toBe('Harbor')
  })

  it('has no label for a key that is not the padded spelling of text', () => {
    expect(labelOfKey(ZERO_KEY)).toBeNull()
    expect(labelOfKey(`0x${'ff'.repeat(32)}`)).toBeNull()
    expect(labelOfKey(`0x6100${'0'.repeat(60)}`.replace(/^0x6100/, '0x610062'))).toBeNull()
    expect(labelOfKey('0x1234')).toBeNull()
    expect(labelOfKey(undefined)).toBeNull()
  })
})

describe('mergeNames', () => {
  it('lists the tokens first, then the names added, then the hints, each name once with where it came from', () => {
    const merged = mergeNames({ tokens: [{ label: 'a', tokenId: '5' }, { label: 'b', tokenId: '6' }], remembered: ['b', 'c'], hints: ['c', 'd', 'a'] })
    expect(merged).toEqual([
      { label: 'a', source: 'token', tokenId: '5' }, { label: 'b', source: 'token', tokenId: '6' }, { label: 'c', source: 'added', tokenId: null }, { label: 'd', source: 'hint', tokenId: null }
    ])
  })
})

describe('classifyAdded', () => {
  it('says what typing a name does, for each place the name can be', () => {
    expect(classifyAdded('harbor', facts(), ACCOUNT).kind).toBe('added')
    expect(classifyAdded('harbor', facts({ registryOwner: WRAPPER, waitForWrap: ACCOUNT }), ACCOUNT).kind).toBe('finish')
    expect(classifyAdded('harbor', wrapped(), ACCOUNT).kind).toBe('listed')
    expect(classifyAdded('harbor', facts({ registryOwner: ZERO_ADDRESS }), ACCOUNT).kind).toBe('free')
    const theirs = classifyAdded('harbor', facts({ registryOwner: RIVAL }), ACCOUNT)
    expect(theirs.kind).toBe('theirs')
    expect(theirs.words).toContain(`${RIVAL.slice(0, 6)}`)
  })
})

describe('controllerState', () => {
  it('is fine for the holder or nobody on an unwrapped name, and only the holder on a wrapped one', () => {
    expect(controllerState(facts({ controller: ACCOUNT }), ACCOUNT, false)).toEqual({ ok: true, words: null })
    expect(controllerState(facts({ controller: ZERO_ADDRESS }), ACCOUNT, false)).toEqual({ ok: true, words: null })
    expect(controllerState(facts({ controller: RIVAL }), ACCOUNT, false).words).toMatch(/Fix the controller/)
    expect(controllerState(wrapped({ controller: ACCOUNT }), ACCOUNT, true)).toEqual({ ok: true, words: null })
    expect(controllerState(wrapped({ controller: ZERO_ADDRESS }), ACCOUNT, true).words).toMatch(/no controller/)
    expect(controllerState(wrapped({ controller: RIVAL }), ACCOUNT, true).words).toMatch(/not your address/)
    expect(controllerState(facts({ controller: null }), ACCOUNT, false).ok).toBe(false)
  })
})

describe('rowOf and chipsOf', () => {
  const rows = (counts: boolean) => [{ key: 'content.ipfs', label: 'IPFS site', value: 'ipfs://x', counts, reason: counts ? 'passes' : 'no-SetTextRecord-log', words: counts ? 'Counts: it' : 'Does not count: no log shows who wrote it', opened: true }]

  it('says a wrapped name whose site counts is in order', () => {
    const row = rowOf({ view: view('wrapped', { rows: rows(true), facts: wrapped() }), account: ACCOUNT, primary: null })
    expect(row).toMatchObject({ state: 'wrapped', primary: false, site: { tone: 'ok' }, controller: { ok: true }, finish: false })
    expect(chipsOf(row, view('wrapped', { facts: wrapped() })).map((chip) => chip.text)).toEqual(['Wrapped, token 7', 'Site counts'])
  })

  it('says why a site does not count, flags the controller and the primary name', () => {
    const state = view('held', { rows: rows(false), facts: facts({ controller: RIVAL }) })
    const row = rowOf({ view: state, account: ACCOUNT, primary: KEY })
    expect(row.site).toMatchObject({ tone: 'warn' })
    expect(row.site.words).toMatch(/IPFS site does not count\. No log shows/)
    expect(row).toMatchObject({ primary: true, controller: { ok: false } })
    expect(chipsOf(row, state).map((chip) => chip.text)).toEqual(['Not wrapped', 'Your primary name', 'A record does not count', 'Controller needs fixing'])
  })

  it('has no site to say for a name with none, and marks a stranded name and one the account lost', () => {
    expect(rowOf({ view: view('held'), account: ACCOUNT, primary: null }).site).toEqual({ tone: 'neutral', words: 'No site set.' })
    const stuck = rowOf({ view: view('stranded', { offer: 'finish' }), account: ACCOUNT, primary: null })
    expect(stuck).toMatchObject({ state: 'stranded', finish: true })
    expect(chipsOf(stuck, view('stranded')).map((chip) => chip.text)).toEqual(['Stuck in the wrapper'])
    const lost = rowOf({ view: view('held', { mine: false }), account: ACCOUNT, primary: null })
    expect(lost.state).toBe('lost')
    expect(chipsOf(lost, view('held', { mine: false })).map((chip) => chip.text)).toEqual(['Not yours'])
  })
})
