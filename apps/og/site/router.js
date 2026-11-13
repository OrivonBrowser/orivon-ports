// The hash router: which view a fragment names. Pure. `#/name/harbor` opens the search with that name typed, so a name can be linked;
// `#/names` is the list of the connected account's names, and `#/names/harbor` the page of one of them.

/** @typedef {{ name: 'search' | 'names' | 'manage' | 'notFound', hash: string, label: string | null }} Route */

export const ROUTES = Object.freeze([
  { name: 'search', path: '/', label: 'Register' },
  { name: 'names', path: '/names', label: 'My names' }
])

/** @param {string} text @returns {string | null} the label a path segment spells, or null when it does not decode */
function labelOf (text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

/**
 * @param {string} hash `location.hash`
 * @returns {Route}
 */
export function parseRoute (hash) {
  const text = typeof hash === 'string' ? hash : ''
  const path = (text.indexOf('?') === -1 ? text : text.slice(0, text.indexOf('?'))).replace(/^#/, '') || '/'
  if (path === '/') return { name: 'search', hash: text, label: null }
  if (path === '/names') return { name: 'names', hash: text, label: null }
  const named = /^\/name\/([^/]+)$/.exec(path)
  if (named !== null) {
    const label = labelOf(named[1] ?? '')
    return label === null ? { name: 'notFound', hash: text, label: null } : { name: 'search', hash: text, label }
  }
  const managed = /^\/names\/([^/]+)$/.exec(path)
  if (managed !== null) {
    const label = labelOf(managed[1] ?? '')
    return label === null ? { name: 'notFound', hash: text, label: null } : { name: 'manage', hash: text, label }
  }
  return { name: 'notFound', hash: text, label: null }
}

/** The fragment that opens the search on one name. @param {string} label */
export const nameHash = (label) => `#/name/${encodeURIComponent(label)}`

/** The fragment that opens the page of one of the person's names. @param {string} label */
export const manageHash = (label) => `#/names/${encodeURIComponent(label)}`
