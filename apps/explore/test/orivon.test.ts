import { describe, expect, it } from 'vitest'
import { describeError, detect, ERROR_TEXT, grants, registration, request, snapshot } from '../site/orivon.js'

const CODES = ['denied', 'revoked', 'unreachable', 'timeout', 'reset', 'closed', 'limit', 'invalid', 'notFound', 'exists', 'internal', 'unavailable']

function fake (overrides: Record<string, unknown> = {}) {
  return {
    orivon: {
      version: 0,
      app: {
        manifest: () => Promise.resolve({ id: 'x', version: '1', capabilities: {} }),
        grants: () => Promise.resolve([{ id: 'g', origin: 'o', capability: 'fs', patterns: [], grantedAt: 1 }]),
        requestGrant: () => Promise.resolve(true),
        ...overrides
      }
    }
  }
}

describe('detect', () => {
  it('is not Orivon without the global, or with something that is not the API', () => {
    expect(detect({})).toEqual({ inOrivon: false, version: null })
    expect(detect({ orivon: 'yes' })).toEqual({ inOrivon: false, version: null })
    expect(detect({ orivon: {} })).toEqual({ inOrivon: false, version: null })
  })

  it('is Orivon with an object that carries a numeric version', () => {
    expect(detect({ orivon: { version: 0 } })).toEqual({ inOrivon: true, version: 0 })
  })
})

describe('registration', () => {
  it('reports the manifest of a registered origin', async () => {
    const found = await registration(fake())
    expect(found.registered).toBe(true)
    expect(found.manifest?.id).toBe('x')
  })

  it('reports an unregistered origin as an answer, with the reason in words', async () => {
    const found = await registration(fake({ manifest: () => Promise.reject(Object.assign(new Error('x'), { code: 'internal' })) }))
    expect(found).toEqual({ registered: false, manifest: null, reason: ERROR_TEXT.internal })
  })

  it('says it is not running in Orivon rather than throwing', async () => {
    expect((await registration({})).registered).toBe(false)
  })
})

describe('grants and request', () => {
  it('lists grants inside Orivon and nothing outside it', async () => {
    expect(await grants(fake())).toHaveLength(1)
    expect(await grants({})).toEqual([])
  })

  it('passes the patterns only when there are some, and answers false outside Orivon', async () => {
    const seen: unknown[] = []
    const scope = fake({ requestGrant: (asked: unknown) => { seen.push(asked); return Promise.resolve(true) } })
    expect(await request('https.connect', ['a.example'], scope)).toBe(true)
    expect(await request('fs', undefined, scope)).toBe(true)
    expect(seen).toEqual([{ capability: 'https.connect', patterns: ['a.example'] }, { capability: 'fs' }])
    expect(await request('fs', undefined, {})).toBe(false)
  })
})

describe('snapshot', () => {
  it('gathers everything inside Orivon, and notes what failed without losing the rest', async () => {
    const whole = await snapshot(fake())
    expect(whole).toMatchObject({ inOrivon: true, version: 0, registered: true })
    const partial = await snapshot(fake({ grants: () => Promise.reject(Object.assign(new Error('x'), { code: 'unavailable' })) }))
    expect(partial.registered).toBe(true)
    expect(partial.notes).toEqual([`Grants: ${ERROR_TEXT.unavailable}`])
  })

  it('is empty outside Orivon', async () => {
    expect(await snapshot({})).toMatchObject({ inOrivon: false, registered: false, grants: [], notes: [] })
  })
})

describe('describeError', () => {
  it('has a sentence for every error code, and no more', () => {
    expect(Object.keys(ERROR_TEXT).sort()).toEqual([...CODES].sort())
    for (const code of CODES) {
      const sentence = describeError({ code })
      expect(sentence).toBe(ERROR_TEXT[code as keyof typeof ERROR_TEXT])
      expect(sentence).toMatch(/^[A-Z].*\.$/)
    }
  })

  it('falls back to the message, then to a plain admission', () => {
    expect(describeError(Object.assign(new Error('odd'), { code: 'new-code' }))).toBe('odd')
    expect(describeError(new Error('plain'))).toBe('plain')
    expect(describeError(null)).toMatch(/no reason/)
    expect(describeError({ code: 'toString' })).toMatch(/no reason/)
  })
})
