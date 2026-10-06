import { describe, expect, it } from 'vitest'
import { devNameProblem, domainProblem, isValidDomain, NO_DOMAIN_APPS } from './manifest-domain.ts'

describe('devNameProblem', () => {
  it('passes a development name that is the domain, or an app with either missing', () => {
    expect(devNameProblem('lounge', 'thelounge.orivonstack.eth', 'thelounge.orivonstack.eth')).toBeUndefined()
    expect(devNameProblem('lounge', undefined, 'thelounge.orivonstack.eth')).toBeUndefined()
    expect(devNameProblem('bisq-fake', 'bisq.eth', undefined)).toBeUndefined()
  })

  it('fails a development name that differs from the domain', () => {
    expect(devNameProblem('lounge', 'lounge.eth', 'thelounge.orivonstack.eth')).toMatch(/not the manifest's "domain"/)
  })
})

describe('isValidDomain', () => {
  it('accepts one lowercase ENS name or DNS host', () => {
    for (const ok of ['thelounge.orivonstack.eth', 'app.example.com', 'a-b.c1.eth', 'xn--bcher-kva.example', `${'a'.repeat(63)}.eth`]) {
      expect(isValidDomain(ok), ok).toBe(true)
    }
  })

  it('rejects anything that is not already the canonical host', () => {
    const bad = [
      'https://x.eth', 'X.ETH', 'x.eth.', 'x.eth:443', 'x.eth/a', 'x.eth?q', 'x.eth#f', 'a@x.eth',
      'x .eth', 'x..eth', '.x.eth', 'bücher.example', '[::1]', 'a_b.example',
      '-x.eth', 'x-.eth', 'x.-eth', 'x.eth-', `${'a'.repeat(64)}.eth`
    ]
    for (const input of bad) expect(isValidDomain(input), input).toBe(false)
  })

  it('rejects IP addresses, localhost, single labels and the .orivon content space', () => {
    for (const input of ['1.2.3.4', '127.1', 'a.1', 'eth', 'localhost', 'app.localhost', 'bafyexample.ipfs.orivon', 'x.orivon']) {
      expect(isValidDomain(input), input).toBe(false)
    }
  })

  it('bounds the length at 253 characters', () => {
    const label = 'a'.repeat(60)
    const at253 = `${label}.${label}.${label}.${label}.${'b'.repeat(253 - 4 * 61)}`
    expect(at253).toHaveLength(253)
    expect(isValidDomain(at253)).toBe(true)
    expect(isValidDomain(`${at253}b`)).toBe(false)
  })

  it('rejects non-strings and the empty string', () => {
    for (const input of [undefined, null, 42, {}, [], '']) expect(isValidDomain(input), String(input)).toBe(false)
  })
})

describe('domainProblem', () => {
  it('names a missing domain and a malformed one separately', () => {
    expect(domainProblem('freetube', undefined)).toMatch(/"domain" is required/)
    expect(domainProblem('freetube', 'X.ETH')).toMatch(/not one URL-canonical/)
    expect(domainProblem('my-app-', 'my-app-.orivonstack.eth')).toMatch(/not one URL-canonical/)
    expect(domainProblem('freetube', 'freetube.orivonstack.eth')).toBeUndefined()
  })

  it('exempts only the apps on the explicit allowlist, and they must stay without one', () => {
    expect([...NO_DOMAIN_APPS]).toEqual(['bisq-fake'])
    expect(domainProblem('bisq-fake', undefined)).toBeUndefined()
    expect(domainProblem('bisq-fake', 'bisq.orivonstack.eth')).toMatch(/must not name a domain/)
    expect(domainProblem('not-bisq', undefined)).toMatch(/required/)
  })
})
