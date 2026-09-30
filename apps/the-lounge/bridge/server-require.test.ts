import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { REQUIRE_FORWARDER } from './require-forwarder.js'
import { makeRequire } from './server-require.js'

describe('makeRequire', () => {
  it('answers a bundled name from the bundle, loading it once and only when asked', () => {
    const load = vi.fn(() => ({ default: () => 'started' }))
    const fallback = vi.fn()
    const require = makeRequire({ bundled: { '../server': load }, fallback })
    expect(load).not.toHaveBeenCalled()
    const first = require('../server') as { default: () => string }
    expect(first.default()).toBe('started')
    expect(require('../server')).toBe(first)
    expect(load).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('hands every other name to the fallback, unchanged, and returns what it returns', () => {
    const fallback = vi.fn((id: string) => ({ loaded: id }))
    const require = makeRequire({ bundled: { '../server': () => ({}) }, fallback })
    expect(require('/orivon/app/lounge-install/dist/defaults/config.js')).toEqual({ loaded: '/orivon/app/lounge-install/dist/defaults/config.js' })
    expect(fallback).toHaveBeenCalledWith('/orivon/app/lounge-install/dist/defaults/config.js')
  })

  it('lets the fallback\'s own error through, as a missing module must fail as it does in Node', () => {
    const missing = Object.assign(new Error("Cannot find module '/x.js'"), { code: 'MODULE_NOT_FOUND' })
    const require = makeRequire({ bundled: {}, fallback: () => { throw missing } })
    expect(() => require('/x.js')).toThrow(missing)
  })

  it('does not treat a name inherited from Object.prototype as bundled', () => {
    const fallback = vi.fn(() => 'from the fallback')
    const require = makeRequire({ bundled: {}, fallback })
    expect(require('constructor')).toBe('from the fallback')
    expect(require('toString')).toBe('from the fallback')
  })

  it('refuses an id that is not a string, as Node does', () => {
    const require = makeRequire({ bundled: {}, fallback: () => undefined })
    expect(() => require(undefined as unknown as string)).toThrow(TypeError)
  })

  it('resolves a bundled name to itself and any other through the fallback', () => {
    const fallback = Object.assign(() => undefined, { resolve: (id: string) => `/resolved${id}` })
    const require = makeRequire({ bundled: { '../server': () => ({}) }, fallback })
    expect(require.resolve('../server')).toBe('../server')
    expect(require.resolve('/a.js')).toBe('/resolved/a.js')
    expect(() => makeRequire({ bundled: {}, fallback: () => undefined }).resolve('/a.js')).toThrow('not available')
  })
})

describe('the banner\'s require forwarder', () => {
  // esbuild's helper, as it prints it: it reads the global `require` once, at start.
  const HELPER = 'var __require = ((x) => typeof require !== "undefined" ? require : x)(function (x) { throw Error("Dynamic require of " + x) })'

  it('is the require the helper holds even when the host already had one, and follows what install-require points it at', () => {
    const hostRequire = vi.fn(() => 'the host\'s')
    const context: Record<string, unknown> = { require: hostRequire }
    runInNewContext(`${REQUIRE_FORWARDER}\n${HELPER}\nglobalThis.helper = __require`, context)
    const helper = context['helper'] as ((id: string) => unknown) & { resolve: (id: string) => string }
    const real = Object.assign(vi.fn((id: string) => ({ loaded: id })), { resolve: (id: string) => `resolved:${id}` })
    ;(context['require'] as { target: unknown }).target = real
    expect(helper('../server')).toEqual({ loaded: '../server' })
    expect(helper.resolve('x')).toBe('resolved:x')
    expect(hostRequire).not.toHaveBeenCalled()
  })
})
