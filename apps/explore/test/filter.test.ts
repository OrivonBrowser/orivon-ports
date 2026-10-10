import { describe, expect, it } from 'vitest'
import type { Site } from '../site/catalog.js'
import { countSites, filterSites, groupByCategory, inSection, hasWeb3Address, normalize, SCORE_SECTIONS } from '../site/filter.js'
import type { Level } from '../site/score.js'

const categories = [{ id: 'a', name: 'Exchange & DeFi' }, { id: 'b', name: 'Storage' }]
const sites: Site[] = [
  { id: 'web3', name: 'Trustless', category: 'a', summary: 'A Level 4 exchange', ens: 'trustless.eth' },
  { id: 'web25', name: 'Café Pay', category: 'a', summary: 'Pay at the counter', orivon: { kind: 'native' } },
  { id: 'port', name: 'IPFS', category: 'b', summary: 'Peer-to-peer files', ens: 'ipfs.eth', orivon: { kind: 'port' } },
  { id: 'web2', name: 'Swap Web', category: 'a', summary: 'Stablecoin swaps on a server', web: 'https://swap.example' }
]
/** The scores a test's sites carry, as a real card's would be. */
const levels: Record<string, Level | null> = { web3: 4, web25: 2, port: null, web2: 1 }
const levelOf = (site: Site) => levels[site.id] ?? null
const ids = (found: readonly { id: string }[]) => found.map((site) => site.id)

describe('filter', () => {
  it('calls a site Web3-addressed when it is an Orivon app or has an ENS name or an IPFS address', () => {
    expect(sites.filter(hasWeb3Address).map((site) => site.id)).toEqual(['web3', 'web25', 'port'])
    expect(hasWeb3Address({ id: 'x', name: 'X', category: 'a', summary: 's', ipfs: 'bafy' })).toBe(true)
    expect(hasWeb3Address({ id: 'x', name: 'X', category: 'a', summary: 's', web: 'https://x.example', ens: 'x.eth' })).toBe(true)
  })

  it('puts every site in exactly one of Web3, Web2.5 and Web2, and all of them in All', () => {
    for (const site of sites) {
      expect(SCORE_SECTIONS.filter((section) => inSection(site, section, levelOf))).toHaveLength(1)
      expect(inSection(site, 'all', levelOf)).toBe(true)
    }
  })

  it('opens the Web3 section on Level 4 sites alone, an Orivon app only when it scores Level 4', () => {
    expect(inSection(sites[0]!, 'web3', levelOf)).toBe(true)
    expect(inSection(sites[1]!, 'web3', levelOf)).toBe(false)
    expect(inSection(sites[2]!, 'web3', levelOf)).toBe(false)
    expect(inSection(sites[3]!, 'web3', levelOf)).toBe(false)
    expect(ids(filterSites(sites, categories, { sections: ['web3'] }, levelOf))).toEqual(['web3'])
    expect(inSection({ ...sites[2]!, id: 'scored' }, 'web3', () => 4)).toBe(true)
  })

  it('keeps the Web3-addressed sites that fall short of Level 4 in Web2.5, Orivon apps included', () => {
    expect(inSection(sites[0]!, 'web25', levelOf)).toBe(false)
    expect(inSection(sites[1]!, 'web25', levelOf)).toBe(true)
    expect(inSection(sites[2]!, 'web25', levelOf)).toBe(true)
    const judged: Site[] = [
      { id: 'named', name: 'Named', category: 'a', summary: 's', ens: 'named.eth' },
      { id: 'level', name: 'Level', category: 'a', summary: 's', ens: 'level.eth' },
      { id: 'apps', name: 'App', category: 'a', summary: 's', orivon: { kind: 'native' } }
    ]
    const appLevels: Record<string, Level | null> = { named: 2, level: 3, apps: null }
    const appLevelOf = (site: Site) => appLevels[site.id] ?? null
    expect(ids(filterSites(judged, categories, { sections: ['web25'] }, appLevelOf))).toEqual(['named', 'level', 'apps'])
  })

  it('counts a Web2 site, an unjudged content-addressed site and every Orivon app as they score', () => {
    expect(ids(filterSites(sites, categories, { sections: ['web25'] }, levelOf))).toEqual(['web25', 'port'])
    expect(ids(filterSites(sites, categories, { sections: ['web2'] }, levelOf))).toEqual(['web2'])
    expect(inSection(sites[2]!, 'orivon', levelOf)).toBe(true)
  })

  it('matches on name, summary, ens name and category name', () => {
    expect(ids(filterSites(sites, categories, { query: 'trustless' }, levelOf))).toEqual(['web3'])
    expect(ids(filterSites(sites, categories, { query: 'counter' }, levelOf))).toEqual(['web25'])
    expect(ids(filterSites(sites, categories, { query: 'ipfs.eth' }, levelOf))).toEqual(['port'])
    expect(ids(filterSites(sites, categories, { query: 'defi' }, levelOf))).toEqual(['web3', 'web25', 'web2'])
  })

  it('ignores case and accents, in the query and in the data', () => {
    expect(ids(filterSites(sites, categories, { query: 'CAFE' }, levelOf))).toEqual(['web25'])
    expect(ids(filterSites(sites, categories, { query: 'café' }, levelOf))).toEqual(['web25'])
    expect(normalize('Crème')).toBe('creme')
  })

  it('requires every term of the query', () => {
    expect(ids(filterSites(sites, categories, { query: 'stablecoin exchange' }, levelOf))).toEqual(['web2'])
    expect(ids(filterSites(sites, categories, { query: 'stablecoin storage' }, levelOf))).toEqual([])
  })

  it('searches the Web3 and Web2.5 sites, or the Web2 ones too', () => {
    expect(ids(filterSites(sites, categories, { query: 'files', sections: ['web3', 'web25'] }, levelOf))).toEqual(['port'])
    expect(ids(filterSites(sites, categories, { query: 'files', sections: SCORE_SECTIONS }, levelOf))).toEqual(['port'])
    expect(ids(filterSites(sites, categories, { query: 'stablecoin', sections: ['web2'] }, levelOf))).toEqual(['web2'])
  })

  it('composes the sections and the category with the query', () => {
    expect(ids(filterSites(sites, categories, { category: 'a' }, levelOf))).toEqual(['web3', 'web25', 'web2'])
    expect(ids(filterSites(sites, categories, { sections: ['orivon'] }, levelOf))).toEqual(['web25', 'port'])
    expect(ids(filterSites(sites, categories, { sections: ['web3'], category: 'a' }, levelOf))).toEqual(['web3'])
    expect(ids(filterSites(sites, categories, { sections: ['web2'], category: 'b' }, levelOf))).toEqual([])
    expect(ids(filterSites(sites, categories, { category: 'b', sections: ['orivon'], query: 'peer' }, levelOf))).toEqual(['port'])
    expect(ids(filterSites(sites, categories, { category: 'b', query: 'trustless' }, levelOf))).toEqual([])
  })

  it('returns everything for an empty or blank query', () => {
    expect(filterSites(sites, categories, {}, levelOf)).toHaveLength(4)
    expect(filterSites(sites, categories, { query: '   ' }, levelOf)).toHaveLength(4)
  })

  it('counts each section, the Orivon apps, and the categories per section', () => {
    expect(countSites(sites, levelOf)).toEqual({
      web3: 1,
      web25: 2,
      web2: 1,
      all: 4,
      orivon: 2,
      byCategory: { web3: { a: 1 }, web25: { a: 1, b: 1 }, web2: { a: 1 }, all: { a: 3, b: 1 } }
    })
  })

  it('groups in category order and skips categories with no match', () => {
    const groups = groupByCategory(filterSites(sites, categories, { category: 'b' }, levelOf), categories, levelOf)
    expect(groups.map((group) => group.category.id)).toEqual(['b'])
    expect(groupByCategory(sites, categories, levelOf).map((group) => ids(group.sites))).toEqual([['web25', 'web3', 'web2'], ['port']])
  })

  it('opens a category on an Orivon app you can open, then Web3, then Web2.5, then Web2, and closes on announced ones', () => {
    const mixed: Site[] = [
      { id: 'soon', name: 'Soon', category: 'a', summary: 's', orivon: { kind: 'port', published: false } },
      { id: 'plain', name: 'Plain', category: 'a', summary: 's', web: 'https://plain.example' },
      { id: 'live', name: 'Live', category: 'a', summary: 's', ipfs: 'bafy', orivon: { kind: 'port', published: true } },
      { id: 'level', name: 'Level', category: 'a', summary: 's', ens: 'level.eth' },
      { id: 'other', name: 'Other', category: 'a', summary: 's', web: 'https://other.example' },
      { id: 'named', name: 'Named', category: 'a', summary: 's', ens: 'named.eth' }
    ]
    const mixedLevels: Record<string, Level | null> = { soon: null, plain: 1, live: null, level: 3, other: 1, named: 2 }
    const mixedLevelOf = (site: Site) => mixedLevels[site.id] ?? null
    expect(ids(groupByCategory(mixed, categories, mixedLevelOf)[0]?.sites ?? [])).toEqual(['live', 'level', 'named', 'plain', 'other', 'soon'])
  })
})
