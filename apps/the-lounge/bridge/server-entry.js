// The server bundle's entry: what `node index.js start` would run, minus
// index.js's version check and chdir. The SQLite engine starts first (a
// top-level await in the shim's ready module). `thelounge/` resolves into the
// clone (esbuild.orivon.config.mjs).

import 'orivon-node-shim/sqlite-ready'
import 'thelounge/server/index.ts'
