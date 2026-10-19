import { describe, expect, it } from 'vitest'
import { fromHex, toHex, utf8 } from '../site/bytes.js'
import { cidToString, CODEC, HASH, parseCid } from '../site/cid.js'
import { sha256, sha256Plain, verifyBlock } from '../site/verify.js'

// A real block: the root of one release file, and the address its folder links it by.
const FILE_ROOT = fromHex('122d0a2401701220bcec8bc0bcf937f89e994d10b05caa87f3de0bd20d6840bafc86fc95880b3a3d12001886c4e015122d0a24017012204b888ef877824d458aad0ba9a5ee05e33f0c683417455e947029905d34a6ee5512001886c4e015122d0a24017012208800718b39bfd6d8e016b8f5ec1acd0f4b0503f504ee4b4d78f78085bbcd5ba712001896f897100a16080218a8c5d73b208080e015208080e01520a8c59710')
const FILE_ROOT_CID = 'bafybeiert2htikvxvu6t7xkp7ay53wqh6n6wuxs5egui5btkezgyj2az6a'
// The raw CIDv1 of the empty block, and sha-256("abc").
const EMPTY_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

describe('sha-256', () => {
  it('matches the known digest through WebCrypto and through the fallback', async () => {
    expect(toHex(await sha256(utf8('abc')))).toBe(ABC)
    expect(toHex(sha256Plain(utf8('abc')))).toBe(ABC)
  })

  it('agrees across block boundaries', async () => {
    for (const length of [0, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = new Uint8Array(length).map((_, i) => i * 7)
      expect(toHex(sha256Plain(data))).toBe(toHex(await sha256(data)))
    }
  })
})

describe('verifyBlock', () => {
  it('accepts the real block its CID names', async () => {
    expect(await verifyBlock(parseCid(FILE_ROOT_CID), FILE_ROOT)).toEqual({ ok: true })
  })

  it('rejects the same block with one byte changed', async () => {
    const changed = FILE_ROOT.slice()
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1
    expect((await verifyBlock(parseCid(FILE_ROOT_CID), changed)).ok).toBe(false)
  })

  it('accepts the empty raw block and rejects anything else under that CID', async () => {
    const cid = parseCid(EMPTY_CID)
    expect(cid).toMatchObject({ codec: CODEC.raw, hashCode: HASH.sha256 })
    expect(cidToString(cid)).toBe(EMPTY_CID)
    expect(await verifyBlock(cid, new Uint8Array(0))).toEqual({ ok: true })
    expect((await verifyBlock(cid, utf8('x'))).ok).toBe(false)
  })

  it('compares identity CIDs by their data', async () => {
    const cid = { version: 1, codec: CODEC.raw, hashCode: HASH.identity, digest: utf8('hello') }
    expect(await verifyBlock(cid, utf8('hello'))).toEqual({ ok: true })
    expect((await verifyBlock(cid, utf8('other'))).ok).toBe(false)
  })

  it('refuses a hash function it cannot compute', async () => {
    const result = await verifyBlock({ version: 1, codec: CODEC.raw, hashCode: 0x13, digest: new Uint8Array(64) }, utf8('x'))
    expect(result).toMatchObject({ ok: false })
  })
})
