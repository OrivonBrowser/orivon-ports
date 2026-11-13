import { describe, expect, it } from 'vitest'
import { toChecksumAddress, ZERO_ADDRESS } from '../site/sdk/abi.js'
import { ChainError } from '../site/sdk/chain.js'
import { callQueue, orivonChain } from '../site/sdk/chain-orivon.js'
import { keyOf } from '../site/resolver/og-name.js'
import { WRAPPER } from '../site/resolver/og-pins.js'
import { createRegistration, gateOf, offerOf, verifyAfter } from '../site/register-flow.js'
import { freezeTip } from '../site/register-tip.js'
import { orivonSender } from '../site/register-send.js'
import { ACCOUNT, linageeWorld, RIVAL, TIP_ADDRESS, type WorldOptions } from './support/linagee-world.ts'

const LABEL = 'harbor'
const KEY = keyOf(LABEL)
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const SITE = { key: 'content.ipfs', text: `ipfs://${CID}` }
const TIP = { to: TIP_ADDRESS, wei: 500_000_000_000_000n, name: 'orivonstack.eth' }
const calm = { sleep: async () => {} }

type Setup = ReturnType<typeof linageeWorld>
interface Request { label: string, account: string, wrapped: boolean, site: { key: string, text: string } | null, tip: { to: string, wei: bigint, name: string } | null, private: boolean }
const REQUEST: Request = { label: LABEL, account: ACCOUNT, wrapped: true, site: SITE, tip: TIP, private: false }

function run (setup: Setup, request: Partial<Request> = {}) {
  const chain = orivonChain(setup.orivon as never, { queue: callQueue({ burst: 100_000, perSecond: 100_000 }) })
  const sender = orivonSender({ orivon: setup.orivon as never, chain, relay: { send: async () => { throw new Error('the relay was not asked for') } } })
  const states: Record<string, any>[] = []
  const registration = createRegistration({ chain, sender, onState: (state) => states.push(state), clock: calm, wait: { intervalMs: 0, timeoutMs: 1000 } })
  return registration.start({ ...REQUEST, ...request }).then((view) => ({ view, states, setup }))
}
const labels = (setup: Setup) => setup.world.log.map((one) => one.label)
const sentTo = (setup: Setup) => setup.world.log.map((one) => one.to.toLowerCase())
const world = (initial = {}, options: WorldOptions = {}) => linageeWorld(initial, { tip: TIP_ADDRESS, plan: true, ...options })

describe('a wrapped registration with a site and a tip', () => {
  it('signs the series once, sends each step after the one before it was mined, and ends with the token, the site and the tip', async () => {
    const setup = world()
    const { view } = await run(setup)
    expect(view['phase']).toBe('done')
    expect(view['signing']).toBe('series')
    expect(setup.world.signatures).toBe(1)
    expect(labels(setup)).toEqual(['reserve', 'setController', 'createWrapper', 'transfer', 'wrap', 'setTextRecord', 'tip'])
    expect(setup.world.log.every((one) => one.status === 1)).toBe(true)
    const { state } = setup.world
    expect(state.owner[KEY]).toBe(WRAPPER)
    expect(Object.values(state.tokenOwner)).toEqual([ACCOUNT])
    expect(state.controller[KEY]).toBe(ACCOUNT)
    expect(state.texts[KEY]).toEqual({ [SITE.key]: SITE.text })
    expect(state.balances[TIP_ADDRESS.toLowerCase()]).toBe(TIP.wei)
    expect(view['steps'].map((step: Record<string, any>) => step['state'])).toEqual(Array(7).fill('done'))
  })

  it('counts the gas of every mined step and the tip it sent', async () => {
    const setup = world()
    const { view } = await run(setup)
    expect(view['costs'].gasUsed).toBe(setup.world.log.reduce((sum, one) => sum + one.gasUsed, 0))
    expect(view['costs'].tipWei).toBe(TIP.wei)
    expect(view['costs'].feeWei).toBe(BigInt(view['costs'].gasUsed) * 1_000_000_000n)
  })

  it('sends nothing the series was not signed for, and the nonces follow each other', async () => {
    const setup = world()
    await run(setup)
    expect(setup.world.signed).toHaveLength(7)
    expect(setup.world.sent).toHaveLength(7)
    expect(setup.world.state.nonces[ACCOUNT.toLowerCase()]).toBe(7)
  })
})

describe('an unwrapped registration', () => {
  it('reserves, writes the site and tips, with no controller step and none of the wrapper\'s', async () => {
    const setup = world()
    const { view } = await run(setup, { wrapped: false })
    expect(view['phase']).toBe('done')
    expect(labels(setup)).toEqual(['reserve', 'setTextRecord', 'tip'])
    expect(setup.world.state.owner[KEY]).toBe(ACCOUNT)
    expect(sentTo(setup).some((to) => to === WRAPPER.toLowerCase())).toBe(false)
  })

  it('removes a controller the name was reserved with before, so a previous holder cannot write its records', async () => {
    const setup = world({ controller: { [KEY]: RIVAL } })
    const { view } = await run(setup, { wrapped: false })
    expect(view['phase']).toBe('done')
    expect(labels(setup)).toEqual(['reserve', 'setController', 'setTextRecord', 'tip'])
    expect(setup.world.state.controller[KEY]).toBe(ACCOUNT)
  })
})

describe('a name taken while the series runs', () => {
  it('stops after the reserve that did nothing, sends no other step and no tip, and says what it cost', async () => {
    const setup = world()
    setup.world.before.set(0, (state) => { state.owner[KEY] = RIVAL })
    const { view } = await run(setup)
    expect(view['phase']).toBe('stopped')
    expect(view['outcome']).toMatchObject({ kind: 'taken', at: 'reserve', offer: null })
    expect(labels(setup)).toEqual(['reserve:none'])
    expect(setup.world.state.balances[TIP_ADDRESS.toLowerCase()]).toBeUndefined()
    expect(view['costs'].tipWei).toBe(0n)
    expect(view['costs'].gasUsed).toBe(23_749)
    expect(view['steps'].slice(1).every((step: Record<string, any>) => step['state'] === 'dropped')).toBe(true)
  })

  it('stops before signing when the name is already held', async () => {
    const setup = world({ owner: { [KEY]: RIVAL } })
    const { view } = await run(setup)
    expect(view['outcome']).toMatchObject({ kind: 'taken', at: null })
    expect(setup.world.signatures).toBe(0)
    expect(setup.world.log).toHaveLength(0)
  })
})

describe('wrapping switched off', () => {
  it('stops before signing, leaves the name free and offers an unwrapped registration', async () => {
    const setup = world({ wrapEnabled: false })
    const { view } = await run(setup)
    expect(view['outcome']).toMatchObject({ kind: 'wrapOff', at: null, offer: 'unwrapped' })
    expect(setup.world.signatures).toBe(0)
    expect(setup.world.log).toHaveLength(0)
    const again = await run(setup, { wrapped: false })
    expect(again.view['phase']).toBe('done')
    expect(setup.world.state.owner[KEY]).toBe(ACCOUNT)
  })

  it('is read again before createWrapper, so the name stays in the registry and is never handed over', async () => {
    const setup = world()
    setup.world.before.set(1, (state) => { state.wrapEnabled = false })
    const { view } = await run(setup)
    expect(view['outcome']).toMatchObject({ kind: 'wrapOff', at: 'createWrapper', offer: 'unwrapped' })
    expect(labels(setup)).toEqual(['reserve', 'setController'])
    expect(setup.world.state.owner[KEY]).toBe(ACCOUNT)
    expect(setup.world.state.balances[TIP_ADDRESS.toLowerCase()]).toBeUndefined()
  })

  it('is read again before wrap: the wrapper holds the name and the person is offered "Finish wrapping", which works once it is back on', async () => {
    const setup = world()
    setup.world.before.set(3, (state) => { state.wrapEnabled = false })
    const { view } = await run(setup)
    expect(view['outcome']).toMatchObject({ kind: 'wrapOffLate', at: 'wrap', offer: 'finishWrapping' })
    expect(labels(setup)).toEqual(['reserve', 'setController', 'createWrapper', 'transfer'])
    expect(setup.world.state.owner[KEY]).toBe(WRAPPER)
    expect(setup.world.state.waitForWrap[KEY]).toBe(ACCOUNT)
    const waiting = await run(setup)
    expect(waiting.view['outcome']).toMatchObject({ kind: 'wrapOffLate', at: null, offer: 'finishWrapping' })
    setup.world.change((state) => { state.wrapEnabled = true })
    const done = await run(setup, { site: null })
    expect(done.view['phase']).toBe('done')
    expect(done.view['situation']).toBe('stranded')
    expect(Object.values(setup.world.state.tokenOwner)).toEqual([ACCOUNT])
  })
})

describe('the tip', () => {
  it('is not planned when it is not ticked', async () => {
    const setup = world()
    const { view } = await run(setup, { tip: null })
    expect(view['phase']).toBe('done')
    expect(labels(setup)).not.toContain('tip')
    expect(view['costs'].tipWei).toBe(0n)
  })

  it('is not sent when a step before it failed', async () => {
    const setup = world()
    setup.world.before.set(4, (state) => { state.owner[KEY] = RIVAL })
    const { view } = await run(setup)
    expect(view['phase']).toBe('stopped')
    expect(setup.world.state.balances[TIP_ADDRESS.toLowerCase()]).toBeUndefined()
  })
})

describe('a wallet that signs one transaction at a time', () => {
  it('asks for each signature when its turn comes', async () => {
    const setup = world({}, { plan: false })
    const { view } = await run(setup)
    expect(view['signing']).toBe('each')
    expect(view['phase']).toBe('done')
    expect(setup.world.signatures).toBe(7)
    expect(setup.world.state.texts[KEY]).toEqual({ [SITE.key]: SITE.text })
  })

  it('stops with what is done when the person declines a later signature, and sends nothing more', async () => {
    const setup = world({}, { plan: false, declineSignature: 3 })
    const { view } = await run(setup)
    expect(view['outcome']).toMatchObject({ kind: 'declined', at: 'transfer' })
    expect(labels(setup)).toEqual(['reserve', 'setController', 'createWrapper'])
    expect(setup.world.state.owner[KEY]).toBe(ACCOUNT)
    expect(view['outcome'].offer).toBe('retry')
  })

  it('sends nothing when the person declines the whole series', async () => {
    const setup = world({}, { declineSignature: 0 })
    const { view } = await run(setup)
    expect(view['outcome']).toMatchObject({ kind: 'declined' })
    expect(setup.world.log).toHaveLength(0)
  })
})

describe('a series that stopped, started again', () => {
  it('plans only what is missing, from the chain', async () => {
    const setup = world({}, { declineSignature: 1, plan: false })
    await run(setup)
    expect(labels(setup)).toEqual(['reserve'])
    const rest = await run(setup)
    expect(rest.view['situation']).toBe('mine')
    expect(rest.view['phase']).toBe('done')
    expect(labels(setup)).toEqual(['reserve', 'setController', 'createWrapper', 'transfer', 'wrap', 'setTextRecord', 'tip'])
  })

  it('has nothing to send for a name the person already holds as a token', async () => {
    const setup = world()
    await run(setup, { site: null, tip: null })
    const count = setup.world.log.length
    const again = await run(setup, { site: null, tip: null })
    expect(again.view['phase']).toBe('done')
    expect(setup.world.log).toHaveLength(count)
  })
})

describe('a tip to an address that holds code', () => {
  const contract = { tipContract: { gas: 52_000 } }
  const frozenFor = async (setup: Setup) => {
    const chain = orivonChain(setup.orivon as never, { queue: callQueue({ burst: 100_000, perSecond: 100_000 }) })
    return await freezeTip(chain, { ticked: true, amountText: '0.0005', shown: TIP_ADDRESS, account: ACCOUNT })
  }

  it('is signed with the gas the contract needs, so it is mined where 21,000 would have failed', async () => {
    const setup = world({}, contract)
    const frozen = await frozenFor(setup)
    expect(frozen.status).toBe('ok')
    const { view } = await run(setup, { wrapped: false, site: null, tip: frozen.tip })
    expect(view['phase']).toBe('done')
    expect(labels(setup)).toEqual(['reserve', 'tip'])
    expect(setup.world.state.balances[TIP_ADDRESS.toLowerCase()]).toBe(TIP.wei)
  })

  it('says with the series that the tip was left out, and why', async () => {
    const setup = world({}, { tipContract: { reverts: true } })
    const chain = orivonChain(setup.orivon as never, { queue: callQueue({ burst: 100_000, perSecond: 100_000 }) })
    const frozen = await freezeTip(chain, { ticked: true, amountText: '0.0005', shown: TIP_ADDRESS, account: ACCOUNT })
    expect(frozen).toMatchObject({ status: 'none', tip: null })
    const words = 'words' in frozen ? frozen.words : ''
    expect(words).toMatch(/does not accept a plain transfer/)
    const { view } = await run(setup, { wrapped: false, site: null, tip: null, notes: [words] } as never)
    expect(view['phase']).toBe('done')
    expect(view['notes']).toEqual([words])
    expect(labels(setup)).toEqual(['reserve'])
  })

  it('reverts at 21,000, which is what a tip signed without a look at the address would have got', async () => {
    const setup = world({}, contract)
    const { view } = await run(setup, { wrapped: false, site: null })
    expect(view['outcome']).toMatchObject({ kind: 'reverted', at: 'tip' })
    expect(setup.world.state.balances[TIP_ADDRESS.toLowerCase()]).toBeUndefined()
  })
})

describe('Continue after a stop at the tip', () => {
  /** A flow whose chain loses sight of the tip: the wait for its receipt times out, and with `hidden` the receipt is never found afterwards either. */
  function losingSightOfTheTip (setup: Setup, hidden: boolean) {
    const base = orivonChain(setup.orivon as never, { queue: callQueue({ burst: 100_000, perSecond: 100_000 }) })
    const unseen = new Set<string>()
    const chain = {
      ...base,
      waitForReceipt: async (hash: string, options: never) => {
        const receipt = await base.waitForReceipt(hash, options)
        if (setup.world.log.at(-1)?.label !== 'tip') return receipt
        if (hidden) unseen.add(hash)
        throw new ChainError('timeout', 'no receipt within the wait', { hash })
      },
      getTransactionReceipt: async (hash: string) => unseen.has(hash) ? null : await base.getTransactionReceipt(hash)
    }
    const sender = orivonSender({ orivon: setup.orivon as never, chain: chain as never, relay: { send: async () => { throw new Error('the relay was not asked for') } } })
    return createRegistration({ chain: chain as never, sender, onState: () => {}, clock: calm, wait: { intervalMs: 0, timeoutMs: 1000 } })
  }
  const tips = (setup: Setup) => setup.world.log.filter((one) => one.label === 'tip')

  it('reads the tip\'s receipt first: a tip that was mined is not sent again, and the person is told', async () => {
    const setup = world()
    const flow = losingSightOfTheTip(setup, false)
    const first = await flow.start(REQUEST)
    expect(first['outcome']).toMatchObject({ kind: 'unknownOutcome', at: 'tip', offer: 'retry' })
    expect(first['request'].earlier.tip).toEqual({ hash: tips(setup)[0]?.hash, maybeSent: true })
    const again = await flow.start(first['request'])
    expect(again['phase']).toBe('done')
    expect(tips(setup)).toHaveLength(1)
    expect(setup.world.state.balances[TIP_ADDRESS.toLowerCase()]).toBe(TIP.wei)
    expect(again['notes'].join(' ')).toMatch(/tip was already sent/)
    expect(labels(setup)).toHaveLength(7)
  })

  it('never plans the tip again while it is not known whether it went out, and says so', async () => {
    const setup = world()
    const flow = losingSightOfTheTip(setup, true)
    const first = await flow.start(REQUEST)
    const again = await flow.start(first['request'])
    expect(again['phase']).toBe('done')
    expect(tips(setup)).toHaveLength(1)
    expect(again['steps']).toEqual([])
    expect(again['notes'].join(' ')).toMatch(/not known whether your earlier tip went out/)
    const third = await flow.start(again['request'])
    expect(tips(setup)).toHaveLength(1)
    expect(third['notes'].join(' ')).toMatch(/not known whether your earlier tip went out/)
  })

  it('sends a tip the person declined to sign, once, and writes no record that was written already', async () => {
    const setup = world({}, { plan: false, declineSignature: 6 })
    const first = await run(setup)
    expect(first.view['outcome']).toMatchObject({ kind: 'declined', at: 'tip' })
    expect(first.view['request'].earlier.tip).toEqual({ hash: null, maybeSent: false })
    const again = await run(setup, first.view['request'])
    expect(again.view['phase']).toBe('done')
    expect(again.view['steps'].map((step: Record<string, any>) => step['kind'])).toEqual(['tip'])
    expect(labels(setup)).toEqual(['reserve', 'setController', 'createWrapper', 'transfer', 'wrap', 'setTextRecord', 'tip'])
    expect(setup.world.state.balances[TIP_ADDRESS.toLowerCase()]).toBe(TIP.wei)
  })

  it('keeps what was finished across stops, so a second Continue does not write the record either', async () => {
    const setup = world()
    const flow = losingSightOfTheTip(setup, false)
    const first = await flow.start(REQUEST)
    const second = await flow.start(first['request'])
    expect(second['request'].earlier.done).toContain('record:content.ipfs')
    expect(second['request'].earlier.tip.maybeSent).toBe(true)
  })
})

describe('the rule of each step, on its own', () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    key: KEY, registryOwner: ACCOUNT, nameToId: 0n, idToName: null, ownerOf: null, controller: ZERO_ADDRESS, values: {}, waitForWrap: ZERO_ADDRESS, wrapEnabled: true, ...over
  })
  const step = (kind: string) => ({ kind }) as never

  it('never lets transfer go to the wrapper unless this series saw createWrapper succeed', () => {
    const ready = facts({ waitForWrap: ACCOUNT })
    expect(gateOf(step('transfer'), ready as never, { account: ACCOUNT, created: false })).toEqual({ ok: false, stop: 'unsafe' })
    expect(gateOf(step('transfer'), ready as never, { account: ACCOUNT, created: true })).toEqual({ ok: true })
    expect(gateOf(step('transfer'), facts() as never, { account: ACCOUNT, created: true })).toEqual({ ok: false, stop: 'unsafe' })
  })

  it('does not reserve a name that has an owner, and does not wrap while wrapping is off', () => {
    expect(gateOf(step('reserve'), facts({ registryOwner: RIVAL }) as never, { account: ACCOUNT, created: false })).toEqual({ ok: false, stop: 'taken' })
    expect(gateOf(step('reserve'), facts({ registryOwner: ZERO_ADDRESS }) as never, { account: ACCOUNT, created: false })).toEqual({ ok: true })
    expect(gateOf(step('createWrapper'), facts({ wrapEnabled: false }) as never, { account: ACCOUNT, created: false })).toEqual({ ok: false, stop: 'wrapOff' })
    expect(gateOf(step('createWrapper'), facts({ wrapEnabled: null }) as never, { account: ACCOUNT, created: false })).toEqual({ ok: false, stop: 'wrapOff' })
    const held = facts({ registryOwner: WRAPPER, waitForWrap: ACCOUNT })
    expect(gateOf(step('wrap'), { ...held, wrapEnabled: false } as never, { account: ACCOUNT, created: true })).toEqual({ ok: false, stop: 'wrapOffLate' })
    expect(gateOf(step('wrap'), held as never, { account: ACCOUNT, created: true })).toEqual({ ok: true })
    expect(gateOf(step('wrap'), { ...held, waitForWrap: RIVAL } as never, { account: ACCOUNT, created: true })).toEqual({ ok: false, stop: 'unsafe' })
  })

  it('checks after each step what the step was for', () => {
    expect(verifyAfter(step('reserve'), facts() as never, { account: ACCOUNT })).toEqual({ ok: true })
    expect(verifyAfter(step('reserve'), facts({ registryOwner: RIVAL }) as never, { account: ACCOUNT })).toEqual({ ok: false, stop: 'taken' })
    expect(verifyAfter(step('createWrapper'), facts() as never, { account: ACCOUNT })).toEqual({ ok: false, stop: 'unexpected' })
    expect(verifyAfter(step('transfer'), facts({ registryOwner: WRAPPER }) as never, { account: ACCOUNT })).toEqual({ ok: true })
    const token = facts({ registryOwner: WRAPPER, nameToId: 7n, idToName: KEY, ownerOf: ACCOUNT })
    expect(verifyAfter(step('wrap'), token as never, { account: ACCOUNT })).toEqual({ ok: true })
    expect(verifyAfter(step('wrap'), { ...token, ownerOf: RIVAL } as never, { account: ACCOUNT })).toEqual({ ok: false, stop: 'unexpected' })
  })

  it('offers an unwrapped registration only for a name the person can still keep', () => {
    expect(offerOf('wrapOff', facts() as never, ACCOUNT)).toBe('unwrapped')
    expect(offerOf('wrapOff', facts({ registryOwner: ZERO_ADDRESS }) as never, ACCOUNT)).toBe('unwrapped')
    expect(offerOf('wrapOff', facts({ registryOwner: RIVAL }) as never, ACCOUNT)).toBeNull()
    expect(offerOf('taken', facts() as never, ACCOUNT)).toBeNull()
    expect(offerOf('wrapOffLate', facts() as never, ACCOUNT)).toBe('finishWrapping')
    expect(offerOf('reverted', facts() as never, ACCOUNT)).toBe('retry')
  })
})

describe('a stopped series in words', () => {
  it('says of a stop at the tip that Continue never pays a second tip while it is not known whether the first went out', async () => {
    const { outcomeWords } = await import('../site/register-words.js')
    const view = { name: 'harbor.og', steps: [], costs: { feeWei: 0n, tipWei: 0n }, outcome: { kind: 'unknownOutcome', at: 'tip', hash: `0x${'12'.repeat(32)}`, offer: 'retry' } }
    const words = outcomeWords(view)
    expect(words.title).toBe('It is not known whether your tip went out.')
    expect(words.lines.join(' ')).toMatch(/never sends a second tip/)
    expect(outcomeWords({ ...view, outcome: { ...view.outcome, at: 'wrap' } }).title).toBe('It is not known whether the last step went out.')
  })

  it('names what was done, what was not sent and what it cost', async () => {
    const { outcomeWords } = await import('../site/register-words.js')
    const setup = world()
    setup.world.before.set(0, (state) => { state.owner[KEY] = RIVAL })
    const { view } = await run(setup)
    const words = outcomeWords(view)
    expect(words.title).toBe('Someone else took harbor.og first.')
    expect(words.lines.join(' ')).toMatch(/neither was the tip/)
    expect(words.lines.join(' ')).toMatch(/cost 0\.0000237\d* ETH in gas|cost [0-9.]+ ETH in gas/)
  })
})
