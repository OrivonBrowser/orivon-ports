import { describe, expect, it } from 'vitest'
import { CONNECT_REASONS, ConnectError, moveAdvice, retryOrMove } from '../site/connect-request.js'
import { connectEntry, consentView, lifetimeChoices, problemWords, PROBLEM_WORDS, signInFailure, stopWords, walletWarningWords } from '../site/connect-model.js'
import { ChainError } from '../site/sdk/chain.js'
import { REQUEST_PROBLEMS } from '../site/sdk/protocol.js'
import { RelayError } from '../site/relay.js'
import { formatTime } from '../site/words.js'
import { attribution, failing } from './support/attribution.ts'
import { testRequest } from './support/signin-flow.ts'

const KEY = '0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978'
const NONCE = 'k3Jf92LmQp0xZ7aT'
const NOW = 1_796_558_400

const request = () => testRequest({ nonce: NONCE })
const withKey = (ttl: number) => testRequest({ nonce: NONCE, key: KEY, ttl })
const held = (label: string) => ({ label, attribution: attribution({}, label) })
const notHeld = (label: string) => ({ label, attribution: failing({ records: { ok: false, resolver: '0x' + '4b'.repeat(20), problem: 'textRoleMissing' } }, label) })
const names = [held('alice'), held('bob-1'), notHeld('carol')]

describe('the words for a request that cannot be used', () => {
  it('has words for every problem a request can have', () => {
    const named = ['notConnect', 'malformed', 'duplicate', 'unknownField', 'badVersion', 'olderVersion', 'badChallenge', 'badNone', ...REQUEST_PROBLEMS]
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

describe('what a link is, decided before anything is drawn', () => {
  const AUDIENCE = 'https://app.example.org'
  const C = 'Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcDeF'
  const hash = (extra = '') => `#/connect?v=2&c=${C}&nonce=${NONCE}${extra}`
  const challenge = (parts: { c?: string, aud?: string, at?: number } = {}) => ({ c: parts.c ?? C, aud: parts.aud ?? AUDIENCE, at: parts.at ?? NOW })
  const enter = (page: string, parts: { referrer?: string, framed?: boolean, stored?: ReturnType<typeof challenge> | null, now?: number } = {}) => connectEntry({
    hash: page, referrer: parts.referrer ?? `${AUDIENCE}/.well-known/orivon-id/bridge.html?c=${C}`, framed: parts.framed ?? false, now: parts.now ?? NOW + 5,
    challenges: { take: () => parts.stored === undefined ? challenge() : parts.stored }
  })

  it('shows the Continue screen for a link that names a site, and goes nowhere on its own', () => {
    expect(enter(`#/connect?v=2&aud=${encodeURIComponent(AUDIENCE)}`, { referrer: '' })).toEqual({
      kind: 'arrive', audience: AUDIENCE, exit: `${AUDIENCE}/.well-known/orivon-id/bridge.html#orivonid-error=cancelled`
    })
  })

  it('shows the consent for a person who came back through the bridge of the site, with the audience the challenge was made for and no warning', () => {
    const shown = enter(hash(`&delegate=${KEY}&ttl=600&state=abc`))
    expect(shown).toEqual({
      kind: 'consent', request: { origin: AUDIENCE, nonce: NONCE, state: 'abc', key: KEY, ttl: 600 },
      exit: `${AUDIENCE}/.well-known/orivon-id/bridge.html#orivonid-error=cancelled&state=abc`
    })
    expect(shown).not.toHaveProperty('warning')
    expect(shown).not.toHaveProperty('returnShown')
  })

  it('stops a page in a frame, whatever else holds, and offers no way back to the site', () => {
    for (const page of [hash(), `#/connect?v=2&aud=${encodeURIComponent(AUDIENCE)}`, '#/connect?v=1']) {
      const stop = enter(page, { framed: true })
      expect(stop).toEqual({ kind: 'stopped', words: 'This page cannot be used inside another page. Open it in its own tab.' })
    }
  })

  it('stops a person who did not come through the bridge of the site, and says what to do', () => {
    expect(enter(hash(), { referrer: 'https://evil.example/page' })).toEqual({ kind: 'stopped', words: stopWords('notFromBridge', AUDIENCE) })
    expect(enter(hash(), { stored: null })).toEqual({ kind: 'stopped', words: stopWords('noChallenge', null) })
    expect(enter(hash(), { stored: challenge({ at: NOW - 500 }) })).toEqual({ kind: 'stopped', words: stopWords('challengeExpired', AUDIENCE) })
    expect(enter(hash(), { stored: challenge({ c: 'B'.repeat(32) }) })).toEqual({ kind: 'stopped', words: stopWords('wrongChallenge', AUDIENCE) })
  })

  it('says when the bridge found no request, in the words the site is asked in', () => {
    const none = enter(`#/connect?v=2&c=${C}&none=1`)
    expect(none).toEqual({ kind: 'stopped', words: `No sign-in was started on ${AUDIENCE} in this browser. Go to ${AUDIENCE} and press Sign in there.` })
  })

  it('refuses a link of the older version in words that name the site that sent it, and goes nowhere', () => {
    const older = enter(`#/connect?v=1&return=${encodeURIComponent(`${AUDIENCE}/callback`)}&nonce=${NONCE}&delegate=${KEY}&ttl=600`, { referrer: '' })
    expect(older).toEqual({ kind: 'invalid', words: `This site uses an older sign-in; ask ${AUDIENCE} to update.` })
    expect(enter('#/connect?v=1&nonce=' + NONCE)).toEqual({ kind: 'invalid', words: 'This site uses an older sign-in; ask the site that sent you here to update.' })
  })

  it('says a link that cannot be read in words, and offers no way back', () => {
    const broken = enter(`#/connect?v=2&c=${C}&nonce=x`)
    expect(broken.kind).toBe('invalid')
    expect(broken.kind === 'invalid' && broken.words).toContain('(nonce)')
    expect(broken).not.toHaveProperty('exit')
    for (const page of ['#/me', '#/connect?v=3', `#/connect?v=2&aud=${encodeURIComponent(AUDIENCE + '/callback')}`]) expect(enter(page).kind, page).toBe('invalid')
  })
})
