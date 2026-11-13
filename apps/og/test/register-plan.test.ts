import { describe, expect, it } from 'vitest'
import { ZERO_ADDRESS } from '../site/sdk/abi.js'
import { keyOf } from '../site/resolver/og-name.js'
import { WRAPPER } from '../site/resolver/og-pins.js'
import { GAS, planSeries, situationOf, textGas, totalGas } from '../site/register-plan.js'
import { ACCOUNT, RIVAL, TIP_ADDRESS } from './support/linagee-world.ts'

const KEY = keyOf('harbor')
const SITE = { key: 'content.bzz', text: `bzz://${'ab'.repeat(32)}` }
const TIP = { to: TIP_ADDRESS, wei: 500_000_000_000_000n, name: 'orivonstack.eth' }
const facts = (over: Record<string, unknown> = {}) => ({
  key: KEY, registryOwner: ZERO_ADDRESS, nameToId: 0n, idToName: null, ownerOf: null, controller: ZERO_ADDRESS, values: {}, waitForWrap: ZERO_ADDRESS, wrapEnabled: true, ...over
}) as never
const kinds = (list: { steps: { kind: string }[] }) => list.steps.map((step) => step.kind)
const plan = (over: Record<string, unknown> = {}, wanted: Record<string, unknown> = {}) =>
  planSeries({ label: 'harbor', account: ACCOUNT, facts: facts(over), wrapped: true, site: SITE, tip: TIP, ...wanted } as never)

describe('situationOf', () => {
  it('tells the five places a name can be for an account', () => {
    expect(situationOf(facts(), ACCOUNT)).toBe('free')
    expect(situationOf(facts({ registryOwner: ACCOUNT }), ACCOUNT)).toBe('mine')
    expect(situationOf(facts({ registryOwner: RIVAL }), ACCOUNT)).toBe('taken')
    expect(situationOf(facts({ registryOwner: WRAPPER, waitForWrap: ACCOUNT }), ACCOUNT)).toBe('stranded')
    expect(situationOf(facts({ registryOwner: WRAPPER, waitForWrap: RIVAL }), ACCOUNT)).toBe('taken')
    expect(situationOf(facts({ registryOwner: WRAPPER, nameToId: 5n, idToName: KEY, ownerOf: ACCOUNT }), ACCOUNT)).toBe('wrappedMine')
    expect(situationOf(facts({ registryOwner: WRAPPER, nameToId: 5n, idToName: KEY, ownerOf: RIVAL }), ACCOUNT)).toBe('taken')
  })

  it('does not take a token for the name\'s when the wrapper\'s id points at another name', () => {
    expect(situationOf(facts({ registryOwner: WRAPPER, nameToId: 5n, idToName: keyOf('other'), ownerOf: ACCOUNT, waitForWrap: ACCOUNT }), ACCOUNT)).toBe('stranded')
  })
})

describe('planSeries', () => {
  it('orders a wrapped registration so that no step strands the name and the records come last but the tip', () => {
    expect(kinds(plan())).toEqual(['reserve', 'setController', 'createWrapper', 'transfer', 'wrap', 'record', 'tip'])
  })

  it('has no wrapper step in an unwrapped one, and no controller step when there is none to replace', () => {
    expect(kinds(plan({}, { wrapped: false }))).toEqual(['reserve', 'record', 'tip'])
    expect(kinds(plan({ controller: RIVAL }, { wrapped: false }))).toEqual(['reserve', 'setController', 'record', 'tip'])
    expect(kinds(plan({ controller: ACCOUNT }, { wrapped: false }))).toEqual(['reserve', 'record', 'tip'])
  })

  it('leaves out the controller step when the account already is the controller', () => {
    expect(kinds(plan({ controller: ACCOUNT }))).toEqual(['reserve', 'createWrapper', 'transfer', 'wrap', 'record', 'tip'])
  })

  it('plans only the wrap for a stranded name, and writes no record it could not write', () => {
    const stranded = { registryOwner: WRAPPER, waitForWrap: ACCOUNT }
    const planned = plan(stranded)
    expect(planned.situation).toBe('stranded')
    expect(kinds(planned)).toEqual(['wrap', 'tip'])
    expect(planned.notes[0]).toMatch(/controller/)
    expect(kinds(plan({ ...stranded, controller: ACCOUNT }))).toEqual(['wrap', 'record', 'tip'])
  })

  it('has no step for a name that is taken or already wrapped as the account wants it', () => {
    expect(plan({ registryOwner: RIVAL }).steps).toEqual([])
    expect(kinds(plan({ registryOwner: WRAPPER, nameToId: 5n, idToName: KEY, ownerOf: ACCOUNT, controller: ACCOUNT }, { site: null, tip: TIP }))).toEqual([])
  })

  it('adds a tip only after at least one other step, and never when none is wanted', () => {
    expect(kinds(plan({}, { tip: null }))).not.toContain('tip')
    expect(plan({ registryOwner: WRAPPER, nameToId: 5n, idToName: KEY, ownerOf: ACCOUNT, controller: ACCOUNT }, { site: null }).steps).toEqual([])
  })

  it('writes a record again only when no earlier run of the request finished it, or the chain holds another value now', () => {
    const held = { registryOwner: WRAPPER, nameToId: 5n, idToName: KEY, ownerOf: ACCOUNT, controller: ACCOUNT, values: { [SITE.key]: SITE.text } }
    const finished = { done: [`record:${SITE.key}`] }
    expect(kinds(plan(held, finished))).toEqual([])
    // The same value can be a previous holder's, written before the name changed hands: only this request's own write is known to count.
    expect(kinds(plan(held))).toEqual(['record', 'tip'])
    expect(kinds(plan({ ...held, values: { [SITE.key]: 'bzz://other' } }, finished))).toEqual(['record', 'tip'])
    expect(kinds(plan({ ...held, values: {} }, finished))).toEqual(['record', 'tip'])
  })

  it('keeps a tip an earlier run stopped at, even when nothing else is left to send', () => {
    const held = { registryOwner: WRAPPER, nameToId: 5n, idToName: KEY, ownerOf: ACCOUNT, controller: ACCOUNT, values: { [SITE.key]: SITE.text } }
    const finished = { done: [`record:${SITE.key}`] }
    expect(kinds(plan(held, { ...finished, tipOwed: true }))).toEqual(['tip'])
    expect(kinds(plan(held, { ...finished, tipOwed: true, tip: null }))).toEqual([])
  })

  it('names every step with its contract and its call, and signs each with a limit above what it used', () => {
    for (const step of plan().steps) {
      expect(step.title.length).toBeGreaterThan(5)
      expect(step.contract.length).toBeGreaterThan(5)
      expect(step.call).toMatch(/\(|ETH/)
      expect(step.gas).toBeGreaterThanOrEqual(21_000)
    }
    expect(GAS.reserve).toBeGreaterThan(45_149)
    expect(GAS.wrap).toBeGreaterThan(202_295)
    expect(GAS.setController).toBeGreaterThan(58_506)
    expect(GAS.createWrapper).toBeGreaterThan(51_606)
    expect(GAS.transfer).toBeGreaterThan(28_489)
  })

  it('writes the record to the resolver, the wrap to the wrapper and the tip as plain ether', () => {
    const steps = Object.fromEntries(plan().steps.map((step) => [step.kind, step]))
    expect(steps['wrap']?.tx.to).toBe(WRAPPER)
    expect(steps['tip']?.tx).toEqual({ to: TIP_ADDRESS, data: new Uint8Array(0), value: TIP.wei })
    expect(steps['record']?.textKey).toBe('content.bzz')
    expect(steps['record']?.value).toBe(SITE.text)
  })

  it('signs the tip with the limit it was given, and with the transfer\'s 21,000 when it has none', () => {
    expect(plan().steps.find((step) => step.kind === 'tip')?.gas).toBe(21_000)
    expect(plan({}, { tip: { ...TIP, gas: 65_000 } }).steps.find((step) => step.kind === 'tip')?.gas).toBe(65_000)
  })

  it('sums the limits', () => {
    const steps = plan().steps
    expect(totalGas(steps)).toBe(steps.reduce((sum, step) => sum + step.gas, 0))
  })
})

describe('textGas', () => {
  it('gives two storage words of value the measured limit and a word more 25,000 more', () => {
    expect(textGas('x'.repeat(62))).toBe(160_000)
    expect(textGas('x'.repeat(64))).toBe(160_000)
    expect(textGas('x'.repeat(65))).toBe(185_000)
    expect(textGas('x'.repeat(128))).toBe(210_000)
    expect(textGas('x'.repeat(129))).toBe(235_000)
  })
})
