// The facade as the Worker's callers see it, with every answer of 400 or more written to the log: the route, the status
// and the start of the text. pkc-js reads a refused kubo call as "retry" or as its own error, and neither names the
// route, so this is where a failing route shows.
//
// With `calls` on (the Worker turns it on when BITSOCIAL_FACADE_TRACE is 1) it also writes, for the calls that make, put
// or read a name's record, a line when the call comes in and one when it is answered, each with the clock, so a record
// that takes long to appear can be placed on one timeline with pkc-js's own log and the node's. Any other call is
// written only when it took two seconds or more.

import { failureText } from '../kubo/http-fetch.js'

const WINDOW_MS = 60_000
const PER_WINDOW = 40
const CALLS_PER_WINDOW = 300
const SLOW_MS = 2000
/** The calls that make, put or read a name's record, the keys and routing calls beside them, and the gateway's read of a name. */
const RECORD_CALL = /^\/(?:api\/v0\/(?:name|key|routing|dht)\/|ipns\/)/

/**
 * @template {{ handle: (request: Request) => Promise<Response> }} F
 * @param {F} facade
 * @param {(line: string) => void} log
 * @param {() => number} [now]
 * @param {{ calls?: boolean }} [options]
 * @returns {F}
 */
export function traceFacade (facade, log, now = Date.now, options = {}) {
  let windowStart = now()
  let shown = 0
  let callsWindowStart = windowStart
  let callsShown = 0
  /** @param {string} line */
  const note = (line) => {
    if (now() - windowStart >= WINDOW_MS) { windowStart = now(); shown = 0 }
    if (shown < PER_WINDOW) { shown += 1; log(line) }
  }
  /** @param {string} line */
  const noteCall = (line) => {
    if (now() - callsWindowStart >= WINDOW_MS) { callsWindowStart = now(); callsShown = 0 }
    if (callsShown < CALLS_PER_WINDOW) { callsShown += 1; log(line) }
  }
  return {
    ...facade,
    /** @param {Request} request */
    async handle (request) {
      const url = new URL(request.url)
      const what = `${request.method} ${url.pathname}`
      const recorded = options.calls === true && RECORD_CALL.test(url.pathname)
      const began = now()
      if (recorded) noteCall(`facade call t=${String(began)} ${what}${url.search.slice(0, 200)}`)
      /** @param {string} how what came of the call, up to "in" or "after" */
      const done = (how) => {
        const took = now() - began
        if (recorded || (options.calls === true && took >= SLOW_MS)) noteCall(`facade done t=${String(now())} ${what} ${how} ${String(took)} ms`)
      }
      let response
      try {
        response = await facade.handle(request)
      } catch (error) {
        note(`facade ${what} threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
        done('threw after')
        throw error
      }
      if (response.status >= 400) {
        const reason = await response.clone().text().then((text) => text.replace(/\s+/g, ' ').trim().slice(0, 200), () => '')
        note(`facade ${what} answered ${String(response.status)}${reason === '' ? '' : `: ${reason}`}`)
      }
      done(`answered ${String(response.status)} in`)
      return response
    }
  }
}

/**
 * The runtime's fetch with a line written for the start and for the end of each call (the method, the path without its query, the status and the time it took),
 * for the Worker's calls to the node's API that do not go through the node client: its status reads, its health checks and the bandwidth reader.
 * @param {typeof fetch} inner
 * @param {(line: string) => void} log
 * @param {() => number} [now]
 * @returns {typeof fetch}
 */
export function traceFetch (inner, log, now = Date.now) {
  return /** @type {typeof fetch} */ (async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const what = `${init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')} ${url.pathname}`
    const began = now()
    log(`node fetch call t=${String(began)} ${what}`)
    try {
      const answer = await inner(input, init)
      log(`node fetch done t=${String(now())} ${what} ${String(answer.status)} in ${String(now() - began)} ms`)
      return answer
    } catch (error) {
      log(`node fetch done t=${String(now())} ${what} failed in ${String(now() - began)} ms: ${failureText(error)}`)
      throw error
    }
  })
}
