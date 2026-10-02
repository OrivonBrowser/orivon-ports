// The address bar is the state: #/ , #/c/<category>, #/orivon, #/lab, and ?q=<search> on
// the directory routes. Pure, so the mapping can be tested without a window.

/**
 * @typedef {{ view: 'directory' | 'lab', category: string | null, orivonOnly: boolean, q: string }} Route
 */

/**
 * @param {string} hash  location.hash, with or without the leading #
 * @param {readonly string[]} categoryIds  a category not in this list falls back to All
 * @returns {Route}
 */
export function parseHash (hash, categoryIds) {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?', 2)
  const parts = path.split('/').filter(Boolean)
  const q = new URLSearchParams(query).get('q') ?? ''
  if (parts[0] === 'lab') return { view: 'lab', category: null, orivonOnly: false, q: '' }
  if (parts[0] === 'orivon') return { view: 'directory', category: null, orivonOnly: true, q }
  if (parts[0] === 'c' && parts[1] && categoryIds.includes(parts[1])) {
    return { view: 'directory', category: parts[1], orivonOnly: false, q }
  }
  return { view: 'directory', category: null, orivonOnly: false, q }
}

/** @param {Route} route */
export function buildHash (route) {
  if (route.view === 'lab') return '#/lab'
  let path = '#/'
  if (route.orivonOnly) path = '#/orivon'
  else if (route.category) path = `#/c/${route.category}`
  return route.q ? `${path}?${new URLSearchParams({ q: route.q }).toString()}` : path
}

/** Two routes that differ only in the search text share a page and a scroll position. */
export function pageKey (route) {
  return buildHash({ ...route, q: '' })
}
