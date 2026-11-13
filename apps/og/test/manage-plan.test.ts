import { describe, expect, it } from 'vitest'
import { ZERO_ADDRESS } from '../site/sdk/abi.js'
import { keyOf } from '../site/resolver/og-name.js'
import { PROXY, REGISTRY, WRAPPER } from '../site/resolver/og-pins.js'
import { planManage, transferProblem } from '../site/manage-plan.js'
import { GAS } from '../site/register-plan.js'
import { ACCOUNT, RIVAL } from './support/linagee-world.ts'

const KEY = keyOf('harbor')
const SITE = { key: 'content.ipfs', text: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }
const facts = (over: Record<string, unknown> = {}) => ({
  key: KEY, registryOwner: ACCOUNT, nameToId: 0n, idToName: null, ownerOf: null, controller: ACCOUNT, values: {}, waitForWrap: ZERO_ADDRESS, wrapEnabled: true, primary: `0x${'0'.repeat(64)}`, resolvesTo: ZERO_ADDRESS, ...over
}) as never
const wrapped = (over: Record<string, unknown> = {}) => facts({ registryOwner: WRAPPER, nameToId: 7n, idToName: KEY, ownerOf: ACCOUNT, ...over })
const stranded = (over: Record<string, unknown> = {}) => facts({ registryOwner: WRAPPER, waitForWrap: ACCOUNT, ...over })
const plan = (action: string, state: unknown, request: Record<string, unknown> = {}) => planManage({ action, label: 'harbor', account: ACCOUNT, ...request } as never, state as never)
const kinds = (made: { steps: { kind: string }[] }) => made.steps.map((step) => step.kind)

describe('transferProblem', () => {
  it('names why an address cannot receive a name, and accepts one that can', () => {
    expect(transferProblem('', ACCOUNT)).toMatch(/Enter the address/)
    expect(transferProblem('hello', ACCOUNT)).toMatch(/not an Ethereum address/)
    expect(transferProblem(ZERO_ADDRESS, ACCOUNT)).toMatch(/zero address/)
    expect(transferProblem(ACCOUNT, ACCOUNT)).toMatch(/your own/)
    expect(transferProblem(ACCOUNT.toLowerCase(), ACCOUNT)).toMatch(/your own/)
    for (const contract of [REGISTRY, PROXY, WRAPPER]) expect(transferProblem(contract, ACCOUNT)).toMatch(/Linagee contracts/)
    expect(transferProblem(RIVAL, ACCOUNT)).toBeNull()
    expect(transferProblem(RIVAL.toLowerCase(), ACCOUNT)).toBeNull()
  })

  it('refuses an address whose capitals are wrong', () => {
    const wrong = RIVAL.replace(/[a-f]/, (letter) => letter.toUpperCase() === letter ? letter.toLowerCase() : letter.toUpperCase())
    expect(wrong).not.toBe(RIVAL)
    expect(transferProblem(wrong, ACCOUNT)).toMatch(/not an Ethereum address/)
  })
})

describe('planManage: what is not the account\'s', () => {
  it('sends nothing for a name that is free or held by another account', () => {
    expect(plan('setPrimary', facts({ registryOwner: ZERO_ADDRESS })).problem).toMatch(/not registered/)
    expect(plan('setPrimary', facts({ registryOwner: RIVAL })).problem).toMatch(/held by another account/)
    expect(plan('setPrimary', wrapped({ ownerOf: RIVAL })).problem).toMatch(/held by another account/)
  })

  it('sends a stranded name only to be wrapped, and says which action finishes it', () => {
    const refused = plan('setSite', stranded(), { site: SITE })
    expect(refused).toMatchObject({ steps: [], fix: 'wrap' })
    expect(kinds(plan('wrap', stranded()))).toEqual(['wrap'])
    expect(plan('wrap', stranded({ wrapEnabled: false })).problem).toMatch(/switched off/)
  })
})

describe('planManage: records', () => {
  it('sets the site as the controller or the holder of an unwrapped name, naming the account first only when another controller stands', () => {
    expect(kinds(plan('setSite', facts(), { site: SITE }))).toEqual(['record'])
    expect(kinds(plan('setSite', facts({ controller: ZERO_ADDRESS }), { site: SITE }))).toEqual(['record'])
    expect(kinds(plan('setSite', facts({ controller: RIVAL }), { site: SITE }))).toEqual(['setController', 'record'])
  })

  it('writes the contract of a web3 site as its own record, with a checksummed address', () => {
    const made = plan('setSite', facts(), { site: SITE, contract: RIVAL.toLowerCase() })
    expect(made.steps.map((step: { textKey?: string }) => step.textKey)).toEqual(['content.ipfs', 'contentcontract'])
    expect(made.steps[1]?.value).toBe(RIVAL)
    expect(kinds(plan('setSite', facts(), { site: null, contract: RIVAL }))).toEqual(['record'])
    expect(plan('setSite', facts(), { site: null, contract: null }).problem).toMatch(/Enter the address/)
  })

  it('refuses to set a site on a wrapped name its controller does not hold, and points at the fix', () => {
    expect(plan('setSite', wrapped({ controller: RIVAL }), { site: SITE })).toMatchObject({ steps: [], fix: 'fixController' })
    expect(kinds(plan('setSite', wrapped(), { site: SITE }))).toEqual(['record'])
  })

  it('writes the records that exist again, and clears the ones asked for', () => {
    const state = facts({ values: { 'content.ipfs': SITE.text, 'content.bzz': `bzz://${'ab'.repeat(32)}` } })
    expect(plan('reconfirm', state, { keys: ['content.ipfs', 'content.arw'] }).steps.map((step: { value?: string }) => step.value)).toEqual([SITE.text])
    expect(plan('reconfirm', state, { keys: ['content.arw'] }).problem).toMatch(/no record/)
    expect(kinds(plan('clear', state, { keys: ['content.ipfs', 'content.bzz'] }))).toEqual(['unsetRecord', 'unsetRecord'])
    expect(plan('clear', wrapped({ controller: ZERO_ADDRESS, values: { 'content.ipfs': SITE.text } }), { keys: ['content.ipfs'] })).toMatchObject({ steps: [], fix: 'fixController' })
  })

  it('names the account the controller before it clears, as setting a site does: a previous holder\'s controller could write the record back', () => {
    const values = { 'content.ipfs': SITE.text }
    expect(kinds(plan('clear', facts({ controller: RIVAL, values }), { keys: ['content.ipfs'] }))).toEqual(['setController', 'unsetRecord'])
    expect(kinds(plan('clear', facts({ controller: ZERO_ADDRESS, values }), { keys: ['content.ipfs'] }))).toEqual(['unsetRecord'])
    expect(kinds(plan('clear', facts({ controller: ACCOUNT, values }), { keys: ['content.ipfs'] }))).toEqual(['unsetRecord'])
    expect(kinds(plan('clear', wrapped({ controller: ACCOUNT, values }), { keys: ['content.ipfs'] }))).toEqual(['unsetRecord'])
  })
})

describe('planManage: the primary name', () => {
  it('sets it once, and says it replaces the one the account has', () => {
    const made = plan('setPrimary', facts({ primary: keyOf('older') }))
    expect(kinds(made)).toEqual(['setPrimary'])
    expect(made.notes.join(' ')).toMatch(/replaces your primary name, older\.og/)
    expect(plan('setPrimary', facts()).notes).toEqual([])
    expect(plan('setPrimary', facts({ primary: KEY, resolvesTo: ACCOUNT })).problem).toMatch(/already your primary/)
  })
})

describe('planManage: the controller', () => {
  it('is one transaction for an unwrapped name, and nothing when it is fine already', () => {
    expect(kinds(plan('fixController', facts({ controller: RIVAL })))).toEqual(['setController'])
    expect(plan('fixController', facts({ controller: ACCOUNT })).problem).toMatch(/fine/)
    expect(plan('fixController', facts({ controller: ZERO_ADDRESS })).problem).toMatch(/fine/)
  })

  it('unwraps, names the account, and wraps again for a wrapped name, with the token it unwraps', () => {
    const made = plan('fixController', wrapped({ controller: RIVAL }))
    expect(kinds(made)).toEqual(['unwrap', 'setController', 'createWrapper', 'transfer', 'wrap'])
    expect(made.steps[0]).toMatchObject({ tokenId: '7', call: 'unwrap(7)' })
    expect(plan('fixController', wrapped()).problem).toMatch(/already the controller/)
  })

  it('finishes what a stop left: an unwrapped name that was wrapped when the person started, and a stranded one', () => {
    expect(kinds(plan('fixController', facts({ controller: ACCOUNT }), { rewrap: true }))).toEqual(['createWrapper', 'transfer', 'wrap'])
    expect(kinds(plan('fixController', facts({ controller: RIVAL }), { rewrap: true }))).toEqual(['setController', 'createWrapper', 'transfer', 'wrap'])
    expect(kinds(plan('fixController', stranded(), { rewrap: true }))).toEqual(['wrap'])
  })

  it('removes the controller of a wrapped name before it is given away, in one series', () => {
    expect(kinds(plan('cleanUp', wrapped()))).toEqual(['unwrap', 'unsetController', 'createWrapper', 'transfer', 'wrap'])
    expect(plan('cleanUp', wrapped({ controller: ZERO_ADDRESS })).problem).toMatch(/no controller already/)
    expect(plan('cleanUp', facts()).problem).toMatch(/for a wrapped name/)
  })

  it('does not unwrap when wrapping is off, because the name could not be wrapped again', () => {
    expect(plan('fixController', wrapped({ controller: RIVAL, wrapEnabled: false })).problem).toMatch(/switched off/)
    expect(plan('cleanUp', wrapped({ wrapEnabled: null })).steps).toEqual([])
  })
})

describe('planManage: wrapping and unwrapping', () => {
  it('wraps an unwrapped name with the account as controller, and writes the records that counted again', () => {
    const state = facts({ controller: ZERO_ADDRESS, values: { 'content.ipfs': SITE.text } })
    const made = plan('wrap', state, { keep: [{ key: 'content.ipfs', text: SITE.text }, { key: 'content.bzz', text: 'gone' }] })
    expect(kinds(made)).toEqual(['setController', 'createWrapper', 'transfer', 'wrap', 'record'])
    expect(kinds(plan('wrap', facts({ values: { 'content.ipfs': SITE.text } }), { keep: [{ key: 'content.ipfs', text: SITE.text }] }))).toEqual(['createWrapper', 'transfer', 'wrap', 'record'])
    expect(plan('wrap', wrapped()).problem).toMatch(/already/)
    expect(plan('wrap', facts({ wrapEnabled: false })).problem).toMatch(/switched off/)
  })

  it('unwraps a wrapped name and writes the records that counted again, which the unwrap made stale', () => {
    const made = plan('unwrap', wrapped({ values: { 'content.ipfs': SITE.text } }), { keep: [{ key: 'content.ipfs', text: SITE.text }] })
    expect(kinds(made)).toEqual(['unwrap', 'record'])
    expect(plan('unwrap', facts()).problem).toMatch(/not wrapped/)
  })
})

describe('planManage: giving a name away', () => {
  it('hands an unwrapped name over after removing the controller and ending the primary name when asked', () => {
    const state = facts({ primary: KEY, resolvesTo: ACCOUNT })
    const made = plan('transfer', state, { to: RIVAL.toLowerCase(), unsetController: true, unsetPrimary: true })
    expect(kinds(made)).toEqual(['unsetPrimary', 'unsetController', 'giveName'])
    expect(made.steps[2]).toMatchObject({ to: RIVAL })
    expect(kinds(plan('transfer', state, { to: RIVAL }))).toEqual(['giveName'])
    expect(kinds(plan('transfer', facts({ controller: ZERO_ADDRESS }), { to: RIVAL, unsetController: true }))).toEqual(['giveName'])
    expect(kinds(plan('transfer', facts(), { to: RIVAL, unsetPrimary: true }))).toEqual(['giveName'])
  })

  it('sends the token of a wrapped name, and says the controller stays', () => {
    const made = plan('transfer', wrapped(), { to: RIVAL })
    expect(kinds(made)).toEqual(['sendToken'])
    expect(made.steps[0]).toMatchObject({ tokenId: '7', to: RIVAL })
    expect(made.notes.join(' ')).toMatch(/controller stays/)
  })

  it('names the problem with the address before anything', () => {
    expect(plan('transfer', facts(), { to: ACCOUNT }).problem).toMatch(/your own/)
    expect(plan('transfer', wrapped(), { to: WRAPPER }).problem).toMatch(/Linagee contracts/)
  })
})

describe('the limits of the new steps', () => {
  it('leave room for what each used on a fork, and name the contract and the call', () => {
    const made = plan('fixController', wrapped({ controller: RIVAL }))
    for (const step of made.steps) {
      expect(step.gas).toBeGreaterThan(0)
      expect(step.contract).not.toBe('')
      expect(step.call).toMatch(/\(/)
    }
    expect(GAS.unwrap).toBeGreaterThan(69_000)
  })
})
