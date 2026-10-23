// Runs in the clone (the executor's cwd) after the recipe's install step, which
// puts esbuild beside it: TiddlyWiki has no build of its own, and no
// dependency. Everything goes to ./orivon-dist:
//
//   server.mjs    the one file upstream's tiddlywiki.js is: it boots the kernel
//                 from the install tree and runs the command line it is given.
//                 Bundled for the Node shim of orivon-mvp (platform 'node'),
//                 with the vm stand-in in bridge/
//   launcher.js   the page that unpacks the tree, starts the server and shows
//                 what it serves
//   install/      upstream's kernel, core, the plugins, themes and languages the
//                 two editions the app can make a wiki from name, and those
//                 editions, as one pack (pack.bin) and its index (install.json,
//                 a stamp and each file's name and size)
//
// It throws when the kernel is not the one the stand-in was written for, when
// the tree is incomplete, or when the server bundle holds a require() nobody
// answers. README.md, Design notes, says why each choice is made.

import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadShimPlugin, printBuildFailure, printWarnings, readFiles, stampOf } from '../../src/build/esbuild-kit.mjs'
import { EDITIONS, editionDirs, INSTALL_DIR, installFileProblems, isInstallFile, kernelProblems, packNameProblems, packOf, WIKI_DIR } from './bridge/install-plan.js'

const RECIPE_DIR = dirname(fileURLToPath(import.meta.url))
const CLONE = process.cwd()
const OUT = join(CLONE, 'orivon-dist')
const posix = (path) => path.split(sep).join('/')
const STAMP_LENGTH = 24

if (!existsSync(join(CLONE, 'boot', 'boot.js')) || !existsSync(join(CLONE, 'tiddlywiki.js'))) {
  throw new Error(`${CLONE} is not a TiddlyWiki clone (no boot/boot.js or tiddlywiki.js): run this from out/wikifolder/source, as orivon-port build does`)
}
const esbuild = createRequire(join(CLONE, '..', 'esbuild', 'package.json'))('esbuild')
const { orivonShimPlugin, virtualRoot } = await loadShimPlugin()

/** Every file of the clone the server reads at run time, read once, in name order. */
async function collectInstall () {
  const dirs = editionDirs(await Promise.all(EDITIONS.map((name) => readFile(join(CLONE, 'editions', name, 'tiddlywiki.info'), 'utf8'))))
  const sources = []
  for (const entry of await readdir(CLONE, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const rel = posix(relative(CLONE, join(entry.parentPath, entry.name)))
    if (rel.startsWith('orivon-dist/') || rel.startsWith('.git/')) continue
    if (isInstallFile(rel, dirs)) sources.push([rel, join(CLONE, rel)])
  }
  const files = await readFiles(sources)
  const names = files.map(([name]) => name)
  const problems = [
    ...installFileProblems(names),
    ...packNameProblems(names),
    ...kernelProblems(await readFile(join(CLONE, 'boot', 'boot.js'), 'utf8'))
  ]
  if (problems.length > 0) throw new Error(`the install tree is not one the server can run from:\n  ${problems.join('\n  ')}`)
  return { files, stamp: stampOf(files, STAMP_LENGTH) }
}

async function bundleServer () {
  const result = await esbuild.build({
    entryPoints: [join(RECIPE_DIR, 'bridge', 'server-entry.js')],
    outfile: join(OUT, 'server.mjs'),
    absWorkingDir: CLONE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
    plugins: [orivonShimPlugin()]
  })
  printWarnings(result)
  console.log('server.mjs: the entry and the Node shim')
}

async function bundleLauncher (install) {
  const result = await esbuild.build({
    entryPoints: [join(RECIPE_DIR, 'launcher', 'launcher.js')],
    outfile: join(OUT, 'launcher.js'),
    absWorkingDir: CLONE,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    logLevel: 'silent',
    define: {
      ORIVON_INSTALL_PARENT: JSON.stringify(INSTALL_DIR),
      ORIVON_INSTALL_STAMP: JSON.stringify(install.stamp),
      ORIVON_WIKI_DIR: JSON.stringify(WIKI_DIR),
      ORIVON_VIRTUAL_ROOT: JSON.stringify(virtualRoot)
    },
    plugins: [orivonShimPlugin()]
  })
  printWarnings(result)
  for (const file of ['index.html', 'launcher.css']) await cp(join(RECIPE_DIR, 'launcher', file), join(OUT, file))
}

/** The collected tree into orivon-dist/install: the pack, and the index the launcher unpacks it by. */
async function writeInstall (install) {
  const dir = join(OUT, 'install')
  await mkdir(dir, { recursive: true })
  const { index, body } = packOf(install.files)
  await writeFile(join(dir, 'pack.bin'), body)
  await writeFile(join(dir, 'install.json'), `${JSON.stringify({ stamp: install.stamp, files: index })}\n`)
  console.log(`install/: ${String(index.length)} files in one pack of ${String(Math.round(body.length / 1024))} KiB, stamp ${install.stamp}`)
}

try {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  const install = await collectInstall()
  await bundleServer()
  await bundleLauncher(install)
  await writeInstall(install)
} catch (error) {
  printBuildFailure(error, (path) => posix(relative(CLONE, path)))
  process.exit(1)
}
