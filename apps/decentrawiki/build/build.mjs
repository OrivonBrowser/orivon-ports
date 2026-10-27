// The DecentraWiki build, run in the TiddlyWiki clone by `orivon-port build`.
// It writes two trees with TiddlyWiki's own command line:
//
// - `decentrawiki-dist/`, the editor (editor.decentrawiki.eth): the page in
//   ../page, the editing frame (frame.html), the shared TiddlyWiki core, and the
//   IPFS node the page publishes from in Orivon: `bin/ipfs-node.p2/`, Orivon's
//   IPFS node built for WebAssembly, fetched by its CID and checked block by
//   block, and `node-launch.js`, the one page file bundled, with Orivon's Node
//   shim, so that it can spawn the node;
// - `decentrawiki-home/`, decentrawiki.eth: the DecentraWiki guide, a wiki
//   published exactly as the editor publishes every wiki.
//
// Both load the same core file, byte for byte; the build refuses otherwise.

import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadShimPlugin, printWarnings } from '../../../src/build/esbuild-kit.mjs'
import { fetchVerified } from '../page/src/ipfs/gateway.js'
import { importDirectory } from '../page/src/ipfs/unixfs.js'

const recipe = dirname(dirname(fileURLToPath(import.meta.url)))
const source = process.cwd()
const editorOut = join(source, 'decentrawiki-dist')
const homeOut = join(source, 'decentrawiki-home')

/**
 * Orivon's IPFS node with its serving mode, as published: the folder's CID and the files the page needs
 * from it. `DECENTRAWIKI_IPFS_NODE_DIR` names a local copy of the folder instead (a network whose resolver
 * hijacks the gateways, or a new build to try): a copy that makes this CID is the published node, any
 * other is a trial build, said so, and not one to publish.
 */
const IPFS_NODE = {
  cid: 'bafybeiaq5sq7n6nssfzzvjsbreybipuouzgne3las6cwhkz3k4kmsr6f44',
  files: ['ipfs-node.p2/ipfs-node.js', 'ipfs-node.p2/ipfs-node.core.wasm', 'ipfs-node.p2/ipfs-node.core2.wasm', 'ipfs-node.p2/ipfs-node.core3.wasm', 'ipfs-node.p2/ipfs-node.core4.wasm', 'LICENSE-MIT', 'LICENSE-APACHE']
}
const GATEWAYS = ['https://ipfs.orbitor.dev', 'https://ipfs.filebase.io', 'https://trustless-gateway.link']
const ESBUILD = '0.25.12'

const { version } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
const core = `tiddlywikicore-${version}.js`
const env = { ...process.env, TIDDLYWIKI_PLUGIN_PATH: join(recipe, 'wiki', 'plugins') }

/** Renders an edition as an HTML page beside the core file it loads. */
function renderEdition (edition, out, page) {
  execFileSync(process.execPath, [
    join(source, 'tiddlywiki.js'), join(recipe, 'wiki', edition),
    '--output', out,
    '--render', '$:/core/save/offline-external-js', page, 'text/plain',
    '--render', '$:/core/templates/tiddlywiki5.js', core, 'text/plain'
  ], { cwd: source, env, stdio: ['ignore', 'inherit', 'inherit'] })
}

await rm(editorOut, { recursive: true, force: true })
await rm(homeOut, { recursive: true, force: true })
await mkdir(editorOut, { recursive: true })

renderEdition('frame', editorOut, 'frame.html')
renderEdition('home', homeOut, 'index.html')

const [editorCore, homeCore] = await Promise.all([readFile(join(editorOut, core)), readFile(join(homeOut, core))])
if (!editorCore.equals(homeCore)) throw new Error(`${core} differs between the editor and decentrawiki.eth: a published wiki would load another core than the one it was edited with`)

await cp(join(recipe, 'page'), editorOut, { recursive: true })

/** The node's files into bin/: the page spawns /bin/ipfs-node, which Orivon runs from bin/ipfs-node.p2/. */
async function addNode () {
  const local = process.env.DECENTRAWIKI_IPFS_NODE_DIR
  const files = []
  for (const path of IPFS_NODE.files) {
    files.push({ path, bytes: local ? new Uint8Array(await readFile(join(local, path))) : (await fetchVerified(IPFS_NODE.cid, path, { gateways: GATEWAYS, timeoutMs: 600_000 })).bytes })
  }
  let trial = false
  if (local) {
    const { cid } = await importDirectory(files)
    if (cid === IPFS_NODE.cid) console.log(`[decentrawiki] the IPFS node from ${local}: the published ${cid}`)
    else if (process.env.DECENTRAWIKI_IPFS_NODE_TRIAL === '1') {
      console.warn(`[decentrawiki] the IPFS node from ${local} is ${cid}, not the published ${IPFS_NODE.cid}: a trial build, not one to publish`)
      trial = true
    } else {
      throw new Error(`${local} makes ${cid}, not the published IPFS node ${IPFS_NODE.cid}. Set DECENTRAWIKI_IPFS_NODE_TRIAL=1 to build with it anyway, as a trial.`)
    }
  }
  for (const { path, bytes } of files) {
    const out = join(editorOut, 'bin', path)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, bytes)
  }
  return trial
}

/** node-launch.js: page/src/node/launch.js with Orivon's Node shim, unminified like the rest of the page. */
async function bundleLauncher () {
  const tools = join(source, '..', 'node-tools')
  const esbuildPackage = join(tools, 'node_modules', 'esbuild', 'package.json')
  const installed = await readFile(esbuildPackage, 'utf8').then((text) => JSON.parse(text).version, () => null)
  if (installed !== ESBUILD) {
    await mkdir(tools, { recursive: true })
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--prefix', tools, '--no-save', '--no-audit', '--no-fund', `esbuild@${ESBUILD}`], { stdio: 'inherit', shell: process.platform === 'win32' })
  }
  const esbuild = createRequire(join(tools, 'package.json'))('esbuild')
  const { orivonShimPlugin } = await loadShimPlugin()
  const result = await esbuild.build({
    entryPoints: [join(recipe, 'page', 'src', 'node', 'launch.js')],
    outfile: join(editorOut, 'node-launch.js'),
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
await bundleLauncher()
await writeFile(join(editorOut, 'build.json'), JSON.stringify({ tiddlywiki: version, core, ipfsNode: IPFS_NODE.cid, ...(trial ? { trial: true } : {}) }, null, 2) + '\n')
