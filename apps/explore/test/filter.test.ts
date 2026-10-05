import { describe, expect, it } from 'vitest'
import type { Site } from '../site/catalog.js'
import { countSites, filterSites, groupByCategory, inSection, isWeb3, normalize } from '../site/filter.js'

const categories = [{ id: 'a', name: 'Exchange & DeFi' }, { id: 'b', name: 'Storage' }]
const sites: Site[] = [
  { id: 'curve', name: 'Curve', category: 'a', summary: 'Stablecoin exchange', ens: 'curve.eth' },
  { id: 'cafe', name: 'Café Pay', category: 'a', summary: 'Pay at the counter', orivon: { kind: 'native' } },
  { id: 'ipfs', name: 'IPFS', category: 'b', summary: 'Peer-to-peer files', ens: 'ipfs.eth', orivon: { kind: 'port' } },
  { id: 'swapweb', name: 'Swap Web', category: 'a', summary: 'Stablecoin swaps on a server', web: 'https://swap.example' }
]
const ids = (found: readonly { id: string }[]) => found.map((site) => site.id)

describe('filter', () => {
  it('calls a site Web3 when it is an Orivon app or has an ENS name or an IPFS address', () => {
    expect(sites.filter(isWeb3).map((site) => site.id)).toEqual(['curve', 'cafe', 'ipfs'])
    expect(isWeb3({ id: 'x', name: 'X', category: 'a', summary: 's', ipfs: 'bafy' })).toBe(true)
    expect(isWeb3({ id: 'x', name: 'X', category: 'a', summary: 's', web: 'https://x.example', ens: 'x.eth' })).toBe(true)
  })

  it('puts every site in exactly one of Web3 and Web2, and all of them in All', () => {
    for (const site of sites) {
      expect(inSection(site, 'web3')).not.toBe(inSection(site, 'web2'))
      expect(inSection(site, 'all')).toBe(true)
    }
  })

  it('matches on name, summary, ens name and category name', () => {
    expect(ids(filterSites(sites, categories, { query: 'curve' }))).toEqual(['curve'])
    expect(ids(filterSites(sites, categories, { query: 'counter' }))).toEqual(['cafe'])
    expect(ids(filterSites(sites, categories, { query: 'ipfs.eth' }))).toEqual(['ipfs'])
    expect(ids(filterSites(sites, categories, { query: 'defi' }))).toEqual(['curve', 'cafe', 'swapweb'])
  })

  it('ignores case and accents, in the query and in the data', () => {
    expect(ids(filterSites(sites, categories, { query: 'CAFE' }))).toEqual(['cafe'])
    expect(ids(filterSites(sites, categories, { query: 'café' }))).toEqual(['cafe'])
    expect(normalize('Crème')).toBe('creme')
  })

  it('requires every term of the query', () => {
    expect(ids(filterSites(sites, categories, { query: 'stablecoin exchange' }))).toEqual(['curve', 'swapweb'])
    expect(ids(filterSites(sites, categories, { query: 'stablecoin storage' }))).toEqual([])
  })

  it('searches the Web3 sites alone, or the Web2 ones too', () => {
    expect(ids(filterSites(sites, categories, { query: 'stablecoin', section: 'web3' }))).toEqual(['curve'])
    expect(ids(filterSites(sites, categories, { query: 'stablecoin', section: 'all' }))).toEqual(['curve', 'swapweb'])
    expect(ids(filterSites(sites, categories, { query: 'stablecoin', section: 'web2' }))).toEqual(['swapweb'])
  })

  it('composes the section and the category with the query', () => {
    expect(ids(filterSites(sites, categories, { category: 'a' }))).toEqual(['curve', 'cafe', 'swapweb'])
    expect(ids(filterSites(sites, categories, { section: 'orivon' }))).toEqual(['cafe', 'ipfs'])
    expect(ids(filterSites(sites, categories, { section: 'web3', category: 'a' }))).toEqual(['curve', 'cafe'])
    expect(ids(filterSites(sites, categories, { section: 'web2', category: 'b' }))).toEqual([])
    expect(ids(filterSites(sites, categories, { category: 'b', section: 'orivon', query: 'peer' }))).toEqual(['ipfs'])
    expect(ids(filterSites(sites, categories, { category: 'b', query: 'curve' }))).toEqual([])
  })

  it('returns everything for an empty or blank query', () => {
    expect(filterSites(sites, categories, {})).toHaveLength(4)
    expect(filterSites(sites, categories, { query: '   ' })).toHaveLength(4)
  })

  it('counts each section, the Orivon apps, and the categories per section', () => {
    expect(countSites(sites)).toEqual({
      web3: 3,
      web2: 1,
      all: 4,
      orivon: 2,
      byCategory: { web3: { a: 2, b: 1 }, web2: { a: 1 }, all: { a: 3, b: 1 } }
    })
  })

  it('groups in category order and skips categories with no match', () => {
    const groups = groupByCategory(filterSites(sites, categories, { category: 'b' }), categories)
    expect(groups.map((group) => group.category.id)).toEqual(['b'])
    expect(groupByCategory(sites, categories).map((group) => ids(group.sites))).toEqual([['cafe', 'curve', 'swapweb'], ['ipfs']])
  })

  it('opens a category on an Orivon app you can open, puts Web3 before Web2, and closes on announced ones', () => {
    const mixed: Site[] = [
      { id: 'soon', name: 'Soon', category: 'a', summary: 's', orivon: { kind: 'port', published: false } },
      { id: 'plain', name: 'Plain', category: 'a', summary: 's', web: 'https://plain.example' },
      { id: 'live', name: 'Live', category: 'a', summary: 's', ipfs: 'bafy', orivon: { kind: 'port', published: true } },
      { id: 'other', name: 'Other', category: 'a', summary: 's', web: 'https://other.example' },
      { id: 'named', name: 'Named', category: 'a', summary: 's', ens: 'named.eth' }
    ]
    expect(ids(groupByCategory(mixed, categories)[0]?.sites ?? [])).toEqual(['live', 'named', 'plain', 'other', 'soon'])
  })
})
