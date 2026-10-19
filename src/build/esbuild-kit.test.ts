// The esbuild kit's gates, each handed the shape change or violation it exists
// to catch: a quiet pass here is a bundle that differs from the one meant.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkMetafile, loadShimPlugin, printBuildFailure, printWarnings, readFiles, stampOf, unmappedBuiltins } from './esbuild-kit.mjs'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

afterEach(() => { vi.restoreAllMocks() })

describe('loadShimPlugin', () => {
  function checkout (source: string | null): string {
    const root = mkdtempSync(join(tmpdir(), 'esbuild-kit-mvp-'))
    if (source !== null) {
      mkdirSync(join(root, 'src', 'shim', 'bundler'), { recursive: true })
      writeFileSync(join(root, 'src', 'shim', 'bundler', 'esbuild-plugin.ts'), source)
    }
    return root
  }

  it('imports the plugin module from the checkout ORIVON_MVP_ROOT names', async () => {
    const root = checkout('export function orivonShimPlugin () { return { name: "shim" } }\nexport const virtualRoot = "/v"\n')
    const plugin = await loadShimPlugin({ ORIVON_MVP_ROOT: root })
    expect(plugin.orivonShimPlugin()).toEqual({ name: 'shim' })
    expect(plugin.virtualRoot).toBe('/v')
  })

  it('falls back to the checkout beside this repository, and says where it looked', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'esbuild-kit-repo-'))
    await expect(loadShimPlugin({}, join(repo, 'orivon-ports'))).rejects.toThrow(/orivon-mvp.*esbuild-plugin\.ts does not exist.*ORIVON_MVP_ROOT/s)
  })

  it('names a checkout without the bundler', async () => {
    await expect(loadShimPlugin({ ORIVON_MVP_ROOT: checkout(null) })).rejects.toThrow(/does not exist\. Set ORIVON_MVP_ROOT/)
  })

  it('refuses a plugin module that stopped exporting orivonShimPlugin', async () => {
    await expect(loadShimPlugin({ ORIVON_MVP_ROOT: checkout('export const other = 1\n') })).rejects.toThrow(/no longer exports orivonShimPlugin/)
  })
})

describe('stampOf', () => {
  it('is the same for the same files in any order, and changes with a name or a byte', () => {
    const a: Array<[string, Uint8Array]> = [['a', bytes('1')], ['b', bytes('2')]]
    expect(stampOf(a, 24)).toBe(stampOf([a[1]!, a[0]!], 24))
    expect(stampOf(a, 24)).not.toBe(stampOf([['a', bytes('1')], ['b', bytes('3')]], 24))
    expect(stampOf(a, 24)).not.toBe(stampOf([['a', bytes('1')], ['c', bytes('2')]], 24))
    expect(stampOf(a, 24)).toMatch(/^[0-9a-f]{24}$/)
  })

  it('does not let a name and a body trade bytes', () => {
    expect(stampOf([['ab', bytes('c')]], 16)).not.toBe(stampOf([['a', bytes('bc')]], 16))
  })

  it('is a prefix of the longer stamp, so a length only chooses how much of it an app keeps', () => {
    const files: Array<[string, Uint8Array]> = [['a', bytes('1')]]
    expect(stampOf(files, 24).startsWith(stampOf(files, 16))).toBe(true)
  })

  it('needs a length, because a default would change paths an app\'s bundle names', () => {
    expect(() => stampOf([['a', bytes('1')]], undefined)).toThrow(/needs a length/)
    expect(() => stampOf([['a', bytes('1')]], 0)).toThrow(/needs a length/)
    expect(() => stampOf([['a', bytes('1')]], 65)).toThrow(/needs a length/)
  })
})

describe('readFiles', () => {
  it('reads each file once and returns them in name order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'esbuild-kit-files-'))
    writeFileSync(join(dir, 'x'), 'second')
    writeFileSync(join(dir, 'y'), 'first')
    const files = await readFiles([['public/z.css', join(dir, 'x')], ['dist/a.js', join(dir, 'y')]])
    expect(files.map((entry: any[]) => [entry[0], String(entry[1])])).toEqual([['dist/a.js', 'first'], ['public/z.css', 'second']])
  })

  it('fails on a file that is not there, naming its path', async () => {
    await expect(readFiles([['public/index.html', join(tmpdir(), 'esbuild-kit-nowhere', 'index.html')]])).rejects.toThrow(/esbuild-kit-nowhere/)
  })
})

describe('checkMetafile', () => {
  const required = ['server/plugins/irc-events/away.ts', 'server/plugins/inputs/msg.ts'].map((path) => ({ path, why: 'loaded by a computed name' }))
  const forbidden = [{ prefix: 'node_modules/vite/', why: 'the dev server is refused' }]

  it('passes a bundle that holds every required input and nothing forbidden', () => {
    expect(checkMetafile([...required.map((entry) => entry.path), 'server/server.ts'], { required, forbidden })).toEqual([])
  })

  it('names a required input the bundle lacks, with the reason it is required', () => {
    const problems = checkMetafile(['server/plugins/irc-events/away.ts'], { required, forbidden })
    expect(problems).toEqual(['the bundle is missing server/plugins/inputs/msg.ts: loaded by a computed name'])
  })

  it('names a forbidden input the bundle carries, with the reason it is forbidden', () => {
    const problems = checkMetafile([...required.map((entry) => entry.path), 'node_modules/vite/dist/node/index.js'], { required, forbidden })
    expect(problems).toEqual(['the bundle holds node_modules/vite/dist/node/index.js: the dev server is refused'])
  })

  it('reports every problem at once, so one run shows the whole list', () => {
    expect(checkMetafile(['node_modules/vite/a.js'], { required, forbidden })).toHaveLength(3)
  })

  it('matches a forbidden prefix as a path, not as a name that merely starts alike', () => {
    expect(checkMetafile([...required.map((entry) => entry.path), 'node_modules/vite-plugin/a.js'], { required, forbidden })).toEqual([])
  })
})

describe('unmappedBuiltins', () => {
  it('groups the plugin\'s errors by builtin, and ignores any other error', () => {
    const texts = [
      "'tty' is a Node builtin the Orivon shim has no module for (imported from /c/node_modules/debug/src/node.js); see src/shim/module-map.ts",
      "'tty' is a Node builtin the Orivon shim has no module for (imported from /c/node_modules/supports-color/index.js); see src/shim/module-map.ts",
      "'node:sqlite' is a Node builtin the Orivon shim has no module for (imported from /c/server/plugins/messageStorage/sqlite.ts); see src/shim/module-map.ts",
      'Could not resolve "left-pad"'
    ]
    expect(unmappedBuiltins(texts)).toEqual(new Map([
      ['tty', ['/c/node_modules/debug/src/node.js', '/c/node_modules/supports-color/index.js']],
      ['node:sqlite', ['/c/server/plugins/messageStorage/sqlite.ts']]
    ]))
  })
})

describe('what a build says', () => {
  it('prints a warning with its place when it has one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    printWarnings({ warnings: [{ text: 'a', location: { file: 'x.js', line: 3 } }, { text: 'b', location: null }] })
    expect(warn.mock.calls).toEqual([['warning: a (x.js:3)'], ['warning: b']])
  })

  it('lists the shim\'s missing builtins by importer, then every other error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    printBuildFailure({
      errors: [
        { text: "'tty' is a Node builtin the Orivon shim has no module for (imported from /c/a.js); see x" },
        { text: "'tty' is a Node builtin the Orivon shim has no module for (imported from /c/a.js); see x" },
        { text: 'Could not resolve "left-pad"' }
      ]
    }, (path: string) => path.slice(3))
    expect(error.mock.calls.map((call) => call[0])).toEqual([
      'The Orivon shim has no module for these Node builtins (orivon-mvp: src/shim/module-map.ts):',
      '  tty, imported by a.js',
      'Could not resolve "left-pad"'
    ])
  })

  it('prints the thrown message when esbuild collected no errors, such as a failed gate', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    printBuildFailure(new Error('server.mjs is not a bundle the shim can run'))
    expect(error.mock.calls).toEqual([['server.mjs is not a bundle the shim can run']])
  })
})
