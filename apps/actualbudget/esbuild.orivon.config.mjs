// Runs after upstream's own desktop build, in the clone (the executor's cwd). Everything goes to
// ./orivon-dist:
//
//   (upstream's renderer)   packages/desktop-client/build-electron, copied as upstream's
//                           desktop-electron/bin/update-client copies it: without sourcemaps,
//                           the browser backend's data and *.wasm
//   server.mjs              upstream's desktop backend (loot-core's bundle.desktop.js, unchanged) and
//                           bridge/server-entry.js, bundled for the Node shim of orivon-mvp: every
//                           Node builtin and `better-sqlite3` go to the shim through mvp's esbuild plugin
//   sqlite3.wasm            the SQLite engine, which the bundle fetches beside itself
//   orivon/actual-backend.js  the page's side of the backend (bridge/backend-entry.js)
//   install/                the files the backend reads at run time: the database template and the
//                           migrations, with install.json (a stamp and the file list)
//
// It throws when the clone is not the release the bridge answers for, when the backend bundle is
// not one that can run, or when the install tree is incomplete. README.md, Design notes, says why
// each choice is made.

import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadShimPlugin, printBuildFailure, printWarnings, readFiles, stampOf } from '../../src/build/esbuild-kit.mjs'
import { ACTUAL_VERSION, installDirFor, moduleLocation, withModuleScope } from './bridge/plan.js'
import { dynamicRequires, installFileProblems, metafileProblems, versionProblem } from './bridge/build-checks.js'

const RECIPE_DIR = dirname(fileURLToPath(import.meta.url))
const CLONE = process.cwd()
const OUT = join(CLONE, 'orivon-dist')
const CLIENT = join(CLONE, 'packages', 'desktop-client', 'build-electron')
const BACKEND = join(CLONE, 'packages', 'loot-core', 'lib-dist', 'electron', 'bundle.desktop.js')
const LOOT_CORE = join(CLONE, 'packages', 'loot-core')
const posix = (path) => path.split(sep).join('/')
const STAMP_LENGTH = 24

for (const file of [join(CLONE, 'packages', 'desktop-electron', 'package.json'), BACKEND, join(CLIENT, 'index.html')]) {
  if (!existsSync(file)) throw new Error(`${file} does not exist: run this from out/actualbudget/source after upstream's desktop build, as orivon-port build does`)
}
const esbuild = createRequire(join(CLONE, 'package.json'))('esbuild')
const { orivonShimPlugin, shimAssets, virtualRoot } = await loadShimPlugin()

/** The database template and the migrations the backend reads from beside its bundle, each read once. */
async function collectInstall () {
  const sources = [['default-db.sqlite', join(LOOT_CORE, 'default-db.sqlite')]]
  for (const name of await readdir(join(LOOT_CORE, 'migrations'))) {
    if (/\.(?:sql|js)$/.test(name)) sources.push([`migrations/${name}`, join(LOOT_CORE, 'migrations', name)])
  }
  const files = await readFiles(sources)
  const problems = installFileProblems(files.map(([name]) => name))
  if (problems.length > 0) throw new Error(`the install tree is incomplete:\n  ${problems.join('\n  ')}`)
  return { files, stamp: stampOf(files, STAMP_LENGTH) }
}

/** Resolves `actual-backend` to upstream's bundle and gives it the names Node's CommonJS wrapper would. */
function backendPlugin (installRoot) {
  return {
    name: 'actual-backend',
    setup (build) {
      build.onResolve({ filter: /^actual-backend$/ }, () => ({ path: BACKEND }))
      build.onLoad({ filter: /bundle\.desktop\.js$/ }, async (args) => {
        const location = moduleLocation(args.path, BACKEND, installRoot)
        if (location === null) return undefined
        return { contents: withModuleScope(await readFile(args.path, 'utf8'), location), loader: 'js', resolveDir: dirname(args.path) }
      })
    }
  }
}

async function bundleServer (installRoot) {
  const result = await esbuild.build({
    entryPoints: [join(RECIPE_DIR, 'bridge', 'server-entry.js')],
    outfile: join(OUT, 'server.mjs'),
    absWorkingDir: CLONE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    metafile: true,
    legalComments: 'external',
    logLevel: 'silent',
    plugins: [backendPlugin(installRoot), orivonShimPlugin()]
  })
  printWarnings(result)
  const code = await readFile(join(OUT, 'server.mjs'), 'utf8')
  const inputs = Object.keys(result.metafile.inputs).map(posix)
  const problems = [...metafileProblems(inputs, posix(relative(CLONE, BACKEND))), ...dynamicRequires(code)]
  if (problems.length > 0) throw new Error(`server.mjs is not a bundle the shim can run:\n  ${problems.join('\n  ')}`)
  // The SQLite engine fetches its WebAssembly relative to the bundle file that holds it.
  for (const { name, path } of shimAssets()) await copyFile(path, join(OUT, name))
  console.log(`server.mjs: ${String(inputs.length)} modules, ${String(Math.round(code.length / 1024))} KiB`)
}

async function bundlePage (install) {
  const result = await esbuild.build({
    entryPoints: [join(RECIPE_DIR, 'bridge', 'backend-entry.js')],
    outfile: join(OUT, 'orivon', 'actual-backend.js'),
    absWorkingDir: CLONE,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    logLevel: 'silent',
    define: {
      ORIVON_INSTALL_STAMP: JSON.stringify(install.stamp),
      ORIVON_VIRTUAL_ROOT: JSON.stringify(virtualRoot)
    },
    plugins: [orivonShimPlugin()]
  })
  printWarnings(result)
}

/** The renderer as upstream's `update-client` copies it into the desktop app. */
async function copyClient () {
  const unwanted = (path) => {
    const rel = posix(relative(CLIENT, path))
    const name = basename(path)
    return rel === 'data' || name.endsWith('.map') || name.endsWith('.wasm') || name.includes('kcab.')
  }
  await cp(CLIENT, OUT, { recursive: true, filter: (source) => !unwanted(source) })
}

async function writeInstall (install) {
  const dir = join(OUT, 'install')
  for (const [name, bytes] of install.files) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), bytes)
  }
  await writeFile(join(dir, 'install.json'), `${JSON.stringify({ stamp: install.stamp, files: install.files.map(([name]) => name) }, null, 2)}\n`)
  console.log(`install/: ${String(install.files.length)} files, stamp ${install.stamp}`)
}

try {
  const upstream = JSON.parse(await readFile(join(CLONE, 'packages', 'desktop-electron', 'package.json'), 'utf8'))
  const mismatch = versionProblem(upstream.version, ACTUAL_VERSION)
  if (mismatch !== null) throw new Error(mismatch)
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  const install = await collectInstall()
  await copyClient()
  await bundleServer(`${virtualRoot}/${installDirFor(install.stamp)}`)
  await bundlePage(install)
  await writeInstall(install)
} catch (error) {
  printBuildFailure(error, (path) => posix(relative(CLONE, path)))
  process.exit(1)
}
