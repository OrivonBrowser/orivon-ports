// The server bundle's entry: what `node index.js start` would run, minus
// index.js's version check and chdir. Order matters: the SQLite engine starts
// first (a top-level await in the shim's ready module), then install-require.js,
// since upstream's config.ts requires its defaults while it evaluates.
// `thelounge/` resolves into the clone (esbuild.orivon.config.mjs).

import 'orivon-node-shim/sqlite-ready'
import './install-require.js'
import 'thelounge/server/index.ts'
