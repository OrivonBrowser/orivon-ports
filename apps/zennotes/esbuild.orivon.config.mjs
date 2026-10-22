// Runs after upstream's own electron-vite build, in the clone (the executor's cwd). Upstream's
// renderer is kept as built, in apps/desktop/out/renderer. This bundles what its Electron main
// process and preload would have been: the preload, which builds window.zen, and the part of the
// main process that reads and writes the notes, as one classic script beside the renderer
// (orivon/zennotes.js). Both run in the page, on orivon-mvp's shim, where the preload's calls
// reach the main-process half over the shim's in-page message bus.
//
// The decisions are in bridge/build-plan.js; README.md, Design notes, says why.

import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkMetafile, loadShimPlugin, printBuildFailure, printWarnings } from '../../src/build/esbuild-kit.mjs'
import {
  answeredChannels, BUNDLE_FILE, FORBIDDEN_PREFIXES, REFUSED_NATIVE, refusedNativeSource, REQUIRED_INPUTS, sentChannels, STAND_INS, unansweredChannels
} from './bridge/build-plan.js'

const RECIPE_DIR = dirname(fileURLToPath(import.meta.url))
const CLONE = process.cwd()
const DESKTOP = join(CLONE, 'apps', 'desktop')
const RENDERER = join(DESKTOP, 'out', 'renderer')
const posix = (path) => path.split(sep).join('/')
const REFUSED = 'zennotes-refused-native'

if (!existsSync(join(RENDERER, 'index.html'))) {
  throw new Error(`${RENDERER}/index.html does not exist: run this from out/zennotes/source after upstream's electron-vite build, as orivon-port build does`)
}
const esbuild = createRequire(join(CLONE, 'package.json'))('esbuild')
const { orivonShimPlugin } = await loadShimPlugin()

/**
 * Resolves the clone's own aliases, puts the port's stand-ins where upstream imports the `electron`
 * module and the file watcher, and refuses the native modules by name.
 */
function portPlugin () {
  const bridge = (name) => join(RECIPE_DIR, 'bridge', name)
  const inClone = (path) => path.startsWith(CLONE + sep)
  return {
    name: 'zennotes',
    setup (build) {
      build.onResolve({ filter: /^zennotes-desktop\// }, async (args) => {
        const target = join(DESKTOP, 'src', args.path.slice('zennotes-desktop/'.length))
        return { path: target }
      })
      for (const [name, file] of Object.entries(STAND_INS)) {
        build.onResolve({ filter: new RegExp(`^${name}$`) }, (args) => {
          if (!inClone(args.importer)) return undefined
          return { path: bridge(file) }
        })
      }
      // One module per importer: esbuild caches a module that threw while loading and hands the
      // next require() its empty exports, where Node would throw again.
      for (const name of REFUSED_NATIVE) {
        build.onResolve({ filter: new RegExp(`^${name}$`) }, (args) => ({ path: `${name} required by ${posix(relative(CLONE, args.importer))}`, namespace: REFUSED }))
      }
      build.onLoad({ filter: /.*/, namespace: REFUSED }, (args) => ({ contents: refusedNativeSource(args.path.split(' ')[0]), loader: 'js' }))
    }
  }
}

async function bundle () {
  const outfile = join(RENDERER, BUNDLE_FILE)
  await mkdir(dirname(outfile), { recursive: true })
  const result = await esbuild.build({
    entryPoints: [join(RECIPE_DIR, 'bridge', 'page-entry.js')],
    outfile,
    absWorkingDir: CLONE,
    bundle: true,
    platform: 'node',
    format: 'iife',
    target: 'es2022',
    metafile: true,
    legalComments: 'external',
    logLevel: 'silent',
    mainFields: ['module', 'main'],
    conditions: ['node', 'import'],
    alias: {
      '@shared': join(CLONE, 'packages', 'shared-domain', 'src'),
      '@bridge-contract': join(CLONE, 'packages', 'bridge-contract', 'src')
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [portPlugin(), orivonShimPlugin()]
  })
  printWarnings(result)
  const inputs = Object.keys(result.metafile.inputs).map(posix)
  const preload = await readFile(join(DESKTOP, 'src', 'preload', 'index.ts'), 'utf8')
  const answered = answeredChannels(
    await readFile(join(RECIPE_DIR, 'bridge', 'main-process.js'), 'utf8'),
    await readFile(join(RECIPE_DIR, 'bridge', 'channels.js'), 'utf8'),
    await readFile(join(RECIPE_DIR, 'bridge', 'vault-calls.js'), 'utf8')
  )
  const problems = [
    ...checkMetafile(inputs, { required: REQUIRED_INPUTS, forbidden: FORBIDDEN_PREFIXES }),
    ...unansweredChannels(sentChannels(preload), answered).map((channel) => `upstream's preload sends '${channel}' to main, and nothing in bridge/ answers it`)
  ]
  if (problems.length > 0) throw new Error(`${BUNDLE_FILE} is not a bundle Orivon can run:\n  ${problems.join('\n  ')}`)
  const code = await readFile(outfile, 'utf8')
  console.log(`${BUNDLE_FILE}: ${String(inputs.length)} modules, ${String(Math.round(code.length / 1024))} KiB`)
}

try {
  await bundle()
} catch (error) {
  printBuildFailure(error, (path) => posix(relative(CLONE, path)))
  process.exit(1)
}
