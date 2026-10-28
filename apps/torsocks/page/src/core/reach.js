// When the page tests a service through Tor by itself, and what a passed test
// is worth. Arti's own word for a service ("publishing", "degraded") waits for
// directory uploads that can take many minutes or fail on a few of ~8 servers,
// while the service already answers; the daemon's `check` op reaches the
// service the way a visitor does. The policy is pure (times come in, times go
// out); `createReachWatch` at the end holds the one timer that applies it.

/** The first test, after the service has an address and is not yet settled. */
export const FIRST_CHECK_MS = 60_000
/** After a failed test, the wait to the next one. */
export const RECHECK_MS = 120_000
/** How long a passed test is believed while Arti has not settled. */
export const PASS_VALID_MS = 600_000
/** The daemon gives up on a test after two minutes; a page waits a little longer for its answer. */
export const CHECK_PATIENCE_MS = 150_000

/** States Arti (or the person) has finished with: a test would tell the page nothing new. */
export const SETTLED_STATES = Object.freeze(['running', 'stopped', 'broken', 'off'])

/** Whether the page is waiting for Arti to settle on this service, and so tests it. */
export function isWaiting (service) {
  return service.enabled === true && typeof service.onion === 'string' && service.onion !== '' && !SETTLED_STATES.includes(service.state)
}

/** Whether a passed test still stands: the service is waiting and the pass is recent. */
export function isReached (service, now) {
  return isWaiting(service) && typeof service.passedAt === 'number' && now - service.passedAt < PASS_VALID_MS
}

/**
 * When the page next tests this service (ms since the epoch; a past time means now), or null when
 * it should not: Arti has settled, there is no address, or a test is under way.
 */
export function checkDueAt (service, now) {
  if (!isWaiting(service) || typeof service.waitingSince !== 'number') return null
  const check = service.check ?? null
  if (check?.pending === true) return check.at + CHECK_PATIENCE_MS
  if (isReached(service, now)) return service.passedAt + PASS_VALID_MS
  const again = check === null ? 0 : check.at + RECHECK_MS
  return Math.max(service.waitingSince + FIRST_CHECK_MS, again)
}

/** The services to test now and when to look again (null: nothing is waiting). */
export function planChecks (services, now) {
  const due = []
  let wakeAt = null
  for (const service of services) {
    const at = checkDueAt(service, now)
    if (at === null) continue
    if (at <= now) due.push(service.id)
    else if (wakeAt === null || at < wakeAt) wakeAt = at
  }
  return { due, wakeAt }
}

/**
 * What the runtime keeps after the daemon reported `state` (and, maybe, an address): when the page
 * began waiting, and whether a pass survives. Arti settling on `running` ends the wait but keeps a
 * recent pass, so a service that Arti flips back to publishing is not doubted again at once;
 * stopped and broken end it.
 */
export function watchAfterState (live, state, onion, now) {
  const waiting = !SETTLED_STATES.includes(state)
  const known = typeof onion === 'string' && onion !== ''
  const change = { waitingSince: waiting ? (known ? (live.waitingSince ?? now) : (live.waitingSince ?? null)) : null }
  if (state === 'stopped' || state === 'broken') change.passedAt = null
  return change
}

/** What a finished test changes: a pass is remembered, and a failure forgets an earlier pass. */
export function watchAfterCheck (live, ok, now) {
  if (!ok) return { passedAt: null }
  if (live.state === undefined || live.state === 'stopped' || live.state === 'broken') return {}
  return { passedAt: now }
}

/**
 * The runtime once the link to the daemon is gone or replaced: no pass is believed, no test is
 * waited for, and the wait starts again when the daemon reports the service.
 */
export function forgetPasses (runtime) {
  const services = {}
  for (const [id, live] of Object.entries(runtime.services)) {
    services[id] = { ...live, passedAt: null, waitingSince: null, check: live.check?.pending === true ? null : (live.check ?? null) }
  }
  return { ...runtime, services }
}

/**
 * The loop that runs the tests. `services()` is the current list, `active()` whether the daemon is
 * connected, `check(id)` starts one test, and `refresh()` publishes the state again (which calls
 * `run`). One timer at a time, set for the earliest moment a test falls due or a pass goes stale.
 */
export function createReachWatch ({ services, active, check, refresh, now = Date.now }) {
  let timer = null
  const stop = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const run = () => {
    stop()
    if (!active()) return
    const { due, wakeAt } = planChecks(services(), now())
    if (due.length > 0) {
      for (const id of due) check(id)
      refresh()
      return
    }
    if (wakeAt !== null) timer = setTimeout(refresh, Math.max(1, wakeAt - now()))
  }
  return { run, stop }
}
