// Workaround, deletable when `orivon.fs` has file times: pkc-js's start lock, which proper-lock-file keeps with
// `fs.utimes`, becomes the in-process lock of node/worker/workarounds/process-lock.js. pkc-js's chunk holds the library
// inside it, so an alias of the package would never be reached: the library's region of the chunk is replaced.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCK_MODULE = 'orivon-process-lock'
const REGION_START = '//#region node_modules/@pkcprotocol/proper-lock-file/dist/src/index.js\n'
const REGION_END = '//#endregion'

/** @type {import('./text-patch.mjs').Patch} */
export const startLock = {
  name: 'fs.utimes is missing: the start lock is held in process',
  file: /rpc-local-community-[\w-]+\.js$/,
  apply (text) {
    const start = text.indexOf(REGION_START)
    const end = start === -1 ? -1 : text.indexOf(REGION_END, start)
    if (start === -1 || end === -1) throw new Error('the proper-lock-file region is not in the chunk')
    const replacement = `${REGION_START}import bitsocialProcessLock from "${LOCK_MODULE}";\nvar require_src = /* @__PURE__ */ __commonJSMin(((exports, module) => { module.exports = bitsocialProcessLock; }));\n`
    return text.slice(0, start) + replacement + text.slice(end)
  }
}

/** Resolves the lock module the patch imports. */
export const lockResolver = {
  name: 'bitsocial-process-lock',
  /** @param {import('esbuild').PluginBuild} build */
  setup (build) {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'node', 'worker', 'workarounds', 'process-lock.js')
    build.onResolve({ filter: new RegExp(`^${LOCK_MODULE}$`) }, () => ({ path: file }))
  }
}
