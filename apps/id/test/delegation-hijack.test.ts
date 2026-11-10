// The delegation hijack: a request can name any P-256 key, and nothing in it says whose key it is or who put the link in
// front of the person. An open redirect at the relying site's `return` path (a 3xx keeps a fragment) then carries the
// signed answer to the attacker, who holds a sign-in that delegates the person's usernames to the attacker's own key.
// The ID site now asks the browser how the person arrived, names the delegation first in a short statement, and shows
// the whole `return` address. Each test keeps the scenario of the attack and asserts it stops.

import { describe, expect, it } from 'vitest'
import { arrivalWords, checkArrival, exitTarget, parseRequest, returnDisplay, signIn } from '../site/connect-request.js'
import { requestSignIn } from '../site/sdk/connect.js'
import { appKey } from '../site/sdk/key.js'
import { parseMessage } from '../site/sdk/siwe.js'
import { fakeId } from './support/fake-id.ts'
import { memoryStore } from './support/signin-flow.ts'
import { NOW, ORIGIN, SIGNER, signInChain } from './support/signin-world.ts'

const DAY = 86_400
const EVIL = 'https://evil.example'

/** What the consent page does with a link: the browser's answers go to `checkArrival`, and only an arrival that passes can sign. */
async function consent (link: string, arriving: { referrer: string, framed: boolean }) {
  const parsed = parseRequest(new URL(link).hash)
  if (!parsed.ok) throw new Error(parsed.reason)
  const arrival = checkArrival({ request: parsed.request, ...arriving })
  const victim = signInChain()
  const signed = arrival.ok
    ? await signIn({ request: parsed.request, chain: victim.chain, address: SIGNER, labels: ['alice'], now: NOW, lifetime: 180 * DAY })
    : null
  return { parsed, arrival, signed, exit: exitTarget(parsed, arriving) }
}

describe('H1: a delegation to the attacker\'s key, started on the real audience through an open redirect at its return path', () => {
  async function attackLink () {
    const attacker = await appKey({ id: (await fakeId()).id }, { origin: ORIGIN })
    const link = requestSignIn({ returnUrl: `${ORIGIN}/out?to=${EVIL}/catch`, delegateKey: attacker.publicKey, ttl: 180 * DAY }, { storage: memoryStore(), now: NOW })
    return { attacker, link }
  }

  it('stops at the ID site when the victim comes from the attacker\'s page: the referrer is another origin than the audience', async () => {
    const { attacker, link } = await attackLink()
    const seen = await consent(link, { referrer: `${EVIL}/free-tokens?x=1`, framed: false })
    expect(seen.parsed.ok && seen.parsed.request.key).toBe(attacker.hex)
    expect(seen.arrival).toEqual({ ok: false, reason: 'wrongOrigin', audience: ORIGIN, seen: EVIL })
    expect(seen.signed).toBeNull()
    expect(seen.exit).toBeNull()
    expect(arrivalWords(seen.arrival)).toBe(`You came from ${EVIL}, not from ${ORIGIN}. Go back to ${ORIGIN} and press Sign in there.`)
  })

  it('stops when the link comes with no referrer (a mail, a chat, a page that strips it) and carries a key: nobody can say who sent the person', async () => {
    const { link } = await attackLink()
    const seen = await consent(link, { referrer: '', framed: false })
    expect(seen.arrival).toEqual({ ok: false, reason: 'unknownOrigin', audience: ORIGIN, seen: null })
    expect(seen.signed).toBeNull()
    expect(seen.exit).toBeNull()
  })

  it('stops when the attacker frames the consent page, whatever the referrer says', async () => {
    const { link } = await attackLink()
    for (const referrer of ['', `${ORIGIN}/`, `${EVIL}/`]) {
      const seen = await consent(link, { referrer, framed: true })
      expect(seen.arrival, referrer).toMatchObject({ ok: false, reason: 'framed' })
      expect(seen.signed).toBeNull()
      expect(seen.exit).toBeNull()
    }
  })

  it('lets through only the person who really pressed Sign in on the audience, and then the statement names the delegation first', async () => {
    const { link } = await attackLink()
    const seen = await consent(link, { referrer: `${ORIGIN}/login`, framed: false })
    expect(seen.arrival).toEqual({ ok: true, unverified: false, audience: ORIGIN })
    expect(arrivalWords(seen.arrival)).toBeNull()
    const statement = parseMessage(seen.signed?.response.message ?? '').statement ?? ''
    expect(statement.length).toBeLessThanOrEqual(140)
    expect(statement.startsWith(`Let ${ORIGIN} act as you, with its own key`)).toBe(true)
  })

  it('shows the whole return address, since a redirect hides behind its path', async () => {
    const { link } = await attackLink()
    const seen = await consent(link, { referrer: `${ORIGIN}/x`, framed: false })
    if (!seen.parsed.ok) throw new Error('refused')
    expect(returnDisplay(seen.parsed.request)).toMatchObject({ origin: ORIGIN, full: `${ORIGIN}/out?to=${EVIL}/catch` })
  })
})

describe('H1: a key request written by hand, with a nonce no relying-site session ever made', () => {
  const hash = (key: string) => `https://id.orivonstack.eth/#/connect?v=1&return=${encodeURIComponent(`${ORIGIN}/`)}&nonce=AttackerChoseThisNonce1&delegate=${key}&ttl=${180 * DAY}`

  it('cannot reach a signature: with no referrer the ID site refuses a key, and from another page it refuses any request', async () => {
    const attacker = await appKey({ id: (await fakeId()).id }, { origin: ORIGIN })
    expect((await consent(hash(attacker.hex), { referrer: '', framed: false })).signed).toBeNull()
    expect((await consent(hash(attacker.hex), { referrer: `${EVIL}/`, framed: false })).signed).toBeNull()
  })
})

describe('checking how the person arrived', () => {
  const plain = { origin: ORIGIN, key: null }
  const keyed = { origin: ORIGIN, key: '0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978' }
  const at = (request: { origin: string, key: string | null }, referrer: string, framed = false) => checkArrival({ request, referrer, framed })

  it('takes a referrer whose origin is the audience, whatever its path, query or capitalisation', () => {
    for (const referrer of [`${ORIGIN}/`, `${ORIGIN}/deep/path?a=1#frag`, 'HTTPS://APP.EXAMPLE.ORG/x']) {
      expect(at(plain, referrer), referrer).toMatchObject({ ok: true, unverified: false })
      expect(at(keyed, referrer), referrer).toMatchObject({ ok: true, unverified: false })
    }
  })

  it('refuses a referrer that is any other origin: another host, a parent or child host, a port, a scheme, a look-alike', () => {
    for (const referrer of [
      'https://other.example.net/', 'https://example.org/', 'https://sub.app.example.org/', 'https://app.example.org.evil.example/',
      'https://app.example.org:8443/', 'http://app.example.org/', 'https://app.example.org@evil.example/', 'null', 'not a url', 'data:text/html,x', 'file:///x'
    ]) {
      expect(at(plain, referrer), referrer).toMatchObject({ ok: false, reason: 'wrongOrigin' })
      expect(at(keyed, referrer), referrer).toMatchObject({ ok: false, reason: 'wrongOrigin' })
    }
  })

  it('lets a plain sign-in go on with no referrer, with the warning the screen shows, and refuses a key', () => {
    expect(at(plain, '')).toEqual({ ok: true, unverified: true, audience: ORIGIN })
    expect(arrivalWords(at(plain, ''))).toBe(`Only continue if you just pressed Sign in on ${ORIGIN}.`)
    expect(at(keyed, '')).toMatchObject({ ok: false, reason: 'unknownOrigin' })
    expect(at(plain, undefined as unknown as string)).toMatchObject({ ok: true, unverified: true })
    expect(at(keyed, undefined as unknown as string)).toMatchObject({ ok: false, reason: 'unknownOrigin' })
  })

  it('refuses a frame first, and anything but an explicit "not framed" counts as framed', () => {
    expect(at(plain, `${ORIGIN}/`, true)).toMatchObject({ ok: false, reason: 'framed' })
    expect(at(plain, '', true)).toMatchObject({ ok: false, reason: 'framed' })
    expect(checkArrival({ request: plain, referrer: `${ORIGIN}/`, framed: undefined as unknown as boolean })).toMatchObject({ ok: false, reason: 'framed' })
  })

  it('words each stop', () => {
    expect(arrivalWords(at(plain, '', true))).toContain('inside another page')
    expect(arrivalWords(at(keyed, ''))).toContain(`lets ${ORIGIN} act for you`)
    expect(arrivalWords(at(plain, 'not a url'))).toContain('You came from another page')
  })
})

describe('where Cancel and "tell the site" may go', () => {
  const RETURN = `${ORIGIN}/callback`
  const hash = (extra: string, ret = RETURN) => `#/connect?v=1&return=${encodeURIComponent(ret)}&nonce=k3Jf92LmQp0xZ7aT${extra}`
  const KEY = '0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978'
  const same = { referrer: `${ORIGIN}/login`, framed: false }

  it('cancels to a return that passed every check and whose arrival passed', () => {
    expect(exitTarget(parseRequest(hash('&state=s1')), same)).toEqual({ answer: 'cancelled', url: `${RETURN}#orivonid-error=cancelled&state=s1` })
    expect(exitTarget(parseRequest(hash('')), { referrer: '', framed: false })).toMatchObject({ answer: 'cancelled' })
  })

  it('goes nowhere when the arrival failed', () => {
    const keyed = parseRequest(hash(`&delegate=${KEY}&ttl=3600`))
    expect(exitTarget(keyed, { referrer: '', framed: false })).toBeNull()
    expect(exitTarget(keyed, { referrer: `${EVIL}/`, framed: false })).toBeNull()
    expect(exitTarget(keyed, { ...same, framed: true })).toBeNull()
  })

  it('answers invalid-request only to a return that was sound by itself and arrived as it should, a key being assumed', () => {
    const broken = parseRequest(hash('&nonce=again'))
    expect(broken).toMatchObject({ ok: false, reason: 'duplicate', returnUrl: RETURN })
    expect(exitTarget(broken, same)).toEqual({ answer: 'invalid-request', url: `${RETURN}#orivonid-error=invalid-request` })
    expect(exitTarget(broken, { referrer: '', framed: false })).toBeNull()
    expect(exitTarget(broken, { referrer: `${EVIL}/`, framed: false })).toBeNull()
    expect(exitTarget(broken, { ...same, framed: true })).toBeNull()
  })

  it('answers nothing to a return that failed a check, or to something that is not a request', () => {
    for (const ret of ['http://app.example.org/', 'https://app.example.org/#x', 'https://a:b@app.example.org/', 'back', `https://${'a'.repeat(60)}.example.org/`]) {
      const parsed = parseRequest(hash('', ret))
      expect(parsed.ok, ret).toBe(false)
      expect(exitTarget(parsed, same), ret).toBeNull()
    }
    expect(exitTarget(parseRequest('#/me'), same)).toBeNull()
  })
})

describe('showing the return address', () => {
  const display = (ret: string) => {
    const parsed = parseRequest(`#/connect?v=1&return=${encodeURIComponent(ret)}&nonce=k3Jf92LmQp0xZ7aT`)
    if (!parsed.ok) throw new Error(parsed.reason)
    return returnDisplay(parsed.request)
  }

  it('leaves it out for the root of the audience, and shows it in full for any path or query', () => {
    expect(display(`${ORIGIN}/`)).toEqual({ origin: ORIGIN, full: null, words: null })
    expect(display(ORIGIN)).toMatchObject({ full: null })
    expect(display(`${ORIGIN}/callback`)).toMatchObject({ origin: ORIGIN, full: `${ORIGIN}/callback` })
    expect(display(`${ORIGIN}/logout?next=${EVIL}/`)).toMatchObject({ full: `${ORIGIN}/logout?next=${EVIL}/` })
    expect(display(`${ORIGIN}/?next=${EVIL}/`)).toMatchObject({ full: `${ORIGIN}/?next=${EVIL}/` })
    expect(display(`${ORIGIN}/callback`).words).toContain('exact address')
  })
})
