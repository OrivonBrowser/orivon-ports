import { describe, expect, it } from 'vitest'
import {
  changedTexts, contenthashView, endAvailability, endedAhead, endedAt, endSignInsWords, isReservedKey, nameStatus, PERMANENT_NOTES, readCache, readKeys, signInsWords, writeCache, writeKeys
} from '../site/me-model.js'
import { moveAdvice, retryOrMove } from '../site/connect-request.js'
import { ChainError } from '../site/sdk/chain.js'
import { REVOKE_REASONS, RevokeError } from '../site/sdk/connect.js'
import { fromHex } from '../site/sdk/bytes.js'
import { attribution, failing, HOLDER as ALICE } from './support/attribution.ts'

const memory = () => {
  const map = new Map<string, string>()
  return { map, get: (key: string) => map.get(key) ?? null, set: (key: string, value: string) => { map.set(key, value) } }
}

const NAME = 'alice.v1.orivonid.eth'

describe('nameStatus', () => {
  it('says an attributed ID can sign in', () => {
    expect(nameStatus(attribution())).toEqual({ ok: true, tone: 'ok', label: 'Can sign in', why: null })
  })

  it('says why an ID cannot, in words, for each clause that fails', () => {
    const roles = nameStatus(failing({ roles: { ok: false, roleCount: 2n, roles: 1n, problem: null } }))
    expect(roles).toMatchObject({ ok: false, tone: 'warn', label: 'Cannot sign in yet' })
    expect(roles.why).toContain('Another account holds a right')
    const problems = ['noResolver', 'noAddress', 'differentAddress', 'resolverFailed', 'invalidLabel'] as const
    const words = problems.map((problem) => nameStatus(failing({ forward: { ok: false, resolver: null, address: null, problem } })).why)
    expect(new Set(words).size).toBe(problems.length)
    expect(words[1]).toContain('Saving the records sets it')
  })

  it('says a registry that would not answer is not a "no", and to try again', () => {
    const unreadable = nameStatus(failing({ roles: { ok: false, roleCount: 0n, roles: 0n, problem: 'rolesUnreadable' } }))
    expect(unreadable.why).toContain('would not say who holds roles')
    expect(unreadable.why).toContain('Try again in a moment.')
  })

  it('says why an ID whose records the address cannot write cannot sign in, and what is possible', () => {
    for (const problem of ['notPermissionedResolver', 'textRoleMissing', 'addressRoleMissing'] as const) {
      const status = nameStatus(failing({ records: { ok: false, resolver: ALICE, problem } }))
      expect(status, problem).toMatchObject({ ok: false, label: 'Cannot sign in yet' })
      expect(status.why, problem).toContain(moveAdvice(NAME))
    }
    const unreadable = nameStatus(failing({ records: { ok: false, resolver: ALICE, problem: 'unreadable' } }))
    expect(unreadable.why).toContain('would not say whether you can change its records')
    expect(unreadable.why).toContain(retryOrMove(NAME))
  })

  it('does not tell a holder who cannot write the records that saving them fixes the address', () => {
    const status = nameStatus(failing({
      forward: { ok: false, resolver: ALICE, address: null, problem: 'noAddress' }, records: { ok: false, resolver: ALICE, problem: 'textRoleMissing' }
    }))
    expect(status.why).not.toContain('Saving the records')
    expect(status.why).toContain(moveAdvice(NAME))
  })
})

describe('whether the button that ends all sign-ins is offered', () => {
  it('is offered when the call could be made', () => {
    expect(endAvailability('alice', null)).toEqual({ canEnd: true })
  })

  it('has words and a remedy for every reason revokeAllCall refuses with, and none for a reason it does not know', () => {
    const refused = [
      new RevokeError('noResolver', 'x'), new RevokeError('noOwner', 'x'),
      ...['notPermissionedResolver', 'textRoleMissing', 'addressRoleMissing', 'unreadable'].map((detail) => new RevokeError('recordsNotHeld', 'x', detail))
    ]
    expect(new Set(refused.map((error) => error.reason))).toEqual(new Set(REVOKE_REASONS))
    const seen = new Set<string>()
    for (const error of refused) {
      const found = endAvailability('alice', error)
      expect(found, `${error.reason} ${error.detail}`).toMatchObject({ canEnd: false })
      if (found.canEnd) continue
      expect(found.words.length).toBeGreaterThan(20)
      expect(found.words).toContain('alice.v1.orivonid.eth')
      seen.add(found.words)
    }
    expect(seen.size).toBeGreaterThanOrEqual(5)
  })

  it('says to try again for a resolver that would not answer, and points to the move for the others', () => {
    expect(endAvailability('alice', new RevokeError('recordsNotHeld', 'x', 'unreadable'))).toMatchObject({ retry: true, remedy: retryOrMove(NAME) })
    expect(endAvailability('alice', new RevokeError('recordsNotHeld', 'x', 'textRoleMissing'))).toMatchObject({ retry: false, remedy: moveAdvice(NAME) })
    expect(endAvailability('alice', new RevokeError('noResolver', 'x'))).toMatchObject({ retry: false, remedy: moveAdvice(NAME) })
  })

  it('says a node that could not be asked is not a refusal, and offers to check again', () => {
    expect(endAvailability('alice', new ChainError('timeout', 'slow'))).toMatchObject({ canEnd: false, retry: true, words: 'The node took too long to answer.' })
  })

})

describe('records', () => {
  it('shows a contenthash by its kind and whole', () => {
    expect(contenthashView(null)).toBeNull()
    expect(contenthashView(new Uint8Array(0))).toBeNull()
    expect(contenthashView(fromHex('0xe30101701220' + 'ab'.repeat(32)))).toEqual({ kind: 'IPFS', hex: '0xe30101701220' + 'ab'.repeat(32) })
    expect(contenthashView(fromHex('0xe50101720024'))?.kind).toBe('IPNS')
    expect(contenthashView(fromHex('0xe40101fa'))?.kind).toBe('Swarm')
    expect(contenthashView(fromHex('0x1234'))?.kind).toBe('Other')
  })

  it('sends only the records that changed, and an emptied one as empty', () => {
    const before = { url: 'https://a.example', description: null, avatar: 'x' }
    expect(changedTexts(before, { url: 'https://a.example', description: '', avatar: 'x' })).toEqual({})
    expect(changedTexts(before, { url: 'https://b.example ', description: 'hello', avatar: '' })).toEqual({ url: 'https://b.example', description: 'hello', avatar: '' })
  })

  it('reads the time sign-ins were ended, and nothing from a record that is not a whole number of seconds', () => {
    expect(endedAt('1796558400')).toEqual({ seconds: 1_796_558_400, text: '6 Dec 2026, 12:00 UTC' })
    for (const value of [null, undefined, '', '0', '01', '-5', '1.5', 'soon', '1'.repeat(17)]) expect(endedAt(value), String(value)).toBeNull()
    expect(endedAhead('1796558400', 1_796_558_100)).toEqual({ seconds: 1_796_558_400, text: '6 Dec 2026, 12:00 UTC' })
    expect(endedAhead('1796558400', 1_796_558_400)).not.toBeNull()
    expect(endedAhead('1796558400', 1_796_558_401)).toBeNull()
    expect(endedAhead('soon', 1)).toBeNull()
    expect(signInsWords(null, 1_796_558_400)).toBe('None have been ended.')
    expect(signInsWords(endedAt('1796558400'), 1_796_558_100)).toBe('Every sign-in made until 6 Dec 2026, 12:00 UTC has been ended. A new one works after that.')
    expect(signInsWords(endedAt('1796558400'), 1_796_558_401)).toBe('Every sign-in made before 6 Dec 2026, 12:00 UTC has been ended.')
    expect(isReservedKey('eth.orivonstack.id.not-before')).toBe(true)
    expect(isReservedKey('url')).toBe(false)
  })
})

describe('the words before a permanent act', () => {
  it('says what ending all sign-ins does, that it costs gas and cannot be taken back, and that signing in again works', () => {
    const words = endSignInsWords('alice.v1.orivonid.eth')
    expect(words.title).toContain('alice.v1.orivonid.eth')
    const text = words.body.join(' ')
    expect(text).toContain('cannot be taken back')
    expect(text).toContain('costs gas')
    expect(text).toContain('Signing in again works after five minutes')
    expect(words.confirm).toBe('End all sign-ins')
  })

  it('warns about the two things the registry makes permanent or dangerous', () => {
    const text = PERMANENT_NOTES.join(' ')
    expect(text).toContain('setApprovalForAll')
    expect(text).toContain('permanent')
  })
})

describe('what is kept in the browser', () => {
  it('keeps and gives back a scan, for the same address in any case', () => {
    const store = memory()
    const cache = { version: 1, address: ALICE.toLowerCase(), lastBlock: 26_357_200, labels: { '00': 'alice' }, held: ['alice'] }
    expect(readCache(store, ALICE)).toBeNull()
    writeCache(store, ALICE, cache)
    expect(readCache(store, ALICE.toLowerCase())).toEqual(cache)
  })

  it('treats anything else in its place as no scan', () => {
    const store = memory()
    const key = `orivonid.names.v1.${ALICE.toLowerCase()}`
    for (const bad of ['not json', 'null', '[]', '{"version":2}', '{"version":1,"lastBlock":"9","labels":{},"held":[],"address":"x"}',
      '{"version":1,"lastBlock":9,"labels":{"a":5},"held":[],"address":"x"}', '{"version":1,"lastBlock":9,"labels":{},"held":[7],"address":"x"}']) {
      store.map.set(key, bad)
      expect(readCache(store, ALICE), bad).toBeNull()
    }
  })

  it('never throws on a store that does', () => {
    const broken = { get: () => { throw new Error('blocked') }, set: () => { throw new Error('blocked') } }
    expect(readCache(broken, ALICE)).toBeNull()
    expect(() => writeCache(broken, ALICE, {})).not.toThrow()
    expect(readKeys(broken)).toEqual([])
    expect(() => writeKeys(broken, ['x'])).not.toThrow()
  })

  it('keeps the record keys a person added, once each, and only text', () => {
    const store = memory()
    writeKeys(store, ['org.matrix', 'org.matrix', 'x'])
    expect(readKeys(store)).toEqual(['org.matrix', 'x'])
    store.map.set('orivonid.keys.v1', JSON.stringify(['ok', 5, '', 'a'.repeat(65), null]))
    expect(readKeys(store)).toEqual(['ok'])
    store.map.set('orivonid.keys.v1', '{"a":1}')
    expect(readKeys(store)).toEqual([])
  })
})
