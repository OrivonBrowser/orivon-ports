// Build wrapper for Ledger Wallet's Electron renderer. It loads upstream's OWN
// renderer and worker config factories from the clone (tools/rspack/*.ts, the
// ones `pnpm build:js` uses) and changes only what running in an Orivon tab
// needs. Upstream's source and build output stay out of this repository (MIT);
// only this file is ours. Why each change is made: ../README.md, Design notes.
//
// Run by the recipe from apps/ledger-live-desktop with LEDGER_WALLET_CLONE
// naming the clone's root. Every patch asserts that it hit what it meant to
// (src/build/webpack-kit.cjs): a patch that matches nothing means upstream's
// config changed shape, and the build must fail rather than build another app.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { cloneRoot, requireFromClone, retargetOutput } = require('../../src/build/webpack-kit.cjs')

const CLONE = cloneRoot('LEDGER_WALLET_CLONE')
const LLD = path.join(CLONE, 'apps', 'ledger-live-desktop')
const fromLld = requireFromClone(LLD)

// tools/rspack/*.ts is TypeScript; the rspack CLI loads this file through jiti,
// which compiles the factories' TypeScript as they are required below.
const { createRendererConfig } = require(path.join(LLD, 'tools', 'rspack', 'rspack.renderer.ts'))
const { createWorkerConfig } = require(path.join(LLD, 'tools', 'rspack', 'rspack.worker.ts'))

// Orivon's Node shim (orivon-mvp src/shim), found the way the-lounge finds it.
const MVP = process.env.ORIVON_MVP_ROOT || path.resolve(__dirname, '..', '..', '..', 'orivon-mvp')
const ALIAS_TABLE = path.join(MVP, 'src', 'shim', 'bundler', 'alias-table.generated.json')
if (!fs.existsSync(ALIAS_TABLE)) {
  throw new Error(`orivon build wrapper: ${ALIAS_TABLE} not found -- set ORIVON_MVP_ROOT to an orivon-mvp checkout`)
}

// Never `.webpack`: that is where upstream's own build writes, and the desktop
// app's main process loads from it.
const OUTPUT_PATH = path.join(LLD, 'dist-orivon')
const UPSTREAM_OUTPUT = path.join(LLD, '.webpack')

function expectOne (found, what) {
  if (found !== 1) {
    throw new Error(`orivon build wrapper: expected exactly one ${what}, found ${String(found)} -- upstream's config changed shape`)
  }
}

const renderer = createRendererConfig('production', { devServer: false })
const workers = createWorkerConfig('production')

// ---- renderer ----

// A page has no Node: `electron-renderer` emits `require("fs")` for every
// builtin and `require("electron")` for the app's own IPC, and a tab has
// neither. The code paths stay Electron's (DefinePlugin flags and
// `process.platform` checks are untouched); only how modules are loaded changes.
expectOne(renderer.target === 'electron-renderer' ? 1 : 0, 'electron-renderer target')
renderer.target = ['web', 'es2020']

const before = renderer.plugins.length
// By name: the CLI evaluates this file and the factories in its own module
// loader, so their `rspack` is not the class object `fromLld` returns.
renderer.plugins = renderer.plugins.filter((plugin) => plugin?.constructor?.name !== 'ElectronTargetPlugin')
expectOne(before - renderer.plugins.length, 'ElectronTargetPlugin')

// `import { ipcRenderer, clipboard, shell, webFrame } from 'electron'` is
// answered by window.ledgerElectron, which bridge/ledger-wallet.js installs
// before the bundle's first line runs.
renderer.externals = { ...renderer.externals, electron: 'var window.ledgerElectron' }

// Every Node builtin the bundle reaches (libs built for Node, 15 distinct ones)
// is answered by Orivon's shim, one exact alias per specifier and per `node:`
// form (a prefix alias would also capture the shim's own subpath imports). A
// builtin the shim lacks fails the build naming its importer: that is orivon-mvp
// work, never something to stub here.
const shimAlias = {}
for (const entry of JSON.parse(fs.readFileSync(ALIAS_TABLE, 'utf8')).entries) {
  if (entry.specifier === 'electron') continue
  const target = entry.kind === 'local'
    ? path.join(MVP, 'src', 'shim', entry.implementation.replace(/\.js$/, '.ts'))
    // `events/` is the npm package; `events` alone is Node's own builtin.
    : require.resolve(`${entry.implementation}/`, { paths: [MVP] })
  if (!entry.prefixOnly) shimAlias[`${entry.specifier}$`] = target
  shimAlias[`node:${entry.specifier}$`] = target
}
// The shim is TypeScript with `.js` import specifiers, compiled here by the same loader upstream uses.
renderer.module.rules.push({
  test: /\.ts$/,
  include: [path.join(MVP, 'src')],
  loader: 'builtin:swc-loader',
  options: { jsc: { parser: { syntax: 'typescript' }, target: 'es2020' } },
  type: 'javascript/auto',
  resolve: { extensionAlias: { '.js': ['.ts', '.js'] } }
})

// @ledgerhq/react-ui lists icons-ui as an injected dependency, which pnpm
// copies at install time -- before the library build has produced the icon
// components -- so the copy is empty. The workspace package is the built one.
const ICONS = path.join(CLONE, 'libs', 'ui', 'packages', 'icons')
if (!fs.existsSync(path.join(ICONS, 'react', 'index.js'))) {
  throw new Error(`orivon build wrapper: ${ICONS}/react/index.js is missing -- run the library build first`)
}

renderer.resolve = {
  ...renderer.resolve,
  alias: { ...renderer.resolve.alias, ...shimAlias, '@ledgerhq/icons-ui': ICONS }
}

// Upstream's production rule emits each animation JSON as an asset and loads it
// with `__non_webpack_require__(path.join(__dirname, ...))`, which needs Node's
// `require` at run time (its own comment: "Works in Electron where
// nodeIntegration is enabled"). A tab has none, so those 58 files (10 MB) are
// bundled as JSON modules instead, which is what upstream's development build does.
const rulesBefore = renderer.module.rules.length
renderer.module.rules = renderer.module.rules.filter((rule) => !JSON.stringify(rule.use ?? []).includes('animationJsonLoader'))
expectOne(rulesBefore - renderer.module.rules.length, 'animation JSON rule')

// ---- both targets ----

// Source maps would be most of the served tree (57 of 143 MB at the pin), and a
// served tree is declared, hashed and fetched whole.
for (const config of [renderer, workers]) {
  expectOne(config.devtool === 'source-map' ? 1 : 0, `source-map devtool on ${String(config.name)}`)
  config.devtool = false
}

for (const [name, config] of [['renderer', renderer], ['workers', workers]]) {
  const moved = retargetOutput(config, { to: OUTPUT_PATH, from: UPSTREAM_OUTPUT })
  console.log(`orivon build wrapper: ${name} -> ${OUTPUT_PATH} (${String(moved)} copy rule(s) moved)`)
}

module.exports = [renderer, workers]
