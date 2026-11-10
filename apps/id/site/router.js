// The hash router: which view a fragment names. Pure. `#/connect?...` carries the whole sign-in request, so the
// route keeps the raw fragment for the view that reads it.

/** @typedef {{ name: 'search' | 'me' | 'connect' | 'developers' | 'notFound', hash: string, next: string | null }} Route */

export const ROUTES = Object.freeze([
  { name: 'search', path: '/', label: 'Register' },
  { name: 'me', path: '/me', label: 'My IDs' },
  { name: 'developers', path: '/developers', label: 'Developers' }
])

/**
 * `next` is a sign-in request the person was on before being sent to register: only `#/connect?...` is accepted, so
 * a link cannot send the page anywhere else.
 * @param {string} hash `location.hash`
 * @returns {Route}
 */
export function parseRoute (hash) {
  const text = typeof hash === 'string' ? hash : ''
  const cut = text.indexOf('?')
  const path = (cut === -1 ? text : text.slice(0, cut)).replace(/^#/, '') || '/'
  const query = cut === -1 ? '' : text.slice(cut + 1)
  if (path === '/connect') return { name: 'connect', hash: text, next: null }
  if (path === '/me') return { name: 'me', hash: text, next: null }
  if (path === '/developers') return { name: 'developers', hash: text, next: null }
  if (path === '/') return { name: 'search', hash: text, next: nextOf(query) }
  return { name: 'notFound', hash: text, next: null }
}

/** @param {string} query */
function nextOf (query) {
  for (const pair of query.split('&')) {
    if (!pair.startsWith('next=')) continue
    try {
      const value = decodeURIComponent(pair.slice(5))
      if (value.startsWith('#/connect?')) return value
    } catch {
      return null
    }
  }
  return null
}

/** The fragment that sends a person to register and then back to the request they came with. @param {string} connectHash */
export const registerThenHash = (connectHash) => `#/?next=${encodeURIComponent(connectHash)}`
