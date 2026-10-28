import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHECK_PATIENCE_MS,
  FIRST_CHECK_MS,
  PASS_VALID_MS,
  RECHECK_MS,
  checkDueAt,
  createReachWatch,
  forgetPasses,
  isReached,
  isWaiting,
  planChecks,
  watchAfterCheck,
  watchAfterState
} from '../page/src/core/reach.js'

const NOW = 1_000_000
const done = (at: number, ok: boolean) => ({ pending: false, ok, text: '', ms: 0, at, auto: true })
const waiting = (change: object = {}): Record<string, unknown> => ({
  id: 'a',
  enabled: true,
  onion: 'x.onion',
  state: 'publishing',
  waitingSince: NOW,
  passedAt: null,
  check: null,
  ...change
})

describe('isWaiting', () => {
  it('is true for a switched-on service with an address that Arti has not settled', () => {
    for (const state of ['starting', 'publishing', 'degraded', 'unreachable', 'recovering']) expect(isWaiting(waiting({ state })), state).toBe(true)
  })

  it('is false once Arti or the person has settled it, and without an address', () => {
    for (const state of ['running', 'stopped', 'broken', 'off']) expect(isWaiting(waiting({ state })), state).toBe(false)
    expect(isWaiting(waiting({ enabled: false }))).toBe(false)
    expect(isWaiting(waiting({ onion: null }))).toBe(false)
    expect(isWaiting(waiting({ onion: '' }))).toBe(false)
  })
})

describe('checkDueAt', () => {
  it('tests about a minute after the address appears', () => {
    expect(checkDueAt(waiting(), NOW)).toBe(NOW + FIRST_CHECK_MS)
  })

  it('tests again two minutes after a failed test finished, never sooner than the first', () => {
    expect(checkDueAt(waiting({ check: done(NOW + FIRST_CHECK_MS + 5000, false) }), NOW)).toBe(NOW + FIRST_CHECK_MS + 5000 + RECHECK_MS)
    expect(checkDueAt(waiting({ check: done(NOW - 10 * RECHECK_MS, false) }), NOW), 'a failure from before this wait').toBe(NOW + FIRST_CHECK_MS)
  })

  it('waits for a test under way, and gives up on one that never answers', () => {
    const check = { ...done(NOW + 70_000, false), pending: true }
    expect(checkDueAt(waiting({ check }), NOW + 80_000)).toBe(NOW + 70_000 + CHECK_PATIENCE_MS)
  })

  it('tests again when a pass goes stale, and not before', () => {
    const passed = waiting({ passedAt: NOW + 90_000, check: done(NOW + 90_000, true) })
    expect(checkDueAt(passed, NOW + 100_000)).toBe(NOW + 90_000 + PASS_VALID_MS)
    expect((checkDueAt(passed, NOW + 90_000 + PASS_VALID_MS) as number) <= NOW + 90_000 + PASS_VALID_MS, 'due once it is stale').toBe(true)
  })

  it('does not test a settled service or one with no wait recorded', () => {
    expect(checkDueAt(waiting({ state: 'running' }), NOW)).toBeNull()
    expect(checkDueAt(waiting({ waitingSince: null }), NOW)).toBeNull()
  })
})

describe('isReached', () => {
  it('holds for ten minutes after a pass while Arti waits', () => {
    const passed = waiting({ passedAt: NOW })
    expect(isReached(passed, NOW + 1)).toBe(true)
    expect(isReached(passed, NOW + PASS_VALID_MS - 1)).toBe(true)
    expect(isReached(passed, NOW + PASS_VALID_MS)).toBe(false)
  })

  it('is false without a pass, or when Arti has settled', () => {
    expect(isReached(waiting(), NOW)).toBe(false)
    expect(isReached(waiting({ passedAt: NOW, state: 'running' }), NOW)).toBe(false)
  })
})

describe('planChecks', () => {
  it('names the services due now and the earliest time to look again', () => {
    const services = [
      waiting({ id: 'late', waitingSince: NOW - FIRST_CHECK_MS }),
      waiting({ id: 'soon', waitingSince: NOW - 10_000 }),
      waiting({ id: 'later', waitingSince: NOW - 1000 }),
      waiting({ id: 'settled', state: 'running' }),
      waiting({ id: 'busy', check: { ...done(NOW - 5000, false), pending: true } })
    ]
    expect(planChecks(services, NOW)).toEqual({ due: ['late'], wakeAt: Math.min(NOW - 10_000 + FIRST_CHECK_MS, NOW - 5000 + CHECK_PATIENCE_MS) })
  })

  it('asks for nothing when nothing waits', () => {
    expect(planChecks([waiting({ state: 'running' })], NOW)).toEqual({ due: [], wakeAt: null })
    expect(planChecks([], NOW)).toEqual({ due: [], wakeAt: null })
  })
})

describe('watchAfterState and watchAfterCheck', () => {
  it('starts the wait at the first state that has an address, and keeps it until Arti settles', () => {
    expect(watchAfterState({}, 'starting', null, 10)).toEqual({ waitingSince: null })
    expect(watchAfterState({}, 'starting', 'x.onion', 10)).toEqual({ waitingSince: 10 })
    expect(watchAfterState({ waitingSince: 10 }, 'degraded', 'x.onion', 99)).toEqual({ waitingSince: 10 })
    expect(watchAfterState({ waitingSince: 10 }, 'running', 'x.onion', 99)).toEqual({ waitingSince: null })
  })

  it('drops the pass on stopped and broken only', () => {
    expect(watchAfterState({ passedAt: 5 }, 'running', 'x.onion', 99)).not.toHaveProperty('passedAt')
    expect(watchAfterState({ passedAt: 5 }, 'stopped', 'x.onion', 99)).toMatchObject({ passedAt: null })
    expect(watchAfterState({ passedAt: 5 }, 'broken', null, 99)).toMatchObject({ passedAt: null })
  })

  it('records a pass for a running service, and clears it on a failure', () => {
    expect(watchAfterCheck({ state: 'publishing' }, true, 42)).toEqual({ passedAt: 42 })
    expect(watchAfterCheck({ state: 'publishing', passedAt: 5 }, false, 42)).toEqual({ passedAt: null })
    expect(watchAfterCheck({ state: 'stopped' }, true, 42)).toEqual({})
    expect(watchAfterCheck({}, true, 42)).toEqual({})
  })
})

describe('forgetPasses', () => {
  it('believes no pass and awaits no answer once the daemon connection is gone', () => {
    const runtime = {
      other: 1,
      services: {
        a: { state: 'publishing', passedAt: 5, waitingSince: 1, check: { ...done(9, true), pending: true } },
        b: { state: 'publishing', passedAt: 5, waitingSince: 1, check: done(9, false) }
      }
    }
    const after = forgetPasses(runtime) as typeof runtime
    expect(after.services.a).toEqual({ state: 'publishing', passedAt: null, waitingSince: null, check: null })
    expect(after.services.b).toMatchObject({ passedAt: null, waitingSince: null, check: done(9, false) })
    expect(after.other).toBe(1)
    expect(runtime.services.a.passedAt, 'the old runtime is untouched').toBe(5)
  })
})

describe('createReachWatch', () => {
  afterEach(() => { vi.useRealTimers() })

  /** A store in miniature: one service whose `check` the test answers by hand. */
  function setup (opts: { active?: () => boolean } = {}) {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const service = waiting({ waitingSince: Date.now() })
    const checks: number[] = []
    const watch = createReachWatch({
      services: () => [service],
      active: opts.active ?? (() => true),
      check: () => {
        checks.push(Date.now())
        service.check = { ...done(Date.now(), false), pending: true }
      },
      refresh: () => { watch.run() }
    })
    watch.run()
    return { service, checks, watch }
  }

  it('runs the first test a minute after the wait began and no sooner', () => {
    const { checks } = setup()
    vi.advanceTimersByTime(FIRST_CHECK_MS - 1)
    expect(checks).toEqual([])
    vi.advanceTimersByTime(1)
    expect(checks).toEqual([NOW + FIRST_CHECK_MS])
  })

  it('never has two tests of one service at once', () => {
    const { service, checks } = setup()
    vi.advanceTimersByTime(FIRST_CHECK_MS + 100_000)
    expect(checks, 'the first is still pending').toHaveLength(1)
    vi.advanceTimersByTime(CHECK_PATIENCE_MS)
    expect(checks, 'a test that never answers is replaced').toHaveLength(2)
    expect((service.check as { pending: boolean }).pending).toBe(true)
  })

  it('tests every two minutes after a failure, and stops after a pass until it goes stale', () => {
    const { service, checks, watch } = setup()
    vi.advanceTimersByTime(FIRST_CHECK_MS)
    service.check = done(Date.now() + 2000, false)
    vi.setSystemTime(Date.now() + 2000)
    watch.run()
    vi.advanceTimersByTime(RECHECK_MS - 1)
    expect(checks).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(checks).toHaveLength(2)
    const passedAt = Date.now() + 3000
    vi.setSystemTime(passedAt)
    service.check = done(passedAt, true)
    service.passedAt = passedAt
    watch.run()
    vi.advanceTimersByTime(PASS_VALID_MS - 1)
    expect(checks, 'quiet while the pass stands').toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(checks, 'a new test when it is stale').toHaveLength(3)
  })

  it('does nothing while the daemon is not connected, and stops its timer', () => {
    let connected = false
    const { checks, watch } = setup({ active: () => connected })
    vi.advanceTimersByTime(10 * FIRST_CHECK_MS)
    expect(checks).toEqual([])
    connected = true
    watch.run()
    vi.advanceTimersByTime(1)
    expect(checks, 'due at once: the wait began long ago').toHaveLength(1)
    watch.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
