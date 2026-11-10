// Action signatures. The frame an action is signed over names the audience origin, so a signature made for one site
// means nothing at another that holds a sign-in for the same key; and both curves accept two forms of a signature, so
// the key signs only the low-s one and a verifier refuses the high-s twin (a replay cache keyed on signature bytes would
// miss it). Each test keeps the scenario of the weakness and asserts it is closed.

import { describe, expect, it } from 'vitest'
import { concat, fromHex, toHex, utf8 } from '../site/sdk/bytes.js'
import { ACTION_PREFIX, appKey, frameAction } from '../site/sdk/key.js'
import { isLowS, verifyP256 } from '../site/sdk/p256.js'
import { hashMessage } from '../site/sdk/siwe.js'
import { checkSigner, verifyAction, verifySignIn } from '../site/sdk/verify.js'
import { parseRequest, signIn } from '../site/connect-request.js'
import { fakeId } from './support/fake-id.ts'
import { runFlow } from './support/signin-flow.ts'
import { NOW, ORIGIN, SIGNER, signInChain } from './support/signin-world.ts'

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const OTHER = 'https://other.example.net'
const word = (value: bigint) => fromHex('0x' + value.toString(16).padStart(64, '0'))
const int = (bytes: Uint8Array) => BigInt('0x' + toHex(bytes))
const flip = (signature: Uint8Array) => concat(signature.subarray(0, 32), word(P256_N - int(signature.subarray(32, 64))))

describe('L1: the audience is part of what an action signs', () => {
  it('frames the payload with the prefix, the audience origin and a line feed', () => {
    expect(toHex(frameAction(utf8('{"n":1}'), ORIGIN))).toBe(toHex(utf8(`${ACTION_PREFIX}${ORIGIN}\n{"n":1}`)))
    for (const origin of [`${ORIGIN}/`, 'http://app.example.org', 'app.example.org', `${ORIGIN}\n`, 'https://App.example.org', 'https://app.example.org:443', '']) {
      expect(() => frameAction(utf8('x'), origin), origin).toThrow(TypeError)
    }
  })

  it('does not verify an action signed for one audience at another that holds a sign-in for the same key', async () => {
    const env = signInChain()
    const fake = await fakeId()
    const keyAt = async (origin: string) => await appKey({ id: fake.id }, { origin })
    const [forA, forB] = [await keyAt(ORIGIN), await keyAt(OTHER)]
    expect(forA.hex).toBe(forB.hex)
    const signedFor = async (origin: string) => {
      const parsed = parseRequest(`#/connect?v=1&return=${encodeURIComponent(origin + '/')}&nonce=Nonce${origin.length}AAAAAAAAAAAA&delegate=${forA.hex}&ttl=86400`)
      if (!parsed.ok) throw new Error(parsed.reason)
      return (await signIn({ request: parsed.request, chain: env.chain, address: SIGNER, labels: ['alice'], now: NOW, lifetime: 86_400 })).response
    }
    const atA = await signedFor(ORIGIN)
    const atB = await signedFor(OTHER)
    const payload = utf8('{"op":"delete-all","n":1}')
    const signature = await forA.sign(payload)
    expect(await verifyAction({ signIn: atA, payload, signature, origin: ORIGIN, chain: env.chain, now: NOW + 5 })).toMatchObject({ ok: true })
    expect(await verifyAction({ signIn: atB, payload, signature, origin: OTHER, chain: env.chain, now: NOW + 5 })).toMatchObject({ ok: false, failure: 'badActionSignature' })
    expect(await verifyAction({ signIn: atB, payload, signature: await forB.sign(payload), origin: OTHER, chain: env.chain, now: NOW + 5 })).toMatchObject({ ok: true })
    expect(await verifyAction({ signIn: atA, payload, signature: await forB.sign(payload), origin: ORIGIN, chain: env.chain, now: NOW + 5 })).toMatchObject({ failure: 'badActionSignature' })
  })

  it('needs the page\'s own origin to make a key, and a verifier to be told its own', async () => {
    const fake = await fakeId()
    await expect(appKey({ id: fake.id })).rejects.toThrow('origin')
    await expect(appKey({ id: fake.id }, { origin: 'app.example.org' })).rejects.toThrow('origin')
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain, withKey: true })
    await expect(verifyAction({ signIn: flow.response, payload: utf8('x'), signature: new Uint8Array(64), origin: `${ORIGIN}/`, chain: env.chain, now: NOW + 5 })).rejects.toThrow(TypeError)
  })
})

describe('L1: only the low-s form of a P-256 signature', () => {
  it('has the key sign the low form every time, and the frame still verifies', async () => {
    const fake = await fakeId()
    const key = await appKey({ id: fake.id }, { origin: ORIGIN })
    for (let index = 0; index < 40; index++) {
      const payload = utf8(`payload ${index}`)
      const signature = await key.sign(payload)
      expect(isLowS(signature), String(index)).toBe(true)
      expect(await verifyP256(key.publicKey, frameAction(payload, ORIGIN), signature)).toBe(true)
    }
  })

  it('turns a high-s answer of orivon.id into the low one', async () => {
    const fake = await fakeId()
    const raw = fake.id.sign
    const high = { ...fake.id, sign: async (options: { curve: string, payload: Uint8Array }) => {
      const signature = await raw(options)
      return isLowS(signature) ? flip(signature) : signature
    } }
    const key = await appKey({ id: high }, { origin: ORIGIN })
    const payload = utf8('x')
    const signature = await key.sign(payload)
    expect(isLowS(signature)).toBe(true)
    expect(await verifyP256(key.publicKey, frameAction(payload, ORIGIN), signature)).toBe(true)
  })

  it('refuses (r, n - s) beside (r, s)', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain, withKey: true })
    const payload = utf8('{"op":"post","n":7}')
    const signature = await flow.key.sign(payload)
    const twin = flip(signature)
    expect(toHex(twin)).not.toBe(toHex(signature))
    expect(isLowS(twin)).toBe(false)
    expect(await verifyAction({ signIn: flow.response, payload, signature, origin: ORIGIN, chain: env.chain, now: NOW + 5 })).toMatchObject({ ok: true })
    expect(await verifyAction({ signIn: flow.response, payload, signature: twin, origin: ORIGIN, chain: env.chain, now: NOW + 5 })).toEqual({
      ok: false, failure: 'badActionSignature', detail: 'highS'
    })
  })
})

describe('L1: only the low-s form of the wallet\'s secp256k1 signature (EIP-2)', () => {
  const twinOf = (signature: Uint8Array) => concat(signature.subarray(0, 32), word(K1_N - int(signature.subarray(32, 64))), Uint8Array.of(signature[64] === 27 ? 28 : 27))

  it('refuses the high-s twin (r, n - s, v flipped) that ecrecover would still name the signer for', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain })
    const sig = fromHex(flow.response.signature)
    expect(int(sig.subarray(32, 64)) <= K1_N >> 1n).toBe(true)
    const twin = twinOf(sig)
    expect(await checkSigner(env.chain, SIGNER, hashMessage(flow.response.message), sig)).toBe('ecrecover')
    expect(await checkSigner(env.chain, SIGNER, hashMessage(flow.response.message), twin)).toBeNull()
    const result = await verifySignIn({ ...flow.response, signature: '0x' + toHex(twin) }, { chain: env.chain, origin: ORIGIN, nonce: flow.nonce, key: null, now: NOW + 5 })
    expect(result).toEqual({ ok: false, failure: 'badSignature', detail: 'highS' })
  })
})
