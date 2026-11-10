import { describe, expect, it, vi } from 'vitest'
import { fromHex, toHex, utf8 } from '../site/sdk/bytes.js'
import { ACTION_PREFIX, appKey, frameAction } from '../site/sdk/key.js'
import { compress, decompress, keyBytes, keyHex, verifyP256 } from '../site/sdk/p256.js'
import { fakeId } from './support/fake-id.ts'

const ORIGIN = 'https://app.example.org'

// NIST P-256's generator, from FIPS 186-4: x ends ...c296, y ends ...51f5 (odd), so the compressed form starts 03.
const G_X = '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'
const G_Y = '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'

describe('P-256 points', () => {
  it('compress and open the generator of the curve', () => {
    const open = fromHex('04' + G_X + G_Y)
    expect(toHex(compress(open) as Uint8Array)).toBe('03' + G_X)
    expect(toHex(decompress(fromHex('03' + G_X)) as Uint8Array)).toBe(toHex(open))
  })

  it('round-trip the keys WebCrypto makes (noble/curves agreed on 200 more when this was written)', async () => {
    for (let index = 0; index < 20; index++) {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
      const open = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
      const closed = compress(open) as Uint8Array
      expect(closed).toHaveLength(33)
      expect(toHex(decompress(closed) as Uint8Array)).toBe(toHex(open))
    }
  })

  it('refuse what is not a point of the curve', () => {
    const closed = fromHex('03' + G_X)
    expect(decompress(fromHex('02' + '00'.repeat(31) + '01'))).toBeNull()
    expect(decompress(fromHex('04' + G_X))).toBeNull()
    expect(decompress(closed.slice(0, 32))).toBeNull()
    expect(decompress(fromHex('02' + 'ff'.repeat(32)))).toBeNull()
    expect(decompress('03' as unknown as Uint8Array)).toBeNull()
    expect(compress(fromHex('04' + G_X + G_Y.slice(0, -2) + 'f4'))).toBeNull()
    expect(compress(fromHex('02' + G_X + G_Y))).toBeNull()
    expect(compress(fromHex('04' + G_X))).toBeNull()
  })

  it('read a key from 33 bytes, 65 bytes, or either as 0x hex, and from nothing else', () => {
    const closed = fromHex('03' + G_X)
    const open = fromHex('04' + G_X + G_Y)
    for (const input of [closed, open, '0x03' + G_X, '0x04' + G_X + G_Y, '0x03' + G_X.toUpperCase()]) expect(toHex(keyBytes(input) as Uint8Array), String(input)).toBe('03' + G_X)
    for (const input of ['03' + G_X, '0x03' + G_X.slice(2), '0x', 5, null, undefined, fromHex('00'.repeat(33)), new Uint8Array(32)]) expect(keyBytes(input), String(input)).toBeNull()
    expect(keyHex(closed)).toBe('0x03' + G_X)
  })
})

describe('verifying what orivon.id.sign makes', () => {
  it('accepts the 64-byte r||s ECDSA/SHA-256 signature of the exact bytes, and nothing else', async () => {
    const { id } = await fakeId()
    const key = compress(await id.publicKey({ curve: 'P-256' })) as Uint8Array
    const data = utf8('a payload')
    const signature = await id.sign({ curve: 'P-256', payload: data })
    expect(signature).toHaveLength(64)
    expect(await verifyP256(key, data, signature)).toBe(true)
    expect(await verifyP256(key, utf8('a payloaD'), signature)).toBe(false)
    expect(await verifyP256(key, data, signature.map((byte, index) => index === 40 ? byte ^ 1 : byte))).toBe(false)
    expect(await verifyP256(key, data, signature.slice(0, 63))).toBe(false)
    expect(await verifyP256(key, data, new Uint8Array(64))).toBe(false)
    const other = compress(await (await fakeId()).id.publicKey({ curve: 'P-256' })) as Uint8Array
    expect(await verifyP256(other, data, signature)).toBe(false)
    expect(await verifyP256(fromHex('02' + '00'.repeat(31) + '01'), data, signature)).toBe(false)
  })

  it('accepts, as a primitive, a signature whose s is the upper half, which WebCrypto makes half the time; verifyAction is the one that refuses it', async () => {
    const { id } = await fakeId()
    const key = compress(await id.publicKey({ curve: 'P-256' })) as Uint8Array
    const seen = new Set<boolean>()
    for (let index = 0; index < 40; index++) {
      const data = utf8(`payload ${index}`)
      const signature = await id.sign({ curve: 'P-256', payload: data })
      seen.add(signature[32]! >= 0x80)
      expect(await verifyP256(key, data, signature)).toBe(true)
    }
    expect(seen.size).toBe(2)
  })
})

describe('the relying site\'s key', () => {
  it('is the origin\'s P-256 key, compressed, asked by the curve name the broker knows', async () => {
    const fake = await fakeId()
    const key = await appKey({ id: fake.id }, { origin: ORIGIN })
    const raw = await fake.id.publicKey({ curve: 'P-256' })
    expect(key.curve).toBe('p256')
    expect(key.publicKey).toHaveLength(33)
    expect(toHex(key.publicKey)).toBe(toHex(compress(raw) as Uint8Array))
    expect(key.hex).toBe('0x' + toHex(key.publicKey))
    expect(key.origin).toBe(ORIGIN)
  })

  it('takes the page\'s origin from the page when it is not given', async () => {
    const fake = await fakeId()
    vi.stubGlobal('location', { origin: ORIGIN })
    expect((await appKey({ id: fake.id })).origin).toBe(ORIGIN)
    vi.unstubAllGlobals()
  })

  it('signs the payload after a fixed prefix and the audience, so a signature made for another purpose or site never reads as a request', async () => {
    const fake = await fakeId()
    const key = await appKey({ id: fake.id }, { origin: ORIGIN })
    const payload = utf8('{"do":"post","n":7}')
    const signature = await key.sign(payload)
    expect(toHex(fake.signed[0] as Uint8Array)).toBe(toHex(utf8(`${ACTION_PREFIX}${ORIGIN}\n{"do":"post","n":7}`)))
    expect(toHex(frameAction(payload, ORIGIN))).toBe(toHex(fake.signed[0] as Uint8Array))
    expect(await verifyP256(key.publicKey, frameAction(payload, ORIGIN), signature)).toBe(true)
    expect(await verifyP256(key.publicKey, frameAction(payload, 'https://other.example.net'), signature)).toBe(false)
    expect(await verifyP256(key.publicKey, payload, signature)).toBe(false)
    const raw = await fake.id.sign({ curve: 'P-256', payload })
    expect(await verifyP256(key.publicKey, frameAction(payload, ORIGIN), raw)).toBe(false)
  })

  it('fails loudly when orivon.id answers something else', async () => {
    const { id } = await fakeId()
    await expect(appKey({ id: { ...id, publicKey: async () => new Uint8Array(65) } }, { origin: ORIGIN })).rejects.toThrow('not a P-256 point')
    const key = await appKey({ id: { ...id, sign: async () => new Uint8Array(65) } }, { origin: ORIGIN })
    await expect(key.sign(utf8('x'))).rejects.toThrow('64 bytes')
  })
})
