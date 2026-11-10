import { describe, expect, it } from 'vitest'
import {
  arrivalUrl, BRIDGE_PATH, bridgeUrl, checkAudience, checkRequest, checkResponse, confirmationUrl, decodeResponse, encodeResponse, errorUrl, ID_ORIGIN, isAfterPath,
  isChallenge, MAX_AUDIENCE, MAX_NAMES, nameResource, randomToken, readResources, REQUEST_PROBLEMS, signInFields, statementFor, successUrl, type SignInResponse
} from '../site/sdk/protocol.js'
import { buildMessage, parseMessage } from '../site/sdk/siwe.js'

const ADDRESS = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826'
const KEY = '0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978'
const NONCE = 'k3Jf92LmQp0xZ7aT'
const AUDIENCE = 'https://app.example.org'
const RESOLVER = '0x' + '7e'.repeat(20)
const OTHER_RESOLVER = '0x' + '4b'.repeat(20)

// The two messages PROTOCOL.md shows. If these change, that page changes with them.
const PLAIN = `id.orivonstack.eth wants you to sign in with your Ethereum account:
0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826

Sign in to https://app.example.org. It sees your usernames and cannot act as you.

URI: https://app.example.org
Version: 1
Chain ID: 1
Nonce: k3Jf92LmQp0xZ7aT
Issued At: 2026-11-06T12:00:00Z
Expiration Time: 2026-11-06T12:10:00Z
Resources:
- orivonid:name:alice.v1.orivonid.eth#0x7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e`

const DELEGATED = `id.orivonstack.eth wants you to sign in with your Ethereum account:
0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826

Let https://app.example.org act as you, with its own key, until expiry. It sees your usernames.

URI: https://app.example.org
Version: 1
Chain ID: 1
Nonce: k3Jf92LmQp0xZ7aT
Issued At: 2026-11-06T12:00:00Z
Expiration Time: 2026-12-06T12:00:00Z
Resources:
- orivonid:name:alice.v1.orivonid.eth#0x7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e
- orivonid:name:bob-1.v1.orivonid.eth#0x4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b
- orivonid:key:p256:0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978`

const base = { audience: AUDIENCE, nonce: NONCE }
const issuedAt = 1_793_966_400

describe('the request', () => {
  it('takes the smallest request, one with a state, and one with a key', () => {
    expect(checkRequest(base)).toEqual({ ok: true, request: { origin: AUDIENCE, nonce: NONCE, state: null, key: null, ttl: null } })
    expect(checkRequest({ ...base, state: 'abc_123.~-' })).toMatchObject({ ok: true, request: { state: 'abc_123.~-' } })
    expect(checkRequest({ ...base, delegate: KEY, ttl: '2592000' })).toMatchObject({ ok: true, request: { key: KEY, ttl: 2_592_000 } })
  })

  it('takes an audience written as an origin, with a port when it is not 443', () => {
    expect(checkAudience('https://app.example.org:8443')).toEqual({ ok: true, origin: 'https://app.example.org:8443' })
    expect(checkAudience('https://alice.eth')).toEqual({ ok: true, origin: 'https://alice.eth' })
    expect(checkAudience('https://xn--bcher-kva.example')).toMatchObject({ ok: true })
  })

  it('keeps the key in lower case whatever case it came in', () => {
    expect(checkRequest({ ...base, delegate: '0x' + KEY.slice(2).toUpperCase(), ttl: '60' })).toMatchObject({ ok: true, request: { key: KEY } })
  })

  const refused: [string, Parameters<typeof checkRequest>[0], string, string][] = [
    ['no audience', { nonce: NONCE }, 'missingAudience', 'aud'],
    ['an empty audience', { ...base, audience: '' }, 'missingAudience', 'aud'],
    ['an audience that is not a URL', { ...base, audience: 'callback' }, 'audienceNotUrl', 'aud'],
    ['an audience with nothing after the scheme', { ...base, audience: 'https://' }, 'audienceNotUrl', 'aud'],
    ['an http audience', { ...base, audience: 'http://app.example.org' }, 'audienceNotHttps', 'aud'],
    ['a javascript audience', { ...base, audience: 'javascript:alert(1)' }, 'audienceNotHttps', 'aud'],
    ['an ipfs audience', { ...base, audience: 'ipfs://bafy/' }, 'audienceNotHttps', 'aud'],
    ['an audience with a path', { ...base, audience: 'https://app.example.org/callback' }, 'audienceNotOrigin', 'aud'],
    ['an audience with a trailing slash', { ...base, audience: 'https://app.example.org/' }, 'audienceNotOrigin', 'aud'],
    ['an audience with a fragment', { ...base, audience: 'https://app.example.org#/home' }, 'audienceNotOrigin', 'aud'],
    ['an audience with a user name', { ...base, audience: 'https://alice@app.example.org' }, 'audienceNotOrigin', 'aud'],
    ['an audience with a password', { ...base, audience: 'https://alice:pw@app.example.org' }, 'audienceNotOrigin', 'aud'],
    ['an audience with the default port written', { ...base, audience: 'https://app.example.org:443' }, 'audienceNotOrigin', 'aud'],
    ['an audience with an upper-case host', { ...base, audience: 'https://App.Example.ORG' }, 'audienceNotOrigin', 'aud'],
    ['an audience with a space', { ...base, audience: 'https://app.example.org a' }, 'audienceNotAscii', 'aud'],
    ['an audience with a line feed the URL parser would drop', { ...base, audience: 'https://app.exa\nmple.org' }, 'audienceNotAscii', 'aud'],
    ['an audience outside ASCII', { ...base, audience: 'https://bücher.example' }, 'audienceNotAscii', 'aud'],
    ['an audience of 65 characters', { ...base, audience: 'https://' + 'a'.repeat(MAX_AUDIENCE - 7) }, 'audienceTooLong', 'aud'],
    ['an audience of 2049 characters', { ...base, audience: 'https://app.example.org/' + 'a'.repeat(2025) }, 'audienceTooLong', 'aud'],
    ['no nonce', { audience: AUDIENCE }, 'missingNonce', 'nonce'],
    ['a nonce of 15 characters', { ...base, nonce: 'a'.repeat(15) }, 'badNonce', 'nonce'],
    ['a nonce of 65 characters', { ...base, nonce: 'a'.repeat(65) }, 'badNonce', 'nonce'],
    ['a nonce with a dash', { ...base, nonce: 'a'.repeat(15) + '-' }, 'badNonce', 'nonce'],
    ['an empty state', { ...base, state: '' }, 'badState', 'state'],
    ['a state of 257 characters', { ...base, state: 'a'.repeat(257) }, 'badState', 'state'],
    ['a state with a space', { ...base, state: 'a b' }, 'badState', 'state'],
    ['a state with a slash', { ...base, state: 'a/b' }, 'badState', 'state'],
    ['a key with no 0x', { ...base, delegate: KEY.slice(2), ttl: '60' }, 'badKey', 'delegate'],
    ['a key of 32 bytes', { ...base, delegate: '0x' + 'ab'.repeat(32), ttl: '60' }, 'badKey', 'delegate'],
    ['an uncompressed key', { ...base, delegate: '0x04' + 'ab'.repeat(64), ttl: '60' }, 'badKey', 'delegate'],
    ['a key with the prefix 04', { ...base, delegate: '0x04' + KEY.slice(4), ttl: '60' }, 'badKey', 'delegate'],
    ['a key that is not a point of the curve', { ...base, delegate: '0x02' + '00'.repeat(31) + '01', ttl: '60' }, 'badKey', 'delegate'],
    ['a key with x past the field', { ...base, delegate: '0x02' + 'ff'.repeat(32), ttl: '60' }, 'badKey', 'delegate'],
    ['a key and no ttl', { ...base, delegate: KEY }, 'missingTtl', 'ttl'],
    ['a ttl of 59', { ...base, delegate: KEY, ttl: '59' }, 'badTtl', 'ttl'],
    ['a ttl of 180 days and a second', { ...base, delegate: KEY, ttl: '15552001' }, 'badTtl', 'ttl'],
    ['a ttl with a leading zero', { ...base, delegate: KEY, ttl: '0600' }, 'badTtl', 'ttl'],
    ['a ttl in exponent form', { ...base, delegate: KEY, ttl: '1e5' }, 'badTtl', 'ttl'],
    ['a negative ttl', { ...base, delegate: KEY, ttl: '-60' }, 'badTtl', 'ttl'],
    ['a ttl and no key', { ...base, ttl: '600' }, 'ttlWithoutKey', 'ttl']
  ]
  it.each(refused)('refuses %s', (_name, raw, reason, field) => {
    expect(checkRequest(raw)).toEqual({ ok: false, reason, field })
    expect(REQUEST_PROBLEMS).toContain(reason)
  })

  it('takes the ends of the ttl range', () => {
    expect(checkRequest({ ...base, delegate: KEY, ttl: '60' }).ok).toBe(true)
    expect(checkRequest({ ...base, delegate: KEY, ttl: '15552000' }).ok).toBe(true)
  })

  it('takes the longest audience', () => {
    const longest = 'https://' + 'a'.repeat(MAX_AUDIENCE - 'https://'.length)
    expect(longest).toHaveLength(MAX_AUDIENCE)
    expect(checkAudience(longest)).toEqual({ ok: true, origin: longest })
  })
})

describe('the links between the sites', () => {
  const challenge = 'Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcDeF'

  it('sends the person to the ID site with the audience and nothing else', () => {
    expect(arrivalUrl(AUDIENCE)).toBe(`${ID_ORIGIN}/#/connect?v=2&aud=https%3A%2F%2Fapp.example.org`)
    expect(arrivalUrl('https://app.example.org:8443')).toBe(`${ID_ORIGIN}/#/connect?v=2&aud=https%3A%2F%2Fapp.example.org%3A8443`)
  })

  it('sends the ID site\'s Continue to the bridge page of the audience, with the challenge as the only query', () => {
    expect(BRIDGE_PATH).toBe('/.well-known/orivon-id/bridge.html')
    expect(bridgeUrl(AUDIENCE, challenge)).toBe(`${AUDIENCE}/.well-known/orivon-id/bridge.html?c=${challenge}`)
  })

  it('brings the bridge page back to the ID site with the request it kept, in one order, or with none', () => {
    const fields = { nonce: NONCE, state: 'abc_123', key: KEY, ttl: 2_592_000 }
    expect(confirmationUrl(challenge, fields)).toBe(`${ID_ORIGIN}/#/connect?v=2&c=${challenge}&nonce=${NONCE}&state=abc_123&delegate=${KEY}&ttl=2592000`)
    expect(confirmationUrl(challenge, { nonce: NONCE, state: null, key: null, ttl: null })).toBe(`${ID_ORIGIN}/#/connect?v=2&c=${challenge}&nonce=${NONCE}`)
    expect(confirmationUrl(challenge, null)).toBe(`${ID_ORIGIN}/#/connect?v=2&c=${challenge}&none=1`)
  })

  it('makes a challenge and a nonce of 32 letters and digits from the random bytes it is given, skipping bytes that would bias a letter', () => {
    const token = randomToken((bytes) => bytes.fill(250).fill(3, 0, 5))
    expect(token).toHaveLength(32)
    expect(isChallenge(token)).toBe(true)
    expect(isChallenge('short')).toBe(false)
    expect(isChallenge(challenge + 'x')).toBe(false)
    expect(isChallenge('Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcD-F')).toBe(false)
    expect(isChallenge(undefined)).toBe(false)
  })

  const paths: [string, boolean][] = [
    ['/', true], ['/signed-in', true], ['/a/b?c=d#e', true], ['/#/home', true],
    ['', false], ['signed-in', false], ['//evil.example', false], ['/\\evil.example', false], ['https://evil.example/', false], ['/a b', false],
    ['/ü', false], [`/${'a'.repeat(2048)}`, false], ['javascript:alert(1)', false]
  ]
  it.each(paths)('says whether %s is a place on the relying site itself: %s', (path, expected) => {
    expect(isAfterPath(path)).toBe(expected)
    if (expected) expect(new URL(path, AUDIENCE).origin).toBe(AUDIENCE)
  })
  it('refuses a path that is not text', () => {
    expect(isAfterPath(undefined)).toBe(false)
    expect(isAfterPath(5)).toBe(false)
  })
})

describe('the message', () => {
  const parts = { address: ADDRESS, origin: 'https://app.example.org', nonce: NONCE, issuedAt }

  it('is this text for one username and no key', () => {
    expect(buildMessage(signInFields({ ...parts, expiresAt: issuedAt + 600, labels: ['alice'], resolvers: [RESOLVER], key: null }))).toBe(PLAIN)
  })

  it('is this text for two usernames and a key', () => {
    expect(buildMessage(signInFields({ ...parts, expiresAt: issuedAt + 2_592_000, labels: ['alice', 'bob-1'], resolvers: [RESOLVER, OTHER_RESOLVER], key: KEY }))).toBe(DELEGATED)
  })

  it('reads back as fields that build the same text', () => {
    for (const text of [PLAIN, DELEGATED]) expect(buildMessage(parseMessage(text))).toBe(text)
  })

  it('names the audience and what a key does in a statement of at most 140 characters, for the longest audience a request may carry', () => {
    const longest = 'https://' + 'a'.repeat(MAX_AUDIENCE - 'https://'.length)
    expect(longest).toHaveLength(MAX_AUDIENCE)
    expect(checkRequest({ ...base, audience: longest })).toMatchObject({ ok: true, request: { origin: longest } })
    for (const key of [null, KEY]) {
      const statement = statementFor({ origin: longest, key })
      expect(statement.length, String(key)).toBeLessThanOrEqual(140)
      expect(statement).toContain(longest)
    }
    expect(statementFor({ origin: longest, key: KEY })).toHaveLength(136)
    expect(statementFor({ origin: longest, key: null })).toHaveLength(122)
  })

  it('puts the delegation first, before anything a clipped quote could cut', () => {
    expect(statementFor({ origin: 'https://x.example', key: KEY }).startsWith('Let https://x.example act as you, with its own key')).toBe(true)
    expect(statementFor({ origin: 'https://x.example', key: null })).not.toContain('key')
  })

  it('refuses an audience the statement could not name in full', () => {
    const tooLong = 'https://' + 'a'.repeat(MAX_AUDIENCE - 'https://'.length + 1)
    expect(checkRequest({ ...base, audience: tooLong })).toEqual({ ok: false, reason: 'audienceTooLong', field: 'aud' })
    expect(checkRequest({ ...base, audience: `https://${'a'.repeat(50)}.example.org:8443` })).toEqual({ ok: false, reason: 'audienceTooLong', field: 'aud' })
    expect(REQUEST_PROBLEMS).toContain('audienceTooLong')
  })

  it('uses only characters EIP-4361 allows in a statement, for a long origin and sixteen usernames too', () => {
    const labels = Array.from({ length: MAX_NAMES }, (_, index) => `name-${index}`)
    const fields = signInFields({ ...parts, origin: 'https://sub.domain-1.example.org:8443', expiresAt: issuedAt + 600, labels, resolvers: labels.map(() => RESOLVER), key: null })
    expect(() => buildMessage(fields)).not.toThrow()
  })

  it('binds each username to a resolver in its resource, and reads the pair back, the key last', () => {
    expect(nameResource('alice', RESOLVER.toUpperCase().replace('0X', '0x'))).toBe(`orivonid:name:alice.v1.orivonid.eth#${RESOLVER}`)
    expect(() => nameResource('alice', 'resolver')).toThrow(TypeError)
    expect(readResources([`orivonid:name:alice.v1.orivonid.eth#${RESOLVER}`, `orivonid:name:bob-1.v1.orivonid.eth#${OTHER_RESOLVER}`, `orivonid:key:p256:${KEY}`]))
      .toEqual({ ok: true, labels: ['alice', 'bob-1'], resolvers: [RESOLVER, OTHER_RESOLVER], key: KEY })
    expect(readResources([`orivonid:name:alice.v1.orivonid.eth#${RESOLVER}`])).toEqual({ ok: true, labels: ['alice'], resolvers: [RESOLVER], key: null })
  })

  it('will not build a message with a resolver short', () => {
    expect(() => signInFields({ ...parts, expiresAt: issuedAt + 600, labels: ['alice', 'bob'], resolvers: [RESOLVER], key: null })).toThrow(TypeError)
  })

  const named = (label: string, resolver = RESOLVER) => `orivonid:name:${label}.v1.orivonid.eth#${resolver}`
  const bad: [string, string[]][] = [
    ['no resources', []],
    ['only a key', [`orivonid:key:p256:${KEY}`]],
    ['a key before a username', [`orivonid:key:p256:${KEY}`, named('alice')]],
    ['two keys', [named('alice'), `orivonid:key:p256:${KEY}`, `orivonid:key:p256:${KEY}`]],
    ['a key of another curve', [named('alice'), `orivonid:key:secp256k1:${KEY}`]],
    ['a key in upper case', [named('alice'), `orivonid:key:p256:0x${KEY.slice(2).toUpperCase()}`]],
    ['a key that is not a point', [named('alice'), 'orivonid:key:p256:0x02' + '00'.repeat(31) + '01']],
    ['a username twice', [named('alice'), named('alice', OTHER_RESOLVER)]],
    ['a username with no resolver', ['orivonid:name:alice.v1.orivonid.eth']],
    ['a username with an empty resolver', ['orivonid:name:alice.v1.orivonid.eth#']],
    ['a resolver in upper case', [named('alice', '0x' + '7E'.repeat(20))]],
    ['a resolver that is a short address', [named('alice', '0x' + '7e'.repeat(19))]],
    ['a resolver that is a name', [named('alice', 'resolver.eth')]],
    ['the zero address as a resolver', [named('alice', '0x' + '00'.repeat(20))]],
    ['a resolver on the key', [named('alice'), `orivonid:key:p256:${KEY}#${RESOLVER}`]],
    ['a label the registrar refuses', [named('-alice')]],
    ['a label in upper case', [named('Alice')]],
    ['a username under another name', [`orivonid:name:alice.orivonid.eth#${RESOLVER}`]],
    ['a deeper name', [named('a.alice')]],
    ['a resource of another kind', [named('alice'), 'https://example.org/']],
    ['seventeen usernames', Array.from({ length: MAX_NAMES + 1 }, (_, index) => named(`name-${index}`))]
  ]
  it.each(bad)('refuses %s', (_name, resources) => {
    expect(readResources(resources).ok).toBe(false)
  })
})

describe('the response', () => {
  const response: SignInResponse = { v: 1, message: PLAIN, signature: '0x' + 'ab'.repeat(65), address: ADDRESS, names: ['alice.v1.orivonid.eth'] }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

  it('travels as base64url of JSON, in the fragment of the bridge page, and comes back the same', () => {
    const url = successUrl(AUDIENCE, response)
    expect(url.startsWith(`${AUDIENCE}${BRIDGE_PATH}#orivonid=`)).toBe(true)
    expect(decodeResponse(url.split('#orivonid=')[1] as string)).toEqual(response)
    expect(encodeResponse(response)).toBe(encode(response))
    expect(decodeResponse(encodeResponse({ ...response, state: 'abc' }))).toEqual({ ...response, state: 'abc' })
  })

  it('has no padding and no characters a fragment would need escaped', () => {
    for (let length = 0; length < 6; length++) expect(encodeResponse({ ...response, names: [], message: 'x'.repeat(length) })).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('says a cancellation as an error with the state, at the bridge page', () => {
    expect(errorUrl(AUDIENCE, 'cancelled', 'abc')).toBe(`${AUDIENCE}${BRIDGE_PATH}#orivonid-error=cancelled&state=abc`)
    expect(errorUrl(AUDIENCE, 'cancelled', null)).toBe(`${AUDIENCE}${BRIDGE_PATH}#orivonid-error=cancelled`)
  })

  const refused: [string, string][] = [
    ['padding', encode(response) + '='],
    ['the standard alphabet', encode(response).slice(0, -4) + '+/+/'],
    ['a length that cannot be base64', 'A'],
    ['trailing bits that are not zero', encode({ ...response }).slice(0, -1) + 'B'],
    ['bytes that are not UTF-8', Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')],
    ['JSON that is not JSON', Buffer.from('{nope').toString('base64url')],
    ['an array', encode([response])],
    ['null', encode(null)],
    ['another key', encode({ ...response, extra: 1 })],
    ['a missing key', encode({ v: 1, message: PLAIN, signature: response.signature, address: ADDRESS })],
    ['a version 2', encode({ ...response, v: 2 })],
    ['a signature of 64 bytes', encode({ ...response, signature: '0x' + 'ab'.repeat(64) })],
    ['a signature that is not hex', encode({ ...response, signature: '0x' + 'zz'.repeat(65) })],
    ['a lower-case address', encode({ ...response, address: ADDRESS.toLowerCase() })],
    ['a name under another suffix', encode({ ...response, names: ['alice.orivonid.eth'] })],
    ['a name that is a number', encode({ ...response, names: [5] })],
    ['seventeen names', encode({ ...response, names: Array.from({ length: 17 }, (_, i) => `n${i}.v1.orivonid.eth`) })],
    ['a state of the wrong kind', encode({ ...response, state: 'a b' })],
    ['a state that is a number', encode({ ...response, state: 5 })],
    ['a body of more than 32768 characters', 'A'.repeat(32_769)]
  ]
  it.each(refused)('refuses %s', (_name, body) => {
    expect(decodeResponse(body)).toBeNull()
  })

  it('checks a value that is not yet encoded the same way', () => {
    expect(checkResponse(response)).toEqual(response)
    expect(checkResponse({ ...response, extra: 1 })).toBeNull()
    expect(checkResponse('text')).toBeNull()
  })
})
