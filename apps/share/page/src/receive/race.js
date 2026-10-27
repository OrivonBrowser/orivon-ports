// Two ways to get the same bytes, run so that the better one wins. The first starts at once; the others start after
// their head start, unless the first is making progress, and at once if it fails. The first to finish wins and the
// rest are cancelled, so a fast peer costs a gateway nothing and a missing peer costs the person nothing.

/**
 * @template T
 * @typedef {object} Attempt
 * @property {string} name
 * @property {(signal: AbortSignal) => Promise<T>} run
 * @property {number} [headStartMs] how long to wait for the attempts before it; 0 starts at once
 * @property {() => boolean} [busy] whether an earlier attempt is making progress, which keeps this one waiting
 */

/**
 * @template T
 * @param {Attempt<T>[]} attempts in order of preference
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ value: T, name: string }>}
 */
export function race (attempts, signal) {
  return new Promise((resolve, reject) => {
    /** @type {(AbortController | null)[]} */
    const controllers = attempts.map(() => null)
    /** @type {unknown[]} */
    const failures = []
    /** @type {ReturnType<typeof setTimeout>[]} */
    const timers = []
    let settled = false
    let failed = 0

    function finish (/** @type {() => void} */ settle, /** @type {number} */ winner = -1) {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      controllers.forEach((controller, index) => { if (index !== winner) controller?.abort() })
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    function onAbort () { finish(() => reject(signal?.reason ?? new DOMException('Cancelled.', 'AbortError'))) }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort)

    function launch (/** @type {number} */ index) {
      if (settled || controllers[index] !== null) return
      const attempt = /** @type {Attempt<T>} */ (attempts[index])
      const controller = new AbortController()
      controllers[index] = controller
      attempt.run(controller.signal).then(
        (value) => finish(() => resolve({ value, name: attempt.name }), index),
        (error) => {
          if (settled) return
          failures[index] = error
          failed += 1
          if (failed === attempts.length) {
            finish(() => reject(failures.findLast((failure) => failure instanceof Error && failure.name !== 'AbortError') ?? failures[failures.length - 1]))
            return
          }
          // One failed: the others need no more waiting.
          for (let next = 0; next < attempts.length; next++) launch(next)
        }
      )
    }

    function schedule (/** @type {number} */ index) {
      const attempt = /** @type {Attempt<T>} */ (attempts[index])
      const wait = attempt.headStartMs ?? 0
      if (index === 0 || wait === 0) {
        launch(index)
        return
      }
      const arm = () => {
        timers.push(setTimeout(() => {
          if (settled) return
          if (attempt.busy?.() === true) arm()
          else launch(index)
        }, wait))
      }
      arm()
    }

    attempts.forEach((_, index) => schedule(index))
  })
}
