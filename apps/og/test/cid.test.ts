import { describe, expect, it } from 'vitest'
import { fromHex } from '../site/sdk/bytes.js'
import { base32Lower, dagPbCid } from '../site/sdk/cid.js'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** The bytes of a CIDv0 (`Qm...`): its base58 decoded, as a sha2-256 multihash. A second way to the digest, to hold the encoder against. */
function digestOfCidV0 (cid: string): Uint8Array {
  let value = 0n
  for (const char of cid) value = value * 58n + BigInt(B58.indexOf(char))
  const bytes = fromHex(value.toString(16).padStart(68, '0'))
  expect([...bytes.subarray(0, 2)]).toEqual([0x12, 0x20])
  return bytes.subarray(2)
}

// The three names that hold a value in the registry's `content` slot (block 26,450,231), with the CIDv0 each value is the digest of.
const LIVE = [
  { label: 'aiagent', value: '0xa9371ce170978fc44da89c13c76cadbd9d37c1fa550015a0c4a7e0bfd1326c0d', v0: 'QmZjCMQ73fi5NhMvkoeBpnAtaAiiNbh6kVZkYHeidMfjtg' },
  { label: 'visioned', value: '0x8e0685652ded331888047e0e6135fdb672f445173a829177643b6740277284d9', v0: 'QmXu4NQZys9MihrE9iNntAX6QCvguVZ7GtKLT4CC3gYirt' },
  { label: 'jsunblaze', value: '0xc452c1d588b1e9f01a272fee57ff9d29b22d163fbbb4fd8733f6e25a7dcbef34', v0: 'QmbZ1otFUGrnHrNafSXXxtpJWShNQ7TQCuRdkdFLBXRiNF' }
]

describe('base32Lower', () => {
  it('is RFC 4648 base32 in lower case with no padding', () => {
    const text = (value: string) => base32Lower(new TextEncoder().encode(value))
    expect(text('')).toBe('')
    expect(text('f')).toBe('my')
    expect(text('fo')).toBe('mzxq')
    expect(text('foo')).toBe('mzxw6')
    expect(text('foob')).toBe('mzxw6yq')
    expect(text('fooba')).toBe('mzxw6ytb')
    expect(text('foobar')).toBe('mzxw6ytboi')
  })
})

describe('dagPbCid', () => {
  it('writes the CIDv1 of jsunblaze\'s digest as the one its CIDv0 stands for', () => {
    expect(dagPbCid(fromHex(LIVE[2]!.value))).toBe('bafybeigekla5lcfr5hybujzp5zl77hjjwiwrmp53wt6yom7w4jnh3s7pgq')
  })

  it.each(LIVE)('writes a 59-character dag-pb CIDv1 for $label whose digest is the one its CIDv0 holds', ({ value, v0 }) => {
    expect(fromHex(value)).toEqual(digestOfCidV0(v0))
    const cid = dagPbCid(fromHex(value))
    expect(cid).toMatch(/^bafybei[a-z2-7]{52}$/)
    expect(cid).toHaveLength(59)
  })

  it('refuses what is not 32 bytes', () => {
    expect(() => dagPbCid(new Uint8Array(31))).toThrow(RangeError)
    expect(() => dagPbCid(new Uint8Array(33))).toThrow(RangeError)
  })
})
