// Build wrapper for Ledger Wallet's renderer. It loads upstream's OWN renderer
// and worker config factories from the clone (tools/rspack/*.ts, the ones
// `pnpm build:js` uses) and changes only what running in an Orivon tab needs.
// Upstream's source and build output stay out of this repository (MIT); only
// this file is ours. Why each change is made: ../README.md, Design notes.
//
// Run by the recipe from apps/ledger-live-desktop with LEDGER_WALLET_CLONE
// naming the clone's root. Every patch asserts that it hit what it meant to
// (src/build/webpack-kit.cjs), and so does every fact the port relies on that
// upstream's config states by itself: a mismatch means upstream's config
// changed shape, and the build must fail rather than build another app.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { cloneRoot, retargetOutput } = require('../../src/build/webpack-kit.cjs')

const CLONE = cloneRoot('LEDGER_WALLET_CLONE')
const LLD = path.join(CLONE, 'apps', 'ledger-live-desktop')

// tools/rspack/*.ts is TypeScript; the rspack CLI loads this file through jiti,
// which compiles the factories' TypeScript as they are required below.
const { createRendererConfig } = require(path.join(LLD, 'tools', 'rspack', 'rspack.renderer.ts'))
const { createWorkerConfig } = require(path.join(LLD, 'tools', 'rspack', 'rspack.worker.ts'))

// Never `.webpack`: that is where upstream's own build writes, and the desktop
// app's main process loads from it.
const OUTPUT_PATH = path.join(LLD, 'dist-orivon')
const UPSTREAM_OUTPUT = path.join(LLD, '.webpack')

function expectOne (found, what) {
  if (found !== 1) {
    throw new Error(`orivon build wrapper: expected exactly one ${what}, found ${String(found)} -- upstream's config changed shape`)
  }
}

// ---- the contract bridge/ledger-wallet.js implements ----

// The renderer reads `window.lld` (src/renderer/bridge.ts) and throws on a
// version it does not know. These are the versions, the members and the
// channels the bridge answers or refuses, written down once: a release that
// changes any of them fails here, before it builds an app whose bridge is
// another contract's.
const BRIDGE_VERSION = 7
const BOOTSTRAP_VERSION = 2
const BRIDGE_MEMBERS = [
  'version', 'bootstrap', 'shell', 'system', 'zcash', 'db', 'updater', 'deeplink', 'webview', 'app', 'files', 'power',
  'store', 'cardSession'
]
const CHANNELS = [
  'bootstrap', 'lld-store:set', 'lld-store:clear', 'getKey', 'setKey', 'hasEncryptionKey', 'setEncryptionKey',
  'removeEncryptionKey', 'isEncryptionKeyCorrect', 'hasBeenDecrypted', 'resetAll', 'reload', 'cleanCache',
  'updater', 'deep-linking', 'webview:domain-check-violation', 'app-reload', 'app-relaunch', 'app-quit',
  'show-app', 'save-logs', 'export-operations', 'save-png', 'openUserDataDirectory', 'activate-keep-screen-awake',
  'deactivate-keep-screen-awake', 'shell:open-external', 'clipboard:matches-text', 'card-session:bootstrap',
  'webview-bridge:message', 'reloadRenderer', 'set-background-color', 'ready-to-show'
]

const CONTRACT = fs.readFileSync(path.join(LLD, 'src', 'bridge', 'contract.ts'), 'utf8')

function contractNumber (name) {
  const found = new RegExp(`export const ${name} = (\\d+);`).exec(CONTRACT)
  return found === null ? -1 : Number(found[1])
}
function difference (upstream, ours) {
  return [
    ...upstream.filter((name) => !ours.includes(name)).map((name) => `+${name}`),
    ...ours.filter((name) => !upstream.includes(name)).map((name) => `-${name}`)
  ]
}

if (contractNumber('BRIDGE_VERSION') !== BRIDGE_VERSION || contractNumber('BOOTSTRAP_VERSION') !== BOOTSTRAP_VERSION) {
  throw new Error(`orivon build wrapper: src/bridge/contract.ts is no longer bridge v${String(BRIDGE_VERSION)} with bootstrap v${String(BOOTSTRAP_VERSION)} -- re-derive bridge/ledger-wallet.js from it`)
}
const channelsBlock = /export const CHANNELS = \{([\s\S]*?)\} as const;/.exec(CONTRACT)
const upstreamChannels = channelsBlock === null ? [] : [...channelsBlock[1].matchAll(/:\s*"([^"]+)"/g)].map((match) => match[1])
const channelDiff = difference(upstreamChannels, CHANNELS)
if (upstreamChannels.length === 0 || channelDiff.length > 0) {
  throw new Error(`orivon build wrapper: the channels of src/bridge/contract.ts changed (${channelDiff.join(' ') || 'none found'}) -- answer or refuse each in bridge/ledger-wallet.js, then update CHANNELS here`)
}
const bridgeType = /export type LedgerBridge = \{([\s\S]*?)\n\};/.exec(CONTRACT)
const upstreamMembers = bridgeType === null ? [] : [...bridgeType[1].matchAll(/^\s+(\w+)\??:/gm)].map((match) => match[1])
const memberDiff = difference(upstreamMembers, BRIDGE_MEMBERS)
if (upstreamMembers.length === 0 || memberDiff.length > 0) {
  throw new Error(`orivon build wrapper: LedgerBridge changed (${memberDiff.join(' ') || 'none found'}) -- bridge/members.json and bridge/ledger-wallet.js must answer exactly its members`)
}

const renderer = createRendererConfig('production', { devServer: false })
const workers = createWorkerConfig('production')

// ---- renderer ----

// Upstream builds the renderer as a page already: context-isolated, no Node, a
// process shim of its own (src/renderer/bootstrap/process.ts) and browser
// fallbacks for the builtins. The port relies on exactly that, so it asserts it
// instead of patching it in.
expectOne(Array.isArray(renderer.target) && renderer.target[0] === 'web' ? 1 : 0, 'web renderer target')
expectOne(renderer.plugins.some((plugin) => plugin?.constructor?.name === 'ElectronTargetPlugin') ? 0 : 1, 'renderer config without ElectronTargetPlugin')
expectOne(renderer.externals === undefined || !('electron' in renderer.externals) ? 1 : 0, 'renderer config without an `electron` external')

// @ledgerhq/react-ui lists icons-ui as an injected dependency, which pnpm
// copies at install time -- before the library build has produced the icon
// components -- so the copy is empty. The workspace package is the built one.
const ICONS = path.join(CLONE, 'libs', 'ui', 'packages', 'icons')
if (!fs.existsSync(path.join(ICONS, 'react', 'index.js'))) {
  throw new Error(`orivon build wrapper: ${ICONS}/react/index.js is missing -- run the library build first`)
}
renderer.resolve = {
  ...renderer.resolve,
  alias: { ...renderer.resolve.alias, '@ledgerhq/icons-ui': ICONS }
}

// ---- both targets ----

// A served tree is declared, hashed and fetched whole, and source maps would be most of it. The
// workers have no check that reads a map, so they emit none. The renderer keeps its map while the
// build runs, because upstream's own ProcessReadGuard reads it after emit and fails the build
// without one; the maps are dropped once the build is done (DropSourceMaps below).
expectOne(workers.devtool === 'source-map' ? 1 : 0, `source-map devtool on ${String(workers.name)}`)
workers.devtool = false
expectOne(renderer.devtool === 'source-map' ? 1 : 0, `source-map devtool on ${String(renderer.name)}`)
expectOne(renderer.plugins.filter((plugin) => plugin?.constructor?.name === 'ProcessReadGuard').length, 'ProcessReadGuard plugin on the renderer')

const SOURCE_MAP_COMMENT = /(?:\n?\/\/# sourceMappingURL=[^\n]*|\n?\/\*# sourceMappingURL=[^*]*\*\/)\s*$/

class DropSourceMaps {
  apply (compiler) {
    compiler.hooks.done.tap('OrivonDropSourceMaps', (stats) => {
      const out = compiler.options.output.path
      let maps = 0
      for (const { name } of stats.compilation.getAssets()) {
        const file = path.join(out, name)
        if (name.endsWith('.map')) {
          fs.rmSync(file)
          maps += 1
        } else if (/\.(?:js|css)$/.test(name)) {
          const text = fs.readFileSync(file, 'utf8')
          if (SOURCE_MAP_COMMENT.test(text)) fs.writeFileSync(file, text.replace(SOURCE_MAP_COMMENT, '\n'))
        }
      }
      expectOne(maps > 0 ? 1 : 0, 'source map emitted for the renderer to drop')
    })
  }
}
renderer.plugins.push(new DropSourceMaps())

for (const [name, config] of [['renderer', renderer], ['workers', workers]]) {
  const moved = retargetOutput(config, { to: OUTPUT_PATH, from: UPSTREAM_OUTPUT })
  console.log(`orivon build wrapper: ${name} -> ${OUTPUT_PATH} (${String(moved)} copy rule(s) moved)`)
}

module.exports = [renderer, workers]
