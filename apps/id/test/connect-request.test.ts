import { describe, expect, it } from 'vitest'
import {
  arrivalCancelUrl, buildSignInMessage, cancelUrl, ConnectError, lifetimeOptions, maxLifetime, parseRequest, signIn
} from '../site/connect-request.js'
import { fromHex } from '../site/sdk/bytes.js'
import { ChainError } from '../site/sdk/chain.js'
import { BRIDGE_PATH, decodeResponse } from '../site/sdk/protocol.js'
import { hashMessage, parseMessage } from '../site/sdk/siwe.js'
import { recoverAddress } from './support/secp256k1.ts'
import { testRequest } from './support/signin-flow.ts'
import { aliceWorld, NOW, ORIGIN, RESOLVER, signInChain, SIGNER } from './support/signin-world.ts'

const KEY = '0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978'
const NONCE = 'k3Jf92LmQp0xZ7aT'
const C = 'Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcDeF'

const hash = (params: Record<string, string>) => '#/connect?' + Object.entries(params).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')
const arrival = { v: '2', aud: ORIGIN }
const confirmation = { v: '2', c: C, nonce: NONCE }

function request (params: { state?: string, key?: string, ttl?: number } = {}) {
  return testRequest(params)
}

describe('reading the arrival', () => {
  it('takes a link that names the audience', () => {
    expect(parseRequest(hash(arrival))).toEqual({ ok: true, stage: 'arrival', audience: ORIGIN })
    expect(parseRequest(hash({ aud: ORIGIN, v: '2' }))).toMatchObject({ ok: true, stage: 'arrival' })
    expect(parseRequest(`#/connect?v=2&aud=${ORIGIN}`)).toMatchObject({ ok: true, audience: ORIGIN })
  })

  const refused: [string, string, string, string][] = [
    ['an empty fragment', '', 'notConnect', 'hash'],
    ['another route', '#/me', 'notConnect', 'hash'],
    ['a route with no query', '#/connect', 'notConnect', 'hash'],
    ['a fragment that begins with a query', '?v=2', 'notConnect', 'hash'],
    ['an empty query', '#/connect?', 'malformed', ''],
    ['a field with no value sign', '#/connect?v', 'malformed', 'v'],
    ['a field with no name', '#/connect?=1', 'malformed', '=1'],
    ['a bad percent escape', '#/connect?v=%zz', 'malformed', 'v'],
    ['a field twice', hash(arrival) + '&aud=' + encodeURIComponent(ORIGIN), 'duplicate', 'aud'],
    ['no version', hash({ aud: ORIGIN }), 'badVersion', 'v'],
    ['version 3', hash({ ...arrival, v: '3' }), 'badVersion', 'v'],
    ['a key beside the audience', hash({ ...arrival, delegate: KEY, ttl: '600' }), 'unknownField', 'delegate'],
    ['a nonce beside the audience', hash({ ...arrival, nonce: NONCE }), 'unknownField', 'nonce'],
    ['the old return address', hash({ ...arrival, return: `${ORIGIN}/callback` }), 'unknownField', 'return'],
    ['a field named like a prototype property', hash(arrival) + '&__proto__=x', 'unknownField', '__proto__'],
    ['a capital in a field name', hash(arrival) + '&Aud=x', 'unknownField', 'Aud'],
    ['no audience', hash({ v: '2' }), 'missingAudience', 'aud'],
    ['an http audience', hash({ ...arrival, aud: 'http://app.example.org' }), 'audienceNotHttps', 'aud'],
    ['an audience with a path', hash({ ...arrival, aud: `${ORIGIN}/callback` }), 'audienceNotOrigin', 'aud'],
    ['an audience with credentials', hash({ ...arrival, aud: 'https://a:b@app.example.org' }), 'audienceNotOrigin', 'aud'],
    ['an audience the statement could not name in full', hash({ ...arrival, aud: `https://${'a'.repeat(60)}.example.org` }), 'audienceTooLong', 'aud'],
    ['an audience that is not a URL', hash({ ...arrival, aud: 'back' }), 'audienceNotUrl', 'aud']
  ]
  it.each(refused)('refuses %s', (_name, fragment, reason, field) => {
    expect(parseRequest(fragment)).toEqual({ ok: false, reason, field, audience: null })
  })

  it('refuses anything that is not text', () => {
    expect(parseRequest(undefined as unknown as string)).toMatchObject({ ok: false, reason: 'notConnect' })
  })

  it('tells a link of version 1 from a damaged one, and names the site that sent it when its return names one', () => {
    const older = hash({ v: '1', return: `${ORIGIN}/callback`, nonce: NONCE, delegate: KEY, ttl: '3600' })
    expect(parseRequest(older)).toEqual({ ok: false, reason: 'olderVersion', field: 'v', audience: ORIGIN })
    expect(parseRequest(hash({ v: '1', nonce: NONCE }))).toEqual({ ok: false, reason: 'olderVersion', field: 'v', audience: null })
    for (const target of ['http://app.example.org/', 'back', `https://${'a'.repeat(70)}.example.org/`, `${ORIGIN}/${'a'.repeat(2100)}`]) {
      expect(parseRequest(hash({ v: '1', return: target, nonce: NONCE })), target).toEqual({ ok: false, reason: 'olderVersion', field: 'v', audience: null })
    }
  })
})

describe('reading the confirmation the bridge sends', () => {
  it('takes the nonce alone, with a state, and with a key and its ttl', () => {
    expect(parseRequest(hash(confirmation))).toEqual({ ok: true, stage: 'confirmation', c: C, fields: { nonce: NONCE, state: null, key: null, ttl: null } })
    expect(parseRequest(hash({ ...confirmation, state: 'abc', delegate: KEY, ttl: '86400' }))).toEqual({
      ok: true, stage: 'confirmation', c: C, fields: { nonce: NONCE, state: 'abc', key: KEY, ttl: 86_400 }
    })
  })

  it('takes the fields in any order', () => {
    expect(parseRequest(`#/connect?nonce=${NONCE}&c=${C}&v=2`)).toMatchObject({ ok: true, stage: 'confirmation', fields: { nonce: NONCE } })
  })

  it('takes "none" alone, as the bridge says no request was kept', () => {
    expect(parseRequest(hash({ v: '2', c: C, none: '1' }))).toEqual({ ok: true, stage: 'confirmation', c: C, fields: null })
  })

  const refused: [string, string, string, string][] = [
    ['a challenge that is too short', hash({ ...confirmation, c: C.slice(1) }), 'badChallenge', 'c'],
    ['a challenge with a symbol', hash({ ...confirmation, c: C.slice(1) + '-' }), 'badChallenge', 'c'],
    ['an audience in the confirmation', hash({ ...confirmation, aud: ORIGIN }), 'unknownField', 'aud'],
    ['a return in the confirmation', hash({ ...confirmation, return: ORIGIN }), 'unknownField', 'return'],
    ['"none" with a nonce', hash({ ...confirmation, none: '1' }), 'badNone', 'none'],
    ['"none" that is not 1', hash({ v: '2', c: C, none: '0' }), 'badNone', 'none'],
    ['no nonce', hash({ v: '2', c: C }), 'missingNonce', 'nonce'],
    ['a nonce of 15 characters', hash({ ...confirmation, nonce: 'abcdefghijklmno' }), 'badNonce', 'nonce'],
    ['a nonce with a symbol', hash({ ...confirmation, nonce: 'abcdefghijklmno!' }), 'badNonce', 'nonce'],
    ['a state that is too long', hash({ ...confirmation, state: 'a'.repeat(257) }), 'badState', 'state'],
    ['a key that is not 33 bytes', hash({ ...confirmation, delegate: '0x' + 'ab'.repeat(32), ttl: '600' }), 'badKey', 'delegate'],
    ['an uncompressed key', hash({ ...confirmation, delegate: '0x04' + 'ab'.repeat(64), ttl: '600' }), 'badKey', 'delegate'],
    ['a key off the curve', hash({ ...confirmation, delegate: '0x02' + '00'.repeat(31) + '01', ttl: '600' }), 'badKey', 'delegate'],
    ['a key and no ttl', hash({ ...confirmation, delegate: KEY }), 'missingTtl', 'ttl'],
    ['a ttl of 15552001', hash({ ...confirmation, delegate: KEY, ttl: '15552001' }), 'badTtl', 'ttl'],
    ['a ttl of 1 second', hash({ ...confirmation, delegate: KEY, ttl: '1' }), 'badTtl', 'ttl'],
    ['a ttl with no key', hash({ ...confirmation, ttl: '600' }), 'ttlWithoutKey', 'ttl'],
    ['a field twice', hash(confirmation) + '&nonce=' + NONCE, 'duplicate', 'nonce']
  ]
  it.each(refused)('refuses %s', (_name, fragment, reason, field) => {
    expect(parseRequest(fragment)).toEqual({ ok: false, reason, field, audience: null })
  })
})

describe('the lifetime', () => {
  it('is ten minutes without a key', () => {
    expect(maxLifetime(request())).toBe(600)
    expect(lifetimeOptions(request())).toEqual([600])
  })

  it('is at most the ttl with a key, offered in steps that stay below it', () => {
    const wide = request({ key: KEY, ttl: 15_552_000 })
    expect(maxLifetime(wide)).toBe(15_552_000)
    expect(lifetimeOptions(wide)).toEqual([3600, 86_400, 604_800, 2_592_000, 7_776_000, 15_552_000])
    expect(lifetimeOptions(request({ key: KEY, ttl: 86_400 }))).toEqual([3600, 86_400])
    expect(lifetimeOptions(request({ key: KEY, ttl: 90 }))).toEqual([90])
  })
})

describe('the message the person signs', () => {
  const asked = request({ key: KEY, ttl: 2_592_000 })
  const resolvers = { alice: RESOLVER, bob: RESOLVER, carol: RESOLVER, 'name-1': RESOLVER }

  it('has the usernames in order, whatever order they were ticked in, and the lifetime chosen', () => {
    const { message, labels, expiresAt } = buildSignInMessage({ request: asked, address: SIGNER, labels: ['carol', 'alice', 'bob'], resolvers, now: NOW, lifetime: 86_400 })
    expect(labels).toEqual(['alice', 'bob', 'carol'])
    expect(expiresAt).toBe(NOW + 86_400)
    const fields = parseMessage(message)
    expect(fields.domain).toBe('id.orivonstack.eth')
    expect(fields.uri).toBe(ORIGIN)
    expect(fields.nonce).toBe(NONCE)
    const bound = ['alice', 'bob', 'carol'].map((label) => `orivonid:name:${label}.v1.orivonid.eth#${RESOLVER.toLowerCase()}`)
    expect(fields.resources).toEqual(bound.concat(`orivonid:key:p256:${KEY}`))
  })

  it('lasts ten minutes without a key, whatever lifetime is passed', () => {
    const { expiresAt } = buildSignInMessage({ request: request(), address: SIGNER, labels: ['alice'], resolvers, now: NOW, lifetime: 9_999 })
    expect(expiresAt).toBe(NOW + 600)
  })

  const make = (labels: string[], extra: Partial<Parameters<typeof buildSignInMessage>[0]> = {}): Parameters<typeof buildSignInMessage>[0] =>
    ({ request: asked, address: SIGNER, labels, resolvers, now: NOW, lifetime: 600, ...extra })
  const bad: [string, Parameters<typeof buildSignInMessage>[0], string][] = [
    ['no usernames', make([]), 'names'],
    ['a username twice', make(['alice', 'alice']), 'names'],
    ['a label the registrar refuses', make(['-bad']), 'names'],
    ['seventeen usernames', make(Array.from({ length: 17 }, (_, i) => `name-${i}`)), 'names'],
    ['no lifetime with a key', make(['alice'], { lifetime: undefined as unknown as number }), 'lifetime'],
    ['a lifetime past the ttl', make(['alice'], { lifetime: 2_592_001 }), 'lifetime'],
    ['a lifetime under a minute', make(['alice'], { lifetime: 59 }), 'lifetime'],
    ['a lifetime that is not whole seconds', make(['alice'], { lifetime: 60.5 }), 'lifetime'],
    ['no resolvers at all', make(['alice'], { resolvers: undefined as unknown as Record<string, string> }), 'resolvers'],
    ['a username with no resolver', make(['alice', 'dave']), 'resolvers'],
    ['the zero address as a resolver', make(['alice'], { resolvers: { alice: '0x' + '00'.repeat(20) } }), 'resolvers'],
    ['a resolver that is not an address', make(['alice'], { resolvers: { alice: 'resolver.eth' } }), 'resolvers']
  ]
  it.each(bad)('is not built for %s', (_name, parts, reason) => {
    expect(() => buildSignInMessage(parts)).toThrow(ConnectError)
    try {
      buildSignInMessage(parts)
    } catch (error) {
      expect((error as ConnectError).reason).toBe(reason)
    }
  })
})

describe('signing', () => {
  it('signs once through the wallet, checks the signature is the address\'s, and builds the URL back', async () => {
    const env = signInChain()
    const asked = request({ state: 'st-1' })
    const { response, url } = await signIn({ request: asked, chain: env.chain, address: SIGNER, labels: ['alice'], now: NOW })
    expect(url.startsWith(`${ORIGIN}${BRIDGE_PATH}#orivonid=`)).toBe(true)
    expect(decodeResponse(url.split('#orivonid=')[1] as string)).toEqual(response)
    expect(response).toMatchObject({ v: 1, address: SIGNER, names: ['alice.v1.orivonid.eth'], state: 'st-1' })
    expect(recoverAddress(hashMessage(response.message), fromHex(response.signature))).toBe(SIGNER)
  })

  it('leaves the state out when the request had none', async () => {
    const { response } = await signIn({ request: request(), chain: signInChain().chain, address: SIGNER, labels: ['alice'], now: NOW })
    expect('state' in response).toBe(false)
  })

  it('does not sign when the wallet\'s address is not the one shown', async () => {
    const env = signInChain()
    env.wallet.address = '0x' + '11'.repeat(20)
    await expect(signIn({ request: request(), chain: env.chain, address: SIGNER, labels: ['alice'], now: NOW })).rejects.toMatchObject({ reason: 'wrongAccount' })
  })

  it('does not sign for a username the address no longer holds', async () => {
    const env = signInChain(aliceWorld(['alice', 'bob']))
    env.world.names['bob']!.owner = '0x' + '22'.repeat(20)
    await expect(signIn({ request: request(), chain: env.chain, address: SIGNER, labels: ['alice', 'bob'], now: NOW })).rejects.toMatchObject({ reason: 'notAttributed', detail: 'bob' })
  })

  it('does not hand back a signature the address did not make', async () => {
    const env = signInChain()
    const wallet = env.chain.signMessage
    env.chain.signMessage = async (message) => {
      const signature = await wallet(message)
      return signature.map((byte, index) => index === 10 ? byte ^ 1 : byte)
    }
    await expect(signIn({ request: request(), chain: env.chain, address: SIGNER, labels: ['alice'], now: NOW })).rejects.toMatchObject({ reason: 'wrongSigner' })
  })

  it('lets the wallet\'s refusal through unchanged', async () => {
    const env = signInChain()
    env.chain.signMessage = async () => { throw new ChainError('declined', 'no') }
    await expect(signIn({ request: request(), chain: env.chain, address: SIGNER, labels: ['alice'], now: NOW })).rejects.toMatchObject({ reason: 'declined' })
  })

  it('builds the URLs for a cancellation, at the bridge page: with the request\'s state, or before any request was read', () => {
    expect(cancelUrl(request({ state: 'st-1' }))).toBe(`${ORIGIN}${BRIDGE_PATH}#orivonid-error=cancelled&state=st-1`)
    expect(cancelUrl(request())).toBe(`${ORIGIN}${BRIDGE_PATH}#orivonid-error=cancelled`)
    expect(arrivalCancelUrl(ORIGIN)).toBe(`${ORIGIN}${BRIDGE_PATH}#orivonid-error=cancelled`)
  })
})
