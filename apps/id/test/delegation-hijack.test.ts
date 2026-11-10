// The delegation hijack (H1). In version 1 a link could name any P-256 key, and nothing in it said whose key it was or who put the
// link in front of the person; an open redirect at the relying site then carried the signed answer to the attacker, who held a
// sign-in delegating the person's usernames to the attacker's own key. In version 2 the request is read back from the relying
// site's own page by its own bridge, so a link carries the audience and nothing else. Each test keeps the scenario of the attack
// and asserts that it stops, at the step that stops it.

import { describe, expect, it } from 'vitest'
import { connectEntry, stopWords } from '../site/connect-model.js'
import { parseRequest, signIn, startChallenge, takeChallenge } from '../site/connect-request.js'
import { runBridge } from '../site/sdk/bridge.js'
import { completeSignIn, takeAnswer } from '../site/sdk/connect.js'
import { PENDING_KEY } from '../site/sdk/pending.js'
import { bridgeUrl, encodeResponse, ID_ORIGIN } from '../site/sdk/protocol.js'
import { appKey } from '../site/sdk/key.js'
import { fakeId } from './support/fake-id.ts'
import { memoryStore, requestOn, runFlow, seeded } from './support/signin-flow.ts'
import { NOW, ORIGIN, SIGNER, signInChain } from './support/signin-world.ts'

const DAY = 86_400
const EVIL = 'https://evil.example'
const GUESS = 'Gu3ssedChallenge0000000000000000'

/** The person's browser: the relying site's storage, the ID site's tab, and the pages that read them. */
function browser () {
  const site = memoryStore()
  const tab = memoryStore()
  const bridge = (location: { search?: string, hash?: string }, referrer: string, now = NOW) => {
    const replaced: string[] = []
    const result = runBridge({
      location: { origin: ORIGIN, search: location.search ?? '', hash: location.hash ?? '' }, referrer, framed: false, storage: site,
      replace: (url) => { replaced.push(url) }, clearHash: () => {}, broadcast: () => {}, now
    })
    return { ...result, replaced }
  }
  const idPage = (hash: string, referrer: string, now = NOW) => connectEntry({ hash, referrer, framed: false, now, challenges: { take: () => takeChallenge(tab) } })
  return { site, tab, bridge, idPage }
}

/** What the person would sign after a link, if anything: nothing unless the ID page reached consent. */
async function signedAfter (entry: ReturnType<ReturnType<typeof browser>['idPage']>) {
  if (entry.kind !== 'consent') return null
  const victim = signInChain()
  return await signIn({ request: entry.request, chain: victim.chain, address: SIGNER, labels: ['alice'], now: NOW, ...(entry.request.key === null ? {} : { lifetime: 180 * DAY }) })
}

describe('H1: a delegation to the attacker\'s key, through a link that names it', () => {
  const attackerKey = async () => (await appKey({ id: (await fakeId()).id }, { origin: ORIGIN })).hex

  it('cannot be written: a link that names a key beside the audience is refused, from any page', async () => {
    const key = await attackerKey()
    const link = `#/connect?v=2&aud=${encodeURIComponent(ORIGIN)}&delegate=${key}&ttl=${180 * DAY}&nonce=AttackerChoseThisNonce1`
    expect(parseRequest(link)).toMatchObject({ ok: false, reason: 'unknownField' })
    for (const referrer of ['', `${ORIGIN}/`, `${ORIGIN}/go.html?to=${ID_ORIGIN}`, `${EVIL}/free-tokens`]) {
      const { idPage } = browser()
      expect(idPage(link, referrer).kind, referrer).toBe('invalid')
    }
  })

  it('reaches a bridge with no request of the person\'s: an arrival link the attacker delivers, even through a script redirect on the relying site, signs nothing', async () => {
    const person = browser()
    const arrival = `#/connect?v=2&aud=${encodeURIComponent(ORIGIN)}`
    // The attacker's page sends the person to the relying site's go.html, which redirects by script to the ID site: the referrer is the relying site's root.
    expect(person.idPage(arrival, `${ORIGIN}/`).kind).toBe('arrive')
    const started = startChallenge({ storage: person.tab, audience: ORIGIN, now: NOW, random: seeded(5) })
    if (started === null) throw new Error('no challenge')
    const forwarded = person.bridge({ search: new URL(started.url).search }, `${ID_ORIGIN}/`)
    expect(forwarded.outcome).toBe('forwardedNone')
    const back = person.idPage(new URL(forwarded.url ?? '').hash, bridgeUrl(ORIGIN, started.c))
    expect(back).toEqual({ kind: 'stopped', words: stopWords('notStarted', ORIGIN) })
    expect(await signedAfter(back)).toBeNull()
  })

  it('cannot make the relying site\'s bridge forward the attacker\'s key, whatever the link to the bridge holds', async () => {
    const person = browser()
    const forwarded = person.bridge({ search: `?c=${GUESS}&delegate=${await attackerKey()}&ttl=600&nonce=AttackerChoseThisNonce1` }, `${ID_ORIGIN}/`)
    expect(forwarded.outcome).toBe('badLink')
    expect(forwarded.replaced).toEqual([])
  })

  it('delegates to the person\'s own key when they really pressed Sign in, whoever delivers the arrival link', async () => {
    const person = browser()
    const mine = await fakeId()
    const own = (await appKey({ id: mine.id }, { origin: ORIGIN })).hex
    await requestOn(person.site, { delegate: true, ttl: 180 * DAY, after: '/signed-in' }, { orivon: { id: mine.id }, origin: ORIGIN, now: NOW })
    expect(person.idPage(`#/connect?v=2&aud=${encodeURIComponent(ORIGIN)}`, `${EVIL}/send-them-here`).kind).toBe('arrive')
    const started = startChallenge({ storage: person.tab, audience: ORIGIN, now: NOW, random: seeded(5) })
    if (started === null) throw new Error('no challenge')
    const forwarded = person.bridge({ search: new URL(started.url).search }, `${ID_ORIGIN}/`)
    const back = person.idPage(new URL(forwarded.url ?? '').hash, bridgeUrl(ORIGIN, started.c))
    expect(back.kind).toBe('consent')
    expect(back.kind === 'consent' && back.request.key).toBe(own)
    const signed = await signedAfter(back)
    expect(signed?.response.message).toContain(`orivonid:key:p256:${own}`)
  })
})

describe('H1: a confirmation written by hand, delivered directly or through a script redirect on the relying site', () => {
  const forged = async (c: string) => {
    const key = (await appKey({ id: (await fakeId()).id }, { origin: ORIGIN })).hex
    return `#/connect?v=2&c=${c}&nonce=AttackerChoseThisNonce1&delegate=${key}&ttl=${180 * DAY}`
  }

  it('is refused when the person has started nothing: there is no challenge to guess', async () => {
    for (const referrer of ['', `${EVIL}/`, `${ORIGIN}/`, bridgeUrl(ORIGIN, GUESS)]) {
      const { idPage } = browser()
      const entry = idPage(await forged(GUESS), referrer)
      expect(entry, referrer).toEqual({ kind: 'stopped', words: stopWords('noChallenge', null) })
      expect(await signedAfter(entry)).toBeNull()
    }
  })

  it('is refused with a challenge that is guessed, even when the referrer is exactly the bridge URL of the guess', async () => {
    const person = browser()
    const started = startChallenge({ storage: person.tab, audience: ORIGIN, now: NOW, random: seeded(5) })
    if (started === null) throw new Error('no challenge')
    const entry = person.idPage(await forged(GUESS), bridgeUrl(ORIGIN, GUESS))
    expect(entry).toEqual({ kind: 'stopped', words: stopWords('wrongChallenge', ORIGIN) })
    expect(await signedAfter(entry)).toBeNull()
  })

  it('is refused with the real challenge when the referrer is the relying site\'s root, which is what a script redirect on it sends', async () => {
    for (const referrer of [`${ORIGIN}/`, `${ORIGIN}/go.html?to=${encodeURIComponent(ID_ORIGIN)}`, '']) {
      const person = browser()
      const started = startChallenge({ storage: person.tab, audience: ORIGIN, now: NOW, random: seeded(5) })
      if (started === null) throw new Error('no challenge')
      const entry = person.idPage(await forged(started.c), referrer)
      expect(entry, referrer).toEqual({ kind: 'stopped', words: stopWords('notFromBridge', ORIGIN) })
      expect(await signedAfter(entry)).toBeNull()
    }
  })

  it('is refused when it is the person\'s own confirmation presented a second time', async () => {
    const person = browser()
    await requestOn(person.site, {}, { origin: ORIGIN, now: NOW })
    const started = startChallenge({ storage: person.tab, audience: ORIGIN, now: NOW, random: seeded(5) })
    if (started === null) throw new Error('no challenge')
    const forwarded = person.bridge({ search: new URL(started.url).search }, `${ID_ORIGIN}/`)
    const hash = new URL(forwarded.url ?? '').hash
    expect(person.idPage(hash, bridgeUrl(ORIGIN, started.c)).kind).toBe('consent')
    expect(person.idPage(hash, bridgeUrl(ORIGIN, started.c))).toEqual({ kind: 'stopped', words: stopWords('noChallenge', null) })
  })
})

describe('H1: the signed answer carried off the relying site', () => {
  it('is dropped by the bridge of another browser: the attacker\'s own request has another nonce', async () => {
    const victim = await runFlow({ chain: signInChain().chain, withKey: true })
    const attacker = browser()
    await requestOn(attacker.site, { delegate: true, ttl: 180 * DAY }, { orivon: { id: (await fakeId()).id }, origin: ORIGIN, now: NOW })
    const landed = attacker.bridge({ hash: `#orivonid=${encodeResponse(victim.response)}` }, `${ID_ORIGIN}/`)
    expect(landed.outcome).toBe('wrongNonce')
    expect(takeAnswer({ storage: attacker.site, now: NOW })).toBeNull()
  })

  it('finds no request to complete in a browser that asked for none, and refuses it in one that asked for something else', async () => {
    const env = signInChain()
    const victim = await runFlow({ chain: env.chain, withKey: true })
    expect(await completeSignIn(victim.response, { chain: env.chain, now: NOW + 5, storage: memoryStore() })).toEqual({ ok: false, failure: 'noPendingRequest' })
    const attacker = memoryStore()
    await requestOn(attacker, { delegate: true, ttl: 180 * DAY }, { orivon: { id: (await fakeId()).id }, origin: ORIGIN, now: NOW })
    expect(attacker.getItem(PENDING_KEY)).not.toBeNull()
    expect(await completeSignIn(victim.response, { chain: env.chain, now: NOW + 5, storage: attacker })).toMatchObject({ ok: false, failure: 'wrongNonce' })
  })

  it('names the key of the person at that site, which signs only in the person\'s browser', async () => {
    const env = signInChain()
    const victim = await runFlow({ chain: env.chain, withKey: true })
    expect(await completeSignIn(victim.response, { chain: env.chain, now: NOW + 5, storage: victim.storage })).toMatchObject({ ok: true, key: victim.key.hex })
  })
})
