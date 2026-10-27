import { describe, expect, it } from 'vitest'
import { concat, fromHex, toHex } from '../site/bytes.js'
import { contenthashCall, decodeAbiBytes, decodeAddress, decodeContenthash, namehash, REGISTRY, resolverCall } from '../site/ens.js'

// explore.orivonstack.eth's contenthash as the resolver returns it.
const EXPLORE_CONTENTHASH = 'e5010172002408011220e17c165e4115a2dfe03903da72b800c90ff815571613629ca42d59136889b867'
const EXPLORE_KEY = 'k51qzi5uqu5dlswot3wcjo7k3vy02gepnrdw2qhu2a3f6ll422kykyoljjshuv'
// The feed manifest of status.orivonstack.eth, set as `bzz://` + this.
const STATUS_FEED = 'fb21f431bc92f13bea4c9a16e255a2c9b9309d24258dd89bc0bb2d6284a32eb3'

/** The ABI encoding of a single `bytes` return value. */
function abiBytes (data: Uint8Array): string {
  const word = (n: number) => fromHex(n.toString(16).padStart(64, '0'))
  const padded = new Uint8Array(Math.ceil(data.length / 32) * 32)
  padded.set(data)
  return '0x' + toHex(concat(word(32), word(data.length), padded))
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

describe('eth_call payloads', () => {
  const node = namehash('foo.eth')

  it('asks the registry for resolver(bytes32)', () => {
    expect(resolverCall(node)).toEqual({ to: REGISTRY, data: '0x0178b8bf' + node.slice(2) })
    expect(REGISTRY).toBe('0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e')
  })

  it('asks the resolver for contenthash(bytes32)', () => {
    const resolver = '0x' + '11'.repeat(20)
    expect(contenthashCall(resolver, node)).toEqual({ to: resolver, data: '0xbc1c58d1' + node.slice(2) })
  })
})

describe('decoding answers', () => {
  it('reads an address, and null for the zero address', () => {
    expect(decodeAddress('0x' + '00'.repeat(12) + 'ab'.repeat(20))).toBe('0x' + 'ab'.repeat(20))
    expect(decodeAddress('0x' + '00'.repeat(32))).toBeNull()
    expect(decodeAddress('0x')).toBeNull()
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
