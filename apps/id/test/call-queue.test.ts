import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callQueue, orivonChain, QUEUE_LIMITS } from '../site/sdk/chain-orivon.js'
import { ChainError } from '../site/sdk/chain.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** Starts of a burst, and how many ran at once at most. */
function watch () {
  const starts: number[] = []
  let open = 0
  let most = 0
  const call = (work = 5) => async () => {
    starts.push(Date.now())
    most = Math.max(most, ++open)
    await new Promise((resolve) => setTimeout(resolve, work))
    open--
    return starts.length
  }
  /** The first call that started before the bucket could have held a token for it, or -1. A bucket of `burst` that gains `perSecond` a second lets the n-th call start no sooner than (n - burst) / perSecond. */
  const earlyStart = () => starts.findIndex((at, index) => at - (starts[0] ?? 0) < ((index + 1 - QUEUE_LIMITS.burst) * 1000) / QUEUE_LIMITS.perSecond - 1)
  return { call, starts, most: () => most, earlyStart }
}

describe('the call queue', () => {
  it('keeps a burst of 40 calls under 8 in flight', async () => {
    const queue = callQueue()
    const seen = watch()
    const all = Promise.all(Array.from({ length: 40 }, () => queue.run(seen.call())))
    await vi.runAllTimersAsync()
    await all
    expect(seen.starts).toHaveLength(40)
    expect(seen.most()).toBeLessThanOrEqual(8)
    expect(seen.most()).toBeGreaterThan(1)
  })

  it('never starts calls faster than a bucket of 48 that gains 7 a second, so 8 a second is never reached for long', async () => {
    const queue = callQueue()
    const seen = watch()
    const all = Promise.all(Array.from({ length: 200 }, () => queue.run(seen.call(1))))
    await vi.runAllTimersAsync()
    await all
    expect(seen.earlyStart()).toBe(-1)
    const span = (seen.starts.at(-1) ?? 0) - (seen.starts[0] ?? 0)
    expect(span, 'the last call waited for the bucket to refill').toBeGreaterThanOrEqual(((200 - QUEUE_LIMITS.burst) * 1000) / QUEUE_LIMITS.perSecond - 5)
    expect(QUEUE_LIMITS.perSecond).toBeLessThan(8)
    expect(QUEUE_LIMITS.burst).toBeLessThan(64)
  })

  it('keeps under 8 in flight when each call takes longer than a second', async () => {
    const queue = callQueue()
    const seen = watch()
    const all = Promise.all(Array.from({ length: 20 }, () => queue.run(seen.call(2500))))
    await vi.runAllTimersAsync()
    await all
    expect(seen.most()).toBe(QUEUE_LIMITS.inFlight)
  })

  it('answers each call with its own result, in the order asked', async () => {
    const queue = callQueue()
    const all = Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => queue.run(async () => n * 2)))
    await vi.runAllTimersAsync()
    expect(await all).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
  })

  it('retries a refusal as too many, with the wait doubling, and then answers', async () => {
    const queue = callQueue()
    const times: number[] = []
    const answer = queue.run(async () => {
      times.push(Date.now())
      if (times.length < 3) throw new ChainError('limit', 'too many at once')
      return 'answered'
    })
    await vi.runAllTimersAsync()
    expect(await answer).toBe('answered')
    expect(times).toHaveLength(3)
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBe(QUEUE_LIMITS.backoffMs)
    expect((times[2] ?? 0) - (times[1] ?? 0)).toBe(QUEUE_LIMITS.backoffMs * 2)
  })

  it('makes every other call wait out the pause that one refusal asks for', async () => {
    const queue = callQueue()
    let first = 0
    const refused = queue.run(async () => { if (first++ === 0) throw new ChainError('limit', 'too many at once'); return 'late' })
    const askedAt = Date.now()
    await vi.advanceTimersByTimeAsync(1)
    const other = queue.run(async () => Date.now())
    await vi.runAllTimersAsync()
    expect(await refused).toBe('late')
    expect((await other) - askedAt).toBeGreaterThanOrEqual(QUEUE_LIMITS.backoffMs)
  })

  it('gives up after its retries and says what the node said', async () => {
    const queue = callQueue()
    let tries = 0
    const answer = queue.run(async () => { tries++; throw new ChainError('limit', 'too many at once') })
    const caught = answer.catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await caught).toMatchObject({ reason: 'limit' })
    expect(tries).toBe(QUEUE_LIMITS.retries + 1)
  })

  it('does not retry any other failure, and goes on with the calls behind it', async () => {
    const queue = callQueue()
    let tries = 0
    const bad = queue.run(async () => { tries++; throw new ChainError('timeout', 'the node took too long') }).catch((error: unknown) => error)
    const good = queue.run(async () => 'fine')
    await vi.runAllTimersAsync()
    expect(await bad).toMatchObject({ reason: 'timeout' })
    expect(await good).toBe('fine')
    expect(tries).toBe(1)
  })
})

describe('the Orivon chain over the queue', () => {
  function node (refusing = 0) {
    const seen = watch()
    let refused = 0
    const handle = {
      chainId: async () => 1,
      blockNumber: async () => {
        await seen.call(5)()
        if (refused < refusing) { refused++; throw Object.assign(new Error('rate'), { code: 'limit' }) }
        return 26_400_000
      }
    }
    const orivon = { use: async () => [handle] }
    return { orivon, seen, refusals: () => refused }
  }

  it('sends a burst of 120 reads without ever having more than 8 open or outrunning the bucket', async () => {
    const { orivon, seen } = node()
    const chain = orivonChain(orivon)
    const all = Promise.all(Array.from({ length: 120 }, () => chain.blockNumber()))
    await vi.runAllTimersAsync()
    expect(new Set(await all)).toEqual(new Set([26_400_000]))
    expect(seen.most()).toBeLessThanOrEqual(8)
    expect(seen.earlyStart()).toBe(-1)
  })

  it('shares the one queue between two chains made over the same page', async () => {
    const { orivon, seen } = node()
    const first = orivonChain(orivon)
    const second = orivonChain(orivon)
    const all = Promise.all(Array.from({ length: 30 }, (_, n) => (n % 2 === 0 ? first : second).blockNumber()))
    await vi.runAllTimersAsync()
    await all
    expect(seen.most()).toBeLessThanOrEqual(8)
  })

  it('retries a read the node refused as too many, then answers it', async () => {
    const { orivon, refusals } = node(2)
    const chain = orivonChain(orivon)
    const answer = chain.blockNumber()
    await vi.runAllTimersAsync()
    expect(await answer).toBe(26_400_000)
    expect(refusals()).toBe(2)
  })
})
