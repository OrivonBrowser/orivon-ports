// Searching and filtering the catalog, and grouping what is left for display. Pure.

/**
 * @typedef {import('./router.js').Section} Section
 * @typedef {{ query?: string, category?: string | null, sections?: readonly Section[] }} Filters
 * @typedef {Record<'web3' | 'web25' | 'web2' | 'all', Record<string, number>>} CategoryCounts
 * @typedef {{ web3: number, web25: number, web2: number, all: number, orivon: number, byCategory: CategoryCounts }} Counts
 */

/**
 * The level a site is scored at, the one its card's Web3 Score mark shows. Null for a site
 * with no score at all: an announced app, whose address is not published yet. Sections are
 * score-like questions, so the filters take this resolver rather than reading scores
 * themselves, and its caller keeps one place where a judgement is applied.
 * @typedef {(site: import('./catalog.js').Site) => import('./score.js').Level | null} LevelOf
 */

/** The three sections a site belongs to exactly one of, in the navigation's order. */
export const SCORE_SECTIONS = /** @type {const} */ (['web3', 'web25', 'web2'])

/**
 * A Web3-addressed site is one Orivon can check file by file: an Orivon app, or a site
 * published at an ENS name or an IPFS address. Every other site is a Web2 site.
 * @param {import('./catalog.js').Site} site
 */
export function hasWeb3Address (site) {
  return Boolean(site.orivon || site.ens || site.ipfs)
}

/**
 * Whether the site shows under a section. The Web3 sites hold the sites scored Level 4 -- Web3 --,
 * Orivon apps no differently; the Web2.5 sites hold every other Web3-addressed site; the Web2
 * sites hold the rest. All and Orivon apps are not memberships but views over them.
 * @param {import('./catalog.js').Site} site
 * @param {Section} section
 * @param {LevelOf} levelOf
 */
export function inSection (site, section, levelOf) {
  if (section === 'all') return true
  if (section === 'orivon') return Boolean(site.orivon)
  if (section === 'web2') return !hasWeb3Address(site)
  const web3 = levelOf(site) === 4
  if (section === 'web3') return web3
  return section === 'web25' && hasWeb3Address(site) && !web3
}

/** Lower case with accents removed, so "Curve" and "curvé" meet. */
export function normalize (text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * Every whitespace-separated term of the query must appear in the name, the summary, the
 * ENS name or the category's name. The sections and the category narrow it further.
 * @param {readonly import('./catalog.js').Site[]} sites
 * @param {readonly import('./catalog.js').Category[]} categories
 * @param {Filters} filters
 * @param {LevelOf} levelOf
 */
export function filterSites (sites, categories, filters, levelOf) {
  const terms = normalize(filters.query ?? '').split(/\s+/).filter(Boolean)
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]))
  return sites.filter((site) => {
    if (filters.sections?.length && !filters.sections.some((section) => inSection(site, section, levelOf))) return false
    if (filters.category && site.category !== filters.category) return false
    if (terms.length === 0) return true
    const haystack = normalize([site.name, site.summary, site.ens ?? '', categoryNames.get(site.category) ?? ''].join(' '))
    return terms.every((term) => haystack.includes(term))
  })
}

/**
 * How many sites each navigation entry would show, the categories counted per section.
 * @param {readonly import('./catalog.js').Site[]} sites
 * @param {LevelOf} levelOf
 * @returns {Counts}
 */
export function countSites (sites, levelOf) {
  /** @type {Counts} */
  const counts = { web3: 0, web25: 0, web2: 0, all: 0, orivon: 0, byCategory: { web3: {}, web25: {}, web2: {}, all: {} } }
  for (const site of sites) {
    const section = SCORE_SECTIONS.find((name) => inSection(site, name, levelOf)) ?? 'web2'
    counts[section] += 1
    counts.all += 1
    if (site.orivon) counts.orivon += 1
    for (const key of /** @type {const} */ ([section, 'all'])) {
      counts.byCategory[key][site.category] = (counts.byCategory[key][site.category] ?? 0) + 1
    }
  }
  return counts
}

/**
 * Where a site sits inside its category: an Orivon app you can open first, then the Web3
 * sites, then the Web2.5 ones, then Web2 sites, then an Orivon app that is announced but not
 * published, so a category never opens on a card with no button.
 * @param {import('./catalog.js').Site} site
 * @param {LevelOf} levelOf
 */
export function rank (site, levelOf) {
  if (site.orivon) return site.orivon.published === false ? 4 : 0
  const level = levelOf(site)
  if (level === 4) return 1
  return hasWeb3Address(site) ? 2 : 3
}

/**
 * The sites under their categories, in the catalog's category order, skipping empty ones.
 * Inside a category, `rank` orders them and the catalog's own order breaks ties.
 * @param {readonly import('./catalog.js').Site[]} sites
 * @param {readonly import('./catalog.js').Category[]} categories
 * @param {LevelOf} levelOf
 */
export function groupByCategory (sites, categories, levelOf) {
  return categories
    .map((category) => ({
      category,
      sites: sites.filter((site) => site.category === category.id).sort((a, b) => rank(a, levelOf) - rank(b, levelOf))
    }))
    .filter((group) => group.sites.length > 0)
}
