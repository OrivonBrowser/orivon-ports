// The bridge page of a relying site: what it forwards to the ID site, whom it forwards for, and what it does with the answer. It runs as
// the relying site in the person's browser, so it is the only reader of the request the site kept.

import { describe, expect, it } from 'vitest'
import { runBridge, type BridgeOutcome } from '../site/sdk/bridge.js'
import { ANSWER_KEY, PENDING_KEY, PENDING_MAX_AGE, type Pending } from '../site/sdk/pending.js'
import { takeAnswer } from '../site/sdk/connect.js'
import { encodeResponse, ID_ORIGIN, type SignInResponse } from '../site/sdk/protocol.js'
import { buildMessage } from '../site/sdk/siwe.js'
import { memoryStore } from './support/signin-flow.ts'
import { NOW, ORIGIN } from './support/signin-world.ts'

const C = 'Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcDeF'
const NONCE = 'k3Jf92LmQp0xZ7aT'
const KEY = '0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978'
const ATTACKER_KEY = '0x02' + '11'.repeat(32)

const pending = (extra: Partial<Pending> = {}): Pending => ({ v: 2, origin: ORIGIN, nonce: NONCE, key: null, ttl: null, state: null, after: '/signed-in', at: NOW, ...extra })

function responseFor (nonce: string): SignInResponse {
  const message = buildMessage({
    domain: 'id.orivonstack.eth', address: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826', statement: 'Sign in.', uri: ORIGIN, version: '1', chainId: 1, nonce,
    issuedAt: '2026-11-06T12:00:00Z', expirationTime: '2026-11-06T12:10:00Z', resources: ['orivonid:name:alice.v1.orivonid.eth#0x' + '7e'.repeat(20)]
  })
  return { v: 1, message, signature: '0x' + 'ab'.repeat(65), address: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826', names: ['alice.v1.orivonid.eth'] }
}

/** A bridge page open in a browser: the storage the site kept, and a log of everything the page did, in order. */
function page (options: { pending?: Pending | string | null, framed?: boolean, referrer?: string, now?: number, origin?: string, failStore?: boolean } = {}) {
  const storage = memoryStore()
  const log: string[] = []
  const messages: unknown[] = []
  const replaced: string[] = []
  if (options.pending !== null && options.pending !== undefined) storage.setItem(PENDING_KEY, typeof options.pending === 'string' ? options.pending : JSON.stringify(options.pending))
  else if (options.pending === undefined) storage.setItem(PENDING_KEY, JSON.stringify(pending()))
  const watched = {
    getItem: (key: string) => { log.push(`get ${key}`); return storage.getItem(key) },
    setItem: (key: string, value: string) => { if (options.failStore === true) throw new Error('quota'); log.push(`set ${key}`); storage.setItem(key, value) },
    removeItem: (key: string) => { log.push(`remove ${key}`); storage.removeItem(key) }
  }
  const run = (location: { search?: string, hash?: string }, referrer = options.referrer ?? `${ID_ORIGIN}/`) => runBridge({
    location: { origin: options.origin ?? ORIGIN, search: location.search ?? '', hash: location.hash ?? '' },
    referrer, framed: options.framed ?? false, storage: watched,
    replace: (url) => { log.push('replace'); replaced.push(url) }, clearHash: () => { log.push('clear') }, broadcast: (message) => { log.push('broadcast'); messages.push(message) },
    now: options.now ?? NOW + 10
  })
  return { storage, log, messages, replaced, run }
}

const visit = `?c=${C}`

/** What a visit's referrer is when the person did not come from the ID site: the bridge acts for neither visit then. */
const NOT_FROM_ID = [
  ['no referrer', ''],
  ['the relying site itself', `${ORIGIN}/`],
  ['another site', 'https://evil.example/'],
  ['a look-alike of the ID site', `${ID_ORIGIN}.evil.example/`],
  ['the ID site over http', 'http://id.orivonstack.eth/'],
  ['the ID site on a port', 'https://id.orivonstack.eth:8443/'],
  ['something that is not a URL', 'null']
] as const

describe('the first visit, from the ID site: it forwards what the site kept', () => {
  it('forwards the nonce alone for a plain request, with the challenge', () => {
    const { run, replaced } = page()
    expect(run({ search: visit })).toEqual({ outcome: 'forwarded', url: `${ID_ORIGIN}/#/connect?v=2&c=${C}&nonce=${NONCE}` })
    expect(replaced).toEqual([`${ID_ORIGIN}/#/connect?v=2&c=${C}&nonce=${NONCE}`])
  })

  it('forwards exactly the pending fields for a request with a state and a key, and nothing else the storage holds', () => {
    const { run, storage } = page({ pending: pending({ state: 'st-1', key: KEY, ttl: 2_592_000 }) })
    storage.setItem('relying.accepted', 'something else')
    storage.setItem('orivonid.answer', 'not forwarded')
    expect(run({ search: visit }).url).toBe(`${ID_ORIGIN}/#/connect?v=2&c=${C}&nonce=${NONCE}&state=st-1&delegate=${KEY}&ttl=2592000`)
  })

  it('says none when no request was kept, when it is older than an hour, and when it is from the future', () => {
    for (const options of [{ pending: null }, { now: NOW + PENDING_MAX_AGE + 1 }, { now: NOW - 3600 }] as const) {
      const { run, replaced } = page(options)
      expect(run({ search: visit }), JSON.stringify(options)).toEqual({ outcome: 'forwardedNone', url: `${ID_ORIGIN}/#/connect?v=2&c=${C}&none=1` })
      expect(replaced).toEqual([`${ID_ORIGIN}/#/connect?v=2&c=${C}&none=1`])
    }
  })

  it('says none for a kept request that is damaged or out of bounds: a bad nonce, a key off the curve, a ttl without a key, another origin, a path elsewhere', () => {
    for (const kept of [
      pending({ nonce: 'short' }), pending({ key: '0x02' + '00'.repeat(31) + '01', ttl: 600 }), pending({ key: KEY, ttl: 1 }), pending({ state: 'a b' }),
      pending({ origin: 'https://evil.example' }), pending({ after: '//evil.example' }), '{', 'null'
    ]) {
      expect(page({ pending: kept }).run({ search: visit }).outcome, JSON.stringify(kept)).toBe('forwardedNone')
    }
  })

  it('does not forward a request that names the attacker\'s key as the person\'s: it forwards only what the page itself wrote', () => {
    const { run } = page({ pending: pending({ key: KEY, ttl: 600 }) })
    const forwarded = run({ search: `?c=${C}&delegate=${ATTACKER_KEY}&ttl=600&nonce=Attacker0000000000` })
    expect(forwarded.outcome).toBe('badLink')
    expect(page({ pending: pending({ key: KEY, ttl: 600 }) }).run({ search: visit }).url).toContain(`delegate=${KEY}`)
  })

  it('does nothing at all when it runs in a frame', () => {
    const { run, replaced, log } = page({ framed: true })
    expect(run({ search: visit })).toEqual({ outcome: 'framed' })
    expect(run({ hash: '#orivonid-error=cancelled' })).toEqual({ outcome: 'framed' })
    expect(replaced).toEqual([])
    expect(log).toEqual([])
  })

  it.each(NOT_FROM_ID)('does not forward for a visit that did not come from the ID site: %s', (_name, referrer) => {
    const { run, replaced, log } = page()
    expect(run({ search: visit }, referrer)).toEqual({ outcome: 'notFromId' })
    expect(replaced).toEqual([])
    expect(log).toEqual([])
  })

  it.each([
    ['no query', ''],
    ['a challenge of 31 characters', `?c=${C.slice(1)}`],
    ['a challenge of 33 characters', `?c=${C}x`],
    ['a challenge with a symbol', `?c=${C.slice(1)}-`],
    ['another parameter beside it', `?c=${C}&x=1`],
    ['another parameter before it', `?x=1&c=${C}`],
    ['the challenge twice', `?c=${C}&c=${C}`],
    ['a name that is not c', `?d=${C}`]
  ])('does not forward for a challenge it cannot read: %s', (_name, search) => {
    const { run, replaced } = page()
    expect(run({ search })).toEqual({ outcome: 'badLink' })
    expect(replaced).toEqual([])
  })
})

describe('the second visit: it lands the answer', () => {
  it('takes the fragment out of the address bar before it reads anything, stores the answer, tells the other tabs and goes to the path the site chose', () => {
    const { run, log, replaced, messages, storage } = page()
    const response = responseFor(NONCE)
    expect(run({ hash: `#orivonid=${encodeResponse(response)}` })).toEqual({ outcome: 'landed', url: '/signed-in' })
    expect(log[0]).toBe('clear')
    expect(log.at(-1)).toBe('replace')
    expect(log.indexOf('broadcast')).toBeGreaterThan(log.indexOf(`set ${ANSWER_KEY}`))
    expect(replaced).toEqual(['/signed-in'])
    expect(messages).toEqual([{ kind: 'answer' }])
    expect(takeAnswer({ storage, now: NOW + 11 })).toEqual({ kind: 'response', response })
  })

  it('drops an answer that names another nonce: it is not stored, the kept request stays, and the person lands on the site', () => {
    const { run, storage, replaced, messages } = page()
    expect(run({ hash: `#orivonid=${encodeResponse(responseFor('Attacker0000000000'))}` }).outcome).toBe('wrongNonce' satisfies BridgeOutcome)
    expect(storage.getItem(ANSWER_KEY)).toBeNull()
    expect(storage.getItem(PENDING_KEY)).not.toBeNull()
    expect(replaced).toEqual(['/signed-in'])
    expect(messages).toEqual([])
  })

  it('drops an answer it cannot read, and leaves the request', () => {
    for (const hash of ['#orivonid=', '#orivonid=%%%', '#orivonid=e30', '#orivonid-error=lost', '#orivonid-error=cancelled&state=a b']) {
      const { run, storage, replaced } = page()
      expect(run({ hash }).outcome, hash).toBe('malformed')
      expect(storage.getItem(ANSWER_KEY), hash).toBeNull()
      expect(storage.getItem(PENDING_KEY), hash).not.toBeNull()
      expect(replaced, hash).toEqual(['/signed-in'])
    }
  })

  it('drops an answer when no request is waiting, or one is too old, and lands the person on the root', () => {
    for (const options of [{ pending: null }, { now: NOW + PENDING_MAX_AGE + 1 }, { pending: pending({ after: '//evil.example' }) }] as const) {
      const { run, storage, replaced } = page(options)
      expect(run({ hash: `#orivonid=${encodeResponse(responseFor(NONCE))}` }).outcome).toBe('noRequest')
      expect(storage.getItem(ANSWER_KEY)).toBeNull()
      expect(replaced).toEqual(['/'])
    }
  })

  it('drops an answer replayed after it was used: the request is gone', () => {
    const { run, storage } = page()
    const hash = `#orivonid=${encodeResponse(responseFor(NONCE))}`
    expect(run({ hash }).outcome).toBe('landed')
    storage.removeItem(PENDING_KEY)
    storage.removeItem(ANSWER_KEY)
    expect(run({ hash }).outcome).toBe('noRequest')
    expect(storage.getItem(ANSWER_KEY)).toBeNull()
  })

  it('lands a cancellation with the state of the request, ends the request, and tells the other tabs', () => {
    const { run, storage, messages } = page({ pending: pending({ state: 'st-1' }) })
    expect(run({ hash: '#orivonid-error=cancelled' }).outcome).toBe('landed')
    expect(takeAnswer({ storage, now: NOW + 11 })).toEqual({ kind: 'error', error: 'cancelled', state: 'st-1' })
    expect(storage.getItem(PENDING_KEY)).toBeNull()
    expect(messages).toEqual([{ kind: 'answer' }])
    const withState = page({ pending: pending({ state: 'st-1' }) })
    expect(withState.run({ hash: '#orivonid-error=cancelled&state=st-1' }).outcome).toBe('landed')
  })

  it('drops a cancellation that names another state than the request\'s', () => {
    const { run, storage } = page({ pending: pending({ state: 'st-1' }) })
    expect(run({ hash: '#orivonid-error=cancelled&state=other' }).outcome).toBe('wrongState')
    expect(storage.getItem(ANSWER_KEY)).toBeNull()
    expect(storage.getItem(PENDING_KEY)).not.toBeNull()
  })

  it('drops an answer when the kept request names another origin than this page\'s', () => {
    for (const options of [{ pending: pending({ origin: 'https://evil.example' }) }, { origin: 'https://other.example' }] as const) {
      const { run, storage, replaced, messages } = page(options)
      expect(run({ hash: `#orivonid=${encodeResponse(responseFor(NONCE))}` }).outcome).toBe('noRequest')
      expect(run({ hash: '#orivonid-error=cancelled' }).outcome).toBe('noRequest')
      expect(storage.getItem(ANSWER_KEY)).toBeNull()
      expect(storage.getItem(PENDING_KEY)).not.toBeNull()
      expect(replaced).toEqual(['/', '/'])
      expect(messages).toEqual([])
    }
  })

  it.each(NOT_FROM_ID)('drops an answer for a visit that did not come from the ID site, and leaves the request waiting: %s', (_name, referrer) => {
    const forgery = page({ pending: pending({ state: 'st-1' }) })
    expect(forgery.run({ hash: '#orivonid-error=cancelled' }, referrer)).toEqual({ outcome: 'notFromId' })
    expect(forgery.run({ hash: `#orivonid=${encodeResponse(responseFor(NONCE))}` }, referrer)).toEqual({ outcome: 'notFromId' })
    expect(forgery.log).toEqual(['clear', 'clear'])
    expect(forgery.replaced).toEqual([])
    expect(forgery.messages).toEqual([])
    expect(forgery.storage.getItem(ANSWER_KEY)).toBeNull()
    expect(JSON.parse(forgery.storage.getItem(PENDING_KEY) ?? 'null')).toEqual(pending({ state: 'st-1' }))
  })

  it('lands the answer of a visit from the ID site, with the same page and the same fragment', () => {
    const { run } = page({ pending: pending({ state: 'st-1' }) })
    expect(run({ hash: '#orivonid-error=cancelled' }, `${ID_ORIGIN}/`).outcome).toBe('landed')
  })

  it('still sends the person to the site when the browser will not keep the answer', () => {
    const { run, replaced } = page({ failStore: true })
    expect(run({ hash: `#orivonid=${encodeResponse(responseFor(NONCE))}` }).outcome).toBe('notStored')
    expect(replaced).toEqual(['/signed-in'])
  })
})
