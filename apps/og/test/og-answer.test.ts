import { describe, expect, it } from 'vitest'
import { answerOf, MAX_RECORDS, MAX_VALUE, notFound, textAddress } from '../site/resolver/og-answer.js'
import { SOURCE, TEXT_KEYS } from '../site/resolver/og-pins.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const REFERENCE = 'ab'.repeat(32)
const ARWEAVE = 'A'.repeat(43)
const MAGNET = `magnet:?xt=urn:btih:${'1'.repeat(40)}`

describe('textAddress', () => {
  it('passes a well-formed value of each type as an address', () => {
    expect(textAddress('ipfs', `ipfs://${CID}`)).toBe(`ipfs://${CID}`)
    expect(textAddress('ipfs', `/ipfs/${CID}`)).toBe(`ipfs://${CID}`)
    expect(textAddress('ipfs', 'ipns://k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8')).toBe('ipns://k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8')
    expect(textAddress('ipfs', '/ipns/example.org')).toBe('ipns://example.org')
    expect(textAddress('ipfs', CID)).toBe(`ipfs://${CID}`)
    expect(textAddress('bzz', `bzz://${REFERENCE.toUpperCase()}`)).toBe(`bzz://${REFERENCE}`)
    expect(textAddress('bzz', REFERENCE)).toBe(`bzz://${REFERENCE}`)
    expect(textAddress('arw', `ar://${ARWEAVE}`)).toBe(`ar://${ARWEAVE}`)
    expect(textAddress('magnet', MAGNET)).toBe(MAGNET)
    expect(textAddress('ethfs', `eth://0x${'ab'.repeat(20)}`)).toBe(`eth://0x${'ab'.repeat(20)}`)
    expect(textAddress('https', 'https://example.com/app')).toBe('https://example.com/app')
    expect(textAddress('http', 'http://example.com')).toBe('http://example.com/')
    expect(textAddress('ddoc', `sha256:${'cd'.repeat(32)}`)).toBe(`sha256:${'cd'.repeat(32)}`)
  })

  it('leaves out a value that is not well-formed for its type', () => {
    const bad: [string, string][] = [
      ['ipfs', `ipfs://${CID}/path`], ['ipfs', 'ipfs://'], ['ipfs', 'ipns://'], ['ipfs', `ipfs://${CID}?x=1`],
      ['bzz', 'bzz://abcd'], ['bzz', `bzz://${REFERENCE}/index`], ['bzz', 'abcd'],
      ['arw', `ar://${'A'.repeat(42)}`], ['arw', `ar://${ARWEAVE}/x`],
      ['magnet', 'magnet:?dn=x'], ['magnet', 'https://example.com'],
      ['ethfs', 'eth://0x12'], ['ethfs', `https://0x${'ab'.repeat(20)}`],
      ['https', 'http://example.com'], ['https', 'https://user:pass@example.com'], ['https', 'https://example.com/?q=1'], ['https', 'https://'], ['https', 'https://example.com\\evil.com'],
      ['http', 'https://example.com'],
      ['ddoc', `sha256:${'cd'.repeat(31)}`], ['ddoc', `sha1:${'cd'.repeat(20)}`],
      ['other', 'anything'], ['ipfs', ''], ['ipfs', ` ipfs://${CID}`], ['https', `https://example.com/${'a'.repeat(MAX_VALUE)}`]
    ]
    for (const [type, value] of bad) expect(textAddress(type, value), `${type} ${value}`).toBeNull()
  })

  it('leaves out a value with anything but visible ASCII', () => {
    for (const value of [`ipfs://${CID}\n`, `ipfs://${CID} `, 'https://exämple.com/', `bzz://${REFERENCE}\u0000`]) {
      expect(textAddress(value.startsWith('bzz') ? 'bzz' : value.startsWith('ipfs') ? 'ipfs' : 'https', value), value).toBeNull()
    }
  })
})

describe('answerOf', () => {
  it('lists the records that counted in the fixed order of the keys, with no owner default', () => {
    const answer = answerOf({ 'content.https': 'https://example.com/', 'content.ipfs': `ipfs://${CID}`, 'content.bzz': `bzz://${REFERENCE}` }, 26_000_000)
    expect(answer).toEqual({
      ownerDefault: null,
      records: [{ type: 'ipfs', value: `ipfs://${CID}` }, { type: 'bzz', value: `bzz://${REFERENCE}` }, { type: 'https', value: 'https://example.com/' }],
      provenance: { by: SOURCE, proven: false, block: 26_000_000 }
    })
  })

  it('names the source in 80 characters or fewer and never says a record was proven', () => {
    expect(SOURCE.length).toBeLessThanOrEqual(80)
    expect(answerOf({}).provenance).toEqual({ by: SOURCE, proven: false })
  })

  it('answers no records for values that are not addresses, and never more than the standard allows', () => {
    expect(answerOf({ 'content.ipfs': 'not an address', 'content.bzz': '' }).records).toEqual([])
    expect(MAX_RECORDS).toBeGreaterThanOrEqual(TEXT_KEYS.length)
  })

  it('answers a name that is not there as one with nothing in it, at the block that said so', () => {
    expect(notFound(7)).toEqual({ ownerDefault: null, records: [], provenance: { by: SOURCE, proven: false, block: 7 } })
  })
})
