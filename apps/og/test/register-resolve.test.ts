import { describe, expect, it } from 'vitest'
import { callQueue, orivonChain } from '../site/sdk/chain-orivon.js'
import { CENSUS_FORMAT, type Census } from '../site/resolver/og-census.js'
import { keyOf } from '../site/resolver/og-name.js'
import { inspectOg, resolveOg } from '../site/resolver/og-names.js'
import { IMPLEMENTATION, UPGRADES } from '../site/resolver/og-pins.js'
import { createSession } from '../site/resolver/og-tail.js'
import { createRegistration } from '../site/register-flow.js'
import { orivonSender } from '../site/register-send.js'
import { ACCOUNT, BASE_BLOCK, linageeWorld, RIVAL, TIP_ADDRESS } from './support/linagee-world.ts'

const LABEL = 'harbor'
const KEY = keyOf(LABEL)
const SITE = { key: 'content.ipfs', text: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }
const OLD = 'ipfs://bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4'
const census = (): Census => ({ format: CENSUS_FORMAT, block: BASE_BLOCK - 100, blockHash: `0x${'00'.repeat(32)}`, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names: {} })

/** A registration through the page's flow in a simulated chain, then the resolver's own answer for the name on that same chain. */
async function registerAndResolve (initial = {}, request: Record<string, unknown> = {}) {
  const setup = linageeWorld(initial, { tip: TIP_ADDRESS, plan: true })
  const chain = orivonChain(setup.orivon as never, { queue: callQueue({ burst: 1e6, perSecond: 1e6 }) })
  const sender = orivonSender({ orivon: setup.orivon as never, chain, relay: { send: async () => { throw new Error('no relay') } } })
  const registration = createRegistration({ chain, sender, onState: () => {}, clock: { sleep: async () => {} }, wait: { intervalMs: 0, timeoutMs: 1000 } })
  const view = await registration.start({ label: LABEL, account: ACCOUNT, wrapped: true, site: SITE, tip: null, private: false, ...request } as never)
  const lookup = { session: createSession(), census: census() }
  return { setup, view, answer: await resolveOg(chain, `${LABEL}.og`, lookup), inspected: await inspectOg(chain, LABEL, { session: createSession(), census: census() }, { latest: true }) }
}

describe('what the resolver answers after the page registers a name', () => {
  it('counts the site of a wrapped registration: the controller is the holder and the record came after the wrap', async () => {
    const { view, answer, inspected } = await registerAndResolve()
    expect(view['phase']).toBe('done')
    expect(answer.records).toEqual([{ type: 'ipfs', value: SITE.text }])
    expect(inspected.holder).toMatchObject({ found: true, wrapped: true, holder: ACCOUNT })
    expect(inspected.verdict?.keys['content.ipfs']?.reason).toBe('passes')
  })

  it('counts the site of an unwrapped registration', async () => {
    const { view, answer } = await registerAndResolve({}, { wrapped: false })
    expect(view['phase']).toBe('done')
    expect(answer.records).toEqual([{ type: 'ipfs', value: SITE.text }])
  })

  it('counts the site of a registration finished after the wrapper switched off and on again', async () => {
    const setup = linageeWorld({}, { plan: true })
    const chain = orivonChain(setup.orivon as never, { queue: callQueue({ burst: 1e6, perSecond: 1e6 }) })
    const sender = orivonSender({ orivon: setup.orivon as never, chain, relay: { send: async () => { throw new Error('no relay') } } })
    const registration = createRegistration({ chain, sender, onState: () => {}, clock: { sleep: async () => {} }, wait: { intervalMs: 0, timeoutMs: 1000 } })
    setup.world.before.set(3, (state) => { state.wrapEnabled = false })
    const stopped = await registration.start({ label: LABEL, account: ACCOUNT, wrapped: true, site: SITE, tip: null, private: false } as never)
    expect(stopped['outcome']).toMatchObject({ kind: 'wrapOffLate', offer: 'finishWrapping' })
    setup.world.change((state) => { state.wrapEnabled = true })
    const finished = await registration.start({ label: LABEL, account: ACCOUNT, wrapped: true, site: SITE, tip: null, private: false } as never)
    expect(finished['phase']).toBe('done')
    const answer = await resolveOg(chain, `${LABEL}.og`, { session: createSession(), census: census() })
    expect(answer.records).toEqual([{ type: 'ipfs', value: SITE.text }])
  })

  it('does not count a record a previous holder left, and names the new holder the controller so the old one cannot write', async () => {
    const left = { controller: { [KEY]: RIVAL }, texts: { [KEY]: { 'content.ipfs': OLD } } }
    const { view, setup, inspected } = await registerAndResolve(left, { wrapped: false, site: null })
    expect(view['phase']).toBe('done')
    expect(view['steps'].map((step: Record<string, unknown>) => step['id'])).toEqual(['reserve', 'setController'])
    expect(setup.world.state.controller[KEY]).toBe(ACCOUNT)
    expect(inspected.verdict?.records).toEqual([])
    expect(inspected.verdict?.keys['content.ipfs']?.reason).toBe('no-SetTextRecord-log')
  })

  it('counts a new site written over what a previous holder left', async () => {
    const left = { controller: { [KEY]: RIVAL }, texts: { [KEY]: { 'content.ipfs': OLD } } }
    const { answer } = await registerAndResolve(left, { wrapped: false })
    expect(answer.records).toEqual([{ type: 'ipfs', value: SITE.text }])
  })
})
