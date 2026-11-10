import { describe, expect, it } from 'vitest'
import { moveAdvice, retryOrMove } from '../site/connect-request.js'
import { forwardWords, moveOffer, notOffered } from '../site/offer-model.js'
import type { Attribution } from '../site/sdk/orivonid.js'
import { attribution, failing, HOLDER } from './support/attribution.ts'

const forward = (problem: NonNullable<Attribution['forward']['problem']>) => ({ ok: false, resolver: HOLDER, address: null, problem })
const records = (problem: NonNullable<Attribution['records']['problem']>) => ({ ok: false, resolver: HOLDER, problem })
const roles = (problem: 'rolesUnreadable' | null) => ({ ok: false, roleCount: 2n, roles: 1n, problem })
const NAME = 'alice.v1.orivonid.eth'
const MY_IDS = { href: '#/me', label: 'Open My IDs' }

describe('whether an ID can be moved to a resolver of its holder', () => {
  it('offers it for an ID the address holds alone, with the right to change the resolver, on a resolver whose records it cannot write', () => {
    for (const problem of ['notPermissionedResolver', 'textRoleMissing', 'addressRoleMissing', 'unreadable', 'noResolver'] as const) {
      expect(moveOffer(failing({ records: records(problem) })), problem).toEqual({ offered: true })
    }
  })

  it('has nothing to move where the records are already held', () => {
    expect(moveOffer(attribution())).toMatchObject({ offered: false, reason: 'held' })
    expect(moveOffer(failing({ forward: forward('noAddress') }))).toMatchObject({ offered: false, reason: 'held' })
  })

  it('refuses an ID the address does not hold alone, in words, and says when to try again', () => {
    expect(moveOffer(failing({ owner: { ok: false, owner: null }, records: records('textRoleMissing') }))).toMatchObject({ offered: false, reason: 'owner', retry: false })
    const shared = moveOffer(failing({ roles: roles(null), records: records('textRoleMissing') }))
    expect(shared).toMatchObject({ offered: false, reason: 'roles', retry: false })
    expect(shared.offered ? '' : shared.words).toContain('Another account holds a right on alice.v1.orivonid.eth')
    expect(moveOffer(failing({ roles: roles('rolesUnreadable'), records: records('textRoleMissing') }))).toMatchObject({ offered: false, reason: 'rolesUnreadable', retry: true })
  })

  it('refuses an ID whose holder does not hold the right to change its resolver', () => {
    const none = { ok: true, roleCount: 1n << 20n, roles: 1n << 20n, problem: null }
    expect(moveOffer(failing({ roles: none, records: records('textRoleMissing') }))).toMatchObject({ offered: false, reason: 'setResolver' })
  })
})

describe('why an ID is not offered for a sign-in, and what is possible', () => {
  it('offers an ID that holds all four clauses', () => {
    expect(notOffered(attribution())).toBeNull()
  })

  it('says an ID the address does not hold, or shares the rights of, cannot be offered, with nothing to do', () => {
    expect(notOffered(failing({ owner: { ok: false, owner: null } }))).toMatchObject({ reason: 'owner', remedy: null, link: null })
    expect(notOffered(failing({ roles: roles(null) }))).toMatchObject({ reason: 'roles', remedy: null, words: expect.stringContaining('Another account holds a right') })
  })

  it('says a registry that would not answer is not a no', () => {
    expect(notOffered(failing({ roles: roles('rolesUnreadable') }))).toMatchObject({ reason: 'rolesUnreadable', remedy: 'Try again in a moment.' })
  })

  it('sends a holder whose records are fine and whose address record is wrong to My IDs, where saving the records sets it', () => {
    for (const problem of ['noAddress', 'differentAddress'] as const) {
      expect(notOffered(failing({ forward: forward(problem) })), problem).toMatchObject({
        reason: 'forward', words: forwardWords(problem), remedy: null, link: { href: '#/me', label: 'Open My IDs' }
      })
    }
  })

  it('points a holder who cannot write the records to the move, not to saving, since saving would fail', () => {
    const one = notOffered(failing({ forward: forward('differentAddress'), records: records('textRoleMissing') }))
    expect(one).toMatchObject({ reason: 'forward', remedy: moveAdvice(NAME), link: MY_IDS })
  })

  it('has its own words for a resolver that did not answer, and one that is not there', () => {
    expect(notOffered(failing({ forward: forward('resolverFailed') }))).toMatchObject({ remedy: 'Try again in a moment.', link: null })
    expect(notOffered(failing({ forward: forward('resolverFailed'), records: records('notPermissionedResolver') }))).toMatchObject({ remedy: retryOrMove(NAME), link: MY_IDS })
    expect(notOffered(failing({ forward: forward('noResolver'), records: records('noResolver') }))).toMatchObject({ remedy: moveAdvice(NAME), link: MY_IDS })
  })

  it('points to the move by name when the address cannot write the records, for each way that can be', () => {
    for (const problem of ['notPermissionedResolver', 'textRoleMissing', 'addressRoleMissing'] as const) {
      expect(notOffered(failing({ records: records(problem) })), problem).toMatchObject({ reason: 'recordsNotHeld', remedy: moveAdvice(NAME), link: MY_IDS })
    }
    expect(notOffered(failing({ records: records('unreadable') }))).toMatchObject({ reason: 'recordsNotHeld', remedy: retryOrMove(NAME), link: MY_IDS })
    expect(moveAdvice(NAME)).toContain('“Move to your own resolver”')
  })

  it('offers no move where the address could not make it, and says nothing to do', () => {
    const noRight = { roles: { ok: true, roleCount: 1n << 20n, roles: 1n << 20n, problem: null } }
    expect(notOffered(failing({ ...noRight, records: records('textRoleMissing') }))).toMatchObject({ reason: 'recordsNotHeld', remedy: null, link: null })
    expect(notOffered(failing({ ...noRight, records: records('unreadable') }))).toMatchObject({ remedy: 'Try again in a moment.', link: null })
  })

  it('names the ID in full and writes no internal name or route into what the person reads', () => {
    const cases: Partial<Attribution>[] = [
      { owner: { ok: false, owner: null } }, { roles: roles(null) }, { roles: roles('rolesUnreadable') },
      ...(['noResolver', 'noAddress', 'resolverFailed', 'differentAddress'] as const).map((problem) => ({ forward: forward(problem), records: records('noResolver') })),
      ...(['notPermissionedResolver', 'textRoleMissing', 'addressRoleMissing', 'unreadable'] as const).map((problem) => ({ records: records(problem) }))
    ]
    for (const change of cases) {
      const one = notOffered(failing(change, 'carol'))
      expect(one?.name).toBe('carol.v1.orivonid.eth')
      const text = `${one?.words} ${one?.remedy ?? ''}`
      expect(text, `${cases.indexOf(change)}`).not.toMatch(/#\/|differentAddress|noAddress|noResolver|textRoleMissing|notPermissioned|resolverFailed|rolesUnreadable/)
    }
  })
})
