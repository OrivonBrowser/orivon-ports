// What the Worker lets pkc-js say about itself. pkc-js logs with the `debug` package, which writes to a stream the shell does not
// show and reads which namespaces to write from `process.env.DEBUG` when it loads. So the Worker sets that variable before pkc-js
// loads (`enable-diagnostics.js`), and the build changes the one place `debug` writes a line to hand it to `routeLog` instead
// (`build/gap-debug-log.mjs`), which makes it a warning: the level that reaches a bug report from orivon://report.

import { DEBUG_SHAPE } from './config.js'

/**
 * The namespaces of pkc-js that say how its RPC server's start went, written whatever the configuration says: whether the
 * communities that were started before the Worker last ended are started again, and what the HTTP router setup they wait for
 * did. A few lines at each boot.
 */
export const START_NAMESPACES = 'pkc-js-rpc:pkc-ws-server:auto-start*,pkc-js:node:setupKuboHttpRouters*,pkc-js:pkc:_initHttpRoutersWithIpfsInBackground*'
const LINE_MAX = 1500

/**
 * The value of `DEBUG` for a Worker started with this `BITSOCIAL_NODE`: the start-up namespaces, and the page's `debug` when it
 * names namespaces. A value that is not a configuration is left to `readConfig`, which refuses it.
 * @param {string | undefined} configText @param {string | undefined} [already] a `DEBUG` the environment had
 */
export function debugNamespaces (configText, already) {
  /** @type {unknown} */
  let asked
  try { asked = JSON.parse(configText ?? '').debug } catch { asked = undefined }
  const more = typeof asked === 'string' && DEBUG_SHAPE.test(asked) ? asked : undefined
  return [already, START_NAMESPACES, more].filter((one) => one !== undefined && one !== '').join(',')
}

/** One line of pkc-js's log, from the arguments its `debug` logger passes. @param {unknown[]} parts */
export function diagnosticLine (parts) {
  const text = parts.map((part) => {
    if (typeof part === 'string') return part
    if (part instanceof Error) return `${part.name}: ${part.message}${part.stack === undefined ? '' : ` | ${part.stack.split('\n').slice(1, 4).map((line) => line.trim()).join(' | ')}`}`
    try { return JSON.stringify(part) } catch { return String(part) }
  }).join(' ').replace(/\s*\n\s*/g, ' ')
  return text.length > LINE_MAX ? `${text.slice(0, LINE_MAX)}...` : text
}

/** Where the patched `debug` hands each line it would have written. @param {Record<string, any>} scope `globalThis` @param {(line: string) => void} warn */
export function routeLog (scope, warn) {
  scope['__bitsocialPkcLog'] = (/** @type {unknown[]} */ ...parts) => { warn(`pkc-js ${diagnosticLine(parts)}`) }
}

/**
 * Where the board manager's own log goes (`board-manager-logger.js`): a warning for each line, with `redact` applied, since a line of
 * its errors can carry the address of the RPC it connected to and the key is in that address.
 * @param {Record<string, any>} scope `globalThis` @param {(line: string) => void} warn @param {(text: string) => string} redact
 */
export function routeBoardLog (scope, warn, redact) {
  scope['__bitsocialBoardLog'] = (/** @type {'log' | 'error'} */ level, /** @type {string} */ _namespace, /** @type {unknown[]} */ parts) => {
    warn(`board manager${level === 'error' ? ' error' : ''}: ${redact(diagnosticLine(parts))}`)
  }
}

/**
 * Where the challenge packages' own log goes (`challenge-logger.js`): a warning for each line, with `redact` applied, since a package that
 * reaches a service can print an address with a key in it.
 * @param {Record<string, any>} scope `globalThis` @param {(line: string) => void} warn @param {(text: string) => string} redact
 */
export function routeChallengeLog (scope, warn, redact) {
  scope['__bitsocialChallengeLog'] = (/** @type {'log' | 'error'} */ level, /** @type {string} */ _namespace, /** @type {unknown[]} */ parts) => {
    warn(`challenge${level === 'error' ? ' error' : ''}: ${redact(diagnosticLine(parts))}`)
  }
}
