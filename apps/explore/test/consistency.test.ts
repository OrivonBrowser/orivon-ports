// The whole catalog, scored the way the page scores it, under the answers a provider can give:
// none yet, all, some, and lookups that came back empty. Whatever arrives, every site sits in
// exactly one section, each section's count is what it lists, and a listed card's mark agrees
// with the section it is listed under.
import { describe, expect, it } from 'vitest'
import { CATEGORIES, SITES } from '../site/catalog.js'
import type { Site } from '../site/catalog.js'
import { countSites, filterSites, SCORE_SECTIONS } from '../site/filter.js'
import { SNAPSHOT } from '../site/judgements.js'
import { judgementFor, observedLevel, scoreOf } from '../site/score.js'

type Live = { provider: string, levels: Map<string, number> } | null

const asked = SITES.filter((site) => observedLevel(site) === 2)
const scenarios: Array<[string, Live]> = [
  ['the snapshot alone', null],
  ['a provider that gave no level anywhere', { provider: 'Live', levels: new Map() }],
  ['a provider that judged every site Level 2', { provider: 'Live', levels: new Map(asked.map((site) => [site.id, 2])) }],
  ['a provider that judged every site Level 4', { provider: 'Live', levels: new Map(asked.map((site) => [site.id, 4])) }],
  ['a provider that answered every other site', { provider: 'Live', levels: new Map(asked.filter((_, i) => i % 2 === 0).map((site) => [site.id, 3])) }]
]

describe.each(scenarios)('the catalog under %s', (_name, live) => {
  const scoreFor = (site: Site) => scoreOf(site, judgementFor(site, live, SNAPSHOT))
  const levelOf = (site: Site) => scoreFor(site)?.level ?? null
  const counts = countSites(SITES, levelOf)
  const listed = Object.fromEntries(SCORE_SECTIONS.map((section) => [section, filterSites(SITES, CATEGORIES, { sections: [section] }, levelOf)]))

  it('puts every site in exactly one section', () => {
    for (const site of SITES) {
      expect(SCORE_SECTIONS.filter((section) => listed[section]?.includes(site)), site.id).toHaveLength(1)
    }
  })

  it('counts each section as it lists', () => {
    for (const section of SCORE_SECTIONS) expect(counts[section], section).toBe(listed[section]?.length)
  })

  it('lists a site under Web3 only with a Web3 mark or as an Orivon app, and never a Web3 mark elsewhere', () => {
    for (const site of listed.web3 ?? []) expect(site.orivon !== undefined || scoreFor(site)?.mark === 'Web3', site.id).toBe(true)
    for (const site of [...(listed.web25 ?? []), ...(listed.web2 ?? [])]) expect(scoreFor(site)?.mark, site.id).not.toBe('Web3')
  })
})

describe('an unanswered lookup', () => {
  it('leaves every site where the snapshot put it', () => {
    const before = (site: Site) => scoreOf(site, judgementFor(site, null, SNAPSHOT))?.mark
    const after = (site: Site) => scoreOf(site, judgementFor(site, { provider: SNAPSHOT.provider, levels: new Map() }, SNAPSHOT))?.mark
    for (const site of SITES) expect(after(site), site.id).toBe(before(site))
  })
})
