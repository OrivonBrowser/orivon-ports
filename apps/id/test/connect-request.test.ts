import { describe, expect, it } from 'vitest'
import {
  arrivalWords, buildSignInMessage, cancelUrl, checkArrival, ConnectError, exitTarget, invalidRequestUrl, lifetimeOptions, maxLifetime, parseRequest,
  returnDisplay, signIn
} from '../site/connect-request.js'
import { fromHex } from '../site/sdk/bytes.js'
import { ChainError } from '../site/sdk/chain.js'
import { decodeResponse } from '../site/sdk/protocol.js'
import { hashMessage, parseMessage } from '../site/sdk/siwe.js'
import { recoverAddress } from './support/secp256k1.ts'
import { aliceWorld, NOW, ORIGIN, RESOLVER, signInChain, SIGNER } from './support/signin-world.ts'

const KEY = '0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978'
const NONCE = 'k3Jf92LmQp0xZ7aT'
const RETURN = `${ORIGIN}/callback`

const hash = (params: Record<string, string>) => '#/connect?' + Object.entries(params).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')
const good = { v: '1', return: RETURN, nonce: NONCE }

function request (params: Record<string, string> = {}) {
  const parsed = parseRequest(hash({ ...good, ...params }))
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.request
}

describe('reading a request out of the fragment', () => {
  it('takes a request with a key, with its state and ttl', () => {
    expect(parseRequest(hash({ ...good, state: 'abc', delegate: KEY, ttl: '86400' }))).toEqual({
      ok: true, request: { returnUrl: RETURN, origin: ORIGIN, nonce: NONCE, state: 'abc', key: KEY, ttl: 86_400 }
    })
  })

  it('takes the fields in any order', () => {
    const shuffled = `#/connect?nonce=${NONCE}&return=${encodeURIComponent(RETURN)}&v=1`
    expect(parseRequest(shuffled)).toMatchObject({ ok: true, request: { nonce: NONCE } })
  })

  const refused: [string, string, string, string, boolean][] = [
    ['an empty fragment', '', 'notConnect', 'hash', false],
    ['another route', '#/me', 'notConnect', 'hash', false],
    ['a route with no query', '#/connect', 'notConnect', 'hash', false],
    ['a fragment that begins with a query', '?v=1', 'notConnect', 'hash', false],
    ['an empty query', '#/connect?', 'malformed', '', false],
    ['a field with no value sign', '#/connect?v', 'malformed', 'v', false],
    ['a field with no name', '#/connect?=1', 'malformed', '=1', false],
    ['a bad percent escape', '#/connect?v=%zz', 'malformed', 'v', false],
    ['a field twice', hash(good) + '&nonce=' + NONCE, 'duplicate', 'nonce', true],
    ['a field v1 does not have', hash(good) + '&scope=all', 'unknownField', 'scope', true],
    ['a field named like a prototype property', hash(good) + '&__proto__=x', 'unknownField', '__proto__', true],
    ['a capital in a field name', hash(good) + '&State=x', 'unknownField', 'State', true],
    ['version 2', hash({ ...good, v: '2' }), 'badVersion', 'v', true],
    ['an http return', hash({ ...good, return: 'http://app.example.org/' }), 'returnNotHttps', 'return', false],
    ['a fragment in the return', hash({ ...good, return: 'https://app.example.org/#/x' }), 'returnHasFragment', 'return', false],
    ['credentials in the return', hash({ ...good, return: 'https://a:b@app.example.org/' }), 'returnHasCredentials', 'return', false],
    ['an audience the statement could not name in full', hash({ ...good, return: `https://${'a'.repeat(60)}.example.org/` }), 'audienceTooLong', 'return', false],
    ['a return that is not a URL', hash({ ...good, return: 'back' }), 'returnNotUrl', 'return', false],
    ['a nonce of 15 characters', hash({ ...good, nonce: 'abcdefghijklmno' }), 'badNonce', 'nonce', true],
    ['a nonce with a symbol', hash({ ...good, nonce: 'abcdefghijklmno!' }), 'badNonce', 'nonce', true],
    ['a state that is too long', hash({ ...good, state: 'a'.repeat(257) }), 'badState', 'state', true],
    ['a key that is not 33 bytes', hash({ ...good, delegate: '0x' + 'ab'.repeat(32), ttl: '600' }), 'badKey', 'delegate', true],
    ['an uncompressed key', hash({ ...good, delegate: '0x04' + 'ab'.repeat(64), ttl: '600' }), 'badKey', 'delegate', true],
    ['a key off the curve', hash({ ...good, delegate: '0x02' + '00'.repeat(31) + '01', ttl: '600' }), 'badKey', 'delegate', true],
    ['a key and no ttl', hash({ ...good, delegate: KEY }), 'missingTtl', 'ttl', true],
    ['a ttl of 15552001', hash({ ...good, delegate: KEY, ttl: '15552001' }), 'badTtl', 'ttl', true],
    ['a ttl of 1 second', hash({ ...good, delegate: KEY, ttl: '1' }), 'badTtl', 'ttl', true],
    ['a ttl with no key', hash({ ...good, ttl: '600' }), 'ttlWithoutKey', 'ttl', true]
  ]
  it.each(refused)('refuses %s', (_name, fragment, reason, field, canGoBack) => {
    expect(parseRequest(fragment)).toEqual({ ok: false, reason, field, returnUrl: canGoBack ? RETURN : null })
  })

  it('refuses anything that is not text', () => {
    expect(parseRequest(undefined as unknown as string)).toMatchObject({ ok: false, reason: 'notConnect' })
  })
})

describe('the lifetime', () => {
  it('is ten minutes without a key', () => {
    expect(maxLifetime(request())).toBe(600)
    expect(lifetimeOptions(request())).toEqual([600])
  })

  it('is at most the ttl with a key, offered in steps that stay below it', () => {
    const wide = request({ delegate: KEY, ttl: '15552000' })
    expect(maxLifetime(wide)).toBe(15_552_000)
    expect(lifetimeOptions(wide)).toEqual([3600, 86_400, 604_800, 2_592_000, 7_776_000, 15_552_000])
    expect(lifetimeOptions(request({ delegate: KEY, ttl: '86400' }))).toEqual([3600, 86_400])
    expect(lifetimeOptions(request({ delegate: KEY, ttl: '90' }))).toEqual([90])
  })
})

describe('the message the person signs', () => {
  const asked = request({ delegate: KEY, ttl: '2592000' })
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
    expect(url.startsWith(`${RETURN}#orivonid=`)).toBe(true)
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

  it('builds the URLs for a cancellation and for a request that cannot be answered', () => {
    expect(cancelUrl(request({ state: 'st-1' }))).toBe(`${RETURN}#orivonid-error=cancelled&state=st-1`)
    expect(cancelUrl(request())).toBe(`${RETURN}#orivonid-error=cancelled`)
    expect(invalidRequestUrl(RETURN)).toBe(`${RETURN}#orivonid-error=invalid-request`)
  })
})
