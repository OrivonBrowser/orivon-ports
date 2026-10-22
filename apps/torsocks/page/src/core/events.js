// What each daemon event does to the page's state (daemon/README.md lists
// them). Pure: a new state object out, the old one untouched, so the
// interface can compare by identity.

const LOG_LIMIT = 400
const SERVICE_STATES = new Set(['starting', 'publishing', 'running', 'degraded', 'unreachable', 'recovering', 'broken', 'stopped'])

/** The runtime half of a service: what the daemon last said about it, by id. */
export function emptyRuntime () {
  return { services: {} }
}

function logLine (state, level, target, msg, now) {
  const logs = state.logs.length >= LOG_LIMIT ? state.logs.slice(state.logs.length - LOG_LIMIT + 1) : state.logs.slice()
  logs.push({ time: now, level, target, msg })
  return { ...state, logs }
}

function withService (runtime, id, change) {
  return { ...runtime, services: { ...runtime.services, [id]: { ...(runtime.services[id] ?? {}), ...change } } }
}

/**
 * `{ state, runtime }` after one event. `runtime` keeps per-service facts the
 * daemon reports (state, problem, hits, onion, the last check); the store
 * merges them with what the person published.
 */
export function applyEvent ({ state, runtime }, event, now = Date.now()) {
  switch (event?.t) {
    case 'hello':
      return { state: { ...state, arti: String(event.arti ?? '') }, runtime }
    case 'bootstrap':
      return {
        state: { ...state, bootstrap: { frac: Number(event.frac) || 0, ready: event.ready === true, msg: String(event.msg ?? ''), blocked: event.blocked ?? null } },
        runtime
      }
    case 'bootstrap-error':
      return { state: logLine({ ...state, bootstrap: { ...state.bootstrap, blocked: String(event.msg ?? '') } }, 'WARN', 'torsocks', `Tor could not be reached: ${String(event.msg)}. Trying again in ${String(event.retryInSec)} s.`, now), runtime }
    case 'socks':
      return {
        state: { ...state, socks: event.state === 'listening'
          ? { state: 'listening', host: String(event.host), port: Number(event.port), msg: '' }
          : { state: 'failed', host: '127.0.0.1', port: 0, msg: String(event.msg ?? 'the proxy could not open a port') } },
        runtime
      }
    case 'traffic':
      return { state: { ...state, traffic: { open: Number(event.open) || 0, total: Number(event.total) || 0 } }, runtime }
    case 'service': {
      const change = { state: SERVICE_STATES.has(event.state) ? event.state : 'broken', problem: event.problem ?? event.error ?? null }
      if (typeof event.onion === 'string') change.onion = event.onion
      return { state, runtime: withService(runtime, String(event.id), change) }
    }
    case 'hits':
      return { state, runtime: withService(runtime, String(event.id), { hits: Number(event.count) || 0 }) }
    case 'check': {
      const text = event.ok === true ? `Reached through Tor: ${String(event.status)}` : String(event.msg ?? event.status ?? 'No answer')
      return { state, runtime: withService(runtime, String(event.id), { check: { pending: false, ok: event.ok === true, text, ms: Number(event.ms) || 0 } }) }
    }
    case 'forgotten': {
      const services = { ...runtime.services }
      delete services[event.id]
      return { state, runtime: { ...runtime, services } }
    }
    case 'log':
      return { state: logLine(state, event.level ?? 'INFO', String(event.target ?? ''), String(event.msg ?? ''), now), runtime }
    case 'error':
      return { state: logLine(state, 'ERROR', 'torsocks', String(event.msg ?? ''), now), runtime }
    case 'fatal':
      return { state: logLine({ ...state, phase: 'failed', error: fatalText(event) }, 'ERROR', 'torsocks', fatalText(event), now), runtime }
    default:
      return { state, runtime }
  }
}

/** What the person is told when the daemon cannot run. */
export function fatalText (event) {
  switch (event.code) {
    case 'control-port-busy': return 'Another program holds TorSocks\' control port (127.0.0.1:9159). Close it, or the other TorSocks, and restart.'
    case 'control-key': return 'TorSocks could not read its own key file. Restart to make a new one.'
    case 'tor-client': return `Tor could not be set up: ${String(event.msg)}`
    default: return String(event.msg ?? 'The Tor daemon stopped.')
  }
}
