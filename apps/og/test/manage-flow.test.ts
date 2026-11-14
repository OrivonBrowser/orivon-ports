import { describe, expect, it } from 'vitest'
import { ZERO_ADDRESS } from '../site/sdk/abi.js'
import { keyOf } from '../site/resolver/og-name.js'
import { WRAPPER } from '../site/resolver/og-pins.js'
import { gateManage, verifyManage } from '../site/manage-flow.js'
import { ACCOUNT, RIVAL, TIP_ADDRESS } from './support/linagee-world.ts'
import { harness } from './support/manage-harness.ts'

const LABEL = 'harbor'
const KEY = keyOf(LABEL)
const SITE = { key: 'content.ipfs', text: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }
const OLD = 'ipfs://bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4'
const ZERO_KEY = `0x${'0'.repeat(64)}`
const mine = (over: Record<string, unknown> = {}) => ({ owner: { [KEY]: ACCOUNT }, controller: { [KEY]: ACCOUNT }, ...over })
const heldWrapped = (over: Record<string, unknown> = {}) => ({
  owner: { [KEY]: WRAPPER }, controller: { [KEY]: ACCOUNT }, nameToId: { [KEY]: 5n }, idToName: { '5': KEY }, tokenOwner: { '5': ACCOUNT }, nextId: 6n, ...over
})
const ids = (view: Record<string, any>) => view['steps'].map((step: Record<string, any>) => step['id'])

/** A registration through the page's own flow, so the logs the freshness rule reads exist. */
async function registered (wrapped: boolean, initial: Record<string, unknown> = {}) {
  const made = harness(initial)
  const view = await made.registration.start({ label: LABEL, account: ACCOUNT, wrapped, site: SITE, tip: null, private: false })
  expect(view['phase']).toBe('done')
  return made
}

describe('the controller', () => {
  it('is fixed for an unwrapped name in one transaction, and records written before it must be confirmed again to count', async () => {
    const made = harness(mine({ controller: { [KEY]: RIVAL }, texts: { [KEY]: { [SITE.key]: SITE.text } } }))
    expect(await made.answer(LABEL)).toEqual([])
    const view = await made.run({ action: 'fixController', label: LABEL })
    expect(view['phase']).toBe('done')
    expect(made.labels()).toEqual(['setController'])
    expect(made.setup.world.state.controller[KEY]).toBe(ACCOUNT)
    expect(await made.answer(LABEL)).toEqual([])
    const again = await made.run({ action: 'reconfirm', label: LABEL, keys: [SITE.key] })
    expect(again['phase']).toBe('done')
    expect(await made.answer(LABEL)).toEqual([{ type: 'ipfs', value: SITE.text }])
  })

  it('is fixed for a wrapped name by unwrapping, naming the account, and wrapping again: the token changes, and the holder keeps the name', async () => {
    const made = harness(heldWrapped({ controller: { [KEY]: RIVAL } }))
    const view = await made.run({ action: 'fixController', label: LABEL })
    expect(view['phase']).toBe('done')
    expect(ids(view)).toEqual(['unwrap', 'setController', 'createWrapper', 'transfer', 'wrap'])
    expect(made.labels()).toEqual(['unwrap', 'setController', 'createWrapper', 'transfer', 'wrap'])
    const { state } = made.setup.world
    expect(state.owner[KEY]).toBe(WRAPPER)
    expect(state.controller[KEY]).toBe(ACCOUNT)
    expect(state.tokenOwner).toEqual({ '6': ACCOUNT })
    expect(state.nameToId[KEY]).toBe(6n)
    expect((await made.inspect(LABEL)).holder).toMatchObject({ found: true, wrapped: true, holder: ACCOUNT })
    expect(view['request']).toMatchObject({ rewrap: true })
  })

  it('is refused with the reason, and nothing is signed, when it is fine already', async () => {
    const made = harness(mine())
    const view = await made.run({ action: 'fixController', label: LABEL })
    expect(view['phase']).toBe('refused')
    expect(view['problem']).toMatch(/fine/)
    expect(made.setup.world.signatures).toBe(0)
  })

  it('stops with the name unwrapped and yours when wrapping is switched off in the middle, and finishes when it is back', async () => {
    const made = harness(heldWrapped({ controller: { [KEY]: RIVAL } }))
    made.setup.world.before.set(1, (state) => { state.wrapEnabled = false })
    const stopped = await made.run({ action: 'fixController', label: LABEL })
    expect(stopped['phase']).toBe('stopped')
    expect(stopped['outcome']).toMatchObject({ kind: 'wrapOff', at: 'createWrapper', offer: 'unwrapped' })
    expect(made.setup.world.state.owner[KEY]).toBe(ACCOUNT)
    expect(made.setup.world.state.controller[KEY]).toBe(ACCOUNT)
    made.setup.world.change((state) => { state.wrapEnabled = true })
    const finished = await made.manage.start(stopped['request'])
    expect(finished['phase']).toBe('done')
    expect(ids(finished)).toEqual(['createWrapper', 'transfer', 'wrap'])
    expect(Object.values(made.setup.world.state.tokenOwner)).toEqual([ACCOUNT])
  })

  it('refuses to unwrap at all when wrapping is off, so a wrapped name is never left unwrapped by a change that could not end', async () => {
    const made = harness(heldWrapped({ controller: { [KEY]: RIVAL }, wrapEnabled: false }))
    const view = await made.run({ action: 'fixController', label: LABEL })
    expect(view['phase']).toBe('refused')
    expect(made.setup.world.log).toEqual([])
  })
})

describe('giving a name away', () => {
  it('hands an unwrapped name over after removing the controller and ending the primary name, and the resolver then has neither', async () => {
    const made = await registered(false)
    made.setup.world.change((state) => { state.controller[KEY] = ACCOUNT })
    await made.run({ action: 'setPrimary', label: LABEL })
    expect(made.setup.world.state.primary[ACCOUNT.toLowerCase()]).toBe(KEY)
    const view = await made.run({ action: 'transfer', label: LABEL, to: RIVAL.toLowerCase(), unsetController: true, unsetPrimary: true })
    expect(view['phase']).toBe('done')
    expect(ids(view)).toEqual(['unsetPrimary', 'unsetController', 'giveName'])
    const { state } = made.setup.world
    expect(state.owner[KEY]).toBe(RIVAL)
    expect(state.controller[KEY]).toBe(ZERO_ADDRESS)
    expect(state.primary[ACCOUNT.toLowerCase()]).toBeUndefined()
    expect(state.resolveAddress[KEY]).toBeUndefined()
    expect((await made.inspect(LABEL)).holder).toMatchObject({ holder: RIVAL })
  })

  it('leaves the old controller standing when the controller is not removed: the new holder\'s records do not count until it is', async () => {
    const made = await registered(false)
    made.setup.world.change((state) => { state.controller[KEY] = ACCOUNT })
    await made.run({ action: 'transfer', label: LABEL, to: RIVAL, unsetController: false })
    expect(made.setup.world.state.controller[KEY]).toBe(ACCOUNT)
    expect(await made.answer(LABEL)).toEqual([])
    expect((await made.inspect(LABEL)).verdict?.keys[SITE.key]?.reason).toBe('controller-is-not-the-holder')
  })

  it('sends the token of a wrapped name, and the new holder\'s records do not show until the controller is fixed', async () => {
    const made = await registered(true)
    const view = await made.run({ action: 'transfer', label: LABEL, to: RIVAL })
    expect(view['phase']).toBe('done')
    expect(ids(view)).toEqual(['sendToken'])
    expect(Object.values(made.setup.world.state.tokenOwner)).toEqual([RIVAL])
    expect((await made.inspect(LABEL)).holder).toMatchObject({ wrapped: true, holder: RIVAL })
    expect(await made.answer(LABEL)).toEqual([])
  })

  it('cleans a wrapped name first so the token carries no controller, and then the new holder\'s write counts', async () => {
    const made = await registered(true)
    const cleaned = await made.run({ action: 'cleanUp', label: LABEL })
    expect(cleaned['phase']).toBe('done')
    expect(ids(cleaned)).toEqual(['unwrap', 'unsetController', 'createWrapper', 'transfer', 'wrap'])
    expect(made.setup.world.state.controller[KEY]).toBe(ZERO_ADDRESS)
    const sent = await made.run({ action: 'transfer', label: LABEL, to: RIVAL })
    expect(sent['phase']).toBe('done')
    expect((await made.inspect(LABEL)).verdict?.controllerOk).toBe(true)
  })

  it('does not send a name that stopped being the account\'s: nothing is signed for the step, and the stop says so', async () => {
    const made = harness(mine())
    made.setup.world.change((state) => { state.owner[KEY] = RIVAL })
    const view = await made.run({ action: 'transfer', label: LABEL, to: ZERO_ADDRESS })
    expect(view['phase']).toBe('refused')
    const after = harness(mine())
    after.setup.world.before.set(0, (state) => { state.owner[KEY] = RIVAL })
    const raced = await after.run({ action: 'transfer', label: LABEL, to: TIP_ADDRESS, unsetController: false })
    expect(raced['phase']).toBe('stopped')
    expect(raced['outcome']).toMatchObject({ kind: 'unexpected', at: 'giveName' })
    expect(after.setup.world.log[0]?.label).toBe('transfer:none')
  })
})

describe('records', () => {
  it('clears each one asked for, and the resolver answers nothing for them afterwards', async () => {
    const made = await registered(false)
    expect(await made.answer(LABEL)).toEqual([{ type: 'ipfs', value: SITE.text }])
    const view = await made.run({ action: 'clear', label: LABEL, keys: [SITE.key] })
    expect(view['phase']).toBe('done')
    expect(made.setup.world.state.texts[KEY]).toEqual({})
    expect(await made.answer(LABEL)).toEqual([])
  })

  it('clears the leftovers of a previous holder and sets a new site that counts', async () => {
    const made = harness(mine({ texts: { [KEY]: { 'content.ipfs': OLD } } }))
    await made.run({ action: 'clear', label: LABEL, keys: ['content.ipfs'] })
    expect(made.setup.world.state.texts[KEY]).toEqual({})
    const view = await made.run({ action: 'setSite', label: LABEL, site: SITE })
    expect(view['phase']).toBe('done')
    expect(await made.answer(LABEL)).toEqual([{ type: 'ipfs', value: SITE.text }])
  })

  it('takes the controller from a previous holder when it clears what they left, so they cannot write it back', async () => {
    const made = harness(mine({ controller: { [KEY]: RIVAL }, texts: { [KEY]: { 'content.ipfs': OLD } } }))
    const view = await made.run({ action: 'clear', label: LABEL, keys: ['content.ipfs'] })
    expect(view['phase']).toBe('done')
    expect(ids(view)).toEqual(['setController', 'unsetRecord:content.ipfs'])
    expect(made.setup.world.state.controller[KEY]).toBe(ACCOUNT)
    expect(made.setup.world.state.texts[KEY]).toEqual({})
  })

  it('sets the web3 contract beside the site, as a record that counts', async () => {
    const made = harness(mine())
    const view = await made.run({ action: 'setSite', label: LABEL, site: SITE, contract: RIVAL.toLowerCase() })
    expect(view['phase']).toBe('done')
    expect(made.setup.world.state.texts[KEY]).toEqual({ [SITE.key]: SITE.text, contentcontract: RIVAL })
    expect((await made.inspect(LABEL)).verdict?.keys['content.ipfs']?.reason).toBe('passes')
  })

  it('names the account the controller first when another controller stood, so the new record counts', async () => {
    const made = harness(mine({ controller: { [KEY]: RIVAL } }))
    const view = await made.run({ action: 'setSite', label: LABEL, site: SITE })
    expect(ids(view)).toEqual(['setController', 'record:content.ipfs'])
    expect(await made.answer(LABEL)).toEqual([{ type: 'ipfs', value: SITE.text }])
  })
})

describe('the primary name', () => {
  it('replaces the one the account had, and the resolver says the new name is the account\'s', async () => {
    const other = keyOf('older')
    const made = harness(mine({ owner: { [KEY]: ACCOUNT, [other]: ACCOUNT }, primary: { [ACCOUNT.toLowerCase()]: other }, resolveAddress: { [other]: ACCOUNT } }))
    const view = await made.run({ action: 'setPrimary', label: LABEL })
    expect(view['phase']).toBe('done')
    const { state } = made.setup.world
    expect(state.primary[ACCOUNT.toLowerCase()]).toBe(KEY)
    expect(state.resolveAddress[KEY]).toBe(ACCOUNT)
    expect(state.resolveAddress[other]).toBeUndefined()
    expect(view['notes'].join(' ')).toMatch(/replaces your primary name, older\.og/)
  })

  it('is set by the controller of a wrapped name, which the registry owner is not', async () => {
    const made = harness(heldWrapped())
    const view = await made.run({ action: 'setPrimary', label: LABEL })
    expect(view['phase']).toBe('done')
    expect(made.setup.world.state.primary[ACCOUNT.toLowerCase()]).toBe(KEY)
  })

  it('is refused for a wrapped name whose controller is another account', async () => {
    const view = await harness(heldWrapped({ controller: { [KEY]: RIVAL } })).run({ action: 'setPrimary', label: LABEL })
    expect(view['phase']).toBe('refused')
    expect(view['fix']).toBe('fixController')
  })
})

describe('wrapping and unwrapping', () => {
  it('wraps an unwrapped name with its site, which is written again so it still counts', async () => {
    const made = await registered(false)
    const keep = [{ key: SITE.key, text: SITE.text }]
    const view = await made.run({ action: 'wrap', label: LABEL, keep })
    expect(view['phase']).toBe('done')
    expect(ids(view)).toEqual(['setController', 'createWrapper', 'transfer', 'wrap', 'record:content.ipfs'])
    expect(await made.answer(LABEL)).toEqual([{ type: 'ipfs', value: SITE.text }])
  })

  it('drops the site when the records are not written again after a wrap: the freshness rule is why they are', async () => {
    const made = await registered(false)
    await made.run({ action: 'wrap', label: LABEL, keep: [] })
    expect(await made.answer(LABEL)).toEqual([])
  })

  it('unwraps with the site written again', async () => {
    const made = await registered(true)
    const view = await made.run({ action: 'unwrap', label: LABEL, keep: [{ key: SITE.key, text: SITE.text }] })
    expect(view['phase']).toBe('done')
    expect(ids(view)).toEqual(['unwrap', 'record:content.ipfs'])
    expect(made.setup.world.state.owner[KEY]).toBe(ACCOUNT)
    expect(await made.answer(LABEL)).toEqual([{ type: 'ipfs', value: SITE.text }])
  })

  it('finishes wrapping a name the wrapper holds for the account', async () => {
    const made = harness({ owner: { [KEY]: WRAPPER }, waitForWrap: { [KEY]: ACCOUNT } })
    const view = await made.run({ action: 'wrap', label: LABEL })
    expect(view['phase']).toBe('done')
    expect(ids(view)).toEqual(['wrap'])
    expect(Object.values(made.setup.world.state.tokenOwner)).toEqual([ACCOUNT])
  })
})

describe('a wallet that signs each step as its turn comes, and one that declines', () => {
  it('goes through the same steps one confirmation each', async () => {
    const made = harness(mine({ controller: { [KEY]: RIVAL } }), { plan: false })
    const view = await made.run({ action: 'fixController', label: LABEL })
    expect(view['phase']).toBe('done')
    expect(view['signing']).toBe('each')
  })

  it('stops with nothing sent when the person declines', async () => {
    const made = harness(mine({ controller: { [KEY]: RIVAL } }), { declineSignature: 0 })
    const view = await made.run({ action: 'fixController', label: LABEL })
    expect(view['phase']).toBe('stopped')
    expect(view['outcome']).toMatchObject({ kind: 'declined' })
    expect(made.setup.world.log).toEqual([])
  })
})

describe('the rule of each new step', () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    key: KEY, registryOwner: ACCOUNT, nameToId: 0n, idToName: null, ownerOf: null, controller: ACCOUNT, values: {}, waitForWrap: ZERO_ADDRESS, wrapEnabled: true, primary: ZERO_KEY, resolvesTo: ZERO_ADDRESS, ...over
  }) as never
  const held = (over: Record<string, unknown> = {}) => facts({ registryOwner: WRAPPER, nameToId: 5n, idToName: KEY, ownerOf: ACCOUNT, ...over })
  const step = (kind: string, more: Record<string, unknown> = {}) => ({ kind, id: kind, ...more }) as never
  const context = { account: ACCOUNT, created: false }

  it('lets a step through only for the holder who may take it', () => {
    expect(gateManage(step('unwrap', { tokenId: '5' }), held(), context)).toEqual({ ok: true })
    expect(gateManage(step('unwrap', { tokenId: '4' }), held(), context)).toEqual({ ok: false, stop: 'taken' })
    expect(gateManage(step('unwrap', { tokenId: '5' }), held({ ownerOf: RIVAL }), context)).toEqual({ ok: false, stop: 'taken' })
    expect(gateManage(step('giveName'), facts(), context)).toEqual({ ok: true })
    expect(gateManage(step('giveName'), facts({ registryOwner: RIVAL }), context)).toEqual({ ok: false, stop: 'taken' })
    expect(gateManage(step('unsetController'), held(), context)).toEqual({ ok: false, stop: 'taken' })
    expect(gateManage(step('sendToken', { tokenId: '5' }), held(), context)).toEqual({ ok: true })
    expect(gateManage(step('sendToken', { tokenId: '5' }), held({ nameToId: 6n }), context)).toEqual({ ok: false, stop: 'unsafe' })
    expect(gateManage(step('setPrimary'), held({ controller: RIVAL }), context)).toEqual({ ok: false, stop: 'unsafe' })
    expect(gateManage(step('unsetPrimary'), facts({ registryOwner: RIVAL }), context)).toEqual({ ok: true })
  })

  it('accepts a step only when the chain shows what it was for', () => {
    expect(verifyManage(step('unwrap'), facts(), context)).toEqual({ ok: true })
    expect(verifyManage(step('unwrap'), held(), context)).toEqual({ ok: false, stop: 'unexpected' })
    expect(verifyManage(step('unsetController'), facts({ controller: ZERO_ADDRESS }), context)).toEqual({ ok: true })
    expect(verifyManage(step('unsetController'), facts(), context)).toEqual({ ok: false, stop: 'unexpected' })
    expect(verifyManage(step('unsetRecord', { textKey: 'content.ipfs' }), facts({ values: { 'content.ipfs': '' } }), context)).toEqual({ ok: true })
    expect(verifyManage(step('unsetRecord', { textKey: 'content.ipfs' }), facts({ values: { 'content.ipfs': 'x' } }), context)).toEqual({ ok: false, stop: 'unexpected' })
    expect(verifyManage(step('setPrimary'), facts({ primary: KEY, resolvesTo: ACCOUNT }), context)).toEqual({ ok: true })
    expect(verifyManage(step('setPrimary'), facts({ primary: KEY, resolvesTo: RIVAL }), context)).toEqual({ ok: false, stop: 'unexpected' })
    expect(verifyManage(step('unsetPrimary'), facts(), context)).toEqual({ ok: true })
    expect(verifyManage(step('giveName', { to: RIVAL }), facts({ registryOwner: RIVAL }), context)).toEqual({ ok: true })
    expect(verifyManage(step('giveName', { to: RIVAL }), facts(), context)).toEqual({ ok: false, stop: 'unexpected' })
    expect(verifyManage(step('sendToken', { to: RIVAL }), held({ ownerOf: RIVAL }), context)).toEqual({ ok: true })
    expect(verifyManage(step('sendToken', { to: RIVAL }), held(), context)).toEqual({ ok: false, stop: 'unexpected' })
  })
})
