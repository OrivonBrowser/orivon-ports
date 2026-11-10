import { describe, expect, it } from 'vitest'
import { CONNECT_REASONS, ConnectError, moveAdvice, parseRequest, retryOrMove } from '../site/connect-request.js'
import { connectEntry, consentView, lifetimeChoices, problemWords, PROBLEM_WORDS, signInFailure, walletWarningWords } from '../site/connect-model.js'
import { ChainError } from '../site/sdk/chain.js'
import { REQUEST_PROBLEMS } from '../site/sdk/protocol.js'
import { RelayError } from '../site/relay.js'
import { formatTime } from '../site/words.js'
import { attribution, failing } from './support/attribution.ts'

const KEY = '0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978'
const NONCE = 'k3Jf92LmQp0xZ7aT'
const RETURN = 'https://app.example.org/callback'
const NOW = 1_796_558_400

function request(extra = '') {
  const parsed = parseRequest(`#/connect?v=1&return=${encodeURIComponent(RETURN)}&nonce=${NONCE}${extra}`)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.request
}
const withKey = (ttl: number) => request(`&delegate=${KEY}&ttl=${ttl}`)
const held = (label: string) => ({ label, attribution: attribution({}, label) })
const notHeld = (label: string) => ({ label, attribution: failing({ records: { ok: false, resolver: '0x' + '4b'.repeat(20), problem: 'textRoleMissing' } }, label) })
const names = [held('alice'), held('bob-1'), notHeld('carol')]

describe('the words for a request that cannot be used', () => {
  it('has words for every problem a request can have', () => {
    const named = ['notConnect', 'malformed', 'duplicate', 'unknownField', ...REQUEST_PROBLEMS]
    for (const reason of named) expect(PROBLEM_WORDS, reason).toHaveProperty(reason)
    expect(Object.keys(PROBLEM_WORDS).sort()).toEqual([...named].sort())
  })

  it('names the field after the words, except for the whole fragment', () => {
    expect(problemWords('badNonce', 'nonce')).toContain('(nonce)')
    expect(problemWords('notConnect', 'hash')).toBe(PROBLEM_WORDS.notConnect)
    expect(problemWords('somethingNew', '')).toBe('The request cannot be read.')
  })
})

describe('what the person is asked to agree to', () => {
  it('says, without a key, that the site learns the IDs for ten minutes and cannot act', () => {
    const view = consentView({ request: request(), names, ticked: new Set(['alice']), lifetime: 0, now: NOW })
    expect(view.audience).toBe('https://app.example.org')
    expect(view.key).toBeNull()
    expect(view.seconds).toBe(600)
    expect(view.terms.join(' ')).toContain('10 minutes')
    expect(view.terms.join(' ')).toContain('cannot act for you')
    expect(view.terms.every((line) => line.includes('https://app.example.org') || line.length > 10)).toBe(true)
  })

  it('says, with a key, until when the site may act as these IDs, what that is, and that it cannot move funds', () => {
    const view = consentView({ request: withKey(2_592_000), names, ticked: new Set(['alice']), lifetime: 86_400, now: NOW })
    expect(view.seconds).toBe(86_400)
    expect(view.expires).toBe('7 Dec 2026, 12:00 UTC')
    expect(view.key?.preview).toBe('0x037cf27b…47669978')
    const text = view.terms.join(' ')
    expect(text).toContain('accepts requests signed by its key')
    expect(text).toContain('It cannot move funds.')
    expect(text).toContain('End all sign-ins')
  })

  it('keeps the lifetime between a minute and what was asked', () => {
    expect(consentView({ request: withKey(86_400), names, ticked: new Set(['alice']), lifetime: 99_999_999, now: NOW }).seconds).toBe(86_400)
    expect(consentView({ request: withKey(86_400), names, ticked: new Set(['alice']), lifetime: 5, now: NOW }).seconds).toBe(60)
  })

  it('offers the lifetimes under the limit, shortest first, and the limit last', () => {
    expect(lifetimeChoices(withKey(15_552_000)).map((choice) => choice.label)).toEqual(['1 hour', '1 day', '7 days', '30 days', '90 days', '180 days'])
    expect(lifetimeChoices(withKey(3000)).map((choice) => choice.label)).toEqual(['50 minutes'])
    expect(lifetimeChoices(request()).map((choice) => choice.seconds)).toEqual([600])
  })

  it('counts the ticked IDs that can sign in, and lists the ones that cannot apart', () => {
    const view = consentView({ request: request(), names, ticked: new Set(['alice', 'bob-1', 'carol']), lifetime: 0, now: NOW })
    expect(view.shareable.map((one) => one.label)).toEqual(['alice', 'bob-1'])
    expect(view.unusable.map((one) => one.label)).toEqual(['carol'])
    expect(view.unusable[0]).toMatchObject({ name: 'carol.v1.orivonid.eth', reason: 'recordsNotHeld', remedy: moveAdvice('carol.v1.orivonid.eth'), link: { href: '#/me', label: 'Open My IDs' } })
    expect(view.unusable[0]?.words).toContain('carol.v1.orivonid.eth')
    expect(view.chosen).toBe(2)
    expect(view.canSignIn).toBe(true)
    expect(consentView({ request: request(), names, ticked: new Set(), lifetime: 0, now: NOW }).canSignIn).toBe(false)
    expect(consentView({ request: request(), names, ticked: new Set(['carol']), lifetime: 0, now: NOW }).canSignIn).toBe(false)
  })

  it('lists an ID apart while its sign-ins are ended up to a time ahead of the clock, and offers it from that time on', () => {
    const until = NOW + 300
    const ended = new Map([['alice', until]])
    const view = consentView({ request: request(), names, ticked: new Set(['alice', 'bob-1']), lifetime: 0, now: NOW, endedUntil: ended })
    expect(view.shareable.map((one) => one.label)).toEqual(['bob-1'])
    expect(view.chosen).toBe(1)
    expect(view.unusable.map((one) => one.label)).toEqual(['alice', 'carol'])
    expect(view.unusable[0]).toMatchObject({ name: 'alice.v1.orivonid.eth', reason: 'ended', remedy: null, link: null })
    expect(view.unusable[0]?.words).toBe(`Every sign-in made with alice.v1.orivonid.eth was just ended. A new one works after ${formatTime(until)}.`)
    const later = consentView({ request: request(), names, ticked: new Set(['alice']), lifetime: 0, now: until + 1, endedUntil: ended })
    expect(later.shareable.map((one) => one.label)).toEqual(['alice', 'bob-1'])
    expect(later.unusable.map((one) => one.label)).toEqual(['carol'])
    expect(consentView({ request: request(), names, ticked: new Set(['alice']), lifetime: 0, now: until, endedUntil: ended }).shareable.map((one) => one.label)).toEqual(['bob-1'])
  })

  it('says, before the wallet opens, that it will warn, why, and what to check', () => {
    const view = consentView({ request: request(), names, ticked: new Set(['alice']), lifetime: 0, now: NOW })
    expect(view.walletWarning).toBe(walletWarningWords('https://app.example.org'))
    expect(view.walletWarning).toContain('Your wallet will warn you')
    expect(view.walletWarning).toContain('signs you in on behalf of https://app.example.org')
    expect(view.walletWarning).toContain('check that the URI it shows is https://app.example.org')
    expect(view.walletWarning).not.toMatch(/[^\x20-\x7e]/)
  })

  it('refuses more than sixteen IDs', () => {
    const many = Array.from({ length: 17 }, (_, index) => held(`name${index}x`))
    const view = consentView({ request: request(), names: many, ticked: new Set(many.map((one) => one.label)), lifetime: 0, now: NOW })
    expect(view).toMatchObject({ chosen: 17, canSignIn: false, tooMany: true })
  })
})

describe('what a sign-in that stopped says', () => {
  it('words each reason the ID site would not sign, and which of them are worth another try', () => {
    for (const reason of CONNECT_REASONS) {
      const found = signInFailure(new ConnectError(reason as never, 'alice', 'textRoleMissing'))
      expect(found.words.length, reason).toBeGreaterThan(20)
      expect(found.words, reason).not.toBe('The sign-in stopped.')
    }
    expect(signInFailure(new ConnectError('notAttributed', 'alice')).words).toContain('alice.v1.orivonid.eth')
    expect(signInFailure(new ConnectError('wrongAccount')).retry).toBe(false)
    expect(signInFailure(new ConnectError('names')).retry).toBe(true)
  })

  it('says why records are not held, in the name of the ID and with what is possible, and retries only when the resolver would not answer', () => {
    const held = signInFailure(new ConnectError('recordsNotHeld', 'alice', 'textRoleMissing'))
    expect(held.words).toContain('alice.v1.orivonid.eth')
    expect(held.words).toContain('Nothing was signed.')
    expect(held.words).toContain(moveAdvice('alice.v1.orivonid.eth'))
    expect(held.retry).toBe(false)
    const unreadable = signInFailure(new ConnectError('recordsNotHeld', 'alice', 'unreadable'))
    expect(unreadable).toMatchObject({ retry: true })
    expect(unreadable.words).toContain(retryOrMove('alice.v1.orivonid.eth'))
  })

  it('says a declined signature shared nothing, and gives the wallet\'s other failures their words', () => {
    expect(signInFailure(new ChainError('declined', 'no'))).toEqual({ words: 'You declined to sign, so nothing was shared.', retry: true })
    expect(signInFailure(new ChainError('timeout', 'slow')).words).toBe('The node took too long to answer.')
    expect(signInFailure(new RelayError('rejected', 'x')).words.length).toBeGreaterThan(0)
  })
})

describe('how the person arrived, decided before anything is drawn', () => {
  const hash = (extra = '') => `#/connect?v=1&return=${encodeURIComponent(RETURN)}&nonce=${NONCE}${extra}`
  const KEYED = hash(`&delegate=${KEY}&ttl=600`)
  const AUDIENCE = 'https://app.example.org'
  const arrive = (page: string, referrer: string, framed = false) => connectEntry({ hash: page, referrer, framed })

  it('shows the consent, with no warning, to a person who came from the site they would sign in to', () => {
    for (const page of [hash(), KEYED]) {
      expect(arrive(page, `${AUDIENCE}/login?x=1`)).toMatchObject({ kind: 'consent', warning: null, exit: { answer: 'cancelled' } })
    }
  })

  it('shows the whole return address beside the origin when it is more than the root, and not otherwise', () => {
    const deep = arrive(hash(), AUDIENCE)
    expect(deep).toMatchObject({ kind: 'consent', returnShown: { origin: AUDIENCE, full: RETURN } })
    expect(deep.kind === 'consent' && deep.returnShown.words).toContain('exact address')
    const root = connectEntry({ hash: `#/connect?v=1&return=${encodeURIComponent(`${AUDIENCE}/`)}&nonce=${NONCE}`, referrer: AUDIENCE, framed: false })
    expect(root).toMatchObject({ kind: 'consent', returnShown: { full: null, words: null } })
  })

  it('stops a page in a frame, whatever the referrer is, and offers no way back to the site', () => {
    for (const page of [hash(), KEYED]) {
      const stop = arrive(page, AUDIENCE, true)
      expect(stop).toMatchObject({ kind: 'stopped', words: 'This page cannot be used inside another page. Open it in its own tab.' })
      expect(stop).not.toHaveProperty('exit')
    }
  })

  it('stops a person who came from another site, and names both', () => {
    const stop = arrive(KEYED, 'https://evil.example/page')
    expect(stop).toMatchObject({ kind: 'stopped' })
    expect(stop.kind === 'stopped' && stop.words).toContain('https://evil.example')
    expect(stop.kind === 'stopped' && stop.words).toContain(AUDIENCE)
    expect(arrive(hash(), 'not a url')).toMatchObject({ kind: 'stopped' })
  })

  it('stops a request that carries a key when the browser named no referrer, and warns on a plain one', () => {
    expect(arrive(KEYED, '')).toMatchObject({ kind: 'stopped' })
    const plain = arrive(hash(), '')
    expect(plain).toMatchObject({ kind: 'consent', warning: `Only continue if you just pressed Sign in on ${AUDIENCE}.`, exit: { answer: 'cancelled' } })
  })

  it('sends Cancel only to a return that passed every check, its arrival included', () => {
    const cancelled = arrive(hash('&state=abc'), AUDIENCE)
    expect(cancelled.kind === 'consent' && cancelled.exit.url).toBe(`${RETURN}#orivonid-error=cancelled&state=abc`)
    for (const stop of [arrive(hash(), 'https://evil.example/', false), arrive(hash(), AUDIENCE, true), arrive(KEYED, '')]) expect(stop.kind).toBe('stopped')
  })

  it('says a request that cannot be read in words, and goes back only when its return was sound and the person came from it', () => {
    const broken = `#/connect?v=1&return=${encodeURIComponent(RETURN)}&nonce=x`
    const fromSite = arrive(broken, AUDIENCE)
    expect(fromSite).toMatchObject({ kind: 'invalid', returnOrigin: AUDIENCE, note: null, exit: { answer: 'invalid-request', url: `${RETURN}#orivonid-error=invalid-request` } })
    expect(fromSite.kind === 'invalid' && fromSite.words).toContain('(nonce)')
    const fromElsewhere = arrive(broken, 'https://evil.example/')
    expect(fromElsewhere).toMatchObject({ kind: 'invalid', returnOrigin: AUDIENCE, exit: null })
    expect(fromElsewhere.kind === 'invalid' && fromElsewhere.note).toContain('cannot tell that you came from there')
    expect(arrive(broken, AUDIENCE, true)).toMatchObject({ kind: 'invalid', exit: null })
    expect(arrive(broken, '')).toMatchObject({ kind: 'invalid', exit: null })
  })

  it('offers no way back when the return itself is unsound', () => {
    for (const page of ['#/connect?v=1&return=http%3A%2F%2Fapp.example.org%2F&nonce=' + NONCE, '#/me', '#/connect?v=1&nonce=' + NONCE]) {
      expect(arrive(page, AUDIENCE)).toMatchObject({ kind: 'invalid', exit: null, returnOrigin: null, note: null })
    }
  })
})
