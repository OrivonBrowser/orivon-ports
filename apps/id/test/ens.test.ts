import { describe, expect, it } from 'vitest'
import { toHex } from '../site/sdk/bytes.js'
import { dnsEncode, labelhash, namehash, NameError } from '../site/sdk/ens.js'

// Expected values from Foundry's cast (namehash, keccak).
describe('namehash and labelhash', () => {
  it('hash the root to zero and names by EIP-137', () => {
    expect(namehash('')).toBe('0x' + '00'.repeat(32))
    expect(namehash('eth')).toBe('0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae')
    expect(namehash('orivonstack.eth')).toBe('0x31d1f503fdbf2bcd136f37f2e82ecce5d78699a053258950c4c9084bd1ab9a7a')
    expect(namehash('alice.v1.orivonid.eth')).toBe('0x4d981184fc3160e65631b55e17ce8da5f41c4485bc4926f09625d3f9c2c8ab5a')
  })

  it('hash a label as keccak-256 of its bytes', () => {
    expect(labelhash('alice')).toBe('0x9c0257114eb9399a2985f8e75dad7600c5d89fe3824ffa99ec1c3eb8bf3b0501')
    expect(labelhash('orivon')).toBe('0x5647e4d60b64b58da57fd01194be016e5e7bfaaf6a23c21c5e62242c1da25ef2')
  })

  it('do not change the case of a name, which is normalization\'s job', () => {
    expect(namehash('ETH')).not.toBe(namehash('eth'))
  })

  it('refuse an empty or oversized label', () => {
    expect(() => namehash('a..eth')).toThrow(NameError)
    expect(() => namehash('eth.')).toThrow(NameError)
    expect(() => namehash(`${'a'.repeat(64)}.eth`)).toThrow(NameError)
  })
})

describe('dnsEncode', () => {
  it('writes each label after its length, ending in a zero byte', () => {
    expect(toHex(dnsEncode('orivonstack.eth'))).toBe('0b6f7269766f6e737461636b0365746800')
    expect(toHex(dnsEncode('alice.v1.orivonid.eth'))).toBe('05616c696365' + '027631' + '086f7269766f6e6964' + '03657468' + '00')
    expect(toHex(dnsEncode(''))).toBe('00')
  })

  it('refuses what the wire format cannot carry', () => {
    expect(() => dnsEncode('a..b')).toThrow(NameError)
    expect(() => dnsEncode(Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.'))).toThrow('255')
  })
})
