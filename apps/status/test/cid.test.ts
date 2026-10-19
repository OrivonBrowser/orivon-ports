import { describe, expect, it } from 'vitest'
import { fromHex, toHex } from '../site/bytes.js'
import { base32Decode, base32Encode, base36Decode, base36Encode, CODEC, cidToString, HASH, parseCid, readVarint, shorten, writeVarint } from '../site/cid.js'

const DIRECTORY = 'bafybeib4liozf4uwoq57zklkldjtfx5e7u65yl2e4prn3evpl6si3qgwr4'
const KEY = 'k51qzi5uqu5dlswot3wcjo7k3vy02gepnrdw2qhu2a3f6ll422kykyoljjshuv'

describe('varint', () => {
  it('round-trips across byte boundaries', () => {
    for (const value of [0, 1, 127, 128, 300, 16383, 16384, 2 ** 32, 2 ** 40 + 5]) {
      const bytes = Uint8Array.from(writeVarint(value))
      expect(readVarint(bytes, 0)).toEqual([value, bytes.length])
    }
  })

  it('reads at an offset and refuses a truncated value', () => {
    expect(readVarint(Uint8Array.from([9, 0xac, 0x02]), 1)).toEqual([300, 3])
    expect(() => readVarint(Uint8Array.from([0x80]), 0)).toThrow(/truncated/)
  })
})

describe('multibase', () => {
  it('round-trips base32 and base36', () => {
    const bytes = fromHex('0170122078a4cadf8bc92a88fa39599ceb81fc29f967b75a18b96d19db1ba7e4')
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes)
    expect(base36Decode(base36Encode(bytes))).toEqual(bytes)
    expect(base32Encode(new TextEncoder().encode('foobar'))).toBe('mzxw6ytboi')
  })

  it('keeps leading zero bytes in base36', () => {
    const bytes = Uint8Array.from([0, 0, 1, 2])
    expect(base36Encode(bytes).startsWith('00')).toBe(true)
    expect(base36Decode(base36Encode(bytes))).toEqual(bytes)
  })

  it('refuses characters outside the alphabet', () => {
    expect(() => base32Decode('A1')).toThrow()
    expect(() => base36Decode('a-b')).toThrow()
  })
})

describe('CID', () => {
  it('parses a dag-pb CIDv1 in base32', () => {
    const cid = parseCid(DIRECTORY)
    expect(cid).toMatchObject({ version: 1, codec: CODEC.dagPb, hashCode: HASH.sha256 })
    expect(toHex(cid.digest)).toBe('3c5a1d92f296743bfca96a58d332dfa4fd3ddc2f44e3e2dd92af5fa48dc0d68f')
    expect(cidToString(cid)).toBe(DIRECTORY)
  })

  it('parses an IPNS key in base36 as a libp2p-key with an identity hash', () => {
    const cid = parseCid(KEY)
    expect(cid).toMatchObject({ codec: CODEC.libp2pKey, hashCode: HASH.identity })
    expect(cid.digest.length).toBe(36)
    expect(cidToString(cid, 'k')).toBe(KEY)
  })

  it('says CIDv0 is not supported, and refuses an unknown prefix', () => {
    expect(() => parseCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toThrow(/not supported/)
    expect(() => parseCid('zb2rhe5P4gXftAwvA4eXQ5HJwsER2owDyS9sKaQRRVQPn93bA')).toThrow(/prefix/)
  })

  it('refuses a CID whose length does not match its hash', () => {
    expect(() => parseCid(DIRECTORY.slice(0, -2))).toThrow()
  })
})

describe('shorten', () => {
  it('keeps both ends of a long address', () => {
    expect(shorten(DIRECTORY)).toBe(`${DIRECTORY.slice(0, 10)}…${DIRECTORY.slice(-6)}`)
    expect(shorten('abc')).toBe('abc')
  })
})
