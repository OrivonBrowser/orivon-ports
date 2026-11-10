import { describe, expect, it } from 'vitest'
import { fromHex } from '../site/sdk/bytes.js'
import { answerOf, MAX_RECORDS, MAX_VALUE, notFound, textAddress, TEXT_KEYS } from '../site/resolver/orv-answer.js'
import { addressOfContenthash, base32 } from '../site/resolver/orv-contenthash.js'

// Every expected string below is what multiformats' CID.decode(bytes).toV1() writes (ipfs) or
// CID.createV1(libp2p-key, multihash) in base36 (ipns): the form Orivon's ENS resolver gives for the same bytes.
const SHA = '29f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f'
const CONTENTHASHES: [name: string, hex: string, type: string, value: string][] = [
  ['ipfs, CIDv1 dag-pb', 'e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f', 'ipfs', 'ipfs://bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4'],
  ['ipfs, CIDv0 bytes become CIDv1', `e3011220${SHA}`, 'ipfs', 'ipfs://bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4'],
  ['ipfs, raw codec', 'e30101551220' + 'ab'.repeat(32), 'ipfs', 'ipfs://bafkreiflvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvm'],
  ['ipns, an ed25519 key in an identity multihash', 'e5010172002408011220' + 'cd'.repeat(32), 'ipns', 'ipns://k51qzi5uqu5dlb8yzi7gbzavdidvsjcgdrxekkw4ccqcxaaya35v6x86gd1eq5'],
  ['ipns, a key in a sha256 multihash', 'e50101721220' + '12'.repeat(32), 'ipns', 'ipns://k2k4r8jv88gvl6hqy7oqhwrokbs071ulgw2passpnydpevnfz5dg6hhu'],
  ['ipns, a DNS name in an identity multihash (DNSLink)', 'e5010155' + '00' + '10' + Buffer.from('docs.example.com').toString('hex'), 'ipns', 'ipns://docs.example.com'],
  ['swarm, a Keccak-256 manifest reference', 'e40101fa011b20' + '77'.repeat(32), 'bzz', 'bzz://' + '77'.repeat(32)],
  ['arweave, 32 bytes', '90b2ca05' + '07'.repeat(32), 'arw', 'ar://BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc']
]

describe('addressOfContenthash', () => {
  it.each(CONTENTHASHES)('writes %s as the address Orivon writes', (_name, hex, type, value) => {
    expect(addressOfContenthash(fromHex(hex))).toEqual({ type, value })
  })

  it('gives null for an empty contenthash, a cut-off one, a protocol the browser does not load, and a form it refuses', () => {
    for (const hex of ['', 'e30101', 'e3', 'bc03aabb', 'e3010172122012' + '12'.repeat(31), 'e4010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f',
      'e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f', '90b2ca0507', 'e5010155' + '00' + '04' + Buffer.from('a b.').toString('hex')]) {
      expect(addressOfContenthash(fromHex(hex)), hex).toBeNull()
    }
  })

  it('encodes base32 as RFC 4648 lower case without padding', () => {
    expect(base32(new TextEncoder().encode('foobar'))).toBe('mzxw6ytboi')
    expect(base32(new Uint8Array(0))).toBe('')
    expect(base32(Uint8Array.of(0xff))).toBe('74')
  })
})

describe('textAddress', () => {
  const GOOD: [type: string, value: string, written: string][] = [
    ['ipfs', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'],
    ['ipfs', '/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'],
    ['ipfs', 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'],
    ['ipfs', 'ipns://docs.example.com', 'ipns://docs.example.com'],
    ['ipfs', '/ipns/k51qzi5uqu5dlb8yzi7gbzavdidvsjcgdrxekkw4ccqcxaaya35v6x86gd1eq5', 'ipns://k51qzi5uqu5dlb8yzi7gbzavdidvsjcgdrxekkw4ccqcxaaya35v6x86gd1eq5'],
    ['bzz', `bzz://${'AB'.repeat(32)}`, `bzz://${'ab'.repeat(32)}`],
    ['bzz', 'cd'.repeat(32), `bzz://${'cd'.repeat(32)}`],
    ['arw', `ar://${'A'.repeat(43)}`, `ar://${'A'.repeat(43)}`],
    ['magnet', `magnet:?xt=urn:btih:${'1'.repeat(40)}&dn=app`, `magnet:?xt=urn:btih:${'1'.repeat(40)}&dn=app`],
    ['https', 'https://example.com', 'https://example.com/'],
    ['https', 'https://Example.com:8443/a/b', 'https://example.com:8443/a/b'],
    ['http', 'http://example.com/x', 'http://example.com/x'],
    ['ddoc', `sha256:${'0f'.repeat(32)}`, `sha256:${'0f'.repeat(32)}`]
  ]

  it.each(GOOD)('reads a %s record %s', (type, value, written) => {
    expect(textAddress(type, value)).toBe(written)
  })

  it('refuses what is not well-formed: nothing is repaired', () => {
    const BAD: [string, string][] = [
      ['ipfs', ''], ['ipfs', 'ipfs://'], ['ipfs', 'ipfs://bafy/path'], ['ipfs', 'ipfs://bafy?x=1'], ['ipfs', 'ipfs://bafy#x'], ['ipfs', ' ipfs://bafy'], ['ipfs', 'ipfs://ba fy'],
      ['bzz', 'bzz://abc'], ['bzz', 'ab'.repeat(64)], ['bzz', `bzz://${'ab'.repeat(32)}/x`], ['arw', 'ar://short'], ['arw', 'ar://' + 'A'.repeat(44)],
      ['magnet', 'magnet:?dn=x'], ['magnet', 'https://example.com'], ['https', 'http://example.com'], ['https', 'https://user@example.com/'], ['https', 'https://example.com/?q=1'],
      ['https', 'https://example.com/#x'], ['https', 'https://exa mple.com'], ['https', 'https://'], ['https', 'https://example.com\\evil'], ['http', 'https://example.com'],
      ['ddoc', 'sha256:abc'], ['ddoc', `SHA256:${'0f'.repeat(32)}`], ['ddoc', `sha256:${'0F'.repeat(32)}`], ['url', 'https://example.com/']
    ]
    for (const [type, value] of BAD) expect(textAddress(type, value), `${type} ${value}`).toBeNull()
  })

  it('refuses a value past the standard\'s bound, and anything outside visible ASCII', () => {
    expect(textAddress('https', 'https://example.com/' + 'a'.repeat(MAX_VALUE))).toBeNull()
    expect(textAddress('https', 'https://example.com/' + 'a'.repeat(MAX_VALUE - 20))).not.toBeNull()
    expect(textAddress('https', `https://example.com/${String.fromCodePoint(0xe9)}`)).toBeNull()
    expect(textAddress('https', 'https://example.com/\n')).toBeNull()
  })
})

describe('answerOf', () => {
  it('lists the records in a fixed order, the contenthash apart as the default, with an unproven provenance', () => {
    const answer = answerOf({
      contenthash: fromHex(CONTENTHASHES[0]![1]),
      texts: { 'content.ddoc': `sha256:${'0f'.repeat(32)}`, 'content.http': 'http://example.com/', 'content.ipfs': 'ipfs://bafy', 'content.bzz': 'cd'.repeat(32), 'url': 'https://example.com/' }
    }, 7)
    expect(answer.ownerDefault).toEqual({ type: 'ipfs', value: CONTENTHASHES[0]![3] })
    expect(answer.records.map((record) => record.type)).toEqual(['ipfs', 'bzz', 'http', 'ddoc'])
    expect(answer.provenance).toEqual({ by: 'Orivon ID', proven: false, block: 7 })
  })

  it('reads the text keys Orivon\'s ENS resolver reads, and no others', () => {
    expect(TEXT_KEYS).toEqual([
      ['content.ipfs', 'ipfs'], ['content.bzz', 'bzz'], ['content.arw', 'arw'], ['content.magnet', 'magnet'],
      ['content.https', 'https'], ['content.http', 'http'], ['content.ddoc', 'ddoc']
    ])
    expect(TEXT_KEYS.length).toBeLessThanOrEqual(MAX_RECORDS)
  })

  it('is the answer for a name with no records when nothing was found, with no block unless one is given', () => {
    expect(notFound()).toEqual({ ownerDefault: null, records: [], provenance: { by: 'Orivon ID', proven: false } })
    expect(notFound(9).provenance.block).toBe(9)
  })
})
