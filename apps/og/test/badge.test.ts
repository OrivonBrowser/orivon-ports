import { describe, expect, it } from 'vitest'
import { ChainError } from '../site/sdk/chain.js'
import { badgeOf, BADGE_WORDS, whyNot } from '../site/badge-model.js'
import { checkOrivonId } from '../site/badge-reads.js'
import { usernameOf } from '../site/view-badge.js'
import { ACCOUNT } from './support/linagee-world.ts'

const clause = { ok: true }
function attributed (over: Record<string, unknown> = {}) {
  return {
    label: 'alice', address: ACCOUNT, ok: true, owner: { ok: true, owner: ACCOUNT }, roles: { ok: true, roleCount: 1n, roles: 1n, problem: null },
    forward: { ...clause, resolver: ACCOUNT, address: ACCOUNT, problem: null }, records: { ...clause, resolver: ACCOUNT, problem: null }, ...over
  } as never
}
const held = (over: Record<string, unknown> = {}) => ({ label: 'alice', attribution: attributed(over) })

describe('the Verified badge', () => {
  it('shows for an address that holds a username with all four clauses', () => {
    const badge = badgeOf({ phase: 'read', names: [held()], lapsed: [], complete: true })
    expect(badge).toMatchObject({ state: 'verified', tone: 'ok', headline: 'Verified', username: 'alice.v1.orivonid.eth', usernames: ['alice.v1.orivonid.eth'] })
  })

  it('does not show for a username that fails a clause, and says which', () => {
    const roles = badgeOf({ phase: 'read', names: [held({ ok: false, roles: { ok: false, roleCount: 2n, roles: 1n, problem: null } })], lapsed: [], complete: true })
    expect(roles).toMatchObject({ state: 'partial', tone: 'warn' })
    expect(roles.words).toMatch(/another account also holds a role/)
    expect(whyNot(attributed({ roles: { ok: false, roleCount: 0n, roles: 0n, problem: 'rolesUnreadable' } }))).toMatch(/could not be read/)
    expect(whyNot(attributed({ forward: { ok: false, problem: 'noResolver' } }))).toMatch(/no resolver/)
    expect(whyNot(attributed({ forward: { ok: false, problem: 'differentAddress' } }))).toMatch(/different address/)
    expect(whyNot(attributed({ forward: { ok: false, problem: 'resolverFailed' } }))).toMatch(/could not be asked/)
    expect(whyNot(attributed({ records: { ok: false, problem: 'textRoleMissing' } }))).toMatch(/cannot write its records/)
    expect(whyNot(attributed({ owner: { ok: false, owner: null } }))).toMatch(/another address/)
  })

  it('is one verified name among several, and the verified ones are the ones named', () => {
    const badge = badgeOf({ phase: 'read', names: [held({ ok: false, forward: { ok: false, problem: 'noAddress' } }), { label: 'bob', attribution: attributed({ label: 'bob' }) }], lapsed: [], complete: true })
    expect(badge).toMatchObject({ state: 'verified', usernames: ['bob.v1.orivonid.eth'] })
  })

  it('says when there is none, and that an incomplete search may have missed one', () => {
    expect(badgeOf({ phase: 'read', names: [], lapsed: [], complete: true })).toMatchObject({ state: 'none', words: 'This address holds no Orivon ID username.' })
    expect(badgeOf({ phase: 'read', names: [], lapsed: [], complete: false }).words).toContain(BADGE_WORDS.recent)
  })

  it('has a state for each time a check can be in', () => {
    expect(badgeOf({ phase: 'idle' }).state).toBe('idle')
    expect(badgeOf({ phase: 'checking' }).state).toBe('checking')
    expect(badgeOf({ phase: 'failed', words: 'No node.' })).toMatchObject({ state: 'failed', tone: 'warn', words: 'No node.' })
  })

  it('always has the lists of what it proves and what it does not', () => {
    expect(BADGE_WORDS.proves.length).toBeGreaterThan(1)
    // The badge is read through whichever node the page was given: an extension's provider is not "your own node".
    expect(BADGE_WORDS.proves.join(' ')).not.toMatch(/your own node/)
    expect(BADGE_WORDS.proves[0]).toMatch(/through the node the strip at the top of the page names/)
    expect(BADGE_WORDS.doesNot.join(' ')).toMatch(/does not say who the person is/)
    expect(BADGE_WORDS.doesNot.join(' ')).toMatch(/\.og name/)
  })
})

describe('the check', () => {
  it('asks the ID registry through the SDK, with the usernames known, and keeps what comes back', async () => {
    const asked: unknown[] = []
    const find = async (_chain: unknown, address: string, options: unknown) => {
      asked.push([address, options])
      return { names: [held()], lapsed: [], cache: { marker: 1 }, coverage: { complete: false, failed: false, unnamed: 0, blocks: 3072 } }
    }
    const done = await checkOrivonId({} as never, ACCOUNT, ['alice'], { find: find as never })
    expect(asked).toEqual([[ACCOUNT, { cache: null, known: ['alice'] }]])
    expect(done.check).toMatchObject({ phase: 'read', complete: false })
    expect(done.cache).toEqual({ marker: 1 })
  })

  it('fails in words, not with an exception, when the node cannot be asked or the person refused', async () => {
    const refuse = async () => { throw new ChainError('declined', 'no') }
    const down = async () => { throw new ChainError('unavailable', 'down') }
    expect((await checkOrivonId({} as never, ACCOUNT, [], { find: refuse as never })).check).toMatchObject({ phase: 'failed', words: expect.stringMatching(/did not let this page/) })
    expect((await checkOrivonId({} as never, ACCOUNT, [], { find: down as never })).check).toMatchObject({ phase: 'failed', words: expect.stringMatching(/did not answer/) })
  })
})

describe('the username typed to check', () => {
  it('is the label as the ID registry spells it, with or without its suffix', () => {
    expect(usernameOf('alice')).toBe('alice')
    expect(usernameOf('  Alice ')).toBe('alice')
    expect(usernameOf('alice.v1.orivonid.eth')).toBe('alice')
    expect(usernameOf('a')).toBeNull()
    expect(usernameOf('')).toBeNull()
    expect(usernameOf('日本語')).toBeNull()
    expect(usernameOf('-alice')).toBeNull()
  })
})
