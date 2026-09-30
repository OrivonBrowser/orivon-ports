import { describe, expect, it, vi } from 'vitest'
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
