import { describe, expect, it } from 'vitest'
import { decode, selector, toChecksumAddress } from '../site/sdk/abi.js'
import { fromHex, toHex } from '../site/sdk/bytes.js'
import { ADDRESSES, type RecordsRead } from '../site/sdk/orivonid.js'
import { callFor, copyKeys, copySet, copyWords, failureNote, type Facts, MOVE_ORDER, MOVE_STEPS, moveWords, NOT_YET_HELD, planMove } from '../site/move-model.js'
import { COMMON_KEYS } from '../site/me-model.js'
import { NOT_BEFORE_KEY } from '../site/sdk/protocol.js'
import { failing } from './support/attribution.ts'

const HOLDER = toChecksumAddress('0x' + 'a1'.repeat(20))
const OLD = toChecksumAddress('0x' + '0d'.repeat(20))
const OWN = toChecksumAddress('0x' + '0e'.repeat(20))
const CONTENTHASH = fromHex('0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f')

const read = (change: Partial<RecordsRead> = {}): RecordsRead => ({
  resolver: OLD, addr: OLD, texts: { url: 'https://alice.example', description: 'Builds things.', avatar: null }, contenthash: CONTENTHASH, failed: [], ...change
})

function facts(change: Partial<Facts> = {}): Facts {
  return {
    label: 'alice', holder: HOLDER, current: OLD, target: { address: OWN, mode: 'deploy', why: null }, old: read(), found: null,
    attribution: failing({ records: { ok: false, resolver: OLD, problem: 'textRoleMissing' } }), ...change
  }
}

const states = (plan: ReturnType<typeof planMove>) => plan.steps.map((step) => `${step.id}:${step.state}`)

describe('the steps of a move', () => {
  it('are three, in the order the chain needs them: the resolver, the records on it, then the registry', () => {
    expect(MOVE_ORDER).toEqual(['deploy', 'records', 'resolver'])
    expect(planMove(facts(), { copy: true }).steps.map((step) => step.id)).toEqual([...MOVE_ORDER])
    for (const id of MOVE_ORDER) expect(MOVE_STEPS[id].title.length, id).toBeGreaterThan(5)
  })

  it('all wait while the holder has no resolver of their own, and the first to send is the one that creates it', () => {
    const plan = planMove(facts(), { copy: true })
    expect(states(plan)).toEqual(['deploy:pending', 'records:pending', 'resolver:pending'])
    expect(plan).toMatchObject({ next: 'deploy', started: false, blocked: null })
  })

  it('goes on from the resolver once it exists, and from the records once they are set', () => {
    const own = { address: OWN, mode: 'reuse' as const, why: null }
    expect(states(planMove(facts({ target: own }), { copy: true }))).toEqual(['deploy:done', 'records:pending', 'resolver:pending'])
    expect(planMove(facts({ target: own }), { copy: true })).toMatchObject({ next: 'records', started: true })
    const both = planMove(facts({ target: own, found: read({ resolver: OWN, addr: HOLDER }) }), { copy: true })
    expect(states(both)).toEqual(['deploy:done', 'records:done', 'resolver:pending'])
    expect(both).toMatchObject({ next: 'resolver', started: true })
  })

  it('is over when the registry names the holder\'s resolver and it carries what was chosen', () => {
    const own = { address: OWN, mode: 'reuse' as const, why: null }
    const plan = planMove(facts({ target: own, current: OWN, old: null, found: read({ resolver: OWN, addr: HOLDER }) }), { copy: true })
    expect(states(plan)).toEqual(['deploy:done', 'records:done', 'resolver:done'])
    expect(plan).toMatchObject({ next: null, started: false })
  })

  it('does not take an address record that is not the holder\'s for set', () => {
    const own = { address: OWN, mode: 'reuse' as const, why: null }
    expect(planMove(facts({ target: own, found: read({ resolver: OWN, addr: OLD, texts: {}, contenthash: null }) }), { copy: false }).next).toBe('records')
    expect(planMove(facts({ target: own, found: read({ resolver: OWN, addr: null, texts: {}, contenthash: null }) }), { copy: false }).next).toBe('records')
  })

  it('is blocked, with the reason, when something else sits where the holder\'s resolver goes', () => {
    const blocked = planMove(facts({ target: { address: OWN, mode: 'blocked', why: 'the contract there is not a PermissionedResolver made by the factory' } }), { copy: true })
    expect(blocked.blocked).toContain('not a PermissionedResolver')
    expect(blocked.next).toBe('deploy')
  })

  it('reads the registry\'s choice case-insensitively', () => {
    const own = { address: OWN, mode: 'reuse' as const, why: null }
    expect(planMove(facts({ target: own, current: OWN.toLowerCase() }), { copy: false }).steps[2]?.state).toBe('done')
  })
})

describe('copying the current records', () => {
  const own = { address: OWN, mode: 'reuse' as const, why: null }

  it('carries the contenthash and the texts the page lists, never the record that ends sign-ins or the address', () => {
    const found = copySet(read({ texts: { url: 'https://alice.example', [NOT_BEFORE_KEY]: '1800000000', avatar: null } }))
    expect(found).toMatchObject({ readable: true, count: 2, texts: { url: 'https://alice.example' }, skipped: [] })
    expect(Object.keys(found.texts)).not.toContain(NOT_BEFORE_KEY)
    expect(toHex(found.contenthash as Uint8Array)).toBe(toHex(CONTENTHASH))
  })

  it('reads the keys the page lists, plus the ones the person added, once each, and not the record that ends sign-ins', () => {
    expect(copyKeys()).toEqual([...COMMON_KEYS])
    expect(copyKeys(['org.matrix', 'url', NOT_BEFORE_KEY])).toEqual([...COMMON_KEYS, 'org.matrix'])
  })

  it('says what a ticked box does, and why it cannot be ticked when it cannot', () => {
    const words = copyWords(copySet(read()))
    expect(words).toMatchObject({ available: true })
    expect(words.detail).toContain('the contenthash and 2 text records')
    expect(copyWords(copySet(read({ texts: { url: 'https://a.example' }, contenthash: null }))).detail).toContain('1 text record to')
    expect(copyWords(copySet(null))).toMatchObject({ available: false })
    expect(copyWords(copySet(read({ texts: {}, contenthash: null })))).toMatchObject({ available: false })
    const dead = copyWords(copySet(read({ texts: { url: null }, contenthash: null, failed: ['contenthash', 'text:url'] })))
    expect(dead).toMatchObject({ available: false })
    expect(dead.detail).toContain('did not answer')
  })

  it('leaves out a record the old resolver would not answer, and says so', () => {
    const partial = copySet(read({ texts: { url: 'https://a.example', avatar: null }, contenthash: null, failed: ['text:avatar'] }))
    expect(partial).toMatchObject({ readable: true, count: 1, skipped: ['avatar'] })
    expect(copyWords(partial).detail).toContain('1 could not be read and is left out')
  })

  it('makes the records step wait for the copy when it is asked for, and not when it is not', () => {
    const bare = read({ resolver: OWN, addr: HOLDER, texts: {}, contenthash: null })
    expect(planMove(facts({ target: own, found: bare }), { copy: false }).steps[1]?.state).toBe('done')
    expect(planMove(facts({ target: own, found: bare }), { copy: true }).steps[1]?.state).toBe('pending')
    const full = read({ resolver: OWN, addr: HOLDER, texts: { url: 'https://alice.example', description: 'Builds things.', avatar: null } })
    expect(planMove(facts({ target: own, found: full }), { copy: true }).steps[1]?.state).toBe('done')
    const wrongHash = read({ ...full, contenthash: fromHex('0xe301') })
    expect(planMove(facts({ target: own, found: wrongHash }), { copy: true }).steps[1]?.state).toBe('pending')
    const wrongText = read({ ...full, texts: { ...full.texts, url: 'https://elsewhere.example' } })
    expect(planMove(facts({ target: own, found: wrongText }), { copy: true }).steps[1]?.state).toBe('pending')
  })

  it('does not wait for a copy of records that could not be read', () => {
    const dead = read({ texts: { url: null }, contenthash: null, failed: ['contenthash', 'text:url'] })
    const bare = read({ resolver: OWN, addr: HOLDER, texts: {}, contenthash: null })
    expect(planMove(facts({ target: own, old: dead, found: bare }), { copy: true }).steps[1]?.state).toBe('done')
  })
})

describe('the transaction of each step', () => {
  const own = { address: OWN, mode: 'reuse' as const, why: null }
  const plain = (data: Uint8Array) => toHex(data.subarray(0, 4))
  const sel = (signature: string) => toHex(selector(signature))

  it('creates the holder\'s resolver with the registration\'s own builder', () => {
    const call = callFor('deploy', facts(), planMove(facts(), { copy: true }))
    expect(call.to).toBe(ADDRESSES.verifiableFactory)
    expect(plain(call.data)).toBe(sel('deployProxy(address,uint256,bytes)'))
  })

  it('sets the address, then the contenthash and texts that were chosen, in one multicall on the holder\'s resolver', () => {
    const f = facts({ target: own })
    const call = callFor('records', f, planMove(f, { copy: true }))
    expect(call.to).toBe(OWN)
    expect(plain(call.data)).toBe(sel('multicall(bytes[])'))
    const [inner] = decode(['bytes[]'], call.data.subarray(4)) as [Uint8Array[]]
    expect(inner.map(plain)).toEqual([sel('setAddress(bytes,uint256,bytes)'), sel('setContenthash(bytes,bytes)'), sel('setText(bytes,string,string)'), sel('setText(bytes,string,string)')])
  })

  it('sets only the address when nothing is copied', () => {
    const f = facts({ target: own })
    const [inner] = decode(['bytes[]'], callFor('records', f, planMove(f, { copy: false })).data.subarray(4)) as [Uint8Array[]]
    expect(inner.map(plain)).toEqual([sel('setAddress(bytes,uint256,bytes)')])
  })

  it('points the registry at the holder\'s resolver for the label', () => {
    const f = facts({ target: own })
    const call = callFor('resolver', f, planMove(f, { copy: true }))
    expect(call.to).toBe(ADDRESSES.r1)
    expect(plain(call.data)).toBe(sel('setResolver(uint256,address)'))
    expect(toHex(call.data.subarray(36 + 12))).toBe(OWN.slice(2).toLowerCase())
  })
})

describe('the words', () => {
  it('say before anything is sent that moving ends every sign-in made with the ID and that the old resolver keeps its copy', () => {
    const words = moveWords('alice')
    const all = words.warnings.join(' ')
    expect(all).toContain('Moving ends every sign-in made with alice.v1.orivonid.eth')
    expect(all).toContain('The old resolver keeps its copy of the records')
    expect(words.steps).toContain('Nothing is sent before you press the button')
    expect(words.title).toBe('Move to your own resolver')
  })

  it('give a revert at each step its own sentence, and nothing for a failure that needs none', () => {
    for (const step of ['deploy', 'records', 'resolver'] as const) expect(failureNote(step, 'reverted'), step).toMatch(/refused/)
    expect(failureNote('records', 'declined')).toBeNull()
    expect(failureNote(null, 'reverted')).toBeNull()
    expect(NOT_YET_HELD).toContain('Check again')
  })
})
