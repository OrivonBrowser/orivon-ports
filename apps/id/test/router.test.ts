import { describe, expect, it } from 'vitest'
import { parseRoute, registerThenHash, ROUTES } from '../site/router.js'

describe('parseRoute', () => {
  it('reads the four views', () => {
    expect(parseRoute('').name).toBe('search')
    expect(parseRoute('#').name).toBe('search')
    expect(parseRoute('#/').name).toBe('search')
    expect(parseRoute('#/me').name).toBe('me')
    expect(parseRoute('#/developers').name).toBe('developers')
    expect(parseRoute('#/connect?v=1').name).toBe('connect')
  })

  it('keeps the raw fragment for the view that reads it', () => {
    const hash = '#/connect?v=1&return=https%3A%2F%2Fapp.example.org%2F&nonce=abc'
    expect(parseRoute(hash).hash).toBe(hash)
  })

  it('treats anything else as no page', () => {
    expect(parseRoute('#/nowhere').name).toBe('notFound')
    expect(parseRoute('#/connect/extra').name).toBe('notFound')
    expect(parseRoute(undefined as unknown as string).name).toBe('search')
  })

  it('carries a sign-in request through registration, and only a sign-in request', () => {
    const connect = '#/connect?v=1&return=https%3A%2F%2Fapp.example.org%2F&nonce=abcdefghijklmnop'
    expect(parseRoute(registerThenHash(connect))).toMatchObject({ name: 'search', next: connect })
    expect(parseRoute('#/?next=' + encodeURIComponent('#/me')).next).toBeNull()
    expect(parseRoute('#/?next=' + encodeURIComponent('https://evil.example/')).next).toBeNull()
    expect(parseRoute('#/?next=%zz').next).toBeNull()
  })

  it('lists a link for every view but the sign-in', () => {
    expect(ROUTES.map((route) => route.name)).toEqual(['search', 'me', 'developers'])
  })
})
