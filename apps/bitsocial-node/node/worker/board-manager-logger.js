// The logger the board manager gets in place of `@pkcprotocol/pkc-logger` (build/board-manager.mjs): the same call shape,
// `Logger(namespace)` giving `log`, `log.error` and `log.trace`, and every line handed to the Worker, which writes it
// as a warning because that is the level a bug report from orivon://report carries (`diagnostics.js`). Traces are dropped.
// `loggerTo` makes one for any other hook: the challenge packages get theirs the same way (`challenge-logger.js`).

/** @param {string} hook the name on `globalThis` the Worker sets to take each line */
export function loggerTo (hook) {
  /** @param {string} namespace */
  function Logger (namespace) {
    /** @param {'log' | 'error'} level @param {unknown[]} parts */
    const write = (level, parts) => { /** @type {any} */ (globalThis)[hook]?.(level, namespace, parts) }
    const log = (/** @type {unknown[]} */ ...parts) => { write('log', parts) }
    log.error = (/** @type {unknown[]} */ ...parts) => { write('error', parts) }
    log.trace = (/** @type {unknown[]} */ ..._parts) => {}
    return log
  }
  Logger.disable = () => {}
  Logger.enable = (/** @type {string} */ _namespaces) => {}
  Logger.enabled = (/** @type {string} */ _namespace) => false
  return Logger
}

export default loggerTo('__bitsocialBoardLog')
