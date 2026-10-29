// An unminified esbuild bundle names every module by its path, so the same sources built from two
// checkout paths made two different bundles, and a tree no other machine could reproduce. These tests
// run the real esbuild (the version the node-launch builds pin) over the same sources laid out in
// different directories.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import * as esbuild from 'esbuild'
import { describe, expect, it } from 'vitest'
import { stableBundlePaths, stablePaths } from './esbuild-kit.mjs'

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

interface Layout { readonly mvp: string, readonly ports: string, readonly clone: string, readonly dist: string }

/**
 * The shape of a port that bundles the shim: an orivon-mvp checkout (a CommonJS dependency, an ES module, and a
 * file the shim plugin hands out under its own namespace), this repository with the page, and the upstream clone
 * the build runs in. Where the two checkouts sit, by name and by depth, is what the arguments change.
 */
function layout (mvpDir: string[], portsDir: string[]): Layout {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stable-paths-')))
  const [mvp, ports] = [join(root, ...mvpDir), join(root, ...portsDir)]
  write(join(mvp, 'node_modules', 'dep', 'index.js'), 'exports.answer = 42\n')
  write(join(mvp, 'src', 'shim', 'lib.js'), "export const y = 'shim'\n")
  write(join(mvp, 'src', 'shim', 'thing.js'), 'module.exports = "thing"\n')
  write(join(ports, 'apps', 'demo', 'page', 'launch.js'), [
    `const dep = require(${JSON.stringify(join(mvp, 'node_modules', 'dep', 'index.js'))})`,
    `const lib = require(${JSON.stringify(join(mvp, 'src', 'shim', 'lib.js'))})`,
    "const thing = require('virtual:thing')",
    'console.log(dep.answer, lib.y, thing)\n'
  ].join('\n'))
  const clone = join(ports, 'out', 'demo', 'source')
  mkdirSync(clone, { recursive: true })
  return { mvp, ports, clone, dist: join(ports, 'out', 'demo', 'dist') }
}

/** What the shim plugin does for `require('net')`: a module of the checkout, under a namespace of its own. */
const shimPlugin = (mvp: string): esbuild.Plugin => ({
  name: 'shim',
  setup (build) {
    build.onResolve({ filter: /^virtual:thing$/ }, () => ({ path: join(mvp, 'src', 'shim', 'thing.js'), namespace: 'orivon-shim-require' }))
    build.onLoad({ filter: /.*/, namespace: 'orivon-shim-require' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'js' }))
  }
})

async function bundle (where: Layout, stable: boolean): Promise<string> {
  const outfile = join(where.dist, 'launch.js')
  await esbuild.build({
    entryPoints: [join(where.ports, 'apps', 'demo', 'page', 'launch.js')],
    outfile,
    absWorkingDir: where.clone,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    minify: false,
    logLevel: 'silent',
    plugins: [shimPlugin(where.mvp), ...stable ? [stableBundlePaths({ env: { ORIVON_MVP_ROOT: where.mvp }, repoRoot: where.ports })] : []]
  })
  return readFileSync(outfile, 'utf8')
}

describe('a bundle built from two checkout paths', () => {
  const here = layout(['orivon-mvp'], ['orivon-ports'])
  const there = layout(['side', 'by', 'mvp-checkout-2'], ['work', 'ports-worktree-7'])

  it('differs without the plugin, which is the fault', async () => {
    const [one, other] = [await bundle(here, false), await bundle(there, false)]
    expect(one).not.toBe(other)
    expect(one).toContain(here.mvp)
  })

  it('is the same bytes with it, and names no directory of either', async () => {
    const [one, other] = [await bundle(here, true), await bundle(there, true)]
    expect(one).toBe(other)
    for (const where of [here, there]) for (const dir of [where.mvp, where.ports, where.clone]) expect(one).not.toContain(dir)
    expect(one).toContain('// orivon-mvp/node_modules/dep/index.js')
    expect(one).toContain('"orivon-mvp/node_modules/dep/index.js"(')
    expect(one).toContain('// orivon-shim-require:orivon-mvp/src/shim/thing.js')
    expect(one).toContain('"orivon-shim-require:orivon-mvp/src/shim/thing.js"(')
    expect(one).toContain('// orivon-ports/apps/demo/page/launch.js')
  })

  it('still runs: the rewritten names are only names', async () => {
    const logged: unknown[][] = []
    new Function('console', await bundle(here, true))({ log: (...args: unknown[]) => logged.push(args) })
    expect(logged).toEqual([[42, 'shim', 'thing']])
  })

  it('fails the build, naming the file, for a module from outside the clone and the two checkouts', async () => {
    const stray = layout(['orivon-mvp'], ['orivon-ports'])
    const outside = join(realpathSync(mkdtempSync(join(tmpdir(), 'stable-paths-outside-'))), 'elsewhere.js')
    write(outside, 'exports.far = 1\n')
    write(join(stray.mvp, 'src', 'shim', 'lib.js'), `export const y = require(${JSON.stringify(outside)}).far\n`)
    await expect(bundle(stray, true)).rejects.toThrow(/elsewhere\.js.*outside the clone and the checkouts orivon-mvp and orivon-ports/)
  })
})

describe('stablePaths', () => {
  const [cwd, mvp] = [resolve('/work/ports/out/demo/source'), resolve('/work/mvp')]
  const roots = [['orivon-mvp', mvp]]
  const posix = (path: string): string => path.split(sep).join('/')

  it('leaves a path inside the clone as esbuild printed it', () => {
    const text = '  // node_modules/x/index.js\n  var a = 1\n'
    expect(stablePaths(text, ['node_modules/x/index.js'], { cwd, roots })).toBe(text)
  })

  it('refuses a bundle that still names a checkout, in a place no input accounts for', () => {
    expect(() => stablePaths(`var where = ${JSON.stringify(mvp)}\n`, [], { cwd, roots })).toThrow(/still names .* \(orivon-mvp\)/)
    const away = posix(relative(cwd, mvp))
    expect(() => stablePaths(`var where = "${away}/src/x.js"\n`, [], { cwd, roots })).toThrow(/still names \.\.\/.*\/ \(orivon-mvp\)/)
  })
})
