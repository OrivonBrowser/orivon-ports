// Workaround, deletable when the shim implements `util.formatWithOptions`: pkc-js's own copy of `debug` writes a line with it, and
// the shim refuses the call, so a log line pkc-js is asked to write ends its caller. The line goes to the Worker instead
// (`node/worker/diagnostics.js`), which writes it as a warning, the level a bug report carries.

import { replaceText } from './text-patch.mjs'

const DEBUG_NODE_BUILD = '//#region node_modules/debug/src/node.js'
const replaceLine = replaceText('return process.stderr.write(util.formatWithOptions(exports.inspectOpts, ...args) + "\\n");', 'return (globalThis.__bitsocialPkcLog ?? ((...parts) => process.stderr.write(parts.join(" ") + "\\n")))(...args);')

/** The chunks of pkc-js named `util-*` are several; the one that holds `debug` is changed, and it must hold the line. @type {import('./text-patch.mjs').Patch} */
export const debugLog = {
  name: 'util.formatWithOptions is missing in the shim: pkc-js log lines go to the Worker',
  file: /@pkcprotocol[\\/]pkc-js[\\/]dist[\\/]bundled[\\/]chunks[\\/]util-[\w-]+\.js$/,
  apply: (text, path) => (text.includes(DEBUG_NODE_BUILD) ? replaceLine(text, path) : text)
}
