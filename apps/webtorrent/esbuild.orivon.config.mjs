// Runs after upstream's own `npm run build` (Babel, src/ -> build/), in the
// clone (the executor's cwd). Everything goes to ./orivon-dist:
//
//   webtorrent-desktop.js  both of upstream's renderer windows (the hidden
//                          torrent window and the main window) and the stand-in
//                          for its main process, as one classic script. Bundled
//                          the way Electron's own require() resolves under
//                          nodeIntegration: Node resolution (platform 'node'),
//                          so no package's `browser` field turns TCP, the DHT or
//                          the streaming server off, and every Node builtin and
//                          `electron` go to orivon-mvp's shim
//   index.html             upstream's static/main.html, its require() replaced
//                          by the bundle
//   static/                upstream's static/, served as it is
//
// The decisions are in bridge/build-plan.js; README.md, Design notes, says why.

import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  APP_ROOT, answeredChannels, ENTRY_FILE, sentChannels, STAMP_FILE, STAND_INS, unansweredChannels, checkBundle, electronRendererDefines, installFiles, mainHtml, moduleScope, REFUSED_NATIVE, refusedNativeSource, stampOf
} from './bridge/build-plan.js'

const RECIPE_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(RECIPE_DIR, '..', '..')
const CLONE = process.cwd()
const OUT = join(CLONE, 'orivon-dist')
const posix = (path) => path.split(sep).join('/')
const REQUIRE_SHAPE = 'webtorrent-require-shape'
const REFUSED = 'webtorrent-refused-native'

/** orivon-mvp's shim bundler plugin: `ORIVON_MVP_ROOT`, else the checkout beside this repository. */
async function loadShimPlugin () {
  const root = process.env.ORIVON_MVP_ROOT ?? resolve(REPO_ROOT, '..', 'orivon-mvp')
  const file = join(root, 'src', 'shim', 'bundler', 'esbuild-plugin.ts')
  if (!existsSync(file)) {
    throw new Error(`${file} does not exist. Set ORIVON_MVP_ROOT to an orivon-mvp checkout that has src/shim/bundler/ (default: ../orivon-mvp beside this repository).`)
  }
  return await import(pathToFileURL(file).href)
}

if (!existsSync(join(CLONE, 'build', 'renderer', 'main.js'))) {
  throw new Error(`${CLONE} has no build/renderer/main.js: run this from out/webtorrent/source after upstream's npm run build, as orivon-port build does`)
}
const esbuild = createRequire(join(CLONE, '..', 'esbuild', 'package.json'))('esbuild')
const { orivonShimPlugin } = await loadShimPlugin()

/**
 * Resolves `webtorrent-desktop/...` into the clone, puts the port's stand-ins
 * where upstream reaches for its main process, refuses the native addons by
 * name, and gives each module the `__dirname` it would have in the install.
 */
function portPlugin () {
  const bridge = (name) => join(RECIPE_DIR, 'bridge', name)
  const inClone = (path) => path.startsWith(CLONE + sep) && !path.startsWith(OUT + sep)
  return {
    name: 'webtorrent-desktop',
    setup (build) {
      build.onResolve({ filter: /^webtorrent-desktop\// }, (args) => ({ path: join(CLONE, args.path.slice('webtorrent-desktop/'.length)) }))
      for (const [name, file] of Object.entries(STAND_INS)) {
        build.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, '\\$&')}$`) }, (args) => {
          if (name === 'electron' && !inClone(args.importer)) return undefined
          return args.kind === 'require-call' ? { path: bridge(file), namespace: REQUIRE_SHAPE } : { path: bridge(file) }
        })
      }
      // A CommonJS caller's require() gets the stand-in's default export, as it would get module.exports.
      build.onLoad({ filter: /.*/, namespace: REQUIRE_SHAPE }, async (args) => {
        const exported = /^export default /m.test(await readFile(args.path, 'utf8')) ? 'namespace.default' : 'namespace'
        return { contents: `import * as namespace from ${JSON.stringify(args.path)}\nmodule.exports = ${exported}\n`, loader: 'js', resolveDir: dirname(args.path) }
      })
      // One module per importer: esbuild caches a module that threw while loading and hands
      // the next require() its empty exports, where Node would throw again.
      for (const name of REFUSED_NATIVE) {
        build.onResolve({ filter: new RegExp(`^${name}$`) }, (args) => ({ path: `${name} required by ${posix(relative(CLONE, args.importer))}`, namespace: REFUSED }))
      }
      build.onLoad({ filter: /.*/, namespace: REFUSED }, (args) => ({ contents: refusedNativeSource(args.path.split(' ')[0]), loader: 'js' }))
      build.onLoad({ filter: /\.[cm]?js$/ }, async (args) => {
        if (!inClone(args.path)) return undefined
        const source = await readFile(args.path, 'utf8')
        return { contents: moduleScope(source, posix(relative(CLONE, args.path))), loader: 'js', resolveDir: dirname(args.path) }
      })
    }
  }
}

/**
 * esbuild applies the nearest tsconfig.json to JavaScript too, and the nearest one above the clone
 * is this repository's strict one, which would put "use strict" in every module of upstream's. One
 * beside the clone, outside it, is nearer: Node runs CommonJS sloppy, and so does this bundle.
 */
async function sloppyCommonJs () {
  await writeFile(join(CLONE, '..', 'tsconfig.json'), `${JSON.stringify({ compilerOptions: { strict: false, alwaysStrict: false } }, null, 2)}\n`)
}

/** The Electron upstream's lockfile installs, which says what its renderer's `process` reports. */
async function electronVersion () {
  return JSON.parse(await readFile(join(CLONE, 'node_modules', 'electron', 'package.json'), 'utf8')).version
}

async function bundle () {
  await sloppyCommonJs()
  const result = await esbuild.build({
    // A CommonJS entry under no tsconfig, so the bundle is not headed with "use strict" (sloppyCommonJs).
    stdin: { contents: `require(${JSON.stringify(join(RECIPE_DIR, 'bridge', 'page-entry.js'))})\n`, resolveDir: tmpdir(), sourcefile: 'webtorrent-desktop-entry.cjs', loader: 'js' },
    outfile: join(OUT, ENTRY_FILE),
    absWorkingDir: CLONE,
    bundle: true,
    platform: 'node',
    format: 'iife',
    target: 'es2022',
    metafile: true,
    legalComments: 'external',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', ...electronRendererDefines(await electronVersion()) },
    plugins: [portPlugin(), orivonShimPlugin()]
  })
  for (const warning of result.warnings) console.warn(`warning: ${warning.text} (${warning.location?.file ?? '?'}:${String(warning.location?.line ?? '?')})`)
  const code = await readFile(join(OUT, ENTRY_FILE), 'utf8')
  const inputs = Object.keys(result.metafile.inputs).map(posix)
  const rendererSources = []
  for (const entry of await readdir(join(CLONE, 'src', 'renderer'), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) rendererSources.push(await readFile(join(entry.parentPath, entry.name), 'utf8'))
  }
  const unanswered = unansweredChannels(sentChannels(rendererSources), answeredChannels(await readFile(join(RECIPE_DIR, 'bridge', 'main-process.js'), 'utf8')))
  const problems = [
    ...checkBundle(code, inputs),
    ...unanswered.map((channel) => `upstream's windows send '${channel}' to main, and bridge/main-process.js does not answer it`)
  ]
  if (problems.length > 0) throw new Error(`${ENTRY_FILE} is not a bundle Orivon can run:\n  ${problems.join('\n  ')}`)
  console.log(`${ENTRY_FILE}: ${String(inputs.length)} modules, ${String(Math.round(code.length / 1024))} KiB`)
}

/** Upstream's static/ as it is, the entry document, and the stamp the page checks before it copies the files the app reads with fs. */
async function writeTree () {
  await cp(join(CLONE, 'static'), join(OUT, 'static'), { recursive: true })
  await writeFile(join(OUT, 'index.html'), mainHtml(await readFile(join(CLONE, 'static', 'main.html'), 'utf8')))
  const files = []
  for (const name of await installFiles(join(CLONE, 'static'))) files.push([name, await readFile(join(CLONE, 'static', name))])
  await writeFile(join(OUT, STAMP_FILE), `${JSON.stringify({ stamp: stampOf(files), root: APP_ROOT, files: files.map(([name]) => name) }, null, 2)}\n`)
  await cp(join(CLONE, 'LICENSE'), join(OUT, 'LICENSE'))
}

try {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  await bundle()
  await writeTree()
} catch (error) {
  const texts = (error.errors ?? []).map((entry) => entry.text)
  for (const text of texts) console.error(text)
  if (texts.length === 0) console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
