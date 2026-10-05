// Searching and filtering the catalog, and grouping what is left for display. Pure.

/**
 * @typedef {import('./router.js').Section} Section
 * @typedef {{ query?: string, category?: string | null, section?: Section }} Filters
 * @typedef {Record<'web3' | 'web2' | 'all', Record<string, number>>} CategoryCounts
 * @typedef {{ web3: number, web2: number, all: number, orivon: number, byCategory: CategoryCounts }} Counts
 */

/**
 * A Web3 site is one Orivon can check file by file: an Orivon app, or a site published at an
 * ENS name or an IPFS address. Every other site is a Web2 site.
 * @param {import('./catalog.js').Site} site
 */
export function isWeb3 (site) {
  return Boolean(site.orivon || site.ens || site.ipfs)
}

/**
 * @param {import('./catalog.js').Site} site
 * @param {Section} section
 */
export function inSection (site, section) {
  if (section === 'all') return true
  if (section === 'orivon') return Boolean(site.orivon)
  return isWeb3(site) === (section === 'web3')
}

/** Lower case with accents removed, so "Curve" and "curvé" meet. */
export function normalize (text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * Every whitespace-separated term of the query must appear in the name, the summary, the
 * ENS name or the category's name. The section and the category narrow it further.
 * @param {readonly import('./catalog.js').Site[]} sites
 * @param {readonly import('./catalog.js').Category[]} categories
 * @param {Filters} filters
 */
export function filterSites (sites, categories, filters) {
  const terms = normalize(filters.query ?? '').split(/\s+/).filter(Boolean)
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]))
  return sites.filter((site) => {
    if (filters.section && !inSection(site, filters.section)) return false
    if (filters.category && site.category !== filters.category) return false
    if (terms.length === 0) return true
    const haystack = normalize([site.name, site.summary, site.ens ?? '', categoryNames.get(site.category) ?? ''].join(' '))
    return terms.every((term) => haystack.includes(term))
  })
}

/**
 * How many sites each navigation entry would show, the categories counted per section.
 * @param {readonly import('./catalog.js').Site[]} sites
 * @returns {Counts}
 */
export function countSites (sites) {
  /** @type {Counts} */
  const counts = { web3: 0, web2: 0, all: 0, orivon: 0, byCategory: { web3: {}, web2: {}, all: {} } }
  for (const site of sites) {
    const section = isWeb3(site) ? 'web3' : 'web2'
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
 * Where a site sits inside its category: an Orivon app you can open first, then the other
 * Web3 sites, then Web2 sites, then an Orivon app that is announced but not published, so a
 * category never opens on a card with no button.
 * @param {import('./catalog.js').Site} site
 */
export function rank (site) {
  if (site.orivon) return site.orivon.published === false ? 3 : 0
  return isWeb3(site) ? 1 : 2
}

/**
 * The sites under their categories, in the catalog's category order, skipping empty ones.
 * Inside a category, `rank` orders them and the catalog's own order breaks ties.
 * @param {readonly import('./catalog.js').Site[]} sites
 * @param {readonly import('./catalog.js').Category[]} categories
 */
export function groupByCategory (sites, categories) {
  return categories
    .map((category) => ({
      category,
      sites: sites.filter((site) => site.category === category.id).sort((a, b) => rank(a) - rank(b))
    }))
    .filter((group) => group.sites.length > 0)
}
