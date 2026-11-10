import { describe, expect, it, vi } from 'vitest'
import { ChainError } from '../site/sdk/chain.js'
import { orivonChain } from '../site/sdk/chain-orivon.js'
import { ALLOW_READ_WORDS, bannerOf, stripOf, watchReads, type Reading } from '../site/header-model.js'
import { fakeOrivon } from './support/fake-orivon.ts'

describe('what the strip says about how Ethereum is read', () => {
  it('wears the shield only for Orivon with the read let through, and says the light client answers', () => {
    expect(stripOf({ kind: 'orivon', reading: 'allowed' })).toEqual({
      tone: 'ok', shield: true, words: 'Ethereum is read through your own light client, inside Orivon.'
    })
  })

  it('says Orivon is not letting the page read, and where that is changed, without the shield', () => {
    const strip = stripOf({ kind: 'orivon', reading: 'refused' })
    expect(strip).toMatchObject({ tone: 'warn', shield: false })
    expect(strip.words).toContain('Orivon is not letting this page read Ethereum')
    expect(strip.words).toContain(ALLOW_READ_WORDS)
    expect(strip.words).not.toContain('through your own light client, inside Orivon')
  })

  it('claims nothing before Orivon has answered: the light client is promised only once the person allows it', () => {
    const strip = stripOf({ kind: 'orivon', reading: 'unknown' })
    expect(strip).toMatchObject({ tone: 'neutral', shield: false })
    expect(strip.words).toContain('once you allow it')
  })

  it('says a wallet extension reads through its own server, and that Orivon would use the light client', () => {
    for (const reading of ['unknown', 'allowed', 'refused'] as Reading[]) {
      const strip = stripOf({ kind: 'eip1193', reading })
      expect(strip).toMatchObject({ tone: 'neutral', shield: false })
      expect(strip.words).toContain('wallet extension and the server it uses')
      expect(strip.words).toContain('Inside Orivon it is read through your own light client')
    }
  })

  it('says there is no wallet, without the shield', () => {
    expect(stripOf({ kind: null, reading: 'unknown' })).toEqual({ tone: 'warn', shield: false, words: 'No wallet is available, so nothing can be read from Ethereum here.' })
  })

  it('has the shield in exactly one of the cases', () => {
    const kinds = ['orivon', 'eip1193', null] as const
    const readings: Reading[] = ['unknown', 'allowed', 'refused']
    const shields = kinds.flatMap((kind) => readings.map((reading) => ({ kind, reading, shield: stripOf({ kind, reading }).shield }))).filter((one) => one.shield)
    expect(shields).toEqual([{ kind: 'orivon', reading: 'allowed', shield: true }])
  })
})

/** A chain whose reads and wallet calls answer or fail as the test says. */
function stubChain(failure: () => Error | null) {
  const call = async () => { const error = failure(); if (error !== null) throw error; return 1 }
  return { kind: 'orivon', blockNumber: call, getBlock: call, call, addresses: call, signMessage: call, waitForReceipt: call } as unknown as import('../site/sdk/chain.js').Chain
}

describe('watching the reads of a chain', () => {
  it('starts unknown, becomes allowed after a read that was answered, and tells the page once', async () => {
    const changes: Reading[] = []
    const watched = watchReads(stubChain(() => null), (reading) => changes.push(reading))
    expect(watched.reading()).toBe('unknown')
    await watched.chain.blockNumber()
    await watched.chain.getBlock('latest')
    expect(watched.reading()).toBe('allowed')
    expect(changes).toEqual(['allowed'])
  })

  it('becomes refused when Orivon answers that the person did not allow the read, and allowed again when it later does', async () => {
    let failure: Error | null = new ChainError('declined', 'the person did not allow it')
    const changes: Reading[] = []
    const watched = watchReads(stubChain(() => failure), (reading) => changes.push(reading))
    await expect(watched.chain.blockNumber()).rejects.toMatchObject({ reason: 'declined' })
    expect(watched.reading()).toBe('refused')
    failure = null
    await watched.chain.blockNumber()
    expect(changes).toEqual(['refused', 'allowed'])
  })

  it('does not call a slow or absent node a refusal', async () => {
    const onChange = vi.fn()
    const watched = watchReads(stubChain(() => new ChainError('timeout', 'slow')), onChange)
    await expect(watched.chain.blockNumber()).rejects.toMatchObject({ reason: 'timeout' })
    await expect(watched.chain.call({} as never)).rejects.toBeInstanceOf(ChainError)
    expect(watched.reading()).toBe('unknown')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('leaves the wallet alone: a refused address is not a refused read', async () => {
    const onChange = vi.fn()
    const watched = watchReads(stubChain(() => new ChainError('declined', 'no')), onChange)
    await expect(watched.chain.addresses()).rejects.toMatchObject({ reason: 'declined' })
    await expect(watched.chain.signMessage(new Uint8Array(1))).rejects.toMatchObject({ reason: 'declined' })
    expect(watched.reading()).toBe('unknown')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reads a refusal off the Chain over `orivon.use`, where the person said no to the light client', async () => {
    const asked = fakeOrivon({ blockNumber: () => 1 }, ['ETH_NET_0_1_READONLY'])
    const watched = watchReads(orivonChain(asked.orivon as never), () => undefined)
    await expect(watched.chain.blockNumber()).rejects.toMatchObject({ reason: 'declined' })
    expect(watched.reading()).toBe('refused')
    const allowed = fakeOrivon({ blockNumber: () => 1 })
    const open = watchReads(orivonChain(allowed.orivon as never), () => undefined)
    expect(await open.chain.blockNumber()).toBe(1)
    expect(open.reading()).toBe('allowed')
  })

  it('keeps the kind of the chain it wraps', () => {
    expect(watchReads(stubChain(() => null), () => undefined).chain.kind).toBe('orivon')
  })
})

describe('what the strip above a page says about a registration it does not show', () => {
  it('says nothing while there is no registration, for a lookup under way or a name that is ready or done', () => {
    for (const state of [{ phase: 'idle' }, { phase: 'ready' }, { phase: 'done' }, { phase: 'checking', what: 'name' }]) expect(bannerOf(state)).toBeNull()
  })

  it('says nothing when a lookup stopped, because nothing was started: no DAI, a taken name or a read that failed is told on the search page', () => {
    expect(bannerOf({ phase: 'failed', during: 'checking', reason: 'noDai' })).toBeNull()
    expect(bannerOf({ phase: 'failed', during: 'checking', reason: 'taken' })).toBeNull()
  })

  it('says a registration needs attention when one that was under way stopped', () => {
    for (const during of ['committing', 'revealing', undefined]) expect(bannerOf({ phase: 'failed', during })).toEqual({ tone: 'warn', words: 'A registration needs your attention.' })
  })

  it('says which name is in progress while a registration runs', () => {
    expect(bannerOf({ phase: 'maturing', name: 'alice.v1.orivonid.eth' })).toEqual({ tone: 'info', words: 'A registration of alice.v1.orivonid.eth is in progress.' })
    expect(bannerOf({ phase: 'committing' })?.words).toBe('A registration of a name is in progress.')
  })
})
