// The Bitsocial Node build, run in the pkc-js clone by `orivon-port build`. It writes `bitsocial-node-dist/`:
//
// - the page in ../page, bar `node-client.js` (with `follow-sync.js`) and `node-dashboard.js` (with its modules in `page/dashboard/`), which are bundled instead;
// - `node/server.mjs`: the Worker (../node/worker/main.js) bundled with pkc-js, the kubo facade, the 5chan board manager and
//   Orivon's Node shim, and `node/sqlite3.wasm` beside it, where the shim's SQLite engine looks for it. The bundle is
//   minified with `keepNames` (pkc-js reads class and function names) and packed: `node/server.mjs` is then the small
//   loader (server-loader.mjs) and the code is `node/server.bundle.js.deflate`. `BITSOCIAL_NODE_MINIFY=0` and
//   `BITSOCIAL_NODE_COMPRESS=0` give back the readable bundle and the plain files, for debugging (pack.mjs);
// - `node-client.js`: the page module that starts the Worker, bundled with the shim, as `globalThis.BitsocialNodeClient`;
// - `node-dashboard.js`: the node dashboard every app's "node" link opens, as `globalThis.BitsocialNodeDashboard` (no shim: it only draws);
// - `bin/`: Orivon's IPFS node, checked against its pin (node-component.mjs);
// - `bundle.json`: each file a page needs to run the node, with its sha256; `build.json`: what was built from.
//
// pkc-js comes from the package npm installs at the version in node/package.json; the clone has to be at the same
// version. The shim comes from the Orivon checkout `ORIVON_MVP_ROOT` names (an esbuild plugin, README.md section Design notes).

import { execFileSync } from 'node:child_process'
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadShimPlugin, mvpRootOf, printBuildFailure, printWarnings, stableBundlePaths } from '../../../src/build/esbuild-kit.mjs'
import { writeBundleManifest } from './bundle-manifest.mjs'
import { BOARD_MANAGER_PACKAGE, boardManagerSource } from './board-manager.mjs'
import { challengeSources } from './challenges.mjs'
import { debugLog } from './gap-debug-log.mjs'
import { dnsResultOrder } from './gap-dns.mjs'
import { lockResolver, startLock } from './gap-lock.mjs'
import { lruStorageFiles } from './gap-lru-storage.mjs'
import { registryResolver } from './gap-registry.mjs'
import { builtinStubs, stubbedBuiltins } from './gap-stubs.mjs'
import { uuidRandomValues } from './gap-uuid.mjs'
import { addNodeComponent, NODE_COMPONENT } from './node-component.mjs'
import { switchedOn, writePackedServer } from './pack.mjs'
import { requireApplied, textPatches } from './text-patch.mjs'

const recipe = dirname(dirname(fileURLToPath(import.meta.url)))
const source = process.cwd()
const out = join(source, 'bitsocial-node-dist')
const nodeDir = join(recipe, 'node')
const minify = switchedOn('BITSOCIAL_NODE_MINIFY')
const compress = switchedOn('BITSOCIAL_NODE_COMPRESS')
/** The page files, and the folder of modules, that are bundled into others instead of being copied. */
const BUNDLED = new Set(['node-client.js', 'node-dashboard.js', 'follow-sync.js', 'dashboard'])

const installed = (/** @type {string} */ name) => readFile(join(nodeDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8').then(JSON.parse, () => {
  throw new Error(`${name} is not installed in ${nodeDir}: run \`npm run bitsocial-node:install\``)
})
const pkcPackage = await installed('@pkcprotocol/pkc-js')
const cloneVersion = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version
if (cloneVersion !== pkcPackage.version) {
  throw new Error(`the clone is pkc-js ${cloneVersion} and node/package.json installs ${pkcPackage.version}: move the pin and the dependency together`)
}
await installed('esbuild')
const boardManager = await installed(BOARD_MANAGER_PACKAGE)
const esbuild = createRequire(join(nodeDir, 'package.json'))('esbuild')
const mvpRoot = mvpRootOf()
const { orivonShimPlugin, shimAssets } = await loadShimPlugin()

await rm(out, { recursive: true, force: true })
await mkdir(join(out, 'node'), { recursive: true })
await cp(join(recipe, 'page'), out, { recursive: true, filter: (path) => !BUNDLED.has(path.slice(join(recipe, 'page').length + 1).split(sep)[0] ?? '') })

const applied = new Set()
/** The patches of pkc-js's chunks: each must find its chunk and its text, or the build stops. */
const PKC_PATCHES = [uuidRandomValues, dnsResultOrder, startLock, debugLog, lruStorageFiles]

/** @param {string} label @param {import('esbuild').BuildOptions} options */
async function bundle (label, options) {
  try {
    const result = await esbuild.build({ bundle: true, target: 'es2022', minify: false, legalComments: 'inline', logLevel: 'silent', absWorkingDir: source, ...options })
    printWarnings(result)
    return result
  } catch (error) {
    console.error(`${label} failed to build`)
    printBuildFailure(error, (path) => path)
    process.exit(1)
  }
}

// A packed bundle is run by server-loader.mjs, which cannot give it a module address: it reads `import.meta.url` from there.
const serverAddress = compress ? { 'import.meta.url': 'globalThis.__bitsocialServerUrl' } : {}
await bundle('node/server.mjs', {
  entryPoints: [join(recipe, 'node', 'worker', 'main.js')],
  outfile: join(out, 'node', 'server.mjs'),
  platform: 'node',
  format: 'esm',
  minify,
  keepNames: minify,
  define: { BITSOCIAL_NODE_FLAGS: JSON.stringify(NODE_COMPONENT.flags), ...serverAddress },
  plugins: [
    builtinStubs,
    registryResolver(mvpRoot),
    lockResolver,
    boardManagerSource({ version: String(boardManager.version) }),
    challengeSources(),
    textPatches(PKC_PATCHES, applied),
    orivonShimPlugin(),
    stableBundlePaths()
  ]
})
requireApplied(PKC_PATCHES, applied)
if (compress) {
  await writePackedServer(join(out, 'node'), await readFile(join(out, 'node', 'server.mjs')))
}
for (const asset of shimAssets()) await copyFile(asset.path, join(out, 'node', asset.name))

await bundle('node-client.js', {
  entryPoints: [join(recipe, 'page', 'node-client.js')],
  outfile: join(out, 'node-client.js'),
  platform: 'browser',
  format: 'iife',
  globalName: 'BitsocialNodeClient',
  plugins: [orivonShimPlugin(), stableBundlePaths()]
})

await bundle('node-dashboard.js', {
  entryPoints: [join(recipe, 'page', 'node-dashboard.js')],
  outfile: join(out, 'node-dashboard.js'),
  platform: 'browser',
  format: 'iife',
  globalName: 'BitsocialNodeDashboard',
  plugins: [stableBundlePaths()]
})

await addNodeComponent(out, process.env, { compress })

const pkcJs = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
await writeFile(join(out, 'build.json'), JSON.stringify({ pkcJs, pkcJsVersion: pkcPackage.version, boardManager: { package: BOARD_MANAGER_PACKAGE, version: boardManager.version }, ipfsNodeFeatures: NODE_COMPONENT.features, ipfsNodeFlags: NODE_COMPONENT.flags, minified: minify, packed: compress, stubbedBuiltins, patches: [...applied].sort() }, null, 2) + '\n')
await writeBundleManifest(out, { pkcJs: pkcPackage.version })
