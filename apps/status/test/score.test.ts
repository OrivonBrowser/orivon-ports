import { describe, expect, it } from 'vitest'
import { bucketOf, describeEvaluation, findEvaluation, parseJsonBytes, readProvider } from '../site/score.js'

const CID = 'bafybeieqer67ojhi6q3eiatmrcu3r3mqjehn7hwit2satqjfnljo65fb4q'

describe('bucketOf', () => {
  // The standard's own vectors (orivon-mvp docs/architecture/web3-score-provider.md).
  it('is the first hex characters of the SHA-256 of the whole identifier', async () => {
    expect(await bucketOf(`cid:${CID}`, 2)).toBe('c6')
    expect(await bucketOf(`cid:${CID}`, 1)).toBe('c')
    expect(await bucketOf('sha256:26054c511f3394b66c6a022a48d82e559d637ac4b111657482ec6b7a7447fbcf', 2)).toBe('4c')
    expect(await bucketOf('sha256:b6761c9738dab8dae6c3ac00c9d048e26992ebbd5f095601f1b8e4782ee24cb2', 2)).toBe('da')
  })
})

describe('readProvider', () => {
  it('accepts the standard with 1 or 2 bucket characters', () => {
    expect(readProvider({ standard: 'orivon-web3-score/1', name: 'Orivon Attila V0.0.1', bucketHexChars: 2 })).toEqual({ name: 'Orivon Attila V0.0.1', bucketHexChars: 2 })
    expect(readProvider({ standard: 'orivon-web3-score/1', bucketHexChars: 1 })?.name).toBe('the provider')
  })

  it('refuses another standard, and wider buckets, as a client does', () => {
    expect(readProvider({ standard: 'orivon-web3-score/2', name: 'x', bucketHexChars: 2 })).toBeNull()
    expect(readProvider({ standard: 'orivon-web3-score/1', name: 'x', bucketHexChars: 3 })).toBeNull()
    expect(readProvider(null)).toBeNull()
  })
})

describe('findEvaluation', () => {
  const entry = (extra: Record<string, unknown> = {}) => ({ id: `cid:${CID}`, name: 'App', evaluated: '2026-10-18', trustlessity: { level: 3, privacy: false }, ...extra })
  const file = (entries: unknown[]) => ({ standard: 'orivon-web3-score/1', subject: 'website', bucket: 'c6', entries })

  it('finds the entry for the identifier among the bucket\'s', () => {
    expect(findEvaluation(file([entry({ id: 'cid:other' }), entry()]), `cid:${CID}`, 'c6')).toEqual({ level: 3, privacy: false, evaluated: '2026-10-18' })
    expect(describeEvaluation({ level: 3, privacy: false, evaluated: '2026-10-18' })).toBe('Level 3')
  })

  it('reads privacy only at Level 4, where the scale allows it', () => {
    expect(findEvaluation(file([entry({ trustlessity: { level: 4, privacy: true } })]), `cid:${CID}`, 'c6')?.privacy).toBe(true)
    expect(findEvaluation(file([entry({ trustlessity: { level: 3, privacy: true } })]), `cid:${CID}`, 'c6')?.privacy).toBe(false)
    expect(describeEvaluation({ level: 4, privacy: true, evaluated: 'x' })).toBe('Level 4 + privacy')
  })

  it('finds nothing when the bucket holds nobody\'s evaluation of it', () => {
    expect(findEvaluation(file([entry({ id: 'cid:other' })]), `cid:${CID}`, 'c6')).toBeNull()
    expect(findEvaluation(file([]), `cid:${CID}`, 'c6')).toBeNull()
  })

  it('finds nothing in a file that is not the bucket asked for, or an evaluation off the scale', () => {
    expect(findEvaluation({ ...file([entry()]), bucket: 'aa' }, `cid:${CID}`, 'c6')).toBeNull()
    expect(findEvaluation({ ...file([entry()]), subject: 'operation' }, `cid:${CID}`, 'c6')).toBeNull()
    expect(findEvaluation(file([entry({ trustlessity: { level: 5 } })]), `cid:${CID}`, 'c6')).toBeNull()
    expect(findEvaluation(null, `cid:${CID}`, 'c6')).toBeNull()
  })

  it('says so when the date is not a date', () => {
    expect(findEvaluation(file([entry({ evaluated: 'yesterday' })]), `cid:${CID}`, 'c6')?.evaluated).toBe('on an unknown date')
  })
})

describe('parseJsonBytes', () => {
  it('parses JSON bytes and gives null for anything else', () => {
    expect(parseJsonBytes(new TextEncoder().encode('{"a":1}'))).toEqual({ a: 1 })
    expect(parseJsonBytes(new TextEncoder().encode('<html>'))).toBeNull()
  })
})
