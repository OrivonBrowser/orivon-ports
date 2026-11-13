import { describe, expect, it } from 'vitest'
import { keyOf } from '../site/resolver/og-name.js'
import { WRAPPER } from '../site/resolver/og-pins.js'
import { createApp } from '../site/app.js'
import { createStore } from '../site/store.js'
import { ACCOUNT, linageeWorld, RIVAL, TIP_ADDRESS } from './support/linagee-world.ts'

const key = (label: string) => keyOf(label)
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

function page (initial: Record<string, unknown> = {}) {
  const setup = linageeWorld(initial as never, { tip: TIP_ADDRESS, plan: true })
  const store = createStore(null)
  const app = createApp({ orivon: setup.orivon, location: { hash: '' } }, { store })
  return { setup, store, app }
}
const token = { owner: { [key('harbor')]: WRAPPER }, nameToId: { [key('harbor')]: 5n }, idToName: { '5': key('harbor') }, tokenOwner: { '5': ACCOUNT } }

describe('the list of names the page loads', () => {
  it('joins the wrapper\'s tokens, the names this device remembers and the names the contracts hint at', async () => {
    const { app, store } = page({ ...token, owner: { ...token.owner, [key('lantern')]: ACCOUNT, [key('hinted')]: ACCOUNT }, primary: { [ACCOUNT.toLowerCase()]: key('hinted') } })
    store.remember(ACCOUNT, 'lantern')
    const loaded = await app.loadNames(ACCOUNT)
    expect(loaded.listed).toEqual([
      { label: 'harbor', source: 'token', tokenId: '5' }, { label: 'lantern', source: 'added', tokenId: null }, { label: 'hinted', source: 'hint', tokenId: null }
    ])
  })

  it('keeps a name added by hand only when the account holds it', async () => {
    const { app, store } = page({ owner: { [key('mine')]: ACCOUNT, [key('theirs')]: RIVAL } })
    expect((await app.addName('mine', ACCOUNT)).kind).toBe('added')
    expect((await app.addName('theirs', ACCOUNT)).kind).toBe('theirs')
    expect((await app.addName('nobody', ACCOUNT)).kind).toBe('free')
    expect(store.names(ACCOUNT)).toEqual(['mine'])
    app.forgetName(ACCOUNT, 'mine')
    expect(store.names(ACCOUNT)).toEqual([])
  })
})

describe('what a series leaves on this device', () => {
  it('remembers an unwrapped name it registered, so the list can show it', async () => {
    const { app, store } = page()
    const ended = await app.register({ label: 'harbor', account: ACCOUNT, wrapped: false, site: null, tip: null, private: false })
    expect(ended?.['phase']).toBe('done')
    expect(store.names(ACCOUNT)).toEqual(['harbor'])
  })

  it('remembers nothing for a series that sent nothing', async () => {
    const { app, store } = page({ owner: { [key('harbor')]: RIVAL } })
    const ended = await app.manageName({ action: 'setPrimary', label: 'harbor', account: ACCOUNT } as never)
    expect(ended?.['phase']).toBe('refused')
    expect(store.names(ACCOUNT)).toEqual([])
  })

  it('keeps the request a stop continues, with the choice to wrap again that the flow made', async () => {
    const { app } = page({ ...token, controller: { [key('harbor')]: RIVAL } })
    await app.manageName({ action: 'fixController', label: 'harbor', account: ACCOUNT } as never)
    expect(app.managing.request).toMatchObject({ action: 'fixController', rewrap: true })
  })

  it('has the request a stop continues in place when the stop is drawn, not only after the series ended', async () => {
    const { app, setup } = page({ ...token, controller: { [key('harbor')]: RIVAL } })
    setup.world.before.set(1, (state) => { state.wrapEnabled = false })
    const seen: unknown[] = []
    app.onManage(() => { if (app.managing.state['phase'] === 'stopped') seen.push(app.managing.request) })
    await app.manageName({ action: 'fixController', label: 'harbor', account: ACCOUNT } as never)
    expect(seen[0]).toMatchObject({ action: 'fixController', rewrap: true })
  })

  it('runs one series at a time: a second is refused while the first is under way', async () => {
    const { app } = page({ owner: { [key('harbor')]: ACCOUNT }, controller: { [key('harbor')]: RIVAL } })
    const first = app.manageName({ action: 'fixController', label: 'harbor', account: ACCOUNT } as never)
    expect(app.busy()).toBe(true)
    expect(await app.register({ label: 'other', account: ACCOUNT, wrapped: false, site: null, tip: null, private: false })).toBeNull()
    expect(await app.manageName({ action: 'setPrimary', label: 'harbor', account: ACCOUNT } as never)).toBeNull()
    expect((await first)?.['phase']).toBe('done')
    expect(app.busy()).toBe(false)
  })
})

describe('starting over', () => {
  it('forgets a finished or stopped registration and its request, and tells the panels, so "Register another name" and "Cancel" work', async () => {
    const { app } = page()
    expect(typeof app.resetRegistration).toBe('function')
    await app.register({ label: 'harbor', account: ACCOUNT, wrapped: false, site: null, tip: null, private: false })
    expect(app.registration.state['phase']).toBe('done')
    expect(app.registration.request).not.toBeNull()
    let told = 0
    app.onRegistration(() => { told++ })
    app.resetRegistration()
    expect(app.registration.state).toEqual({ phase: 'idle' })
    expect(app.registration.request).toBeNull()
    expect(told).toBe(1)
  })

  it('forgets a change to a name the same way', async () => {
    const { app } = page({ owner: { [key('harbor')]: ACCOUNT }, controller: { [key('harbor')]: RIVAL } })
    await app.manageName({ action: 'fixController', label: 'harbor', account: ACCOUNT } as never)
    app.resetManage()
    expect(app.managing.state).toEqual({ phase: 'idle' })
    expect(app.managing.request).toBeNull()
  })
})

describe('the Orivon ID check', () => {
  it('finds a username the person types, reads it on chain, and remembers it', async () => {
    const { app, store } = page({ ids: { alice: ACCOUNT } })
    const check = await app.idCheck(ACCOUNT, { extra: ['alice'] })
    expect(check).toMatchObject({ phase: 'read' })
    expect(check.phase === 'read' && check.names.map((one) => [one.label, one.attribution.ok])).toEqual([['alice', true]])
    expect(store.idNames()).toEqual(['alice'])
  })

  it('does not show a username another address holds, and reads once for an address it has read', async () => {
    const { app, setup } = page({ ids: { alice: RIVAL } })
    const check = await app.idCheck(ACCOUNT, { extra: ['alice'] })
    expect(check.phase === 'read' && check.names).toEqual([])
    const before = setup.calls.length
    await app.idCheck(ACCOUNT)
    expect(setup.calls.length).toBe(before)
  })
})
