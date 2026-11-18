// Keeps Orivon's IPFS node running: spawns the component, waits for its `/health`, and when it ends starts it again.
// A node killed and started again at once can fail with "No file descriptors available (os error 33)", so a start
// waits for the previous child's exit and then a pause, and a start that fails lengthens the pause.

const ANSI = /\x1b\[[0-9;]*m/g

/**
 * @typedef {object} Clock
 * @property {() => number} now
 * @property {(ms: number) => Promise<void>} sleep
 */

/** @type {Clock} */
const REAL_CLOCK = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }

/**
 * @typedef {object} Timing
 * @property {number} startWaitMs
 * @property {number} pollMs
 * @property {number} settleMs
 * @property {number} maxPauseMs
 * @property {number} firstStartAttempts
 * @property {number} killWaitMs
 */

/** @type {Readonly<Timing>} */
export const TIMING = Object.freeze({
  /** A start that has not answered `/health` by then has failed. */
  startWaitMs: 60_000,
  pollMs: 300,
  /** The pause after an exit before the next start; doubled for each start that failed in a row. */
  settleMs: 5_000,
  maxPauseMs: 60_000,
  /** The first start gives up after this many failed attempts; later ones retry for ever. */
  firstStartAttempts: 3,
  killWaitMs: 10_000
})

/** Hands each whole line of a stream to `onLine`, whatever the chunks. @param {(line: string) => void} onLine */
export function lineReader (onLine) {
  let pending = ''
  const decoder = new TextDecoder()
  return {
    /** @param {Uint8Array | string} chunk */
    take (chunk) {
      const whole = (pending + (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))).split('\n')
      pending = whole.pop() ?? ''
      whole.forEach(onLine)
    },
    end () { if (pending !== '') onLine(pending); pending = '' }
  }
}

/**
 * @typedef {object} SuperviseOptions
 * @property {(program: string, args: string[]) => import('node:child_process').ChildProcess} spawn
 * @property {typeof fetch} fetch the process's own fetch, never the facade's
 * @property {string} program
 * @property {string[]} args
 * @property {string} key the node's `x-orivon-key`
 * @property {number} apiPort
 * @property {(state: { state: 'starting' | 'up' | 'restarting' | 'failed', detail?: string }) => void} [onState]
 * @property {(line: string) => void} [onLine] a line the node wrote, with its colours removed
 * @property {() => Promise<unknown>} [beforeLaunch] runs before each start, once the previous child has ended; a failure of it is ignored
 * @property {Clock} [clock]
 * @property {Partial<Timing>} [timing]
 */

/** @param {SuperviseOptions} options */
export function superviseNode (options) {
  const { spawn, fetch: ask, program, key, apiPort, onState = () => {}, onLine = () => {} } = options
  let args = options.args
  const clock = options.clock ?? REAL_CLOCK
  const timing = { ...TIMING, ...options.timing }
  const base = `http://127.0.0.1:${apiPort}`

  let stopping = false
  /** @type {() => void} */
  let wake = () => {}
  const stopped = new Promise((resolve) => { wake = () => { resolve(undefined) } })
  /** A pause a stop cuts short. @param {number} ms */
  const pause = (ms) => Promise.race([clock.sleep(ms), stopped])
  /** @type {Run | null} */
  let current = null
  let everUp = false
  /** @type {(value: void) => void} */
  let markReady = () => {}
  /** @type {(reason: Error) => void} */
  let markFailed = () => {}
  const ready = new Promise((resolve, reject) => { markReady = resolve; markFailed = reject })
  ready.catch(() => {})

  /** @typedef {{ child: import('node:child_process').ChildProcess, ended: boolean, exit: Promise<string>, stderr: string }} Run */

  /** @returns {Run} */
  function launch () {
    const child = spawn(program, args)
    /** @type {Run} */
    const run = { child, ended: false, exit: Promise.resolve(''), stderr: '' }
    const line = (/** @type {boolean} */ keep) => lineReader((text) => {
      const clean = text.replace(ANSI, '')
      if (clean.trim() === '') return
      if (keep) run.stderr = `${run.stderr}${clean}\n`.slice(-1500)
      onLine(clean)
    })
    const err = line(true)
    const out = line(false)
    child.stderr?.on('data', err.take)
    child.stdout?.on('data', out.take)
    run.exit = new Promise((resolve) => {
      const finish = (/** @type {string} */ how) => {
        if (run.ended) return
        run.ended = true
        err.end()
        out.end()
        resolve(`${how}${run.stderr.trim() === '' ? '' : `: ${run.stderr.trim().split('\n').slice(-2).join(' ')}`}`)
      }
      child.on('error', (error) => { finish(`could not start (${error.message})`) })
      child.on('exit', (code, signal) => { finish(`ended (${signal ?? `code ${String(code)}`})`) })
    })
    return run
  }

  /** @param {Run} run */
  async function healthy (run) {
    const until = clock.now() + timing.startWaitMs
    while (clock.now() < until) {
      if (run.ended) return false
      try {
        const answer = await ask(`${base}/health`, { headers: { 'x-orivon-key': key }, signal: AbortSignal.timeout(2_000) })
        if (answer.status === 200) return true
      } catch { /* not listening yet */ }
      if (stopping) return false
      await clock.sleep(timing.pollMs)
    }
    return false
  }

  async function cycle () {
    let failures = 0
    while (!stopping) {
      onState({ state: everUp ? 'restarting' : 'starting' })
      await Promise.resolve().then(() => options.beforeLaunch?.()).catch(() => {})
      const run = launch()
      current = run
      const up = await healthy(run)
      /** @type {string} */
      let how
      if (up) {
        everUp = true
        failures = 0
        onState({ state: 'up' })
        markReady()
        how = await run.exit
      } else {
        failures += 1
        if (!run.ended) run.child.kill()
        how = await Promise.race([run.exit, clock.sleep(timing.killWaitMs).then(() => 'did not answer in time')])
        if (!everUp && failures >= timing.firstStartAttempts) {
          onState({ state: 'failed', detail: how })
          markFailed(new Error(`Orivon's IPFS node did not start: ${how}`))
          return
        }
      }
      if (stopping) return
      onState({ state: 'restarting', detail: how })
      await pause(Math.min(timing.maxPauseMs, timing.settleMs * 2 ** Math.min(failures, 10)))
    }
  }

  const running = cycle().catch((error) => { markFailed(error instanceof Error ? error : new Error(String(error))) })

  return {
    /** Resolves when the node first answers `/health`; rejects when the first starts all fail. */
    ready,
    /** Starts the node again, with `next` as its command line when given: the running one is ended, and the loop starts it after its usual pause. @param {string[]} [next] */
    restart (next) {
      if (next !== undefined) args = next
      if (current !== null && !current.ended) current.child.kill()
    },
    /** Ends the node and waits for its exit. */
    async stop () {
      stopping = true
      wake()
      const run = current
      if (run !== null && !run.ended) {
        run.child.kill()
        await Promise.race([run.exit, clock.sleep(timing.killWaitMs)])
      }
      await running
    }
  }
}
