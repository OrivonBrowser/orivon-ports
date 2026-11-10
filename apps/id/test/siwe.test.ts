import { describe, expect, it } from 'vitest'
import { toHex } from '../site/sdk/bytes.js'
import { buildMessage, formatTime, hashMessage, isAuthority, isUri, MAX_MESSAGE_BYTES, parseMessage, parseTime, SiweError } from '../site/sdk/siwe.js'

// The first example of EIP-4361. The others, and every hash, were made by viem's createSiweMessage and hashMessage
// (2.56.8) and are pasted here, so these files do not depend on viem being installed.
const EIP_EXAMPLE = `example.com wants you to sign in with your Ethereum account:
0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2

I accept the ExampleOrg Terms of Service: https://example.com/tos

URI: https://example.com/login
Version: 1
Chain ID: 1
Nonce: 32891756
Issued At: 2021-09-30T16:25:24Z
Resources:
- ipfs://bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq/
- https://example.com/my-web2-claim.json`

const VIEM_EXAMPLE = EIP_EXAMPLE.replace('24Z', '24.000Z')
const VIEM_EXAMPLE_HASH = '0xeb19b4c54c2951805f787f78e27e9b249acb59b3f59c268327c60e0948b49e03'

const EVERYTHING = 'https://localhost:3000 wants you to sign in with your Ethereum account:\n0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826\n\nHello, world.\n\n' +
  'URI: https://localhost:3000/path?x=1#y\nVersion: 1\nChain ID: 137\nNonce: ABCD1234efgh\nIssued At: 2026-11-06T12:00:00.123Z\n' +
  'Expiration Time: 2026-11-07T12:00:00.000Z\nNot Before: 2026-11-06T11:59:00.000Z\nRequest ID: req-1\nResources:'
const EVERYTHING_HASH = '0x5c1c4a984dfec0475395678a1110a58dc9243338a047c149c9a84241b9e7d27e'

const NO_STATEMENT = 'id.orivonstack.eth wants you to sign in with your Ethereum account:\n0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826\n\n\n' +
  'URI: https://example.org\nVersion: 1\nChain ID: 1\nNonce: abcdefgh12345678\nIssued At: 2026-11-06T12:00:00.000Z\nExpiration Time: 2026-11-06T12:10:00.000Z'

const hash = (text: string) => '0x' + toHex(hashMessage(text))

describe('building and reading', () => {
  it('reads the first example of EIP-4361 and writes it back byte for byte', () => {
    const fields = parseMessage(EIP_EXAMPLE)
    expect(fields).toEqual({
      domain: 'example.com',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      statement: 'I accept the ExampleOrg Terms of Service: https://example.com/tos',
      uri: 'https://example.com/login',
      version: '1',
      chainId: 1,
      nonce: '32891756',
      issuedAt: '2021-09-30T16:25:24Z',
      resources: ['ipfs://bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq/', 'https://example.com/my-web2-claim.json']
    })
    expect(buildMessage(fields)).toBe(EIP_EXAMPLE)
  })

  it('writes what viem writes for the same fields, and reads what viem wrote', () => {
    expect(buildMessage({ ...parseMessage(EIP_EXAMPLE), issuedAt: '2021-09-30T16:25:24.000Z' })).toBe(VIEM_EXAMPLE)
    expect(parseMessage(VIEM_EXAMPLE).issuedAt).toBe('2021-09-30T16:25:24.000Z')
    const all = parseMessage(EVERYTHING)
    expect(all).toMatchObject({ scheme: 'https', domain: 'localhost:3000', chainId: 137, requestId: 'req-1', resources: [] })
    expect(all.notBefore).toBe('2026-11-06T11:59:00.000Z')
    expect(buildMessage(all)).toBe(EVERYTHING)
  })

  it('has the two blank lines of EIP-4361 where a statement would be, when there is none', () => {
    const fields = parseMessage(NO_STATEMENT)
    expect(fields.statement).toBeUndefined()
    expect(buildMessage(fields)).toBe(NO_STATEMENT)
  })

  it('hashes as a wallet does for a personal message: the prefix, the length in bytes, the text', () => {
    expect(hash(VIEM_EXAMPLE)).toBe(VIEM_EXAMPLE_HASH)
    expect(hash(EVERYTHING)).toBe(EVERYTHING_HASH)
    expect(hash('Hello World')).toBe('0xa1de988600a42c4b4ab089b619297c17d53cffae5d5120d82d8a92d0bb3b78f2')
    expect(hash('héllo')).toBe('0x42fd95dd8ed22d7d934d6ffff71ed0b730835b0de4bb3532a271568c8760c8d2')
    expect(hash('')).toBe('0x5f35dce98ba4fba25530a026ed80b2cecdaa31091ba4958b99b52ea1d068adad')
  })
})

describe('reading is strict: anything that is not the one form is refused', () => {
  const swap = (text: string, from: string, to: string) => {
    expect(text).toContain(from)
    return text.replace(from, to)
  }
  const refused: [string, string][] = [
    ['a carriage return', EIP_EXAMPLE.replace(/\n/g, '\r\n')],
    ['a final line feed', EIP_EXAMPLE + '\n'],
    ['a lower-case address', swap(EIP_EXAMPLE, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')],
    ['a wrong checksum', swap(EIP_EXAMPLE, '0xC02aaA39', '0xc02aaA39')],
    ['an address that is short', swap(EIP_EXAMPLE, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756C')],
    ['an empty statement written out', swap(EIP_EXAMPLE, 'Cc2\n\nI accept', 'Cc2\n\n\nI accept').replace('/tos\n\nURI', '/tos\n\n\nURI')],
    ['no blank line after the address', swap(EIP_EXAMPLE, 'Cc2\n\nI accept', 'Cc2\nI accept')],
    ['a statement with a percent sign', swap(EIP_EXAMPLE, 'Terms of Service', '100% of Service')],
    ['a statement with a quotation mark', swap(EIP_EXAMPLE, 'Terms of Service', '"Terms" of Service')],
    ['a statement outside ASCII', swap(EIP_EXAMPLE, 'ExampleOrg', 'Exämple')],
    ['a tab in the statement', swap(EIP_EXAMPLE, 'accept the', 'accept\tthe')],
    ['a version other than 1', swap(EIP_EXAMPLE, 'Version: 1', 'Version: 2')],
    ['a chain id with a leading zero', swap(EIP_EXAMPLE, 'Chain ID: 1', 'Chain ID: 01')],
    ['a chain id that is not a number', swap(EIP_EXAMPLE, 'Chain ID: 1', 'Chain ID: 1.0')],
    ['an empty chain id', swap(EIP_EXAMPLE, 'Chain ID: 1', 'Chain ID: ')],
    ['a nonce of seven characters', swap(EIP_EXAMPLE, '32891756', '3289175')],
    ['a nonce with a dash', swap(EIP_EXAMPLE, '32891756', '3289-756')],
    ['fields out of order', swap(EIP_EXAMPLE, 'Version: 1\nChain ID: 1', 'Chain ID: 1\nVersion: 1')],
    ['no Issued At', swap(EIP_EXAMPLE, 'Issued At: 2021-09-30T16:25:24Z\n', '')],
    ['a field the grammar does not have', swap(EIP_EXAMPLE, 'Resources:', 'Audience: x\nResources:')],
    ['Not Before in front of Expiration Time', swap(EVERYTHING, 'Expiration Time: 2026-11-07T12:00:00.000Z\nNot Before: 2026-11-06T11:59:00.000Z', 'Not Before: 2026-11-06T11:59:00.000Z\nExpiration Time: 2026-11-07T12:00:00.000Z')],
    ['a date that does not exist', swap(EIP_EXAMPLE, '2021-09-30T16', '2021-02-30T16')],
    ['a month 13', swap(EIP_EXAMPLE, '2021-09-30T16', '2021-13-01T16')],
    ['hour 24', swap(EIP_EXAMPLE, 'T16:25:24Z', 'T24:25:24Z')],
    ['a time with a space for the T', swap(EIP_EXAMPLE, '30T16', '30 16')],
    ['a time with no zone', swap(EIP_EXAMPLE, '16:25:24Z', '16:25:24')],
    ['a resource with no dash', swap(EIP_EXAMPLE, '- https://example.com/my', 'https://example.com/my')],
    ['a resource with no scheme', swap(EIP_EXAMPLE, '- https://example.com/my-web2-claim.json', '- example.com/my-web2-claim.json')],
    ['a resource with a space', swap(EIP_EXAMPLE, 'my-web2-claim', 'my web2 claim')],
    ['a URI with an angle bracket', swap(EIP_EXAMPLE, '/login', '/<login>')],
    ['a URI with a bad escape', swap(EIP_EXAMPLE, '/login', '/lo%2gin')],
    ['a domain with a path', swap(EIP_EXAMPLE, 'example.com wants', 'example.com/x wants')],
    ['no domain', swap(EIP_EXAMPLE, 'example.com wants', ' wants')],
    ['a misspelled first line', swap(EIP_EXAMPLE, 'sign in with your Ethereum account', 'sign in with your Ethereum wallet')],
    ['a scheme that starts with a digit', `1http://${EIP_EXAMPLE}`],
    ['a message of more than 8192 bytes', swap(EIP_EXAMPLE, '- https://example.com/my-web2-claim.json', `- https://example.com/${'a'.repeat(MAX_MESSAGE_BYTES)}`)]
  ]
  it.each(refused)('refuses %s', (_name, text) => {
    expect(() => parseMessage(text)).toThrow(SiweError)
  })

  it('refuses what is not text', () => {
    expect(() => parseMessage(undefined as unknown as string)).toThrow(SiweError)
  })
})

describe('building is as strict', () => {
  const fields = parseMessage(EIP_EXAMPLE)
  it.each([
    ['a domain with a space', { domain: 'a b' }],
    ['a lower-case address', { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' }],
    ['a statement with a line feed', { statement: 'one\ntwo' }],
    ['an empty statement', { statement: '' }],
    ['a version 2', { version: '2' as '1' }],
    ['a chain id that is not an integer', { chainId: 1.5 }],
    ['a short nonce', { nonce: 'abc' }],
    ['a time that is not a time', { issuedAt: 'yesterday' }],
    ['a resource that is not a URI', { resources: ['nope'] }],
    ['a request id with a space', { requestId: 'a b' }]
  ])('refuses %s', (_name, change) => {
    expect(() => buildMessage({ ...fields, ...change })).toThrow(SiweError)
  })
})

describe('the leaves of the grammar', () => {
  it('knows an RFC 3986 URI', () => {
    for (const uri of [
      'https://example.com', 'https://example.com/a/b?c=d#e', 'ipfs://Qme7ss3ARVgxv6rXqVPiikMJ8u2NLgmgszg13pYrDKEoiu', 'orivonid:name:alice.v1.orivonid.eth',
      'orivonid:key:p256:0x02ab', 'urn:isbn:0451450523', 'mailto:a@b.example', 'https://user:pw@[2001:db8::1]:8443/p', 'file:///etc/hosts', 'a+b.c-d:x', 'https://a.b/%41'
    ]) expect(isUri(uri), uri).toBe(true)
    for (const uri of [
      '', 'example.com', '//example.com', '/path', 'https://exa mple.com', 'https://a.b/<', 'https://a.b/%zz', 'https://a.b#x#y', '1a:b', 'https://a.b:80a/', 'https://[::1/', ':x'
    ]) expect(isUri(uri), uri).toBe(false)
  })

  it('knows an authority', () => {
    for (const authority of ['example.com', 'id.orivonstack.eth', 'localhost:3000', '127.0.0.1:8080', '[::1]:3000', 'u@host']) expect(isAuthority(authority), authority).toBe(true)
    for (const authority of ['', 'a b', 'a/b', 'a?b', 'a#b', 'host:12x']) expect(isAuthority(authority), authority).toBe(false)
  })

  it('reads an RFC 3339 date-time to milliseconds, or null', () => {
    expect(parseTime('2021-09-30T16:25:24Z')).toBe(1_633_019_124_000)
    expect(parseTime('2021-09-30T16:25:24.5Z')).toBe(1_633_019_124_500)
    expect(parseTime('2021-09-30T17:25:24+01:00')).toBe(1_633_019_124_000)
    expect(parseTime('2021-09-30T15:25:24-01:00')).toBe(1_633_019_124_000)
    expect(parseTime('2021-09-30t16:25:24z')).toBe(1_633_019_124_000)
    expect(parseTime('2024-02-29T00:00:00Z')).toBe(1_709_164_800_000)
    expect(parseTime('2023-02-29T00:00:00Z')).toBeNull()
    expect(parseTime('2100-02-29T00:00:00Z')).toBeNull()
    expect(parseTime('2000-02-29T00:00:00Z')).not.toBeNull()
    for (const text of ['2021-09-31T00:00:00Z', '2021-00-10T00:00:00Z', '2021-09-30T24:00:00Z', '2021-09-30T00:60:00Z', '2021-09-30T00:00:61Z', '2021-09-30T00:00:00+24:00', '21-09-30T00:00:00Z', '2021-09-30', '']) {
      expect(parseTime(text), text).toBeNull()
    }
    expect(parseTime(5)).toBeNull()
  })

  it('writes the time both sides use: UTC, whole seconds, a Z', () => {
    expect(formatTime(1_633_019_124)).toBe('2021-09-30T16:25:24Z')
    expect(formatTime(0)).toBe('1970-01-01T00:00:00Z')
    expect(() => formatTime(-1)).toThrow(SiweError)
    expect(() => formatTime(1.5)).toThrow(SiweError)
    expect(() => formatTime(253_402_300_800)).toThrow(SiweError)
  })
})
