import { describe, expect, it } from 'vitest'
import { resolveRequestPath } from './serve.ts'

const ROOT = '/srv/app'

describe('resolveRequestPath', () => {
  it('resolves an ordinary asset', () => {
    expect(resolveRequestPath(ROOT, '/js/main.js')).toBe('/srv/app/js/main.js')
  })

  it('serves the entry document for /', () => {
    expect(resolveRequestPath(ROOT, '/')).toBe('/srv/app/index.html')
    expect(resolveRequestPath(ROOT, '/', 'app.html')).toBe('/srv/app/app.html')
  })

  it('refuses a traversal, however it is spelled', () => {
    for (const bad of [
      '/../secrets',
      '/../../etc/passwd',
      '/js/../../secrets',
      '/%2e%2e/secrets',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd'
    ]) {
      expect(resolveRequestPath(ROOT, bad), bad).toBeNull()
    }
  })

  // `....` is an ordinary directory name, not a traversal. The trick defeats
  // filters that strip the substring `../`; normalize-then-compare has nothing
  // to strip, so the path stays inside the root and is served as written.
  it('treats a ....// segment as an ordinary name, still inside the root', () => {
    expect(resolveRequestPath(ROOT, '/....//secrets')).toBe('/srv/app/..../secrets')
  })

  // `startsWith(root)` alone accepts this: the sibling directory shares the
  // root's name as a prefix. Only the separator test rejects it.
  it('refuses a sibling directory that shares the root as a prefix', () => {
    expect(resolveRequestPath(ROOT, '/../app-secrets/key')).toBeNull()
  })

  it('refuses a NUL byte and undecodable percent-escapes', () => {
    expect(resolveRequestPath(ROOT, '/a%00.js')).toBeNull()
    expect(resolveRequestPath(ROOT, '/%')).toBeNull()
  })

  it('allows the root itself', () => {
    expect(resolveRequestPath(ROOT, '/.')).toBe(ROOT)
  })
})
