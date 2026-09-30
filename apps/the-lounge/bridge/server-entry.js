// The server bundle's entry: what `node index.js start` would run, minus
// index.js's version check and chdir. Order matters: install-require.js first,
// since upstream's config.ts requires its defaults while it evaluates.
// `thelounge/` resolves into the clone (esbuild.orivon.config.mjs).

import './install-require.js'
import 'thelounge/server/index.ts'
