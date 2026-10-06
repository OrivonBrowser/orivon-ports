// The address bar is the state: #/ (Web3 sites), #/web25, #/web2, #/all, #/orivon, a category
// inside a section (#/c/<id>, #/web25/c/<id>, #/web2/c/<id>, #/all/c/<id>),
// #/search?q=<text>[&web2=1], and #/lab. Pure, so the mapping can be tested without a window.

/**
 * @typedef {'web3' | 'web25' | 'web2' | 'all' | 'orivon'} Section
 * @typedef {{
 *   view: 'directory' | 'search' | 'lab', section: Section, category: string | null,
 *   q: string, web2: boolean
 * }} Route
 */

/** @type {readonly Section[]} */
const PREFIXED = ['web2', 'web25', 'all', 'orivon']

/** @param {Partial<Route>} fields @returns {Route} */
function route (fields) {
  return { view: 'directory', section: 'web3', category: null, q: '', web2: false, ...fields }
}

/**
 * Any directory address with a search on it reads as a search, so an older `#/c/x?q=y` link
 * still finds what it asked for.
 * @param {string} hash  location.hash, with or without the leading #
 * @param {readonly string[]} categoryIds  a category not in this list falls back to its section
 * @returns {Route}
 */
export function parseHash (hash, categoryIds) {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?', 2)
  const parts = path.split('/').filter(Boolean)
  const params = new URLSearchParams(query)
  const q = params.get('q') ?? ''
  if (parts[0] === 'lab') return route({ view: 'lab' })
  if (q.trim() !== '') return route({ view: 'search', q, web2: params.get('web2') === '1' })
  const section = PREFIXED.find((name) => name === parts[0]) ?? 'web3'
  const rest = section === 'web3' ? parts : parts.slice(1)
  if (section !== 'orivon' && rest[0] === 'c' && rest[1] && categoryIds.includes(rest[1])) {
    return route({ section, category: rest[1] })
  }
  return route({ section })
}

/** @param {Route} route */
export function buildHash (route) {
  if (route.view === 'lab') return '#/lab'
  if (route.view === 'search') {
    const params = new URLSearchParams({ q: route.q })
    if (route.web2) params.set('web2', '1')
    return `#/search?${params.toString()}`
  }
  const base = route.section === 'web3' ? '#/' : `#/${route.section}`
  if (!route.category || route.section === 'orivon') return base
  return route.section === 'web3' ? `#/c/${route.category}` : `${base}/c/${route.category}`
}

/**
 * Every search is one page, so typing never resets the scroll position.
 * @param {Route} route
 */
export function pageKey (route) {
  return route.view === 'search' ? '#/search' : buildHash(route)
}

/**
 * The section a category link stays in: the one being browsed, or Web3 sites from the Orivon
 * apps, a search or the Lab.
 * @param {Route} route
 * @returns {Exclude<Section, 'orivon'>}
 */
export function browsedSection (route) {
  return route.view === 'directory' && route.section !== 'orivon' ? route.section : 'web3'
}
