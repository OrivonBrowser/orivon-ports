import { afterEach, describe, expect, it, vi } from 'vitest'
import { toChecksumAddress } from '../site/sdk/abi.js'
import { toHex, utf8 } from '../site/sdk/bytes.js'
import { keccak256 } from '../site/sdk/keccak.js'
import { nameOf } from '../site/sdk/orivonid.js'
import { type SignInResponse, signInFields } from '../site/sdk/protocol.js'
import { buildMessage, hashMessage, type SiweFields } from '../site/sdk/siwe.js'
import { FAILURES, verifyAction, verifySignIn } from '../site/sdk/verify.js'
import { signDigest } from './support/secp256k1.ts'
import { runFlow } from './support/signin-flow.ts'
import { aliceWorld, NOT_BEFORE, NOW, ORIGIN, PRIVATE_KEY, RESOLVER, signInChain, type SignInChain, SIGNER } from './support/signin-world.ts'
import { fakeId } from './support/fake-id.ts'
import { appKey } from '../site/sdk/key.js'

const NONCE = 'k3Jf92LmQp0xZ7aT'
const KEY = '0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978'
const OTHER = toChecksumAddress('0x' + '9a'.repeat(20))

/** A response the wallet really signed, for fields the test chose. */
function forge (change: (fields: SiweFields) => SiweFields = (fields) => fields, mutate: (response: SignInResponse) => SignInResponse = (response) => response, key: Uint8Array = PRIVATE_KEY): SignInResponse {
  const plain = signInFields({ address: SIGNER, origin: ORIGIN, nonce: NONCE, issuedAt: NOW, expiresAt: NOW + 600, labels: ['alice'], resolvers: [RESOLVER], key: null })
  const message = buildMessage(change(plain))
  return mutate({ v: 1, message, signature: '0x' + toHex(signDigest(key, hashMessage(message))), address: SIGNER, names: ['alice.v1.orivonid.eth'] })
}

const asked = (env: SignInChain, change: Partial<Parameters<typeof verifySignIn>[1]> = {}) => ({ chain: env.chain, origin: ORIGIN, nonce: NONCE, key: null, now: NOW, ...change })

describe('verifying a sign-in', () => {
  it('accepts the answer to a request without a key, and says who signed in and as which username', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain })
    expect(await verifySignIn(flow.response, { chain: env.chain, origin: ORIGIN, nonce: flow.nonce, key: null, now: NOW + 5 })).toEqual({
      ok: true, address: SIGNER, names: ['alice.v1.orivonid.eth'], key: null, notAfter: NOW + 600, issuedAt: NOW, via: 'ecrecover'
    })
  })

  it('accepts the answer to a request with a key, for the lifetime the person chose', async () => {
    const env = signInChain(aliceWorld(['alice', 'bob']))
    const flow = await runFlow({ chain: env.chain, labels: ['bob', 'alice'], withKey: true, ttl: 2_592_000, lifetime: 86_400, state: 'st' })
    const result = await verifySignIn(flow.response, { chain: env.chain, origin: ORIGIN, nonce: flow.nonce, key: flow.key.hex, ttl: 2_592_000, state: 'st', now: NOW })
    expect(result).toEqual({ ok: true, address: SIGNER, names: ['alice.v1.orivonid.eth', 'bob.v1.orivonid.eth'], key: flow.key.hex, notAfter: NOW + 86_400, issuedAt: NOW, via: 'ecrecover' })
  })

  it('names every failure it can return', () => {
    expect(new Set(FAILURES).size).toBe(FAILURES.length)
    expect(FAILURES).toHaveLength(29)
  })

  it('refuses a clock in milliseconds, and a call that leaves the key out, instead of passing everything', async () => {
    const env = signInChain()
    await expect(verifySignIn(forge(), asked(env, { now: NOW * 1000 }))).rejects.toThrow('whole seconds')
    await expect(verifySignIn(forge(), { ...asked(env), key: undefined as unknown as null })).rejects.toThrow('key')
  })

  describe('the message and the response, before the chain is asked', () => {
    const refused: [string, string, () => SignInResponse, Partial<Parameters<typeof verifySignIn>[1]>][] = [
      ['an object that is not a response', 'malformedResponse', () => ({}) as SignInResponse, {}],
      ['a response with another field', 'malformedResponse', () => ({ ...forge(), extra: 1 }) as SignInResponse, {}],
      ['a message with a carriage return', 'malformedMessage', () => forge(undefined, (r) => ({ ...r, message: r.message.replace('\n', '\r\n') })), {}],
      ['a message in a form EIP-4361 does not allow', 'malformedMessage', () => forge(undefined, (r) => ({ ...r, message: r.message + '\n' })), {}],
      ['a scheme before the domain', 'wrongDomain', () => forge((f) => ({ ...f, scheme: 'https' })), {}],
      ['another domain', 'wrongDomain', () => forge((f) => ({ ...f, domain: 'evil.example' })), {}],
      ['a message made for another site', 'wrongAudience', () => forge((f) => ({ ...f, uri: 'https://other.example.org' })), {}],
      ['the same site under another path', 'wrongAudience', () => forge((f) => ({ ...f, uri: `${ORIGIN}/x` })), {}],
      ['another chain', 'wrongChain', () => forge((f) => ({ ...f, chainId: 5 })), {}],
      ['another nonce', 'wrongNonce', () => forge((f) => ({ ...f, nonce: 'abcdefgh12345678' })), {}],
      ['an address in the response that is not the message\'s', 'wrongAddress', () => forge(undefined, (r) => ({ ...r, address: OTHER })), {}],
      ['a state that is not the one sent', 'wrongState', () => forge(undefined, (r) => ({ ...r, state: 'forged' })), {}],
      ['a time with milliseconds', 'badTimes', () => forge((f) => ({ ...f, issuedAt: '2026-11-06T12:00:00.000Z' })), {}],
      ['no Expiration Time', 'badTimes', () => forge((f) => { const { expirationTime: _, ...rest } = f; return rest }), {}],
      ['an Expiration Time before the Issued At', 'badTimes', () => forge((f) => ({ ...f, expirationTime: '2026-11-06T11:59:00Z' })), {}],
      ['an Issued At from the future', 'notYetValid', () => forge(), { now: NOW - 301 }],
      ['an Expiration Time that has come', 'expired', () => forge(), { now: NOW + 600 }],
      ['a lifetime of eleven minutes without a key', 'badLifetime', () => forge((f) => ({ ...f, expirationTime: '2026-11-06T12:11:00Z' })), {}],
      ['a lifetime of nine minutes without a key', 'badLifetime', () => forge((f) => ({ ...f, expirationTime: '2026-11-06T12:09:00Z' })), {}],
      ['no usernames', 'badResources', () => forge((f) => ({ ...f, resources: [] })), {}],
      ['a resource that is not ours', 'badResources', () => forge((f) => ({ ...f, resources: ['https://example.org/'] })), {}],
      ['a username twice', 'badResources', () => forge((f) => ({ ...f, resources: [...(f.resources ?? []), ...(f.resources ?? [])] })), {}],
      ['usernames that are not the response\'s', 'namesMismatch', () => forge(undefined, (r) => ({ ...r, names: ['bob.v1.orivonid.eth'] })), {}],
      ['a key nobody asked for', 'keyMismatch', () => forge((f) => keyed(f)), {}],
      ['a key asked for and left out', 'keyMismatch', () => forge(), { key: KEY, ttl: 600 }],
      ['another key than the one asked for', 'keyMismatch', () => forge((f) => keyed(f)), { key: '0x036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' }],
      ['a statement that says something else', 'wrongStatement', () => forge((f) => ({ ...f, statement: 'Sign in to https://app.example.org with alice.v1.orivonid.eth. It lets it move funds.' })), {}],
      ['a field the ID site does not write', 'notCanonical', () => forge((f) => ({ ...f, requestId: 'x' })), {}],
      ['a Not Before', 'notCanonical', () => forge((f) => ({ ...f, notBefore: '2026-11-06T11:00:00Z' })), {}]
    ]
    it.each(refused)('refuses %s', async (_name, failure, make, options) => {
      const env = signInChain()
      const response = make()
      const result = await verifySignIn(response, asked(env, options))
      expect(result).toMatchObject({ ok: false, failure })
      expect(env.queries).toHaveLength(0)
    })

    it('refuses a lifetime past the ttl that was asked, or past 180 days', async () => {
      const env = signInChain()
      const wide = (seconds: number) => forge((f) => keyed(f, seconds))
      expect(await verifySignIn(wide(86_401), asked(env, { key: KEY, ttl: 86_400 }))).toMatchObject({ failure: 'badLifetime' })
      expect(await verifySignIn(wide(15_552_001), asked(env, { key: KEY }))).toMatchObject({ failure: 'badLifetime' })
      expect(await verifySignIn(wide(59), asked(env, { key: KEY }))).toMatchObject({ failure: 'badLifetime' })
      expect(await verifySignIn(wide(86_400), asked(env, { key: KEY, ttl: 86_400 }))).toMatchObject({ ok: true })
      expect(await verifySignIn(wide(15_552_000), asked(env, { key: KEY }))).toMatchObject({ ok: true })
    })
  })

  describe('the signer', () => {
    it('refuses a signature by another key', async () => {
      const env = signInChain()
      const response = forge(undefined, undefined, keccak256(utf8('another key')))
      expect(await verifySignIn(response, asked(env))).toMatchObject({ ok: false, failure: 'badSignature' })
    })

    it('refuses a signature that is damaged, of the wrong length, or with a v that is neither 27 nor 28', async () => {
      const env = signInChain()
      const good = forge()
      const bytes = good.signature.slice(2)
      for (const signature of [
        '0x' + bytes.slice(0, 20) + (bytes[20] === 'a' ? 'b' : 'a') + bytes.slice(21),
        '0x' + '00'.repeat(65),
        '0x' + bytes.slice(0, 128) + '1d',
        '0x' + bytes.slice(0, 128) + '00',
        '0x' + bytes.slice(0, 128) + '01'
      ]) expect(await verifySignIn({ ...good, signature }, asked(env)), signature).toMatchObject({ ok: false, failure: 'badSignature' })
    })

    it('proves a 7702-delegated account by its own key, without asking the code behind it', async () => {
      const env = signInChain()
      env.codes[SIGNER.toLowerCase()] = Uint8Array.from([0xef, 0x01, 0x00, ...new Uint8Array(20).fill(0x42)])
      expect(await verifySignIn(forge(), asked(env))).toMatchObject({ ok: true, via: 'ecrecover' })
      expect(env.queries.some((query) => query.selector === '1626ba7e')).toBe(false)
    })

    describe('a contract wallet', () => {
      const wallet = toChecksumAddress('0x' + 'c0'.repeat(20))
      const forWallet = () => {
        const env = signInChain(aliceWorld(['alice'], wallet))
        const plain = signInFields({ address: wallet, origin: ORIGIN, nonce: NONCE, issuedAt: NOW, expiresAt: NOW + 600, labels: ['alice'], resolvers: [RESOLVER], key: null })
        const message = buildMessage(plain)
        const response: SignInResponse = { v: 1, message, signature: '0x' + toHex(signDigest(PRIVATE_KEY, hashMessage(message))), address: wallet, names: ['alice.v1.orivonid.eth'] }
        return { env, response }
      }

      it('is proven by its own say-so (EIP-1271) when ecrecover names someone else', async () => {
        const { env, response } = forWallet()
        env.codes[wallet.toLowerCase()] = { isValidSignature: 'accept' }
        expect(await verifySignIn(response, asked(env))).toMatchObject({ ok: true, address: wallet, via: 'erc1271' })
      })

      it('is refused when the contract says no, reverts, or answers something else', async () => {
        for (const answer of ['reject', 'revert'] as const) {
          const { env, response } = forWallet()
          env.codes[wallet.toLowerCase()] = { isValidSignature: answer }
          expect(await verifySignIn(response, asked(env)), answer).toMatchObject({ ok: false, failure: 'badSignature' })
        }
      })

      it('is not asked when the address has no code, which is an account that did not sign', async () => {
        const { env, response } = forWallet()
        expect(await verifySignIn(response, asked(env))).toMatchObject({ ok: false, failure: 'badSignature' })
        expect(env.queries.some((query) => query.selector === '1626ba7e')).toBe(false)
      })
    })
  })

  describe('the usernames, read now', () => {
    it('refuses a name that was sent to someone else', async () => {
      const env = signInChain()
      env.world.names['alice']!.owner = OTHER
      expect(await verifySignIn(forge(), asked(env))).toEqual({ ok: false, failure: 'notAttributed', detail: 'owner', name: 'alice.v1.orivonid.eth' })
    })

    it('refuses a name whose address record now points elsewhere', async () => {
      const env = signInChain()
      env.world.resolvers[RESOLVER]!.addr = OTHER
      expect(await verifySignIn(forge(), asked(env))).toEqual({ ok: false, failure: 'notAttributed', detail: 'forward:differentAddress', name: 'alice.v1.orivonid.eth' })
    })

    it('refuses a name whose roles are shared with someone else', async () => {
      const env = signInChain()
      env.world.names['alice']!.roleCount = (1n << 20n) + 1n
      expect(await verifySignIn(forge(), asked(env))).toMatchObject({ ok: false, failure: 'notAttributed', detail: 'roles' })
    })

    it('refuses a name that nobody holds', async () => {
      const env = signInChain()
      delete env.world.names['alice']
      expect(await verifySignIn(forge(), asked(env))).toMatchObject({ ok: false, failure: 'notAttributed', detail: 'owner' })
    })

    it('names the username that fails when there are many, and checks them all', async () => {
      const labels = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff']
      const env = signInChain(aliceWorld(labels))
      const response = forge(() => signInFields({ address: SIGNER, origin: ORIGIN, nonce: NONCE, issuedAt: NOW, expiresAt: NOW + 600, labels, resolvers: labels.map(() => RESOLVER), key: null }), (r) => ({ ...r, names: labels.map(nameOf) }))
      expect(await verifySignIn(response, asked(env))).toMatchObject({ ok: true, names: labels.map(nameOf) })
      env.world.names['ddd']!.owner = OTHER
      expect(await verifySignIn(response, asked(env))).toMatchObject({ ok: false, failure: 'notAttributed', name: 'ddd.v1.orivonid.eth' })
    })
  })

  describe('revocation', () => {
    const set = (env: SignInChain, value: string) => { env.world.resolvers[RESOLVER]!.texts = { [NOT_BEFORE]: value } }

    it('voids a sign-in made no later than the record, and keeps one made after it', async () => {
      const env = signInChain()
      set(env, String(NOW - 1))
      expect(await verifySignIn(forge(), asked(env))).toMatchObject({ ok: true })
      set(env, String(NOW))
      expect(await verifySignIn(forge(), asked(env))).toEqual({ ok: false, failure: 'revoked', detail: String(NOW), name: 'alice.v1.orivonid.eth' })
      set(env, String(NOW + 1))
      expect(await verifySignIn(forge(), asked(env))).toMatchObject({ ok: false, failure: 'revoked' })
    })

    it('treats an empty record and a zero as no revocation', async () => {
      const env = signInChain()
      set(env, '')
      expect(await verifySignIn(forge(), asked(env))).toMatchObject({ ok: true })
      set(env, '0')
      expect(await verifySignIn(forge(), asked(env))).toMatchObject({ ok: true })
    })

    it('refuses on a record that is not a time, instead of reading it as none', async () => {
      const env = signInChain()
      for (const value of ['soon', '-5', '1.5', '01', '12345678901234567', ' 5']) {
        set(env, value)
        expect(await verifySignIn(forge(), asked(env)), value).toMatchObject({ ok: false, failure: 'revocationUnreadable', name: 'alice.v1.orivonid.eth' })
      }
    })
  })

  it('says the node could not answer instead of guessing, and passes no sign-in on its silence', async () => {
    const env = signInChain()
    env.down.value = true
    expect(await verifySignIn(forge(), asked(env))).toEqual({ ok: false, failure: 'chainUnavailable', detail: 'unavailable' })
  })
})

function keyed (fields: SiweFields, seconds = 600): SiweFields {
  const labels = ['alice']
  const parts = { address: SIGNER, origin: ORIGIN, nonce: NONCE, issuedAt: NOW, expiresAt: NOW + seconds, labels, resolvers: [RESOLVER], key: KEY }
  const full = signInFields(parts)
  return { ...fields, statement: full.statement as string, resources: full.resources as string[], expirationTime: full.expirationTime as string }
}

describe('verifying an action signed by the delegated key', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  async function delegated (extra: { labels?: string[], lifetime?: number } = {}) {
    const env = signInChain(aliceWorld(extra.labels ?? ['alice']))
    const flow = await runFlow({ chain: env.chain, withKey: true, ttl: 2_592_000, ...extra })
    const payload = utf8('{"post":"hello","n":1}')
    const signature = await flow.key.sign(payload)
    env.queries.length = 0
    return { env, flow, payload, signature }
  }
  const call = (env: SignInChain, flow: { response: SignInResponse }, payload: Uint8Array, signature: Uint8Array, change: Record<string, unknown> = {}) =>
    verifyAction({ signIn: flow.response, payload, signature, origin: ORIGIN, chain: env.chain, now: NOW + 3600, ...change })

  it('accepts the key\'s signature while the chain still agrees', async () => {
    const { env, flow, payload, signature } = await delegated()
    expect(await call(env, flow, payload, signature)).toEqual({
      ok: true, address: SIGNER, names: ['alice.v1.orivonid.eth'], key: flow.key.hex, notAfter: NOW + 2_592_000, issuedAt: NOW, via: 'ecrecover'
    })
  })

  it('refuses a payload or a signature that is not the key\'s', async () => {
    const { env, flow, payload, signature } = await delegated()
    expect(await call(env, flow, utf8('{"post":"hello","n":2}'), signature)).toMatchObject({ ok: false, failure: 'badActionSignature' })
    const other = await appKey({ id: (await fakeId()).id }, { origin: ORIGIN })
    expect(await call(env, flow, payload, await other.sign(payload))).toMatchObject({ ok: false, failure: 'badActionSignature' })
    expect(await call(env, flow, payload, await flow.id.id.sign({ curve: 'P-256', payload }))).toMatchObject({ ok: false, failure: 'badActionSignature' })
    expect(await call(env, flow, payload, signature.map((byte, index) => index === 3 ? byte ^ 1 : byte))).toMatchObject({ failure: 'badActionSignature' })
    expect(env.queries).toHaveLength(0)
  })

  it('refuses inputs that are not bytes of the right length', async () => {
    const { env, flow, payload, signature } = await delegated()
    expect(await call(env, flow, payload, signature.slice(0, 63))).toMatchObject({ failure: 'badAction' })
    expect(await call(env, flow, 'text' as unknown as Uint8Array, signature)).toMatchObject({ failure: 'badAction' })
  })

  it('refuses a sign-in that carries no key', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain })
    expect(await call(env, flow, utf8('x'), new Uint8Array(64), { now: NOW + 5 })).toMatchObject({ ok: false, failure: 'noKey' })
  })

  it('refuses a sign-in made for another site, even with a valid key', async () => {
    const { env, flow, payload, signature } = await delegated()
    expect(await call(env, flow, payload, signature, { origin: 'https://evil.example' })).toMatchObject({ failure: 'wrongAudience' })
  })

  it('refuses a sign-in that was edited after it was signed, and one the chain no longer backs', async () => {
    const { env, flow, payload, signature } = await delegated()
    expect(await call(env, flow, payload, signature, { signIn: { ...flow.response, message: flow.response.message.replace('Version: 1', 'Version: 2') } })).toMatchObject({ failure: 'malformedMessage' })
    expect(await call(env, flow, payload, signature, { signIn: { ...flow.response, signature: '0x' + '11'.repeat(65) } })).toMatchObject({ failure: 'badSignature' })
  })

  it('stops at the expiry of the sign-in, not a second before', async () => {
    const { env, flow, payload, signature } = await delegated({ lifetime: 86_400 })
    expect(await call(env, flow, payload, signature, { now: NOW + 86_399 })).toMatchObject({ ok: true })
    expect(await call(env, flow, payload, signature, { now: NOW + 86_400 })).toMatchObject({ ok: false, failure: 'expired' })
  })

  it('stops when the name is transferred, or its address record changes', async () => {
    const { env, flow, payload, signature } = await delegated()
    env.world.names['alice']!.owner = OTHER
    expect(await call(env, flow, payload, signature)).toMatchObject({ ok: false, failure: 'notAttributed', detail: 'owner' })
    env.world.names['alice']!.owner = SIGNER
    expect(await call(env, flow, payload, signature)).toMatchObject({ ok: true })
    env.world.resolvers[RESOLVER]!.addr = OTHER
    expect(await call(env, flow, payload, signature)).toMatchObject({ ok: false, failure: 'notAttributed', detail: 'forward:differentAddress' })
  })

  it('stops when the owner ends all sign-ins after it was made', async () => {
    const { env, flow, payload, signature } = await delegated()
    env.world.resolvers[RESOLVER]!.texts = { [NOT_BEFORE]: String(NOW + 10) }
    expect(await call(env, flow, payload, signature)).toMatchObject({ ok: false, failure: 'revoked' })
  })

  it('says so when the node is silent, or when this page has no WebCrypto', async () => {
    const { env, flow, payload, signature } = await delegated()
    env.down.value = true
    expect(await call(env, flow, payload, signature)).toMatchObject({ ok: false, failure: 'chainUnavailable' })
    vi.stubGlobal('crypto', {})
    expect(await call(env, flow, payload, signature)).toMatchObject({ ok: false, failure: 'cryptoUnavailable' })
  })
})
