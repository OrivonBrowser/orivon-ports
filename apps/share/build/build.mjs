// The Orivon Share build, run in the typage clone by `orivon-port build`. It writes `share-dist/`:
//
// - the page in ../page, copied as it is (bar the two files that are bundled instead);
// - `crypto-worker.js`: page/src/crypto/worker.js bundled with typage (age-encryption) from the clone's own
//   lib/index.ts and the locked dependencies `npm ci` installed beside it, unminified, licence comments kept;
// - `node-launch.js`: page/src/node/launch.js bundled with Orivon's Node shim, so that the page can spawn its IPFS
//   node;
// - `bin/ipfs-node.p2/`: Orivon's IPFS node built for WebAssembly, fetched by its CID and checked block by block;
// - `build.json`: what was built from.

import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadShimPlugin, printWarnings } from '../../../src/build/esbuild-kit.mjs'
import { fetchVerified } from '../page/src/ipfs/gateway.js'
import { importDirectory } from '../page/src/ipfs/unixfs.js'

const recipe = dirname(dirname(fileURLToPath(import.meta.url)))
const source = process.cwd()
const out = join(source, 'share-dist')

/**
 * Orivon's IPFS node, as published: the folder's CID and the files the page needs from it. `features` is what the
 * node can do beyond serving blocks to a peer it dials: Share starts the node only when it lists `listen` and
 * `provide` (page/src/node/provide.js), so it stays empty until a node build that has them is published.
 * `SHARE_IPFS_NODE_DIR` names a local copy of the folder instead (a network whose resolver hijacks the gateways, or
 * a new build to try): a copy that makes this CID is the published node, any other is a trial build, said so.
 */
const IPFS_NODE = {
  cid: 'bafybeic3ggsskceuxhbd5gxmzw7pgfdu4cuqz3gv3ax3sioojywuqusmbe',
  features: /** @type {string[]} */ ([]),
  files: ['ipfs-node.p2/ipfs-node.js', 'ipfs-node.p2/ipfs-node.core.wasm', 'ipfs-node.p2/ipfs-node.core2.wasm', 'ipfs-node.p2/ipfs-node.core3.wasm', 'ipfs-node.p2/ipfs-node.core4.wasm', 'LICENSE-MIT', 'LICENSE-APACHE']
}
const GATEWAYS = ['https://ipfs.orbitor.dev', 'https://ipfs.filebase.io', 'https://trustless-gateway.link']
const ESBUILD = '0.25.12'
/** Page files that are bundled into the files above, so that their sources are not shipped as modules that cannot load. */
const BUNDLED = new Set(['src/crypto/worker.js', 'src/node/launch.js'])

const { version } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await cp(join(recipe, 'page'), out, {
  recursive: true,
  filter: (path) => !BUNDLED.has(relative(join(recipe, 'page'), path).split('\\').join('/'))
})

/** The node's files into bin/: the page spawns /bin/ipfs-node, which Orivon runs from bin/ipfs-node.p2/. */
async function addNode () {
  const local = process.env.SHARE_IPFS_NODE_DIR
  const files = []
  for (const path of IPFS_NODE.files) {
    files.push({ path, bytes: local ? new Uint8Array(await readFile(join(local, path))) : (await fetchVerified(IPFS_NODE.cid, path, { gateways: GATEWAYS, timeoutMs: 600_000 })).bytes })
  }
  let trial = false
  if (local) {
    const { cid } = await importDirectory(files)
    if (cid === IPFS_NODE.cid) console.log(`[share] the IPFS node from ${local}: the published ${cid}`)
    else if (process.env.SHARE_IPFS_NODE_TRIAL === '1') {
      console.warn(`[share] the IPFS node from ${local} is ${cid}, not the published ${IPFS_NODE.cid}: a trial build, not one to publish`)
      trial = true
    } else {
      throw new Error(`${local} makes ${cid}, not the published IPFS node ${IPFS_NODE.cid}. Set SHARE_IPFS_NODE_TRIAL=1 to build with it anyway, as a trial.`)
    }
  }
  for (const { path, bytes } of files) {
    const target = join(out, 'bin', path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
  return trial
}

/** esbuild at the pinned version, installed beside the clone so that it is not part of typage's own tree. */
async function esbuildTools () {
  const tools = join(source, '..', 'node-tools')
  const installed = await readFile(join(tools, 'node_modules', 'esbuild', 'package.json'), 'utf8').then((text) => JSON.parse(text).version, () => null)
  if (installed !== ESBUILD) {
    await mkdir(tools, { recursive: true })
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--prefix', tools, '--no-save', '--no-audit', '--no-fund', `esbuild@${ESBUILD}`], { stdio: 'inherit', shell: process.platform === 'win32' })
  }
  return createRequire(join(tools, 'package.json'))('esbuild')
}

/** crypto-worker.js: the page's worker with typage, from the clone. */
async function bundleWorker (esbuild) {
  const result = await esbuild.build({
    entryPoints: [join(recipe, 'page', 'src', 'crypto', 'worker.js')],
    outfile: join(out, 'crypto-worker.js'),
    alias: { 'age-encryption': join(source, 'lib', 'index.ts') },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: false,
    legalComments: 'inline',
    logLevel: 'silent'
  })
  printWarnings(result)
}

/** node-launch.js: page/src/node/launch.js with Orivon's Node shim, unminified like the rest of the page. */
async function bundleLauncher (esbuild) {
  const { orivonShimPlugin } = await loadShimPlugin()
  const result = await esbuild.build({
    entryPoints: [join(recipe, 'page', 'src', 'node', 'launch.js')],
    outfile: join(out, 'node-launch.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: false,
    legalComments: 'inline',
    logLevel: 'silent',
    plugins: [orivonShimPlugin()]
  })
  printWarnings(result)
}

const trial = await addNode()
const esbuild = await esbuildTools()
await bundleWorker(esbuild)
await bundleLauncher(esbuild)
await writeFile(join(out, 'build.json'), JSON.stringify({ typage: version, ipfsNode: IPFS_NODE.cid, nodeFeatures: IPFS_NODE.features, ...(trial ? { trial: true } : {}) }, null, 2) + '\n')
