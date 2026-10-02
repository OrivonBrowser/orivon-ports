// Searching and filtering the catalog, and grouping what is left for display. Pure.

/**
 * @typedef {{ query?: string, category?: string | null, orivonOnly?: boolean }} Filters
 */

/** Lower case with accents removed, so "Curve" and "curvé" meet. */
export function normalize (text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * Every whitespace-separated term of the query must appear in the name, the summary, the
 * ENS name or the category's name. The category and the Orivon filter narrow it further.
 * @param {readonly import('./catalog.js').Site[]} sites
 * @param {readonly import('./catalog.js').Category[]} categories
 * @param {Filters} filters
 */
export function filterSites (sites, categories, filters) {
  const terms = normalize(filters.query ?? '').split(/\s+/).filter(Boolean)
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]))
  return sites.filter((site) => {
    if (filters.category && site.category !== filters.category) return false
    if (filters.orivonOnly && !site.orivon) return false
    if (terms.length === 0) return true
    const haystack = normalize([site.name, site.summary, site.ens ?? '', categoryNames.get(site.category) ?? ''].join(' '))
    return terms.every((term) => haystack.includes(term))
  })
}

/**
 * How many sites each navigation entry would show.
 * @param {readonly import('./catalog.js').Site[]} sites
 * @returns {{ total: number, orivon: number, byCategory: Record<string, number> }}
 */
export function countSites (sites) {
  /** @type {Record<string, number>} */
  const byCategory = {}
  let orivon = 0
  for (const site of sites) {
    byCategory[site.category] = (byCategory[site.category] ?? 0) + 1
    if (site.orivon) orivon += 1
  }
  return { total: sites.length, orivon, byCategory }
}

/**
 * Where a site sits inside its category: an Orivon app you can open first, then every other
 * site, then an Orivon app that is announced but not published, so a category never opens
 * on a card with no button.
 * @param {import('./catalog.js').Site} site
 */
export function rank (site) {
  if (!site.orivon) return 1
  return site.orivon.published === false ? 2 : 0
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
