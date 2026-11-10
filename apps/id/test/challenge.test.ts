// The challenge: 32 characters the ID site makes when the person presses Continue and keeps in that tab. A confirmation is read only
// when it carries that challenge, once, soon, and when the browser says the page before was the bridge page of the audience.

import { describe, expect, it } from 'vitest'
import { connectEntry, stopWords } from '../site/connect-model.js'
import { CHALLENGE_KEY, CHALLENGE_MAX_AGE, checkChallenge, startChallenge, takeChallenge } from '../site/connect-request.js'
import { bridgeUrl, ID_ORIGIN } from '../site/sdk/protocol.js'
import { memoryStore, seeded } from './support/signin-flow.ts'
import { NOW, ORIGIN } from './support/signin-world.ts'

const NONCE = 'k3Jf92LmQp0xZ7aT'

function tab () {
  const storage = memoryStore()
  const started = startChallenge({ storage, audience: ORIGIN, now: NOW, random: seeded(3) })
  if (started === null) throw new Error('no challenge')
  return { storage, ...started }
}

describe('making the challenge', () => {
  it('makes 32 letters and digits, keeps it with the audience and the time in the tab, and gives the bridge page to go to', () => {
    const { storage, c, url } = tab()
    expect(c).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(url).toBe(`${ORIGIN}/.well-known/orivon-id/bridge.html?c=${c}`)
    expect(JSON.parse(storage.getItem(CHALLENGE_KEY) ?? 'null')).toEqual({ c, aud: ORIGIN, at: NOW })
  })

  it('makes another each time, and keeps only the last: an earlier Continue is void', () => {
    const storage = memoryStore()
    const first = startChallenge({ storage, audience: ORIGIN, now: NOW, random: seeded(3) })
    const second = startChallenge({ storage, audience: 'https://other.example', now: NOW + 5, random: seeded(4) })
    expect(first?.c).not.toBe(second?.c)
    expect(takeChallenge(storage)).toEqual({ c: second?.c, aud: 'https://other.example', at: NOW + 5 })
  })

  it('draws from the browser\'s random source unless told', () => {
    const storage = memoryStore()
    const seen = new Set<string>()
    for (let index = 0; index < 10; index++) seen.add(startChallenge({ storage, audience: ORIGIN, now: NOW, random: (bytes) => globalThis.crypto.getRandomValues(bytes) })?.c ?? '')
    expect(seen.size).toBe(10)
  })

  it('makes none when the tab will not keep it, so nothing is sent anywhere', () => {
    expect(startChallenge({ storage: null, audience: ORIGIN, now: NOW, random: seeded(3) })).toBeNull()
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
    expect(startChallenge({ storage: broken, audience: ORIGIN, now: NOW, random: seeded(3) })).toBeNull()
  })
})

describe('taking the challenge', () => {
  it('hands it over once: the second look finds none', () => {
    const { storage, c } = tab()
    expect(takeChallenge(storage)).toEqual({ c, aud: ORIGIN, at: NOW })
    expect(storage.getItem(CHALLENGE_KEY)).toBeNull()
    expect(takeChallenge(storage)).toBeNull()
  })

  it('removes a damaged one too, and reads it as none', () => {
    const storage = memoryStore()
    for (const text of ['', '{', 'null', '[]', '{"c":"short","aud":"https://app.example.org","at":1}', JSON.stringify({ c: 'a'.repeat(32), aud: `${ORIGIN}/path`, at: NOW }), JSON.stringify({ c: 'a'.repeat(32), aud: ORIGIN, at: 'now' })]) {
      storage.setItem(CHALLENGE_KEY, text)
      expect(takeChallenge(storage), text).toBeNull()
      expect(storage.getItem(CHALLENGE_KEY), text).toBeNull()
    }
    expect(takeChallenge(null)).toBeNull()
  })
})

describe('checking a confirmation against it', () => {
  const check = (parts: { c?: string, stored?: ReturnType<typeof takeChallenge>, referrer?: unknown, now?: number }, made = tab()) => {
    const stored = parts.stored === undefined ? takeChallenge(made.storage) : parts.stored
    return checkChallenge({ c: parts.c ?? made.c, stored, referrer: parts.referrer ?? bridgeUrl(ORIGIN, made.c), now: parts.now ?? NOW + 10 })
  }

  it('passes when the challenge is this tab\'s, soon enough, and the referrer is the bridge URL byte for byte', () => {
    expect(check({})).toEqual({ ok: true, audience: ORIGIN })
    expect(check({ now: NOW + CHALLENGE_MAX_AGE })).toEqual({ ok: true, audience: ORIGIN })
  })

  it('refuses when this tab made none', () => {
    expect(check({ stored: null })).toEqual({ ok: false, reason: 'noChallenge', audience: null })
  })

  it('refuses a challenge older than 120 seconds, and one from the future', () => {
    expect(check({ now: NOW + CHALLENGE_MAX_AGE + 1 })).toEqual({ ok: false, reason: 'challengeExpired', audience: ORIGIN })
    expect(check({ now: NOW - 3600 })).toEqual({ ok: false, reason: 'challengeExpired', audience: ORIGIN })
  })

  it('refuses a challenge that is not the one stored', () => {
    expect(check({ c: 'A'.repeat(32) })).toEqual({ ok: false, reason: 'wrongChallenge', audience: ORIGIN })
    const made = tab()
    expect(check({ c: made.c.slice(0, 31) + (made.c.endsWith('a') ? 'b' : 'a') }, made)).toMatchObject({ ok: false, reason: 'wrongChallenge' })
  })

  it('checks the lifetime before the match, and the match before the referrer', () => {
    expect(check({ c: 'A'.repeat(32), referrer: '', now: NOW + 500 })).toMatchObject({ reason: 'challengeExpired' })
    expect(check({ c: 'A'.repeat(32), referrer: '' })).toMatchObject({ reason: 'wrongChallenge' })
  })

  const bridge = '/.well-known/orivon-id/bridge.html'
  const referrers: [string, (c: string) => unknown][] = [
    ['an empty referrer', () => ''],
    ['no referrer at all', () => undefined],
    ['the relying site\'s root', () => `${ORIGIN}/`],
    ['a page of the relying site that redirects by script', () => `${ORIGIN}/go.html?to=${ID_ORIGIN}`],
    ['the bridge URL with another challenge', () => bridgeUrl(ORIGIN, 'A'.repeat(32))],
    ['the bridge URL with an extra parameter', (c) => `${bridgeUrl(ORIGIN, c)}&x=1`],
    ['the bridge URL with a parameter before', (c) => `${ORIGIN}${bridge}?x=1&c=${c}`],
    ['the bridge URL with a fragment', (c) => `${bridgeUrl(ORIGIN, c)}#orivonid=x`],
    ['the bridge URL without its query', () => `${ORIGIN}${bridge}`],
    ['the bridge of another origin', (c) => bridgeUrl('https://evil.example', c)],
    ['the bridge of a look-alike origin', (c) => bridgeUrl(`${ORIGIN}.evil.example`, c)],
    ['the bridge over http', (c) => bridgeUrl('http://app.example.org', c)],
    ['a bridge path with another case', (c) => `${ORIGIN}/.well-known/orivon-id/Bridge.html?c=${c}`],
    ['something that is not text', () => 7]
  ]
  it.each(referrers)('refuses %s as the referrer', (_name, referrer) => {
    const one = tab()
    expect(checkChallenge({ c: one.c, stored: takeChallenge(one.storage), referrer: referrer(one.c), now: NOW + 10 }))
      .toEqual({ ok: false, reason: 'notFromBridge', audience: ORIGIN })
  })
})

describe('the order the ID site takes them in', () => {
  const hash = (c: string) => `#/connect?v=2&c=${c}&nonce=${NONCE}`
  const entryFor = (made: ReturnType<typeof tab>, parts: Partial<Parameters<typeof connectEntry>[0]> = {}) => connectEntry({
    hash: hash(made.c), referrer: bridgeUrl(ORIGIN, made.c), framed: false, now: NOW + 10, challenges: { take: () => takeChallenge(made.storage) }, ...parts
  })

  it('reads the confirmation when everything holds, and the audience is the one the challenge was made for', () => {
    const made = tab()
    expect(entryFor(made)).toMatchObject({ kind: 'consent', request: { origin: ORIGIN, nonce: NONCE, key: null }, exit: `${ORIGIN}/.well-known/orivon-id/bridge.html#orivonid-error=cancelled` })
  })

  it('uses the challenge once: the same confirmation, read again, is refused as having no challenge', () => {
    const made = tab()
    expect(entryFor(made).kind).toBe('consent')
    expect(entryFor(made)).toEqual({ kind: 'stopped', words: stopWords('noChallenge', null) })
    expect(made.storage.getItem(CHALLENGE_KEY)).toBeNull()
  })

  it.each([
    ['a challenge that does not match', (made: ReturnType<typeof tab>) => ({ hash: hash('A'.repeat(32)), referrer: bridgeUrl(ORIGIN, made.c) }), 'wrongChallenge'],
    ['a referrer that is not the bridge', (made: ReturnType<typeof tab>) => ({ referrer: `${ORIGIN}/` }), 'notFromBridge'],
    ['a challenge that expired', () => ({ now: NOW + CHALLENGE_MAX_AGE + 1 }), 'challengeExpired'],
    ['a bridge that found no request', (made: ReturnType<typeof tab>) => ({ hash: `#/connect?v=2&c=${made.c}&none=1` }), 'notStarted']
  ])('removes the challenge whatever the check decides: %s', (_name, parts, reason) => {
    const made = tab()
    expect(entryFor(made, parts(made))).toEqual({ kind: 'stopped', words: stopWords(reason as Parameters<typeof stopWords>[0], ORIGIN) })
    expect(made.storage.getItem(CHALLENGE_KEY)).toBeNull()
    expect(entryFor(made).kind).toBe('stopped')
  })

  it('refuses a frame before it reads the link, and leaves the challenge for the page that is not framed', () => {
    const made = tab()
    expect(entryFor(made, { framed: true })).toEqual({ kind: 'stopped', words: stopWords('framed', null) })
    expect(made.storage.getItem(CHALLENGE_KEY)).not.toBeNull()
    expect(entryFor(made, { framed: undefined as unknown as boolean }).kind).toBe('stopped')
  })

  it('does not touch the challenge for a link it cannot read, or for an arrival', () => {
    const made = tab()
    expect(entryFor(made, { hash: `#/connect?v=2&c=${made.c}&nonce=short` }).kind).toBe('invalid')
    expect(entryFor(made, { hash: `#/connect?v=2&aud=${encodeURIComponent(ORIGIN)}` }).kind).toBe('arrive')
    expect(made.storage.getItem(CHALLENGE_KEY)).not.toBeNull()
  })

  it('says in words what stopped it, naming the audience when the tab knows it', () => {
    expect(stopWords('notStarted', ORIGIN)).toBe(`No sign-in was started on ${ORIGIN} in this browser. Go to ${ORIGIN} and press Sign in there.`)
    expect(stopWords('notFromBridge', ORIGIN)).toContain('did not say that you came from the sign-in page')
    expect(stopWords('notFromBridge', ORIGIN)).toContain('works in Orivon and in Chromium-based browsers; a browser that trims the address it tells other sites stops it here')
    expect(stopWords('noChallenge', null)).toContain('No sign-in was started from this tab')
    expect(stopWords('challengeExpired', ORIGIN)).toContain('waited too long')
    expect(stopWords('wrongChallenge', ORIGIN)).toContain('not the sign-in this tab started')
    expect(stopWords('framed', null)).toContain('inside another page')
  })
})
