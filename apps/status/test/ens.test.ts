import { describe, expect, it } from 'vitest'
import { concat, fromHex, toHex } from '../site/bytes.js'
import { contenthashLookup, decodeAbiBytes, decodeContenthash, decodeResolveAnswer, dnsEncode, namehash, revertMeaning, UNIVERSAL_RESOLVER } from '../site/ens.js'

// explore.orivonstack.eth's contenthash as the resolver returns it.
const EXPLORE_CONTENTHASH = 'e5010172002408011220e17c165e4115a2dfe03903da72b800c90ff815571613629ca42d59136889b867'
const EXPLORE_KEY = 'k51qzi5uqu5dlswot3wcjo7k3vy02gepnrdw2qhu2a3f6ll422kykyoljjshuv'
// The feed manifest of status.orivonstack.eth, set as `bzz://` + this.
const STATUS_FEED = 'fb21f431bc92f13bea4c9a16e255a2c9b9309d24258dd89bc0bb2d6284a32eb3'
const STATUS_KEY = 'k51qzi5uqu5dh386n6jw6dolvnxvxp5s1x9c0mhf8igbgvbahcnnxtkjz4qnml'
// The Universal Resolver call for foo.eth as viem encodes it, and mainnet's answers to real calls: status.orivonstack.eth
// (an ENSv2 name, which the v1 registry lists with no resolver), and the revert for a name nobody registered.
const SUPERPRODUCTIVITY_LOOKUP = '0x9061b923000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000002311737570657270726f6475637469766974790b6f7269766f6e737461636b036574680000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000024bc1c58d188ac5461bc04b230f29b70dbee792b401b32427f3aa9b924d3f5dd965fd6199700000000000000000000000000000000000000000000000000000000'
const FOO_LOOKUP = '0x9061b92300000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000903666f6f036574680000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000024bc1c58d1de9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f00000000000000000000000000000000000000000000000000000000'
const STATUS_ANSWER = '0x0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000f29100983e058b709f3d539b0c765937b804ac1500000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002ae50101720024080112202460095f41c03b13ffd464d02274359dff728eb8cf7124f53c58dd2f555a1a1d00000000000000000000000000000000000000000000'
const NOT_FOUND = '0x77209fe800000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000017116f7269766f6e2d6e6f70652d7a7a3931780365746800000000000000000000'

/** The ABI encoding of a single `bytes` return value. */
function abiBytes (data: Uint8Array): string {
  const word = (n: number) => fromHex(n.toString(16).padStart(64, '0'))
  const padded = new Uint8Array(Math.ceil(data.length / 32) * 32)
  padded.set(data)
  return '0x' + toHex(concat(word(32), word(data.length), padded))
}

/** The Universal Resolver's answer, `(bytes result, address resolver)`, around a resolver's raw return value. */
function resolveAnswer (raw: Uint8Array): string {
  const lengthAndBytes = abiBytes(raw).slice(2 + 64)
  return `0x${(64).toString(16).padStart(64, '0')}${'00'.repeat(12)}${'11'.repeat(20)}${lengthAndBytes}`
}

describe('namehash (EIP-137)', () => {
  it('matches the specification vectors', () => {
    expect(namehash('')).toBe('0x' + '00'.repeat(32))
    expect(namehash('eth')).toBe('0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae')
    expect(namehash('foo.eth')).toBe('0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f')
  })

  it('lower-cases the name', () => {
    expect(namehash('Foo.ETH')).toBe(namehash('foo.eth'))
  })
})

describe('the Universal Resolver call', () => {
  it('encodes a name in DNS wire form', () => {
    expect(toHex(dnsEncode('status.orivonstack.eth'))).toBe('067374617475730b6f7269766f6e737461636b0365746800')
    expect(() => dnsEncode('a..eth')).toThrow()
  })

  it('asks resolve(bytes,bytes) for contenthash(bytes32), byte for byte as viem does', () => {
    expect(contenthashLookup('foo.eth')).toEqual({ to: UNIVERSAL_RESOLVER, data: FOO_LOOKUP })
    // A name of 35 DNS bytes, which takes two padded words.
    expect(contenthashLookup('superproductivity.orivonstack.eth').data).toBe(SUPERPRODUCTIVITY_LOOKUP)
    expect(UNIVERSAL_RESOLVER).toBe('0xeeeeeeee14d718c2b47d9923deab1335e144eeee')
  })
})

describe('decoding answers', () => {
  it("reads the contenthash in mainnet's answer for status.orivonstack.eth", () => {
    expect(decodeContenthash(decodeResolveAnswer(STATUS_ANSWER))).toEqual({ kind: 'ipns', uri: `ipns://${STATUS_KEY}`, cid: STATUS_KEY })
  })

  it('reads a resolver that keeps no contenthash, or returns nothing, as empty bytes', () => {
    expect(decodeResolveAnswer(resolveAnswer(fromHex(abiBytes(new Uint8Array(0))))).length).toBe(0)
    expect(decodeResolveAnswer(resolveAnswer(new Uint8Array(0))).length).toBe(0)
  })

  it('refuses an answer too short to be (bytes, address)', () => {
    expect(() => decodeResolveAnswer('0x')).toThrow()
    expect(() => decodeResolveAnswer('0x' + '00'.repeat(95))).toThrow()
  })

  it('tells the reverts apart: no resolver, no contenthash, answered offchain, anything else', () => {
    const wrapped = (inner: string): string => `0x95c0c752${(32).toString(16).padStart(64, '0')}${(inner.length / 2).toString(16).padStart(64, '0')}${inner.padEnd(Math.ceil(inner.length / 64) * 64, '0')}`
    expect(revertMeaning(NOT_FOUND)).toBe('noresolver')
    expect(revertMeaning('0x1e9535f2' + '00'.repeat(64))).toBe('noresolver')
    expect(revertMeaning(wrapped('5fe9a5df' + '00'.repeat(64)))).toBe('noresolver')
    expect(revertMeaning(wrapped('08c379a0' + '00'.repeat(64)))).toBe('other')
    expect(revertMeaning('0x7B1C461B' + 'bc1c58d1'.padEnd(64, '0'))).toBe('nocontenthash')
    expect(revertMeaning('0x556f1830' + '00'.repeat(32))).toBe('offchain')
    expect(revertMeaning('')).toBe('other')
  })

  it('reads ABI bytes, including an empty value', () => {
    const data = fromHex(EXPLORE_CONTENTHASH)
    expect(toHex(decodeAbiBytes(abiBytes(data)))).toBe(EXPLORE_CONTENTHASH)
    expect(decodeAbiBytes(abiBytes(new Uint8Array(0))).length).toBe(0)
    expect(decodeAbiBytes('0x').length).toBe(0)
  })

  it('refuses ABI bytes whose length runs past the answer', () => {
    const short = abiBytes(fromHex(EXPLORE_CONTENTHASH)).slice(0, 150)
    expect(() => decodeAbiBytes(short)).toThrow()
  })
})

describe('contenthash', () => {
  it('decodes the real explore.orivonstack.eth value to its ipns:// key', () => {
    expect(decodeContenthash(fromHex(EXPLORE_CONTENTHASH))).toEqual({ kind: 'ipns', uri: `ipns://${EXPLORE_KEY}`, cid: EXPLORE_KEY })
  })

  it('decodes an ipfs namespace value to a base32 CIDv1', () => {
    const cid = '01701220' + '3c5a1d92f296743bfca96a58d332dfa4fd3ddc2f44e3e2dd92af5fa48dc0d68f'
    expect(decodeContenthash(fromHex('e301' + cid))).toEqual({
      kind: 'ipfs',
      uri: 'ipfs://bafybeib4liozf4uwoq57zklkldjtfx5e7u65yl2e4prn3evpl6si3qgwr4',
      cid: 'bafybeib4liozf4uwoq57zklkldjtfx5e7u65yl2e4prn3evpl6si3qgwr4'
    })
  })

  it('decodes a Swarm value (a keccak-256 swarm-manifest CID) to its 64 hex character reference', () => {
    expect(decodeContenthash(fromHex('e40101fa011b20' + STATUS_FEED))).toEqual({ kind: 'swarm', uri: `bzz://${STATUS_FEED}`, reference: STATUS_FEED })
  })

  it('does not call a Swarm value a reference unless it is a manifest of a 32-byte keccak-256 hash', () => {
    const body = '00'.repeat(32)
    const notManifest = ['e4010155011b20' + body, 'e40101fa011220' + body, 'e40101fa011b20' + body.slice(2), 'e40101fa011b20' + body + '00', 'e40101fa011b20', 'e401']
    for (const hex of notManifest) {
      expect(decodeContenthash(fromHex(hex)), hex).toMatchObject({ kind: 'other' })
    }
  })

  it('reports empty and unknown namespaces without throwing', () => {
    expect(decodeContenthash(new Uint8Array(0))).toEqual({ kind: 'empty' })
    expect(decodeContenthash(fromHex('e60101fa011b20' + '00'.repeat(32))).kind).toBe('other')
  })
})
