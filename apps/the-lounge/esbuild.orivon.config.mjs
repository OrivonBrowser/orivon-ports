// Runs after upstream's own `yarn build`, in the clone (the executor's cwd).
// Two bundles and the install tree, all into ./orivon-dist:
//
//   server.mjs    upstream's TypeScript sources (server/index.ts), bundled for
//                 the Node shim of orivon-mvp: platform 'node', so `ws` and
//                 irc-framework keep their TCP and socket code, and every Node
//                 builtin goes to the shim through mvp's esbuild plugin
//   launcher.js   the page that forks the server and shows what it serves
//   install/      upstream's public/ and defaults/config.js, which the server
//                 reads with `fs`, and install.json (a stamp and the file list)
//
// It throws when the server bundle is not one that can run: a builtin the shim
// lacks, a require() nobody answers, a module the server loads by a computed
// name that is missing, or Vite in the graph. The decisions are bridge/bundle-plan.js.
// README.md, Design notes, says why each choice is made.

import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  checkGlobLookups, checkMetafile, checkRequires, computedModules, HOME_DIR, INSTALL_DIR, installFileProblems, isInstallFile,
  moduleLocation, stampOf, unmappedBuiltins, withGlobExtensions, withModuleScope
} from './bridge/bundle-plan.js'

const RECIPE_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(RECIPE_DIR, '..', '..')
const CLONE = process.cwd()
const OUT = join(CLONE, 'orivon-dist')
const posix = (path) => path.split(sep).join('/')

/** orivon-mvp's shim bundler plugin: `ORIVON_MVP_ROOT`, else the checkout beside this repository. */
async function loadShimPlugin () {
  const root = process.env.ORIVON_MVP_ROOT ?? resolve(REPO_ROOT, '..', 'orivon-mvp')
  const file = join(root, 'src', 'shim', 'bundler', 'esbuild-plugin.ts')
  if (!existsSync(file)) {
    throw new Error(`${file} does not exist. Set ORIVON_MVP_ROOT to an orivon-mvp checkout that has src/shim/bundler/ (default: ../orivon-mvp beside this repository).`)
  }
  return await import(pathToFileURL(file).href)
}

if (!existsSync(join(CLONE, 'server', 'index.ts'))) {
  throw new Error(`${CLONE} is not a The Lounge clone (no server/index.ts): run this from out/the-lounge/source, as orivon-port build does`)
}
const esbuild = createRequire(join(CLONE, 'package.json'))('esbuild')
const { orivonShimPlugin, shimAssets, virtualRoot } = await loadShimPlugin()
const INSTALL_ROOT = `${virtualRoot}/${INSTALL_DIR}`

/** Names the port refuses, each resolved to a module that throws by name (bridge/). */
const REFUSED = [
  { filter: /^undici$/, module: 'refused-undici.js' },
  { filter: /(?:^|\/)plugins\/dev-server$/, module: 'refused-dev-server.js' }
]

/** Resolves `thelounge/...` into the clone, swaps the refused modules in, and gives each clone module its CommonJS names. */
function loungePlugin () {
  return {
    name: 'the-lounge',
    setup (build) {
      build.onResolve({ filter: /^thelounge\// }, (args) => ({ path: join(CLONE, args.path.slice('thelounge/'.length)) }))
      for (const { filter, module } of REFUSED) {
        build.onResolve({ filter }, () => ({ path: join(RECIPE_DIR, 'bridge', module) }))
      }
      build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
        const location = moduleLocation(posix(args.path), posix(CLONE), INSTALL_ROOT)
        if (location === null) return undefined
        const rel = posix(relative(CLONE, args.path))
        const contents = withModuleScope(withGlobExtensions(await readFile(args.path, 'utf8'), rel), location)
        return { contents, loader: args.path.endsWith('.ts') ? 'ts' : 'js', resolveDir: dirname(args.path) }
      })
    }
  }
}

async function names (dir) {
  return (await readdir(join(CLONE, dir))).map(String)
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
    metafile: true,
    legalComments: 'external',
    logLevel: 'silent',
    define: { ORIVON_INSTALL_ROOT: JSON.stringify(INSTALL_ROOT) },
    plugins: [loungePlugin(), orivonShimPlugin()]
  })
  for (const warning of result.warnings) console.warn(`warning: ${warning.text} (${warning.location?.file ?? '?'}:${String(warning.location?.line ?? '?')})`)
  const code = await readFile(join(OUT, 'server.mjs'), 'utf8')
  const inputs = Object.keys(result.metafile.inputs).map(posix)
  const bridge = (module) => posix(relative(CLONE, join(RECIPE_DIR, 'bridge', module)))
  const problems = [
    ...checkRequires(code),
    ...checkGlobLookups(code),
    ...checkMetafile(inputs, {
      required: [
        ...[
          ...computedModules('server/plugins/irc-events', await names('server/plugins/irc-events')),
          ...computedModules('server/plugins/inputs', await names('server/plugins/inputs'))
        ].map((path) => ({ path, why: 'the server loads it by a computed name, which no bundler follows unless esbuild resolved the whole directory' })),
        ...REFUSED.map(({ module }) => ({ path: bridge(module), why: 'the port refuses a dependency by name with this module, and the refusal did not take effect' }))
      ],
      forbidden: [
        { prefix: 'node_modules/vite/', why: 'the development server is refused, and nothing else may pull Vite in' },
        { prefix: 'node_modules/undici/', why: 'undici is refused by name (bridge/refused-undici.js)' },
        { prefix: 'server/plugins/dev-server.ts', why: 'the development server is refused by name (bridge/refused-dev-server.js)' }
      ]
    })
  ]
  if (problems.length > 0) throw new Error(`server.mjs is not a bundle the shim can run:\n  ${problems.join('\n  ')}`)
  // The SQLite engine fetches its WebAssembly relative to the bundle file that holds it.
  for (const { name, path } of shimAssets()) await copyFile(path, join(OUT, name))
  console.log(`server.mjs: ${String(inputs.length)} modules, ${String(Math.round(code.length / 1024))} KiB`)
}

async function bundleLauncher () {
  const result = await esbuild.build({
    entryPoints: [join(RECIPE_DIR, 'launcher', 'launcher.js')],
    outfile: join(OUT, 'launcher.js'),
    absWorkingDir: CLONE,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    logLevel: 'silent',
    define: { ORIVON_HOME_DIR: JSON.stringify(HOME_DIR), ORIVON_INSTALL_DIR: JSON.stringify(INSTALL_DIR), ORIVON_VIRTUAL_ROOT: JSON.stringify(virtualRoot) },
    plugins: [orivonShimPlugin()]
  })
  for (const warning of result.warnings) console.warn(`warning: ${warning.text}`)
  for (const file of ['index.html', 'launcher.css']) await cp(join(RECIPE_DIR, 'launcher', file), join(OUT, file))
}

/** Upstream's client, defaults and licence into the tree the launcher writes and the server reads. */
async function writeInstall () {
  const install = join(OUT, 'install')
  const entries = []
  const publicDir = join(CLONE, 'public')
  if (!existsSync(join(publicDir, 'index.html'))) throw new Error('public/index.html is missing: upstream\'s client build did not run, or wrote elsewhere')
  for (const entry of await readdir(publicDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const rel = posix(relative(publicDir, join(entry.parentPath, entry.name)))
    if (isInstallFile(rel)) entries.push([`public/${rel}`, join(publicDir, rel)])
  }
  entries.push(['dist/defaults/config.js', join(CLONE, 'defaults', 'config.js')])
  const files = []
  const stamped = []
  for (const [name, from] of entries) {
    await mkdir(dirname(join(install, name)), { recursive: true })
    await cp(from, join(install, name))
    files.push(name)
    stamped.push([name, await readFile(from)])
  }
  files.sort()
  const problems = installFileProblems(files)
  if (problems.length > 0) throw new Error(`the install tree is incomplete:\n  ${problems.join('\n  ')}`)
  await writeFile(join(install, 'install.json'), `${JSON.stringify({ stamp: stampOf(stamped), files }, null, 2)}\n`)
  await cp(join(CLONE, 'LICENSE'), join(OUT, 'LICENSE'))
  console.log(`install/: ${String(files.length)} files`)
}

try {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  await bundleServer()
  await bundleLauncher()
  await writeInstall()
} catch (error) {
  const texts = (error.errors ?? []).map((entry) => entry.text)
  const builtins = unmappedBuiltins(texts)
  if (builtins.size > 0) {
    console.error('The Orivon shim has no module for these Node builtins (orivon-mvp: src/shim/module-map.ts):')
    for (const [specifier, importers] of builtins) {
      console.error(`  ${specifier}, imported by ${[...new Set(importers.map((path) => posix(relative(CLONE, path))))].join(', ')}`)
    }
  }
  for (const text of texts) if (!unmappedBuiltins([text]).size) console.error(text)
  if (texts.length === 0) console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
