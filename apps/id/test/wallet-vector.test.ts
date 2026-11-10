import { describe, expect, it } from 'vitest'
import { toHex, utf8 } from '../site/sdk/bytes.js'
import { keccak256 } from '../site/sdk/keccak.js'
import { hashMessage } from '../site/sdk/siwe.js'
import { addressOf, recoverAddress, signDigest } from './support/secp256k1.ts'

// The conformance vector of Orivon's own ETH_0_1 (src/standards/official/eth-0-1.json): the key keccak256("cow")
// signs the bytes of "Hello World" as an EIP-191 personal message. The test signer, which a person's wallet
// stands in for in these tests, must give that signature byte for byte.
describe('the test signer', () => {
  const key = keccak256(utf8('cow'))
  const signature = 'b48cbb7331343e0d831876892f1eac6b4fbec2e3f5177a4790f4bed0a9e586af246b639027d0ade24c0219595b5fa30857b3b75dc64b6d52017b6e39365892071b'

  it('has the address of that key', () => {
    expect(addressOf(key)).toBe('0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826')
  })

  it('signs as Orivon\'s wallet does: deterministic, the low s, v as 27 or 28', () => {
    expect(toHex(signDigest(key, hashMessage('Hello World')))).toBe(signature)
  })

  it('recovers the address from that signature, and from none made for other bytes', () => {
    const bytes = Uint8Array.from(Buffer.from(signature, 'hex'))
    expect(recoverAddress(hashMessage('Hello World'), bytes)).toBe('0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826')
    expect(recoverAddress(hashMessage('Hello World!'), bytes)).not.toBe('0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826')
  })
})
