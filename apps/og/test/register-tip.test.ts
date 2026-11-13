import { describe, expect, it } from 'vitest'
import { ZERO_ADDRESS } from '../site/sdk/abi.js'
import { callQueue, orivonChain } from '../site/sdk/chain-orivon.js'
import { freezeTip, parseEther, resolveTipAddress, settleTip, TIP, tipAmount, tipPlanOf } from '../site/register-tip.js'
import { ACCOUNT, linageeWorld, RIVAL, TIP_ADDRESS } from './support/linagee-world.ts'

const chainOf = (options: Parameters<typeof linageeWorld>[1]) => orivonChain(linageeWorld({}, options).orivon as never, { queue: callQueue({ burst: 1e6, perSecond: 1e6 }) })

describe('the amount', () => {
  it('reads ether as decimal digits', () => {
    expect(parseEther('0.0005')).toBe(500_000_000_000_000n)
    expect(parseEther('1')).toBe(10n ** 18n)
    expect(parseEther(' 0.000000000000000001 ')).toBe(1n)
    for (const bad of ['', '.', '-1', '1e3', '0x10', '1,5', '0.0000000000000000001', 'abc']) expect(parseEther(bad), bad).toBeNull()
  })

  it('defaults to 0.0005 ETH and takes at most 0.005 ETH', () => {
    expect(TIP.defaultWei).toBe(parseEther(TIP.defaultText))
    expect(tipAmount('0.0005')).toEqual({ ok: true, wei: 500_000_000_000_000n })
    expect(tipAmount('0.005')).toEqual({ ok: true, wei: 5_000_000_000_000_000n })
    expect(tipAmount('0.0050000001')).toMatchObject({ ok: false, words: expect.stringMatching(/at most 0\.005/) })
    expect(tipAmount('0')).toMatchObject({ ok: false })
    expect(tipAmount('nothing')).toMatchObject({ ok: false })
  })
})

describe('tipPlanOf', () => {
  const found = { ok: true as const, address: TIP_ADDRESS }
  it('is nothing when it is not ticked, whatever else is wrong', () => {
    expect(tipPlanOf({ ticked: false, amountText: 'nonsense', lookup: null })).toEqual({ tip: null, blocks: false, words: '' })
  })
  it('blocks the registration on a wrong amount and not on a failed lookup', () => {
    expect(tipPlanOf({ ticked: true, amountText: '9', lookup: found })).toMatchObject({ tip: null, blocks: true })
    expect(tipPlanOf({ ticked: true, amountText: '0.0005', lookup: { ok: false, words: 'orivonstack.eth could not be looked up right now, so no tip will be sent.' } }))
      .toMatchObject({ tip: null, blocks: false, words: expect.stringMatching(/no tip will be sent/) })
    expect(tipPlanOf({ ticked: true, amountText: '0.0005', lookup: null })).toMatchObject({ tip: null, blocks: false, words: expect.stringMatching(/Looking up/) })
  })
  it('is the amount to the address the name resolved to', () => {
    expect(tipPlanOf({ ticked: true, amountText: '0.001', lookup: found })).toEqual({ tip: { to: TIP_ADDRESS, wei: 10n ** 15n, name: 'orivonstack.eth' }, blocks: false, words: '' })
  })
})

describe('the lookup', () => {
  it('asks the person\'s node for what the name resolves to, at this moment', async () => {
    expect(await resolveTipAddress(chainOf({ tip: TIP_ADDRESS }))).toEqual({ ok: true, address: TIP_ADDRESS })
  })
  it('leaves the tip out, in words, when the lookup fails', async () => {
    expect(await resolveTipAddress(chainOf({ tip: null }))).toMatchObject({ ok: false, words: expect.stringMatching(/could not be looked up right now, so no tip will be sent/) })
  })
  it('leaves the tip out when the name points to no address', async () => {
    expect(await resolveTipAddress(chainOf({ tip: ZERO_ADDRESS }))).toMatchObject({ ok: false, words: expect.stringMatching(/points to no address/) })
  })
  it('says so when Orivon does not let the page look the name up', async () => {
    expect(await resolveTipAddress(chainOf({ tip: TIP_ADDRESS, decline: ['ETH_NET_0_1_READONLY'] }))).toMatchObject({ ok: false, words: expect.stringMatching(/did not let this page/) })
  })
})

describe('freezeTip', () => {
  it('sends the tip to the address looked up when Register is pressed, when it is the one the review showed', async () => {
    const chain = chainOf({ tip: TIP_ADDRESS })
    expect(await freezeTip(chain, { ticked: true, amountText: '0.0005', shown: TIP_ADDRESS })).toEqual({ status: 'ok', tip: { to: TIP_ADDRESS, wei: 500_000_000_000_000n, name: 'orivonstack.eth' } })
    expect(await freezeTip(chain, { ticked: true, amountText: '0.0005', shown: null })).toMatchObject({ status: 'ok' })
  })
  it('stops for a new look when the name moved since the review showed an address', async () => {
    const frozen = await freezeTip(chainOf({ tip: RIVAL }), { ticked: true, amountText: '0.0005', shown: TIP_ADDRESS })
    expect(frozen).toMatchObject({ status: 'changed', tip: null, address: RIVAL, words: expect.stringMatching(/press Register again/) })
  })
  it('is no tip when unticked, when the lookup fails, and an invalid one when the amount is wrong', async () => {
    expect(await freezeTip(chainOf({ tip: TIP_ADDRESS }), { ticked: false, amountText: '0.0005', shown: null })).toMatchObject({ status: 'none', tip: null })
    expect(await freezeTip(chainOf({ tip: null }), { ticked: true, amountText: '0.0005', shown: TIP_ADDRESS })).toMatchObject({ status: 'none', tip: null })
    expect(await freezeTip(chainOf({ tip: TIP_ADDRESS }), { ticked: true, amountText: '1', shown: null })).toMatchObject({ status: 'invalid' })
  })
})

describe('freezeTip, when the address has code', () => {
  const frozen = (tipContract: Parameters<typeof linageeWorld>[1] extends infer O ? O extends { tipContract?: infer C } ? C : never : never) =>
    freezeTip(chainOf({ tip: TIP_ADDRESS, tipContract }), { ticked: true, amountText: '0.0005', shown: TIP_ADDRESS, account: ACCOUNT })

  it('signs a tip to a plain address with the 21,000 gas of a transfer, naming no limit of its own', async () => {
    const found = await freezeTip(chainOf({ tip: TIP_ADDRESS }), { ticked: true, amountText: '0.0005', shown: TIP_ADDRESS, account: ACCOUNT })
    expect(found).toEqual({ status: 'ok', tip: { to: TIP_ADDRESS, wei: 500_000_000_000_000n, name: 'orivonstack.eth' } })
  })

  it('gives a tip to a contract what the node estimates for it and a quarter more', async () => {
    expect(await frozen({ gas: 52_000 })).toEqual({ status: 'ok', tip: { to: TIP_ADDRESS, wei: 500_000_000_000_000n, name: 'orivonstack.eth', gas: 65_000 } })
  })

  it('caps the limit at 100,000, and leaves the tip out when the estimate is above it', async () => {
    expect(await frozen({ gas: 90_000 })).toMatchObject({ status: 'ok', tip: { gas: 100_000 } })
    expect(await frozen({ gas: 100_001 })).toMatchObject({ status: 'none', tip: null, words: expect.stringMatching(/needs more gas than a tip may use/) })
  })

  it('leaves the tip out and says why when the contract would not take it', async () => {
    expect(await frozen({ reverts: true })).toMatchObject({ status: 'none', tip: null, words: expect.stringMatching(/contract.*does not accept a plain transfer/) })
  })

  it('leaves the tip out when the node cannot say what the address holds', async () => {
    const world = linageeWorld({}, { tip: TIP_ADDRESS })
    const chain = orivonChain(world.orivon as never, { queue: callQueue({ burst: 1e6, perSecond: 1e6 }) })
    const found = await freezeTip({ ...chain, getCode: async () => { throw new Error('down') } } as never, { ticked: true, amountText: '0.0005', shown: TIP_ADDRESS, account: ACCOUNT })
    expect(found).toMatchObject({ status: 'none', tip: null, words: expect.stringMatching(/could not be looked up/) })
  })
})

describe('settleTip', () => {
  const HASH = `0x${'12'.repeat(32)}`
  const chainWith = (answer: () => Promise<unknown>) => ({ getTransactionReceipt: answer }) as never

  it('leaves the tip as asked when no earlier run reached one, or the earlier one never went out', async () => {
    const never = chainWith(async () => { throw new Error('no receipt was asked for') })
    expect(await settleTip(never, null)).toEqual({ status: 'open', words: null })
    expect(await settleTip(never, { hash: null, maybeSent: false })).toEqual({ status: 'open', words: null })
  })

  it('leaves a tip out that was mined, and says its transaction', async () => {
    const found = await settleTip(chainWith(async () => ({ status: 1 })), { hash: HASH, maybeSent: true })
    expect(found.status).toBe('paid')
    expect(found.words).toContain(HASH)
  })

  it('plans a tip again that was mined and failed, and tells the person', async () => {
    const found = await settleTip(chainWith(async () => ({ status: 0 })), { hash: HASH, maybeSent: true })
    expect(found).toMatchObject({ status: 'open', words: expect.stringMatching(/mined and failed/) })
  })

  it('never plans a tip again whose outcome is not known: no receipt yet, a node that does not answer, or no hash to look for', async () => {
    for (const earlier of [{ hash: HASH, maybeSent: true }, { hash: null, maybeSent: true }]) {
      expect((await settleTip(chainWith(async () => null), earlier)).status).toBe('unknown')
      expect((await settleTip(chainWith(async () => { throw new Error('down') }), earlier)).status).toBe('unknown')
    }
    expect((await settleTip(chainWith(async () => null), { hash: HASH, maybeSent: true })).words).toMatch(/not known whether your earlier tip went out/)
  })
})
