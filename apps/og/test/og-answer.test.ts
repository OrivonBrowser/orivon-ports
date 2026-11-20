import { describe, expect, it } from 'vitest'
import { answerOf, MAX_RECORDS, MAX_VALUE, notFound, slotAddress, textAddress } from '../site/resolver/og-answer.js'
import { CONTRACT_KEY, REGISTRY_CONTENT, SOURCE, TEXT_KEYS } from '../site/resolver/og-pins.js'
import { dagPbCid } from '../site/sdk/cid.js'
import { fromHex } from '../site/sdk/bytes.js'

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

describe('slotAddress', () => {
  const JSUNBLAZE = '0xc452c1d588b1e9f01a272fee57ff9d29b22d163fbbb4fd8733f6e25a7dcbef34'

  it('turns the 32 bytes of the registry\'s slot into the ipfs address of the file whose sha2-256 digest they are', () => {
    expect(slotAddress(JSUNBLAZE)).toBe('ipfs://bafybeigekla5lcfr5hybujzp5zl77hjjwiwrmp53wt6yom7w4jnh3s7pgq')
    expect(slotAddress(JSUNBLAZE.toUpperCase().replace('0X', '0x'))).toBe(slotAddress(JSUNBLAZE))
  })

  it('is null for anything that is not 0x and 64 hexadecimal digits: the registry says nothing of what shorter or longer bytes mean', () => {
    for (const value of ['', '0x', JSUNBLAZE.slice(0, -2), `${JSUNBLAZE}00`, JSUNBLAZE.slice(2), `0x${'zz'.repeat(32)}`, ` ${JSUNBLAZE}`]) expect(slotAddress(value), value).toBeNull()
  })
})

describe('answerOf with the registry\'s slot', () => {
  const SLOT = `0x${'12'.repeat(32)}`
  const FROM_SLOT = { type: 'ipfs', value: `ipfs://${dagPbCid(fromHex(SLOT))}` }

  it('answers the slot as one ipfs record, with nothing else when no text key counted', () => {
    expect(answerOf({ [REGISTRY_CONTENT]: SLOT }).records).toEqual([FROM_SLOT])
  })

  it('lists the text records first, in the order of the keys, and the slot\'s record after them', () => {
    const answer = answerOf({ [REGISTRY_CONTENT]: SLOT, 'content.https': 'https://example.com/', 'content.ipfs': `ipfs://${CID}` })
    expect(answer.records).toEqual([{ type: 'ipfs', value: `ipfs://${CID}` }, { type: 'https', value: 'https://example.com/' }, FROM_SLOT])
  })

  it('lists the slot after the contract\'s record in the answer that has one, and in no answer without it', () => {
    const counted = { [REGISTRY_CONTENT]: SLOT, [CONTRACT_KEY]: `web3://0x${'ab'.repeat(20)}` }
    expect(answerOf(counted, undefined, { web3: true }).records.map((one) => one.type)).toEqual(['web3', 'ipfs'])
    expect(answerOf(counted).records).toEqual([FROM_SLOT])
  })

  it('answers one record, not two, when a text record names the same file', () => {
    expect(answerOf({ [REGISTRY_CONTENT]: SLOT, 'content.ipfs': FROM_SLOT.value }).records).toEqual([FROM_SLOT])
  })

  it('leaves out a slot that is not 32 bytes, and keeps every other record', () => {
    expect(answerOf({ [REGISTRY_CONTENT]: '0x1234', 'content.ipfs': `ipfs://${CID}` }).records).toEqual([{ type: 'ipfs', value: `ipfs://${CID}` }])
  })

  it('has room for the slot\'s record after every other record an answer can hold', () => {
    const byType: Record<string, string> = { ipfs: `ipfs://${CID}`, bzz: `bzz://${REFERENCE}`, arw: `ar://${ARWEAVE}`, magnet: MAGNET, ethfs: `eth://0x${'ab'.repeat(20)}`, https: 'https://example.com/', http: 'http://example.com/', ddoc: `sha256:${'cd'.repeat(32)}` }
    const every = { ...Object.fromEntries(TEXT_KEYS.map(([key, type]) => [key, byType[type]])), [CONTRACT_KEY]: `web3://0x${'ab'.repeat(20)}`, [REGISTRY_CONTENT]: SLOT }
    const records = answerOf(every, undefined, { web3: true }).records
    expect(records).toHaveLength(TEXT_KEYS.length + 2)
    expect(records.at(-1)).toEqual(FROM_SLOT)
    expect(records.length).toBeLessThanOrEqual(MAX_RECORDS)
  })
})

