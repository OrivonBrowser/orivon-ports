import { describe, expect, it } from 'vitest'
import { toChecksumAddress } from '../site/sdk/abi.js'
import { ChainError } from '../site/sdk/chain.js'
import { attribution, records } from '../site/sdk/orivonid.js'
import { decide, parseRec, serialPerAccount, storeKey, webStore } from '../site/register-flow.js'
import { makeCommitment, MAX_COMMITMENT_AGE, MIN_COMMITMENT_AGE } from '../site/register-tx.js'
import { RelayError } from '../site/relay.js'
import { harness, type Harness } from './support/flow-harness.ts'

const ALICE = toChecksumAddress('0x' + 'a1'.repeat(20))
const BOB = toChecksumAddress('0x' + 'b0'.repeat(20))
const DAI = 10n ** 18n
const steps = (h: Harness) => h.market.sent.map((sent) => sent.step)

/** Stops a flow the first time `phase` is drawn, as a closed tab would; a send already begun still finishes. */
const stopAt = (phase: string) => {
  const run: { flow?: Harness['flow'], seen: boolean } = { seen: false }
  return { run, onState: (state: Record<string, any>) => { if (state['phase'] === phase && !run.seen) { run.seen = true; run.flow?.stop() } } }
}

async function startedHarness(options: Parameters<typeof harness>[0], label = 'alice') {
  const h = harness(options)
  expect((await h.flow.check(label))['phase']).toBe('ready')
  return h
}

describe('check: what stops a registration before anything is sent', () => {
  const reasonOf = async (input: unknown, options: Partial<Parameters<typeof harness>[0]> = {}) => {
    const h = harness({ account: ALICE, ...options })
    const state = await h.flow.check(input)
    expect(state['phase'] === 'ready' || state['phase'] === 'failed').toBe(true)
    expect(h.market.sent).toEqual([])
    return state['reason'] ?? 'ready'
  }

  it('names the input problems: nothing, not ASCII, not a name the registrar sells, a reserved name', async () => {
    expect(await reasonOf('')).toBe('empty')
    expect(await reasonOf('café')).toBe('notAscii')
    expect(await reasonOf('ab')).toBe('invalidLabel')
    expect(await reasonOf('-ab')).toBe('invalidLabel')
    expect(await reasonOf('0x' + '1'.repeat(40))).toBe('invalidLabel')
    expect(await reasonOf('Orivon')).toBe('reserved')
    expect((await harness({ account: ALICE }).flow.check('ab'))['detail']).toBe('tooShort')
  })

  it('says a held name is taken, and whether the holder is the wallet itself', async () => {
    const other = harness({ account: ALICE, world: { names: { bob: { owner: BOB, resolver: BOB } }, resolvers: {}, registrar: {} } })
    expect(await other.flow.check('bob')).toMatchObject({ phase: 'failed', reason: 'taken', holder: BOB, mine: false })
    const mine = harness({ account: ALICE, world: { names: { bob: { owner: ALICE, resolver: BOB } }, resolvers: {}, registrar: {} } })
    expect(await mine.flow.check('bob')).toMatchObject({ reason: 'taken', mine: true })
  })

  it('says why the sale is closed', async () => {
    expect(await reasonOf('alice', { world: { names: {}, resolvers: {}, registrar: { daiAboveFloor: false } } })).toBe('daiBelowFloor')
    expect(await reasonOf('alice', { world: { names: {}, resolvers: {}, registrar: { beneficiary: 'revert' } } })).toBe('noBeneficiary')
    expect(await reasonOf('alice', { world: { names: {}, resolvers: {}, registrar: {}, r0ToR1: ALICE } })).toBe('v1Unreachable')
  })

  it('says the wallet holds too little DAI, with both numbers', async () => {
    const h = harness({ account: ALICE, dai: 9n * DAI })
    expect(await h.flow.check('alice')).toMatchObject({ reason: 'notEnoughDai', have: 9n * DAI, need: 10n * DAI })
    expect(await reasonOf('abcd', { dai: 199n * DAI })).toBe('notEnoughDai')
    expect(await reasonOf('abcd', { dai: 200n * DAI })).toBe('ready')
  })

  it('stops at the receiver preflight for code that does not take the name token, in words', async () => {
    for (const accountCode of ['rejecting', 'delegating'] as const) {
      const h = harness({ account: ALICE, accountCode })
      const state = await h.flow.check('alice')
      expect(state, accountCode).toMatchObject({ phase: 'failed', reason: 'receiverRefuses', recover: 'none' })
      expect(String(state['words'])).toContain('does not accept the name token')
      expect(h.market.sent).toEqual([])
    }
    expect(String((await harness({ account: ALICE, accountCode: 'delegating' }).flow.check('alice'))['detail'])).toContain('delegates to code')
  })

  it('lets a contract wallet through when its code answers the hook', async () => {
    expect(await harness({ account: ALICE, accountCode: 'accepting' }).flow.check('alice')).toMatchObject({ phase: 'ready', receiver: 'accepts' })
  })

  it('stops for a resolver address held by something that is not the account\'s resolver', async () => {
    expect(await reasonOf('alice', { resolver: 'foreign' })).toBe('resolverBlocked')
    expect(await reasonOf('alice', { resolver: 'noRoles' })).toBe('resolverBlocked')
  })

  it('is ready with the price, the cost to come and the transactions it will take', async () => {
    const h = harness({ account: ALICE, dai: 1000n * DAI })
    const ready = await h.flow.check('  AbCd ')
    expect(ready).toMatchObject({
      phase: 'ready', label: 'abcd', name: 'abcd.v1.orivonid.eth', price: 200n * DAI, advisePrivate: true, resolverMode: 'deploy',
      needs: { approve: true, deployResolver: true }, transactions: ['commit', 'approve', 'deploy', 'register', 'records']
    })
    expect(await harness({ account: ALICE }).flow.check('alice')).toMatchObject({ price: 10n * DAI, advisePrivate: false })
    expect(await harness({ account: ALICE, dai: 1000n * DAI }).flow.check('abc')).toMatchObject({ price: 800n * DAI, advisePrivate: true })
  })

  it('needs no approval when the allowance covers the price, and no deploy for a resolver it can reuse', async () => {
    const ready = await harness({ account: ALICE, allowance: 10n * DAI, resolver: 'ours' }).flow.check('alice')
    expect(ready).toMatchObject({ resolverMode: 'reuse', needs: { approve: false, deployResolver: false }, transactions: ['commit', 'register', 'records'] })
  })
})

describe('a registration from the first look to the end', () => {
  it('commits, approves and deploys while the commitment matures, reveals at once, records, and is done', async () => {
    const h = await startedHarness({ account: ALICE })
    const done = await h.flow.start()
    expect(done).toMatchObject({ phase: 'done', label: 'alice', name: 'alice.v1.orivonid.eth' })
    expect(h.phases()).toEqual(['checking', 'ready', 'committing', 'maturing', 'revealing', 'recording', 'verifying', 'done'])
    expect(steps(h)).toEqual(['commit', 'approve', 'deploy', 'register', 'records'])
    const [commit, , deploy, register] = h.market.sent
    expect(deploy?.ts).toBeLessThan((commit?.ts ?? 0) + MIN_COMMITMENT_AGE)
    expect((register?.ts ?? 0) - (commit?.ts ?? 0)).toBeGreaterThanOrEqual(MIN_COMMITMENT_AGE)
    expect((register?.ts ?? 0) - (commit?.ts ?? 0)).toBeLessThan(MIN_COMMITMENT_AGE + 30)
    expect(h.market.sent.every((sent) => sent.ok)).toBe(true)
    expect(h.market.balanceOf(ALICE)).toBe(90n * DAI)
    expect((await attribution(h.market.chain, 'alice', ALICE)).ok).toBe(true)
    expect(h.store.map.size).toBe(0)
  })

  it('sends each transaction with the estimate plus a quarter as its gas', async () => {
    const h = await startedHarness({ account: ALICE })
    await h.flow.start()
    expect(h.prepares.map((prepared) => prepared.gas)).toEqual([125_000, 125_000, 125_000, 125_000, 125_000])
  })

  it('stores the secret before the commit and each hash before its send', async () => {
    const h = await startedHarness({ account: ALICE })
    await h.flow.start()
    const first = JSON.parse(h.store.writes[0]?.value ?? '{}')
    expect(first.secret).toMatch(/^0x[0-9a-f]{64}$/)
    expect(first.pending).toBeNull()
    expect(first.commitment).toBe(makeCommitment('alice', ALICE, first.resolver, first.secret))
    expect(h.sends.map((send) => send.step)).toEqual(['commit', 'approve', 'deploy', 'register', 'records'])
    for (const send of h.sends) {
      expect(send.stored?.secret, send.step).toBe(first.secret)
      expect(send.stored?.pending, send.step).toMatchObject({ step: send.step, hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) })
      expect(send.stored?.hashes[send.step], send.step).toBe(send.stored?.pending.hash)
    }
  })

  it('skips the approval and the deploy when it need not make them', async () => {
    const h = await startedHarness({ account: ALICE, allowance: 10n * DAI, resolver: 'ours' })
    expect((await h.flow.start())['phase']).toBe('done')
    expect(steps(h)).toEqual(['commit', 'register', 'records'])
    expect(h.market.world.resolvers[h.market.predicted]?.addr).toBe(ALICE)
  })

  it('writes text records with the address in the same call', async () => {
    const h = await startedHarness({ account: ALICE })
    await h.flow.start({ texts: { url: 'https://alice.example' } })
    expect(await records(h.market.chain, 'alice', ['url'])).toMatchObject({ addr: ALICE, texts: { url: 'https://alice.example' } })
    expect(steps(h).filter((step) => step === 'records')).toHaveLength(1)
  })

  it('draws the countdown from block timestamps while the commitment matures', async () => {
    const h = await startedHarness({ account: ALICE, allowance: 10n * DAI, resolver: 'ours' })
    await h.flow.start()
    const waiting = h.states.filter((state) => state['phase'] === 'maturing' && state['secondsToMaturity'] !== undefined)
    expect(waiting.length).toBeGreaterThan(1)
    expect(waiting[0]).toMatchObject({ matureAt: expect.any(Number), expiresAt: expect.any(Number) })
    const left = waiting.map((state) => state['secondsToMaturity'] as number)
    expect(left).toEqual([...left].sort((a, b) => b - a))
    expect((waiting[0]?.['expiresAt'] as number) - (waiting[0]?.['matureAt'] as number)).toBe(MAX_COMMITMENT_AGE - MIN_COMMITMENT_AGE)
  })

  it('refuses to start without a check, and while another registration of the account is stored', async () => {
    const h = harness({ account: ALICE })
    await expect(h.flow.start()).rejects.toThrow('check the name first')
    await h.flow.check('alice')
    const secret = '0x' + '11'.repeat(32)
    h.store.set(storeKey(ALICE), JSON.stringify({ v: 1, label: 'older', owner: ALICE, resolver: ALICE, resolverMode: 'deploy', secret, commitment: makeCommitment('older', ALICE, ALICE, secret), price: String(10n * DAI), pending: null, hashes: {} }))
    expect(await h.flow.start()).toMatchObject({ phase: 'failed', reason: 'pendingExists', label: 'older' })
    expect(h.market.sent).toEqual([])
  })

  it('runs a second start, resume or retry made while it works after the first, sending nothing twice', async () => {
    const h = await startedHarness({ account: ALICE })
    const [first, second, third] = await Promise.all([h.flow.start(), h.flow.start(), h.flow.resume()])
    expect(first).toMatchObject({ phase: 'done' })
    expect(second).toMatchObject({ phase: 'done' })
    expect(third).toBeNull()
    expect(steps(h)).toEqual(['commit', 'approve', 'deploy', 'register', 'records'])
  })
})

describe('a registration picked up after a reload', () => {
  it('continues from the chain after the commit, with the same secret, committing once', async () => {
    const stop = stopAt('maturing')
    const first = await startedHarness({ account: ALICE, onState: stop.onState })
    stop.run.flow = first.flow
    await first.flow.start()
    expect(steps(first)).toEqual(['commit', 'approve'])
    const second = harness({ account: ALICE, market: first.market, store: first.store })
    const done = await second.flow.resume()
    expect(done?.['phase']).toBe('done')
    expect(steps(second)).toEqual(['commit', 'approve', 'deploy', 'register', 'records'])
    expect(first.market.sent.filter((sent) => sent.step === 'commit')).toHaveLength(1)
  })

  it('names every transaction of the plan again from the chain, not from the store, so a reloaded page lists them all', async () => {
    const stop = stopAt('maturing')
    const first = await startedHarness({ account: ALICE, onState: stop.onState })
    stop.run.flow = first.flow
    await first.flow.start()
    expect(steps(first)).toEqual(['commit', 'approve'])
    const stored = JSON.parse(first.store.map.get(storeKey(ALICE)) ?? '{}')
    expect(stored.transactions).toBeUndefined()
    const second = harness({ account: ALICE, market: first.market, store: first.store })
    await second.flow.resume()
    const planned = second.states.filter((state) => Array.isArray(state['transactions']))
    expect(planned.length).toBeGreaterThan(0)
    expect(second.states.find((state) => state['phase'] === 'checking' && state['what'] === 'chain')?.['transactions']).toBeUndefined()
    expect(planned[0]?.['transactions']).toEqual(['commit', 'deploy', 'register', 'records'])
  })

  it('leaves out the approval and the resolver the chain shows are not needed', async () => {
    const stop = stopAt('maturing')
    const first = await startedHarness({ account: ALICE, allowance: 10n * DAI, resolver: 'ours', onState: stop.onState })
    stop.run.flow = first.flow
    await first.flow.start()
    const second = harness({ account: ALICE, market: first.market, store: first.store })
    await second.flow.resume()
    expect(second.states.find((state) => Array.isArray(state['transactions']))?.['transactions']).toEqual(['commit', 'register', 'records'])
  })

  it('does not name a plan once the name is held, for the chain no longer says what was needed', async () => {
    const first = await startedHarness({ account: ALICE })
    first.crash.on = 'records'
    await first.flow.start()
    const second = harness({ account: ALICE, market: first.market, store: first.store })
    await second.flow.resume()
    expect(second.states.some((state) => Array.isArray(state['transactions']))).toBe(false)
  })

  it('continues when the tab closed at the reveal\'s signing prompt', async () => {
    const first = await startedHarness({ account: ALICE })
    first.crash.on = 'register'
    expect((await first.flow.start())).toMatchObject({ phase: 'failed', reason: 'unavailable' })
    expect(steps(first)).toEqual(['commit', 'approve', 'deploy'])
    const stored = JSON.parse(first.store.map.get(storeKey(ALICE)) ?? '{}')
    expect(stored.pending).toBeNull()
    const second = harness({ account: ALICE, market: first.market, store: first.store })
    expect((await second.flow.resume())?.['phase']).toBe('done')
    expect(steps(second)).toEqual(['commit', 'approve', 'deploy', 'register', 'records'])
  })

  it('records after a reveal that was mined before the records, without deploying or paying again', async () => {
    const first = await startedHarness({ account: ALICE })
    first.crash.on = 'records'
    expect(await first.flow.start()).toMatchObject({ phase: 'failed' })
    expect(first.market.world.names['alice']?.owner).toBe(ALICE)
    expect(first.market.world.resolvers[first.market.predicted]?.addr).toBeNull()
    const second = harness({ account: ALICE, market: first.market, store: first.store })
    const done = await second.flow.resume()
    expect(done?.['phase']).toBe('done')
    expect(steps(second)).toEqual(['commit', 'approve', 'deploy', 'register', 'records'])
    expect(second.sends.map((send) => send.step)).toEqual(['records'])
    expect(first.market.balanceOf(ALICE)).toBe(90n * DAI)
  })

  it('deploys on resume when the reveal was mined and the resolver was not', async () => {
    const first = await startedHarness({ account: ALICE, allowance: 10n * DAI })
    first.crash.on = 'deploy'
    await first.flow.start()
    first.crash.on = null
    first.market.advance(MIN_COMMITMENT_AGE)
    const second = harness({ account: ALICE, market: first.market, store: first.store })
    expect((await second.flow.resume())?.['phase']).toBe('done')
    expect(second.sends.map((send) => send.step)).toEqual(['register', 'deploy', 'records'])
  })

  it('waits for a commit that was sent and not yet mined, then goes on', async () => {
    const first = await startedHarness({ account: ALICE })
    first.market.hooks.drop = true
    const stalled = await first.flow.start()
    expect(stalled).toMatchObject({ phase: 'failed', reason: 'notMined', step: 'commit', offerPublic: false })
    const pending = JSON.parse(first.store.map.get(storeKey(ALICE)) ?? '{}').pending
    expect(pending).toMatchObject({ step: 'commit' })
    first.market.includeDropped()
    const second = harness({ account: ALICE, market: first.market, store: first.store })
    expect((await second.flow.resume())?.['phase']).toBe('done')
    expect(second.sends.map((send) => send.step)).toEqual(['approve', 'deploy', 'register', 'records'])
  })

  it('starts again, with a new secret and nothing sent, when the commitment is a day old', async () => {
    const stop = stopAt('maturing')
    const first = await startedHarness({ account: ALICE, onState: stop.onState })
    stop.run.flow = first.flow
    await first.flow.start()
    const oldSecret = JSON.parse(first.store.map.get(storeKey(ALICE)) ?? '{}').secret
    const written = first.store.writes.length
    first.market.advance(MAX_COMMITMENT_AGE + 5)
    const second = harness({ account: ALICE, market: first.market, store: first.store })
    expect(await second.flow.resume()).toMatchObject({ phase: 'ready', expired: true, label: 'alice' })
    expect(second.sends).toEqual([])
    expect(first.store.map.size).toBe(0)
    expect((await second.flow.start())['phase']).toBe('done')
    const secrets = second.store.writes.slice(written).map((write) => JSON.parse(write.value).secret)
    expect(secrets.length).toBeGreaterThan(0)
    expect(secrets.every((secret) => secret !== oldSecret)).toBe(true)
    expect(steps(second).filter((step) => step === 'commit')).toHaveLength(2)
  })

  it('fails as taken, and forgets, when someone else holds the name by the time it can be revealed, sending no reveal', async () => {
    const stop = stopAt('maturing')
    const first = await startedHarness({ account: ALICE, onState: stop.onState })
    stop.run.flow = first.flow
    await first.flow.start()
    first.market.world.names['alice'] = { owner: BOB, resolver: BOB }
    const second = harness({ account: ALICE, market: first.market, store: first.store })
    expect(await second.flow.resume()).toMatchObject({ phase: 'failed', reason: 'taken', holder: BOB, recover: 'edit' })
    expect(first.store.map.size).toBe(0)
    expect(second.sends.map((send) => send.step)).not.toContain('register')
    expect(first.market.balanceOf(ALICE)).toBe(100n * DAI)
  })

  it('has nothing to resume without a stored registration, or with one it cannot read', async () => {
    const h = harness({ account: ALICE })
    expect(await h.flow.resume()).toBeNull()
    h.store.set(storeKey(ALICE), '{"v":1,"label":"x"}')
    expect(await h.flow.resume()).toBeNull()
    h.store.set(storeKey(ALICE), 'not json')
    expect(await h.flow.resume()).toBeNull()
  })

  it('forgets a registration on request, leaving the commitment to lapse', async () => {
    const h = await startedHarness({ account: ALICE })
    h.crash.on = 'register'
    await h.flow.start()
    expect(h.store.map.size).toBe(1)
    await h.flow.forget()
    expect(h.store.map.size).toBe(0)
    expect(await h.flow.resume()).toBeNull()
  })
})

describe('what goes wrong, by name', () => {
  it('stops before sending when the estimate says the registrar would refuse, and goes on when it would not', async () => {
    const h = await startedHarness({ account: ALICE })
    h.crash.on = 'register'
    await h.flow.start()
    h.crash.on = null
    h.market.world.registrar.daiAboveFloor = false
    const second = harness({ account: ALICE, market: h.market, store: h.store })
    const failed = await second.flow.resume()
    expect(failed).toMatchObject({ phase: 'failed', reason: 'daiBelowFloor', recover: 'retry', during: 'revealing', step: 'register' })
    expect(second.sends).toEqual([])
    h.market.world.registrar.daiAboveFloor = true
    expect((await second.flow.retry())['phase']).toBe('done')
  })

  it('names a missing beneficiary the same way', async () => {
    const h = await startedHarness({ account: ALICE })
    h.crash.on = 'register'
    await h.flow.start()
    h.market.world.registrar.beneficiary = 'revert'
    const second = harness({ account: ALICE, market: h.market, store: h.store })
    expect(await second.flow.resume()).toMatchObject({ reason: 'noBeneficiary' })
  })

  it('reports a declined signature as retryable, with nothing pending, and sends on retry', async () => {
    const h = await startedHarness({ account: ALICE })
    h.crash.on = 'approve'
    h.crash.error = new ChainError('declined', 'the person said no')
    expect(await h.flow.start()).toMatchObject({ phase: 'failed', reason: 'declined', recover: 'retry', step: 'approve' })
    expect(JSON.parse(h.store.map.get(storeKey(ALICE)) ?? '{}').pending).toBeNull()
    h.crash.on = null
    expect((await h.flow.retry())['phase']).toBe('done')
    expect(steps(h)).toEqual(['commit', 'approve', 'deploy', 'register', 'records'])
  })

  it('reports a node that cannot be read as unavailable and goes on from where it was', async () => {
    const h = await startedHarness({ account: ALICE })
    h.crash.on = 'commit'
    h.crash.error = new ChainError('unavailable', 'no node')
    expect(await h.flow.start()).toMatchObject({ phase: 'failed', reason: 'unavailable' })
    h.crash.on = null
    expect((await h.flow.retry())['phase']).toBe('done')
  })

  it('reports a transaction that was mined and reverted, and retries it', async () => {
    const h = await startedHarness({ account: ALICE })
    h.market.hooks.revertMined = 'register'
    expect(await h.flow.start()).toMatchObject({ phase: 'failed', reason: 'reverted', step: 'register' })
    h.market.hooks.revertMined = null
    expect((await h.flow.retry())['phase']).toBe('done')
    expect(steps(h).filter((step) => step === 'register')).toHaveLength(2)
  })

  it('gives up with notAttributed when the records are set and the name still does not resolve to the address', async () => {
    const h = await startedHarness({ account: ALICE })
    h.market.hooks.onRegister = () => { h.market.world.names['alice'] = { owner: ALICE, resolver: h.market.predicted, roleCount: 3n, roles: { [ALICE]: 1n } } }
    expect(await h.flow.start()).toMatchObject({ phase: 'failed', reason: 'notAttributed', during: 'verifying' })
    expect(h.phases()).toContain('verifying')
  })
})

describe('the private send', () => {
  it('sends only the reveal to the relay when the switch is on', async () => {
    const h = await startedHarness({ account: ALICE })
    expect((await h.flow.start({ private: true }))['phase']).toBe('done')
    expect(h.sends.map((send) => [send.step, send.private])).toEqual([['commit', false], ['approve', false], ['deploy', false], ['register', true], ['records', false]])
    expect(h.relay.calls).toBe(1)
  })

  it('stops with the relay\'s failure and offers the public send, never sending publicly by itself', async () => {
    const h = await startedHarness({ account: ALICE })
    h.relay.failure = new RelayError('rejected', 'nonce too low')
    const failed = await h.flow.start({ private: true })
    expect(failed).toMatchObject({ phase: 'failed', reason: 'relayFailed', detail: 'nonce too low', step: 'register', offerPublic: true })
    expect(steps(h)).toEqual(['commit', 'approve', 'deploy'])
    expect(h.sends.filter((send) => send.step === 'register')).toHaveLength(1)
  })

  it('sends the very transaction it already signed when told to go public, signing nothing again', async () => {
    const h = await startedHarness({ account: ALICE })
    h.relay.failure = new RelayError('unavailable', 'HTTP 503')
    await h.flow.start({ private: true })
    expect(h.prepares.filter((prepared) => prepared.step === 'register')).toHaveLength(1)
    const done = await h.flow.retry({ private: false })
    expect(done['phase']).toBe('done')
    expect(h.prepares.filter((prepared) => prepared.step === 'register')).toHaveLength(1)
    expect(h.sends.filter((send) => send.step === 'register').map((send) => send.private)).toEqual([true, false])
    expect(h.relay.calls).toBe(1)
  })

  it('keeps the hash when the relay may have received the transaction, and sends it publicly on request', async () => {
    const h = await startedHarness({ account: ALICE })
    h.relay.failure = new RelayError('timeout', 'no answer', { maybeSent: true })
    const failed = await h.flow.start({ private: true })
    expect(failed).toMatchObject({ phase: 'failed', reason: 'relayFailed', offerPublic: true })
    expect(JSON.parse(h.store.map.get(storeKey(ALICE)) ?? '{}').pending).toMatchObject({ step: 'register' })
    expect((await h.flow.retry({ private: false }))['phase']).toBe('done')
    expect(h.prepares.filter((prepared) => prepared.step === 'register')).toHaveLength(1)
  })

  it('offers the public send when a private reveal is not mined in time', async () => {
    const h = await startedHarness({ account: ALICE, pendingTimeoutMs: 20_000 })
    h.market.hooks.drop = false
    h.crash.on = 'register'
    await h.flow.start({ private: true })
    h.crash.on = null
    const second = harness({ account: ALICE, market: h.market, store: h.store, pendingTimeoutMs: 20_000 })
    second.market.hooks.drop = true
    const stalled = await second.flow.resume()
    expect(stalled).toMatchObject({ phase: 'failed', reason: 'notMined', step: 'register', offerPublic: true })
  })
})

describe('decide, the pure step', () => {
  const rec = (patch: Record<string, unknown> = {}) => ({
    v: 1, label: 'alice', owner: ALICE, resolver: BOB, resolverMode: 'deploy', secret: '0x' + '11'.repeat(32), commitment: '0x' + '22'.repeat(32),
    price: String(10n * DAI), private: false, texts: {}, pending: null, hashes: {}, ...patch
  }) as Parameters<typeof decide>[0]
  const facts = (patch: Record<string, unknown> = {}) => ({
    head: { timestamp: 10_000, number: 1 }, holder: null, commitmentAt: 10_000, allowance: 10n * DAI, resolverCode: true, pending: null, ...patch
  })
  const act = (r: ReturnType<typeof rec>, f: ReturnType<typeof facts>) => {
    const out = decide(r, f)
    return [out.act.kind, out.act['step'] ?? null, out.view['phase']]
  }

  it('commits when no commitment stands', () => {
    expect(act(rec(), facts({ commitmentAt: 0 }))).toEqual(['send', 'commit', 'committing'])
  })

  it('matures for 60 seconds, approving and deploying meanwhile, then waits', () => {
    expect(act(rec(), facts({ allowance: 0n }))).toEqual(['send', 'approve', 'maturing'])
    expect(act(rec(), facts({ resolverCode: false }))).toEqual(['send', 'deploy', 'maturing'])
    expect(act(rec(), facts())).toEqual(['wait', null, 'maturing'])
    expect(act(rec({ resolverMode: 'reuse' }), facts({ resolverCode: true }))).toEqual(['wait', null, 'maturing'])
    expect(decide(rec(), facts()).view['secondsToMaturity']).toBe(60)
  })

  it('reveals at the first second the registrar allows, approving first if the allowance fell short', () => {
    const at = (age: number, patch: Record<string, unknown> = {}) => facts({ head: { timestamp: 10_000 + age, number: 2 }, ...patch })
    expect(act(rec(), at(59))[0]).toBe('wait')
    expect(act(rec(), at(60))).toEqual(['send', 'register', 'revealing'])
    expect(act(rec(), at(60, { allowance: 0n }))).toEqual(['send', 'approve', 'revealing'])
    expect(act(rec(), at(60, { resolverCode: false }))).toEqual(['send', 'register', 'revealing'])
    expect(act(rec(), at(86399))[1]).toBe('register')
    expect(act(rec(), at(86400))[0]).toBe('restart')
  })

  it('waits on a send that is not mined yet instead of sending it again', () => {
    const pending = { step: 'register', hash: '0x' + 'ab'.repeat(32), status: 'waiting' }
    expect(act(rec(), facts({ head: { timestamp: 10_100, number: 2 }, pending }))).toEqual(['wait', null, 'revealing'])
    expect(act(rec(), facts({ commitmentAt: 0, pending: { ...pending, step: 'commit' } }))).toEqual(['wait', null, 'committing'])
  })

  it('records once the name is ours: deploy if the resolver is missing, then the records, then verify, then done', () => {
    const ours = { holder: ALICE, commitmentAt: 0 }
    expect(act(rec(), facts({ ...ours, resolverCode: false }))).toEqual(['send', 'deploy', 'recording'])
    expect(act(rec(), facts({ ...ours, recordsDone: false }))).toEqual(['send', 'records', 'recording'])
    expect(act(rec(), facts({ ...ours, recordsDone: true, attributed: { ok: false } }))).toEqual(['verify', null, 'verifying'])
    expect(act(rec(), facts({ ...ours, recordsDone: true, attributed: { ok: true } }))).toEqual(['done', null, 'done'])
  })

  it('fails as taken for another holder, and names a mined revert and a timeout', () => {
    expect(decide(rec(), facts({ holder: BOB })).view).toMatchObject({ phase: 'failed', reason: 'taken', holder: BOB })
    const stuck = { step: 'register', hash: '0x' + 'cd'.repeat(32) }
    expect(decide(rec(), facts({ pending: { ...stuck, status: 'reverted' } })).view).toMatchObject({ reason: 'reverted', step: 'register' })
    expect(decide(rec({ private: true }), facts({ pending: { ...stuck, status: 'timedOut' } })).view).toMatchObject({ reason: 'notMined', offerPublic: true })
    expect(decide(rec(), facts({ pending: { ...stuck, status: 'timedOut' } })).view).toMatchObject({ reason: 'notMined', offerPublic: false })
  })
})

describe('one send at a time per account', () => {
  it('runs a second send of the same account after the first, and lets another account\'s run beside it', async () => {
    const log: string[] = []
    let open = () => {}
    const wait = new Promise<void>((resolve) => { open = resolve })
    const a1 = serialPerAccount(ALICE, async () => { log.push('a1 start'); await wait; log.push('a1 end') })
    const a2 = serialPerAccount(ALICE.toLowerCase(), async () => { log.push('a2 start') })
    await serialPerAccount(BOB, async () => { log.push('b1 start') })
    expect(log).toEqual(['a1 start', 'b1 start'])
    open()
    await Promise.all([a1, a2])
    expect(log).toEqual(['a1 start', 'b1 start', 'a1 end', 'a2 start'])
  })

  it('goes on after a failed send', async () => {
    await expect(serialPerAccount(ALICE, async () => { throw new Error('no') })).rejects.toThrow('no')
    expect(await serialPerAccount(ALICE, async () => 'fine')).toBe('fine')
  })
})

describe('the stored record', () => {
  const secret = '0x' + '11'.repeat(32)
  const good = { v: 1, label: 'alice', owner: ALICE, resolver: BOB, resolverMode: 'reuse', secret, commitment: makeCommitment('alice', ALICE, BOB, secret), price: String(10n * DAI) }

  it('is read back with defaults for what it lacks, and refused when it is not one', () => {
    expect(parseRec(JSON.stringify(good))).toMatchObject({ label: 'alice', private: false, texts: {}, pending: null, hashes: {} })
    for (const bad of [{ ...good, v: 2 }, { ...good, owner: 'nope' }, { ...good, secret: '0x12' }, { ...good, price: '-1' }, { ...good, resolverMode: 'x' }, null, 5]) {
      expect(parseRec(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull()
    }
    expect(parseRec('{')).toBeNull()
  })

  it('is kept per account, case aside', () => {
    expect(storeKey(ALICE)).toBe(storeKey(ALICE.toLowerCase()))
    expect(storeKey(ALICE)).not.toBe(storeKey(BOB))
  })

  it('goes through a Storage that may throw, as nothing', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } } as unknown as Storage
    const store = webStore(broken)
    expect(store.get('k')).toBeNull()
    expect(() => { store.set('k', 'v'); store.delete('k') }).not.toThrow()
    const map = new Map<string, string>()
    const working = webStore({ getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) }, removeItem: (key: string) => { map.delete(key) } } as unknown as Storage)
    working.set('k', 'v')
    expect(working.get('k')).toBe('v')
    working.delete('k')
    expect(working.get('k')).toBeNull()
  })
})
