// Imported before the server, so `globalThis.require` exists when config.ts
// evaluates: esbuild's `__require` falls back to it for every call it could
// not resolve. "../server" is the bundled server module, loaded on first use
// (a literal require, which esbuild bundles lazily); every other name, the
// two config.js files, goes to the shim's `module.createRequire`.

import { createRequire } from 'module'
import { makeRequire } from './server-require.js'

// ORIVON_INSTALL_ROOT is a build-time constant: where the launcher writes
// upstream's install tree (esbuild.orivon.config.mjs, `define`).
const fromInstall = createRequire(`${ORIVON_INSTALL_ROOT}/dist/server/index.js`)

globalThis.require = makeRequire({
  bundled: { '../server': () => require('thelounge/server/server.ts') },
  fallback: fromInstall
})
