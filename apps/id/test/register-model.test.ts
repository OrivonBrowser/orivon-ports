import { describe, expect, it } from 'vitest'
import { toChecksumAddress } from '../site/sdk/abi.js'
import { REASONS } from '../site/register-reasons.js'
import { countdown, failureActions, knownSteps, MISMATCH_WORDS, panelView, STEP_WORDS, trackHashes, trackPlan, trackTiming, type Timing } from '../site/register-model.js'
import { makeCommitment } from '../site/register-tx.js'
import { storeKey } from '../site/register-flow.js'
import { RELAY_WORDS, RelayError } from '../site/relay.js'
import { harness } from './support/flow-harness.ts'

const ALICE = toChecksumAddress('0x' + 'a1'.repeat(20))
const DAI = 10n ** 18n

/** Runs a whole registration and draws each state it passes through, as the page does. */
async function drawAll(options: Parameters<typeof harness>[0] & { private?: boolean }, label = 'alice') {
  const states: Record<string, any>[] = []
  const h = harness({ ...options, onState: (state) => states.push(state) })
  await h.flow.check(label)
  await h.flow.start({ private: options.private === true })
  let plan: readonly string[] | null = null
  let timing: Timing | null = null
  let hashes: Record<string, string> = {}
  const views = states.map((state, index) => {
    plan = trackPlan(plan, state)
    timing = trackTiming(timing, state, index * 1000)
    hashes = trackHashes(hashes, state)
    return { state, view: panelView(state, { plan, timing, nowMs: index * 1000, hashes }) }
  })
  return { h, views }
}

describe('the panel for a whole registration', () => {
  it('draws every state the flow passes through, each with a heading and a sentence for a screen reader', async () => {
    const { views } = await drawAll({ account: ALICE, dai: 100n * DAI })
    const phases = new Set(views.map(({ view }) => view.phase))
    for (const phase of ['checking', 'ready', 'committing', 'maturing', 'revealing', 'recording', 'verifying', 'done']) expect(phases.has(phase), phase).toBe(true)
    for (const { view } of views) {
      expect(view.heading).not.toBe('')
      expect(view.status).not.toBe('')
    }
  })

  it('lists the five transactions before anything is sent, all still to come, with the price and the balance', async () => {
    const { views } = await drawAll({ account: ALICE, dai: 100n * DAI })
    const ready = views.find(({ view }) => view.phase === 'ready')?.view
    expect(ready?.steps.map((step) => step.id)).toEqual(['commit', 'approve', 'deploy', 'register', 'records'])
    expect(ready?.steps.every((step) => step.state === 'pending' && step.hash === null)).toBe(true)
    expect(ready?.summary).toEqual({ price: '10 DAI', balance: '100 DAI', transactions: 5 })
    expect(ready?.actions).toEqual([{ id: 'register', label: 'Register for 10 DAI', primary: true }])
    expect(ready?.privateChoice).toEqual({ advised: false })
    expect(ready?.heading).toBe('Register alice.v1.orivonid.eth')
  })

  it('puts the approval and the resolver in the wait, between the commit and the register', async () => {
    const { views } = await drawAll({ account: ALICE, dai: 100n * DAI })
    const ready = views.find(({ view }) => view.phase === 'ready')?.view
    expect(ready?.steps.map((step) => step.group)).toEqual(['before', 'wait', 'wait', 'after', 'after'])
  })

  it('leaves out the approval and the resolver when the account already has both', async () => {
    const { views } = await drawAll({ account: ALICE, dai: 100n * DAI, allowance: 10n * DAI, resolver: 'ours' })
    const ready = views.find(({ view }) => view.phase === 'ready')?.view
    expect(ready?.steps.map((step) => step.id)).toEqual(['commit', 'register', 'records'])
  })

  it('shows the step in hand as active, and the ones before it as done with their hashes', async () => {
    const { views } = await drawAll({ account: ALICE, dai: 100n * DAI })
    const approving = views.find(({ view }) => view.phase === 'maturing' && view.steps.some((step) => step.id === 'approve' && step.state === 'active'))
    expect(approving, 'a state with the approval in hand').toBeDefined()
    expect(approving?.view.steps.find((step) => step.id === 'commit')).toMatchObject({ state: 'done' })
    expect(approving?.view.status).toContain('approving DAI')
    expect(approving?.view.busy).toBe(true)
  })

  it('ends with every step done and a hash for each, and the ways on', async () => {
    const { views } = await drawAll({ account: ALICE, dai: 100n * DAI })
    const done = views.at(-1)?.view
    expect(done?.phase).toBe('done')
    expect(done?.tone).toBe('ok')
    expect(done?.heading).toBe('Registration complete')
    expect(done?.status).toContain('alice.v1.orivonid.eth is yours')
    expect(done?.steps.every((step) => step.state === 'done' && /^0x[0-9a-f]{64}$/.test(step.hash ?? ''))).toBe(true)
    expect(done?.actions.map((action) => action.id)).toEqual(['mine', 'another'])
  })

  it('counts the wait down from block time while it matures, and not otherwise', async () => {
    const { views } = await drawAll({ account: ALICE, dai: 100n * DAI })
    const waiting = views.filter(({ view }) => view.phase === 'maturing' && view.timer !== null)
    expect(waiting.length).toBeGreaterThan(0)
    for (const { view } of waiting) expect(view.timer?.remaining).toBeLessThanOrEqual(60)
    for (const { view } of views.filter(({ view }) => view.phase !== 'maturing')) expect(view.timer).toBeNull()
  })

  it('advises the private send for a name of three letters and not for five', async () => {
    const short = await drawAll({ account: ALICE, dai: 1000n * DAI }, 'abc')
    expect(short.views.find(({ view }) => view.phase === 'ready')?.view.privateChoice).toEqual({ advised: true })
    expect(short.views.find(({ view }) => view.phase === 'ready')?.view.summary?.price).toBe('800 DAI')
  })
})

describe('a failure', () => {
  it('says the reason\'s words and keeps the technical detail apart', async () => {
    const h = harness({ account: ALICE, dai: DAI })
    const state = await h.flow.check('alice')
    const view = panelView(state, { plan: null, timing: null, nowMs: 0 })
    expect(view).toMatchObject({ phase: 'failed', tone: 'bad', status: 'The registration stopped.', failure: { words: REASONS['notEnoughDai']?.words } })
    expect(view.failure?.detail).toContain('of')
    expect(view.busy).toBe(false)
  })

  it('offers the public send, and the private relay again, when the relay refused', async () => {
    const relay = { failure: new RelayError('rejected', 'nope'), calls: 0 }
    const states: Record<string, any>[] = []
    const h = harness({ account: ALICE, dai: 1000n * DAI, relay, onState: (state) => states.push(state) })
    await h.flow.check('abc')
    const final = await h.flow.start({ private: true })
    const view = panelView(final, { plan: null, timing: null, nowMs: 0 })
    expect(final['phase']).toBe('failed')
    expect(view.actions.map((action) => [action.id, action.label])).toEqual([['public', RELAY_WORDS.sendPublicly], ['private', 'Try the private relay again']])
    expect(view.failure?.words).toBe(REASONS['relayFailed']?.words)
  })

  it('maps every reason to a way on that matches what the person can do', () => {
    for (const [reason, known] of Object.entries(REASONS)) {
      const checking = failureActions({ phase: 'failed', reason, during: 'checking' }).map((action) => action.id)
      const sending = failureActions({ phase: 'failed', reason, during: 'revealing' }).map((action) => action.id)
      if (known.recover === 'edit' || reason === 'taken') expect(checking, reason).toEqual(['edit'])
      else if (reason === 'pendingExists') expect(checking, reason).toEqual(['continue', 'forget'])
      else if (reason === 'noWallet') expect(checking, reason).toEqual(['connect'])
      else expect(checking, reason).toEqual(['check', 'edit'])
      if (known.recover === 'retry') expect(sending, reason).toEqual(['retry'])
    }
  })

  it('lists no steps when the failure came while the name was being checked', () => {
    const view = panelView({ phase: 'failed', reason: 'notEnoughDai', during: 'checking' }, { plan: ['commit', 'register', 'records'], timing: null, nowMs: 0 })
    expect(view.steps).toEqual([])
  })

  it('names a failed registration from the name remembered earlier', () => {
    const view = panelView({ phase: 'failed', reason: 'unknownOutcome' }, { plan: null, timing: null, nowMs: 0, name: 'abc.v1.orivonid.eth' })
    expect(view.heading).toBe('Registering abc.v1.orivonid.eth')
  })

  it('keeps the steps already done in view when the failure is reported without them', async () => {
    const relay = { failure: new RelayError('rejected', 'nope'), calls: 0 }
    const states: Record<string, any>[] = []
    const h = harness({ account: ALICE, dai: 1000n * DAI, relay, onState: (state) => states.push(state) })
    await h.flow.check('abc')
    const final = await h.flow.start({ private: true })
    expect(final['hashes']).toBeUndefined()
    const hashes = states.reduce((all, state) => trackHashes(all, state), {} as Record<string, string>)
    const view = panelView(final, { plan: ['commit', 'approve', 'deploy', 'register', 'records'], timing: null, nowMs: 0, hashes })
    expect(view.steps.map((step) => [step.id, step.state])).toEqual([
      ['commit', 'done'], ['approve', 'done'], ['deploy', 'done'], ['register', 'failed'], ['records', 'pending']
    ])
    expect(view.steps.slice(0, 3).every((step) => step.hash !== null)).toBe(true)
  })

  it('says a transaction that may still be mined may still be mined, with its hash', () => {
    const hash = '0x' + '12'.repeat(32)
    const view = panelView({ phase: 'failed', reason: 'notMined', words: REASONS['notMined']?.words, hash, pendingStatus: 'timedOut', step: 'register' }, { plan: null, timing: null, nowMs: 0 })
    expect(view.failure).toMatchObject({ hash, hashNote: expect.stringContaining('may still be mined') })
    const reverted = panelView({ phase: 'failed', reason: 'reverted', words: REASONS['reverted']?.words, hash, step: 'register' }, { plan: null, timing: null, nowMs: 0 })
    expect(reverted.failure?.hashNote).toBeNull()
  })
})

describe('a stored registration that was discarded on resume', () => {
  const SECRET = '0x' + '11'.repeat(32)
  const BOB = toChecksumAddress('0x' + 'b0'.repeat(20))
  const stored = (resolver: string, patch: Record<string, unknown> = {}) => {
    const base = { v: 1, label: 'alice', owner: ALICE, resolver, resolverMode: 'deploy', secret: SECRET, price: String(10n * DAI), private: false, texts: {}, pending: null, hashes: {}, ...patch }
    return { commitment: makeCommitment(String(base.label), String(base.owner), String(base.resolver), SECRET), ...base }
  }

  it('says what did not match and offers to start again, for each thing a resume can find wrong', async () => {
    const found = new Set<string>()
    const wrong = (predicted: string): Record<string, unknown>[] => [
      stored(predicted, { label: 'X' }), stored(predicted, { price: '1' }), { ...stored(predicted), commitment: '0x' + '33'.repeat(32) },
      stored(BOB, { owner: BOB }), stored(BOB)
    ]
    for (let at = 0; at < 5; at++) {
      const h = harness({ account: ALICE })
      h.store.set(storeKey(ALICE), JSON.stringify(wrong(h.market.predicted)[at]))
      const state = (await h.flow.resume(ALICE)) as Record<string, any>
      expect(state, String(at)).toMatchObject({ phase: 'failed', reason: 'recordDiscarded', recover: 'edit' })
      found.add(state['mismatch'])
      const view = panelView(state, { plan: null, timing: null, nowMs: 0 })
      expect(view.failure).toMatchObject({ words: REASONS['recordDiscarded']?.words, note: `It did not match in ${MISMATCH_WORDS[state['mismatch'] as keyof typeof MISMATCH_WORDS]}.` })
      expect(view.actions).toEqual([{ id: 'edit', label: 'Start again', primary: true }])
      expect(view.steps).toEqual([])
    }
    expect([...found].sort()).toEqual(Object.keys(MISMATCH_WORDS).sort())
  })

  it('says nothing about a mismatch for any other failure, and still words one it does not know', () => {
    expect(panelView({ phase: 'failed', reason: 'timeout', during: 'checking' }, { plan: null, timing: null, nowMs: 0 }).failure?.note).toBeNull()
    const odd = panelView({ phase: 'failed', reason: 'recordDiscarded', mismatch: 'somethingNew' }, { plan: null, timing: null, nowMs: 0 })
    expect(odd.failure?.note).toBe('It did not match in something it holds.')
  })
})

describe('a registration picked up after a reload', () => {
  /** Draws each state of a flow that resumes a registration which was stopped while the commitment matured. */
  async function drawResumed(options: Partial<Parameters<typeof harness>[0]> = {}) {
    let first: ReturnType<typeof harness> | null = null
    first = harness({ account: ALICE, dai: 100n * DAI, ...options, onState: (state) => { if (state['phase'] === 'maturing') first?.flow.stop() } })
    await first.flow.check('alice')
    await first.flow.start()
    const second = harness({ account: ALICE, dai: 100n * DAI, ...options, market: first.market, store: first.store })
    await second.flow.resume()
    let plan: readonly string[] | null = null
    let timing: Timing | null = null
    let hashes: Record<string, string> = {}
    return second.states.map((state, index) => {
      plan = trackPlan(plan, state)
      timing = trackTiming(timing, state, index * 1000)
      hashes = trackHashes(hashes, state)
      return { state, view: panelView(state, { plan, timing, nowMs: index * 1000, hashes }) }
    })
  }

  it('lists the resolver from the first state it draws, and never grows its list while the steps are sent', async () => {
    const views = (await drawResumed()).filter(({ view }) => view.phase !== 'checking')
    expect(views.length).toBeGreaterThan(3)
    for (const { view } of views) expect(view.steps.map((step) => step.id), view.status).toEqual(['commit', 'approve', 'deploy', 'register', 'records'])
    expect(views[0]?.view.phase).toBe('maturing')
  })

  it('lists only what the chain says is still needed, when the account already has the approval and the resolver', async () => {
    const views = (await drawResumed({ allowance: 10n * DAI, resolver: 'ours' })).filter(({ view }) => view.phase !== 'checking')
    for (const { view } of views) expect(view.steps.map((step) => step.id), view.status).toEqual(['commit', 'register', 'records'])
  })
})

describe('the plan the page keeps', () => {
  it('is the one a state carries, none while a name is checked, and the one before otherwise', () => {
    const plan = ['commit', 'register', 'records']
    expect(trackPlan(null, { phase: 'ready', transactions: plan })).toBe(plan)
    expect(trackPlan(null, { phase: 'maturing', transactions: plan })).toBe(plan)
    expect(trackPlan(plan, { phase: 'maturing', step: 'approve', sending: 'signing' })).toBe(plan)
    expect(trackPlan(plan, { phase: 'checking', what: 'chain' })).toBe(plan)
    expect(trackPlan(plan, { phase: 'checking', what: 'name' })).toBeNull()
    expect(trackPlan(null, { phase: 'maturing' })).toBeNull()
  })
})

describe('the steps, and the countdown', () => {
  it('knows a step from a stored registration that has lost its plan', () => {
    expect(knownSteps({ phase: 'maturing', hashes: { commit: '0x1', approve: '0x2' } }, null)).toEqual(['commit', 'approve', 'register', 'records'])
    expect(knownSteps({ phase: 'maturing', step: 'deploy', hashes: {} }, null)).toEqual(['commit', 'deploy', 'register', 'records'])
    for (const id of Object.keys(STEP_WORDS)) expect(STEP_WORDS[id as keyof typeof STEP_WORDS].detail.length).toBeGreaterThan(20)
  })

  it('counts from the maturity time less the block time and the seconds since', () => {
    const timing: Timing = { matureAt: 1060, blockTimestamp: 1018, receivedAt: 5000 }
    expect(countdown(timing, 5000)).toEqual({ remaining: 42, total: 60, text: '0:42', done: false })
    expect(countdown(timing, 5000 + 30_900)).toMatchObject({ remaining: 12, text: '0:12' })
    expect(countdown(timing, 5000 + 99_000)).toEqual({ remaining: 0, total: 60, text: '0:00', done: true })
    expect(countdown(null, 0)).toBeNull()
  })

  it('keeps the last timing through a send, and drops it when the wait is over', () => {
    const timing: Timing = { matureAt: 100, blockTimestamp: 50, receivedAt: 0 }
    expect(trackTiming(null, { phase: 'maturing', matureAt: 100, blockTimestamp: 50 }, 0)).toEqual(timing)
    expect(trackTiming(timing, { phase: 'maturing', step: 'approve', sending: 'signing' }, 10)).toBe(timing)
    expect(trackTiming(timing, { phase: 'revealing', step: 'register' }, 10)).toBeNull()
    expect(trackTiming(timing, { phase: 'ready' }, 10)).toBeNull()
  })
})
