import { describe, expect, it } from 'vitest'
import type { Site } from '../site/catalog.js'
import { chipsFor, isBlocked, isPublished, primaryHref, shortCid, upstreamChip } from '../site/addresses.js'

const CID = 'bafybeieqer67ojhi6q3eiatmrcu3r3mqjehn7hwit2satqjfnljo65fb4q'
const full: Site = { id: 'x', name: 'X', category: 'dev', summary: 's', web: 'https://x.example/app', ens: 'x.eth', ipfs: CID }
const inside = { inOrivon: true }
const outside = { inOrivon: false }

function without (site: Site, ...keys: Array<'web' | 'ens' | 'ipfs'>): Site {
  const copy = { ...site }
  for (const key of keys) delete copy[key]
  return copy
}

describe('addresses', () => {
  it('prefers ens, then ipfs, then web inside Orivon', () => {
    expect(primaryHref(full, inside)).toBe('https://x.eth/')
    expect(primaryHref(without(full, 'ens'), inside)).toBe(`ipfs://${CID}/`)
    expect(primaryHref(without(full, 'ens', 'ipfs'), inside)).toBe('https://x.example/app')
    expect(chipsFor(full, inside).map((chip) => chip.kind)).toEqual(['ens', 'ipfs', 'web'])
  })

  it('prefers web, then the eth.limo and dweb.link forms elsewhere', () => {
    expect(primaryHref(full, outside)).toBe('https://x.example/app')
    expect(primaryHref(without(full, 'web'), outside)).toBe('https://x.eth.limo/')
    expect(primaryHref(without(full, 'web', 'ens'), outside)).toBe(`https://${CID}.ipfs.dweb.link/`)
    expect(chipsFor(full, outside).map((chip) => chip.kind)).toEqual(['web', 'ens', 'ipfs'])
  })

  it('shows every address as a chip, and the ens chip names what it is', () => {
    const chips = chipsFor(full, inside)
    expect(chips.map((chip) => chip.text)).toEqual(['x.eth · ENS + IPFS', 'ipfs · bafybeie…fb4q', 'x.example'])
  })

  it('has no link for a site with no address, and shortens a long cid only', () => {
    expect(primaryHref({ id: 'y', name: 'Y', category: 'dev', summary: 's' } satisfies Site, inside)).toBeNull()
    expect(shortCid('short')).toBe('short')
    expect(shortCid(CID)).toBe('bafybeie…fb4q')
  })

  it('offers no link outside Orivon to an app that runs only in Orivon', () => {
    const lounge: Site = { id: 'thelounge', name: 'The Lounge', category: 'social', summary: 's', ipfs: CID, orivon: { kind: 'port', needsOrivon: true } }
    expect(isBlocked(lounge, outside)).toBe(true)
    expect(primaryHref(lounge, outside)).toBeNull()
    expect(chipsFor(lounge, outside)).toHaveLength(1)
    expect(chipsFor(lounge, outside).every((chip) => chip.href === null)).toBe(true)
    expect(isBlocked(lounge, inside)).toBe(false)
    expect(primaryHref(lounge, inside)).toBe(`ipfs://${CID}/`)
  })

  it('does not block an Orivon app that also works elsewhere', () => {
    const both: Site = { ...full, orivon: { kind: 'native' } }
    expect(isBlocked(both, outside)).toBe(false)
    expect(primaryHref(both, outside)).toBe('https://x.example/app')
  })

  it('names the upstream project on a port, published or not, and on nothing else', () => {
    const port: Site = { id: 'element', name: 'Element', category: 'social', summary: 's', orivon: { kind: 'port', needsOrivon: true, upstream: 'https://element.io', published: false } }
    expect(upstreamChip(port)).toEqual({ text: 'Ported from Element \u2197', title: 'https://element.io', href: 'https://element.io' })
    expect(upstreamChip(full)).toBeNull()
    expect(upstreamChip({ ...port, orivon: { kind: 'port', upstream: 'https://element.io', published: true } })).not.toBeNull()
  })

  it('has no address and no link for an announced app, in either environment', () => {
    const announced: Site = { id: 'element', name: 'Element', category: 'social', summary: 's', orivon: { kind: 'port', needsOrivon: true, upstream: 'https://element.io', published: false } }
    expect(isPublished(announced)).toBe(false)
    for (const env of [inside, outside]) {
      expect(chipsFor(announced, env)).toEqual([])
      expect(primaryHref(announced, env)).toBeNull()
    }
    expect(isPublished(full)).toBe(true)
    expect(isPublished({ ...announced, orivon: { kind: 'port', published: true } })).toBe(true)
  })
})
