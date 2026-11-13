import { describe, expect, it } from 'vitest'
import { ChainError } from '../site/sdk/chain.js'
import { toHex } from '../site/sdk/bytes.js'
import { keccak256 } from '../site/sdk/keccak.js'
import { callQueue, orivonChain } from '../site/sdk/chain-orivon.js'
import { keyOf } from '../site/resolver/og-name.js'
import { createRegistration, offerOf } from '../site/register-flow.js'
import { createWrapperTx, reserveTx, tipTx } from '../site/register-tx.js'
import { extensionSender, orivonSender } from '../site/register-send.js'
import { OFFER_LABELS, outcomeWords } from '../site/register-words.js'
import { RELAY_WORDS, RelayError } from '../site/relay.js'
import { ACCOUNT, linageeWorld, TIP_ADDRESS, type WorldOptions } from './support/linagee-world.ts'

const KEY = keyOf('harbor')
const quiet = { send: async (): Promise<string> => { throw new Error('the relay was not asked for') } }
function build (initial = {}, options: WorldOptions = {}, relay: { send: (raw: Uint8Array) => Promise<string> } = quiet) {
  const setup = linageeWorld(initial, { tip: TIP_ADDRESS, ...options })
  const chain = orivonChain(setup.orivon as never, { queue: callQueue({ burst: 1e6, perSecond: 1e6 }) })
  return { setup, chain, sender: orivonSender({ orivon: setup.orivon as never, chain, relay }) }
}
const reserve = { ...reserveTx(KEY), gas: 70_000 }

describe('the Orivon sender with a wallet that signs a series', () => {
  it('asks for the series once, in the groups it needs, and sends the signed bytes unchanged', async () => {
    const { setup, sender } = build({}, { plan: true })
    expect(await sender.prepare(ACCOUNT, [reserve, { ...tipTx(TIP_ADDRESS, 1n), gas: 21_000 }])).toEqual({ signed: true })
    expect(setup.uses).toEqual([{ codes: ['ETH_0_1', 'ETH_NET_0_1'], groups: ['addresses', 'sign', 'plan', 'broadcast'] }])
    const hash = await sender.send(0, ACCOUNT, reserve, { private: false })
    expect(hash).toBe(setup.world.sent[0])
    expect(setup.calls.filter((call) => call.fn.endsWith('.signTransaction'))).toHaveLength(0)
    expect(setup.calls.filter((call) => call.fn.endsWith('.signTransactions'))).toHaveLength(1)
  })

  it('refuses a wallet that signs fewer transactions than it was given', async () => {
    const { setup, sender } = build({}, { plan: true })
    const real = setup.orivon.use.bind(setup.orivon)
    setup.orivon.use = async (codes, options) => {
      const handles = (await real(codes, options)) as Record<string, any>[]
      return handles.map((handle) => handle['signTransactions'] === undefined ? handle : { ...handle, signTransactions: async () => [] })
    }
    await expect(sender.prepare(ACCOUNT, [reserve])).rejects.toMatchObject({ reason: 'badAnswer' })
  })
})

describe('the Orivon sender with a wallet that signs one transaction at a time', () => {
  it('signs when the step\'s turn comes, with the nonce, the fees and a limit the estimate cannot exceed', async () => {
    const { setup, sender } = build({}, { plan: false })
    expect(await sender.prepare(ACCOUNT, [reserve])).toEqual({ signed: false })
    expect(setup.world.signatures).toBe(0)
    const hash = await sender.send(0, ACCOUNT, reserve, { private: false })
    expect(setup.world.signatures).toBe(1)
    const signed = setup.calls.find((call) => call.fn.endsWith('.signTransaction'))?.args[0] as Record<string, unknown>
    expect(signed).toMatchObject({ from: ACCOUNT, nonce: 0, chainId: 1, gas: 70_000, maxFeePerGas: expect.stringMatching(/^0x/), maxPriorityFeePerGas: expect.stringMatching(/^0x/) })
    expect(setup.world.log[0]?.hash).toBe(hash)
  })

  it('does not ask the wallet to sign a step the node says would fail', async () => {
    const { setup, sender } = build({}, { plan: false })
    await expect(sender.send(0, ACCOUNT, { ...createWrapperTx(KEY), gas: 90_000 }, { private: false })).rejects.toMatchObject({ reason: 'reverted' })
    expect(setup.world.signatures).toBe(0)
  })

  it('reads the broadcast that took too long as an outcome nobody knows, with its hash', async () => {
    const { setup, sender } = build({}, { plan: true })
    const real = setup.orivon.use.bind(setup.orivon)
    setup.orivon.use = async (codes, options) => {
      const handles = (await real(codes, options)) as Record<string, any>[]
      return handles.map((handle) => handle['sendRawTransaction'] === undefined ? handle : { ...handle, sendRawTransaction: async () => { throw Object.assign(new Error('slow'), { code: 'timeout' }) } })
    }
    await sender.prepare(ACCOUNT, [reserve])
    const failure = await sender.send(0, ACCOUNT, reserve, { private: false }).catch((error) => error)
    expect(failure).toBeInstanceOf(ChainError)
    expect(failure).toMatchObject({ reason: 'unknownOutcome', hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) })
  })
})

describe('the private send', () => {
  it('sends every step through the relay, and a registration completes through it', async () => {
    const relayed: string[] = []
    const holder: { setup?: ReturnType<typeof linageeWorld> } = {}
    const relay = { send: async (raw: Uint8Array) => { relayed.push(`0x${toHex(keccak256(raw))}`); return holder.setup!.mine(raw) } }
    const { setup, chain, sender } = build({}, { plan: true }, relay)
    holder.setup = setup
    const registration = createRegistration({ chain, sender, onState: () => {}, clock: { sleep: async () => {} }, wait: { intervalMs: 0, timeoutMs: 1000 } })
    const view = await registration.start({ label: 'harbor', account: ACCOUNT, wrapped: false, site: null, tip: null, private: true })
    expect(view['phase']).toBe('done')
    expect(relayed).toHaveLength(1)
    expect(setup.world.sent).toHaveLength(0)
  })

  it('counts a relay that may have sent the transaction as sent, and stops the series as not known', async () => {
    const relay = { send: async (): Promise<string> => { throw new RelayError('timeout', 'the relay did not answer', { maybeSent: true }) } }
    const { chain, sender } = build({}, { plan: true }, relay)
    const registration = createRegistration({ chain, sender, onState: () => {}, clock: { sleep: async () => {} }, wait: { intervalMs: 0, timeoutMs: 1000 } })
    const view = await registration.start({ label: 'harbor', account: ACCOUNT, wrapped: false, site: null, tip: null, private: true })
    expect(view['outcome']).toMatchObject({ kind: 'unknownOutcome' })
  })

  it('names the hash of the transaction a relay may have sent, so its receipt can be read later', async () => {
    const relay = { send: async (): Promise<string> => { throw new RelayError('timeout', 'the relay did not answer', { maybeSent: true }) } }
    const { chain, sender } = build({}, { plan: true }, relay)
    const registration = createRegistration({ chain, sender, onState: () => {}, clock: { sleep: async () => {} }, wait: { intervalMs: 0, timeoutMs: 1000 } })
    const view = await registration.start({ label: 'harbor', account: ACCOUNT, wrapped: false, site: null, tip: null, private: true })
    expect(view['outcome'].hash).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('a relay that did not take the transaction', () => {
  const request = { label: 'harbor', account: ACCOUNT, wrapped: false, site: null, tip: null, private: true }
  const failing = (maybeSent: boolean) => ({ send: async (): Promise<string> => { throw new RelayError(maybeSent ? 'timeout' : 'rejected', 'the relay said no', { maybeSent }) } })

  it('offers to send publicly in place of a private retry, in the relay\'s own words', async () => {
    const { chain, sender } = build({}, { plan: true }, failing(false))
    const registration = createRegistration({ chain, sender, onState: () => {}, clock: { sleep: async () => {} }, wait: { intervalMs: 0, timeoutMs: 1000 } })
    const view = await registration.start(request)
    expect(view['outcome']).toMatchObject({ kind: 'unavailable', offer: 'public' })
    const words = outcomeWords(view)
    expect(words.lines).toContain(RELAY_WORDS.failed)
    expect(OFFER_LABELS['public']).toBe('Send publicly')
  })

  it('offers it for a relay that may have passed the transaction on, and says it may still be mined', async () => {
    const { chain, sender } = build({}, { plan: true }, failing(true))
    const registration = createRegistration({ chain, sender, onState: () => {}, clock: { sleep: async () => {} }, wait: { intervalMs: 0, timeoutMs: 1000 } })
    const view = await registration.start(request)
    expect(view['outcome']).toMatchObject({ kind: 'unknownOutcome', offer: 'public' })
    expect(outcomeWords(view).lines.join(' ')).toMatch(/may still be mined/)
  })

  it('finishes the registration when the same request is sent publicly, with the steps that were not sent', async () => {
    const { setup, chain, sender } = build({}, { plan: true }, failing(false))
    const registration = createRegistration({ chain, sender, onState: () => {}, clock: { sleep: async () => {} }, wait: { intervalMs: 0, timeoutMs: 1000 } })
    const stopped = await registration.start(request)
    expect(setup.world.log).toHaveLength(0)
    const view = await registration.start({ ...stopped['request'], private: false })
    expect(view['phase']).toBe('done')
    expect(setup.world.state.owner[keyOf('harbor')]).toBe(ACCOUNT)
  })

  it('leaves the offer of a node that did not answer as it was', () => {
    expect(offerOf('unavailable', { registryOwner: ACCOUNT } as never, ACCOUNT)).toBe('retry')
    expect(offerOf('unavailable', { registryOwner: ACCOUNT } as never, ACCOUNT, new RelayError('rejected', 'no'))).toBe('public')
  })
})

describe('the wallet extension sender', () => {
  it('cannot send privately and sends each step as one request', async () => {
    const sent: unknown[] = []
    const sender = extensionSender({ sendTransaction: async (tx: unknown) => { sent.push(tx); return `0x${'12'.repeat(32)}` } } as never)
    expect(sender.canSendPrivately).toBe(false)
    expect(await sender.prepare(ACCOUNT, [])).toEqual({ signed: false })
    await expect(sender.send(0, ACCOUNT, reserve, { private: true })).rejects.toMatchObject({ reason: 'invalid' })
    expect(sent).toHaveLength(0)
    expect(await sender.send(0, ACCOUNT, reserve, { private: false })).toBe(`0x${'12'.repeat(32)}`)
    expect(sent[0]).toMatchObject({ from: ACCOUNT, to: reserve.to, gas: 70_000 })
  })
})
