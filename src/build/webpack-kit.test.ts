// The two build traps in docs/porting-guide.md, as tests. Both failed
// silently in the real port -- a blank page and a 404 -- so what is asserted
// here is mostly that the kit REFUSES, loudly, rather than carrying on.
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { REPO_ROOT } from '../paths.ts'

interface WebpackKit {
  addBrowserFallbacks: (config: any, extra?: Record<string, unknown>) => unknown
  cloneRoot: (envVar?: string) => string
  patchPlugins: (config: any, Ctor: unknown, patch: (plugin: any) => unknown, options?: { expect?: number | 'at-least-one', what?: string }) => number
  requireFromClone: (root: string) => (specifier: string) => unknown
  retargetOutput: (config: any, options: { to: string, from?: string }) => number
  NODE_BUILTINS: readonly string[]
}

const kit = createRequire(import.meta.url)('./webpack-kit.cjs') as WebpackKit

class DefinePlugin {
  definitions: Record<string, unknown>
  constructor (definitions: Record<string, unknown>) { this.definitions = definitions }
}

class CopyPlugin {
  patterns: Array<{ to: string }>
  constructor (patterns: Array<{ to: string }>) { this.patterns = patterns }
}

describe('patchPlugins', () => {
  it('patches the one instance and says so', () => {
    const plugin = new DefinePlugin({ 'process.env.IS_ELECTRON': false })
    const patched = kit.patchPlugins({ plugins: [plugin, new CopyPlugin([])] }, DefinePlugin, (p) => { p.definitions['process.env.IS_ELECTRON'] = true })
    expect(patched).toBe(1)
    expect(plugin.definitions['process.env.IS_ELECTRON']).toBe(true)
  })

  it('throws when upstream stopped carrying it', () => {
    expect(() => kit.patchPlugins({ plugins: [] }, DefinePlugin, () => {}))
      .toThrow(/expected 1 DefinePlugin to patch, patched 0 -- upstream's config changed shape/)
  })

  it('throws when upstream grew a second one, rather than patching whichever came first', () => {
    const config = { plugins: [new DefinePlugin({}), new DefinePlugin({})] }
    expect(() => kit.patchPlugins(config, DefinePlugin, () => {})).toThrow(/patched 2/)
  })

  it('lets a patch disown an instance it did not mean, and still counts the rest', () => {
    const wanted = new DefinePlugin({ 'process.env.SUPPORTS_LOCAL_API': false })
    const other = new DefinePlugin({ 'process.env.SOMETHING_ELSE': 1 })
    const patch = vi.fn((plugin: DefinePlugin) => {
      if (plugin.definitions['process.env.SUPPORTS_LOCAL_API'] === undefined) return false
      plugin.definitions['process.env.SUPPORTS_LOCAL_API'] = true
      return true
    })
    expect(kit.patchPlugins({ plugins: [other, wanted] }, DefinePlugin, patch)).toBe(1)
    expect(patch).toHaveBeenCalledTimes(2)
  })

  it('takes at-least-one for a plugin upstream may carry several of', () => {
    const config = { plugins: [new DefinePlugin({}), new DefinePlugin({})] }
    expect(kit.patchPlugins(config, DefinePlugin, () => {}, { expect: 'at-least-one' })).toBe(2)
    expect(() => kit.patchPlugins({ plugins: [] }, DefinePlugin, () => {}, { expect: 'at-least-one' }))
      .toThrow(/expected at least one/)
  })
})

describe('retargetOutput', () => {
  it('sends the build to its own directory', () => {
    const config: Record<string, any> = {}
    kit.retargetOutput(config, { to: '/out/static' })
    expect(config['output'].path).toBe('/out/static')
  })

  // The trap: a pattern whose `to:` is absolute ignores output.path entirely,
  // so changing the output directory moves the bundle and leaves these behind.
  it('moves the copy patterns that hardcode upstream\'s own dist path', () => {
    const plugin = new CopyPlugin([{ to: '/clone/dist/web/static/x.json' }, { to: '/clone/dist/web/sw.js' }])
    const config = { plugins: [plugin] }
    expect(kit.retargetOutput(config, { to: '/clone/dist/orivon', from: '/clone/dist/web' })).toBe(2)
    expect(plugin.patterns.map((pattern) => pattern.to)).toEqual(['/clone/dist/orivon/static/x.json', '/clone/dist/orivon/sw.js'])
  })

  it('leaves a relative pattern alone, because that one already follows output.path', () => {
    const plugin = new CopyPlugin([{ to: 'swiper.css' }])
    kit.retargetOutput({ plugins: [plugin] }, { to: '/clone/dist/orivon', from: '/clone/dist/web' })
    expect(plugin.patterns[0]?.to).toBe('swiper.css')
  })

  it('refuses to build when a pattern still writes into another target, naming it', () => {
    const plugin = new CopyPlugin([{ to: '/clone/dist/electron/app.js' }])
    expect(() => kit.retargetOutput({ plugins: [plugin] }, { to: '/clone/dist/orivon', from: '/clone/dist/web' }))
      .toThrow(/1 copy pattern\(s\) write outside \/clone\/dist\/orivon[\s\S]*\/clone\/dist\/electron\/app.js/)
  })

  it('accepts a pattern already inside the new output path', () => {
    const plugin = new CopyPlugin([{ to: '/clone/dist/orivon/nested/x.js' }])
    expect(() => kit.retargetOutput({ plugins: [plugin] }, { to: '/clone/dist/orivon' })).not.toThrow()
  })
})

describe('addBrowserFallbacks', () => {
  it('answers false for every node builtin an isomorphic library checks for', () => {
    const config: Record<string, any> = {}
    kit.addBrowserFallbacks(config)
    for (const name of kit.NODE_BUILTINS) expect(config['resolve'].fallback[name]).toBe(false)
  })

  it('keeps what the config already had, and takes an override last', () => {
    const config = { resolve: { fallback: { assert: 'assert-browserify' } } }
    kit.addBrowserFallbacks(config, { crypto: 'crypto-browserify' })
    expect(config.resolve.fallback).toMatchObject({ assert: 'assert-browserify', crypto: 'crypto-browserify', fs: false })
  })
})

describe('resolving against the clone', () => {
  it('requires from the root it is given, not from this repository', () => {
    expect(kit.requireFromClone(REPO_ROOT)('typescript')).toBeDefined()
    expect(() => kit.requireFromClone('/nonexistent')('typescript')).toThrow()
  })

  it('defaults the clone to the working directory, which is where the executor runs a build', () => {
    expect(kit.cloneRoot()).toBe(process.cwd())
    expect(kit.cloneRoot('ORIVON_TEST_CLONE_UNSET')).toBe(process.cwd())
    process.env['ORIVON_TEST_CLONE'] = '/somewhere/else'
    expect(kit.cloneRoot('ORIVON_TEST_CLONE')).toBe('/somewhere/else')
    delete process.env['ORIVON_TEST_CLONE']
  })
})
