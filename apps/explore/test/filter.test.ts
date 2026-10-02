import { describe, expect, it } from 'vitest'
import type { Site } from '../site/catalog.js'
import { countSites, filterSites, groupByCategory, normalize } from '../site/filter.js'

const categories = [{ id: 'a', name: 'Exchange & DeFi' }, { id: 'b', name: 'Storage' }]
const sites: Site[] = [
  { id: 'curve', name: 'Curve', category: 'a', summary: 'Stablecoin exchange', ens: 'curve.eth' },
  { id: 'cafe', name: 'Café Pay', category: 'a', summary: 'Pay at the counter', orivon: { kind: 'native' } },
  { id: 'ipfs', name: 'IPFS', category: 'b', summary: 'Peer-to-peer files', ens: 'ipfs.eth', orivon: { kind: 'port' } }
]
const ids = (found: readonly { id: string }[]) => found.map((site) => site.id)

describe('filter', () => {
  it('matches on name, summary, ens name and category name', () => {
    expect(ids(filterSites(sites, categories, { query: 'curve' }))).toEqual(['curve'])
    expect(ids(filterSites(sites, categories, { query: 'counter' }))).toEqual(['cafe'])
    expect(ids(filterSites(sites, categories, { query: 'ipfs.eth' }))).toEqual(['ipfs'])
    expect(ids(filterSites(sites, categories, { query: 'defi' }))).toEqual(['curve', 'cafe'])
  })

  it('ignores case and accents, in the query and in the data', () => {
    expect(ids(filterSites(sites, categories, { query: 'CAFE' }))).toEqual(['cafe'])
    expect(ids(filterSites(sites, categories, { query: 'café' }))).toEqual(['cafe'])
    expect(normalize('Crème')).toBe('creme')
  })

  it('requires every term of the query', () => {
    expect(ids(filterSites(sites, categories, { query: 'stablecoin exchange' }))).toEqual(['curve'])
    expect(ids(filterSites(sites, categories, { query: 'stablecoin storage' }))).toEqual([])
  })

  it('composes the category and the Orivon-only filters with the query', () => {
    expect(ids(filterSites(sites, categories, { category: 'a' }))).toEqual(['curve', 'cafe'])
    expect(ids(filterSites(sites, categories, { orivonOnly: true }))).toEqual(['cafe', 'ipfs'])
    expect(ids(filterSites(sites, categories, { category: 'a', orivonOnly: true }))).toEqual(['cafe'])
    expect(ids(filterSites(sites, categories, { category: 'b', orivonOnly: true, query: 'peer' }))).toEqual(['ipfs'])
    expect(ids(filterSites(sites, categories, { category: 'b', query: 'curve' }))).toEqual([])
  })

  it('returns everything for an empty or blank query', () => {
    expect(filterSites(sites, categories, {})).toHaveLength(3)
    expect(filterSites(sites, categories, { query: '   ' })).toHaveLength(3)
  })

  it('counts per category and for the Orivon apps', () => {
    expect(countSites(sites)).toEqual({ total: 3, orivon: 2, byCategory: { a: 2, b: 1 } })
  })

  it('groups in category order and skips categories with no match', () => {
    const groups = groupByCategory(filterSites(sites, categories, { category: 'b' }), categories)
    expect(groups.map((group) => group.category.id)).toEqual(['b'])
    expect(groupByCategory(sites, categories).map((group) => ids(group.sites))).toEqual([['curve', 'cafe'], ['ipfs']])
  })
})
