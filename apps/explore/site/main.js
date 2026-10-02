// Entry: reads the address bar, renders the directory or the Lab, and wires the search box
// and the keyboard. Nothing here knows how a card is drawn or how a probe runs.

import { CATEGORIES, SITES } from './catalog.js'
import { countSites } from './filter.js'
import { buildHash, pageKey, parseHash } from './router.js'
import { detect } from './orivon.js'
import { renderNav, renderPill, renderResults } from './directory.js'
import { renderLab } from './lab/lab.js'

const env = { inOrivon: detect().inOrivon }
const counts = countSites(SITES)
const categoryIds = CATEGORIES.map((category) => category.id)

const search = /** @type {HTMLInputElement} */ (document.getElementById('search'))
const nav = /** @type {HTMLElement} */ (document.getElementById('nav'))
const main = /** @type {HTMLElement} */ (document.getElementById('main'))
const pill = /** @type {HTMLElement} */ (document.getElementById('env'))

let route = parseHash(location.hash, categoryIds)
let shownPage = ''

function render () {
  route = parseHash(location.hash, categoryIds)
  if (search.value !== route.q) search.value = route.q
  renderPill(pill, env)
  renderNav(nav, route, counts, CATEGORIES)
  if (pageKey(route) !== shownPage) {
    shownPage = pageKey(route)
    window.scrollTo(0, 0)
  }
  if (route.view === 'lab') {
    document.title = 'Lab · Orivon Explore'
    void renderLab(main)
    return
  }
  const category = CATEGORIES.find((candidate) => candidate.id === route.category)
  document.title = `${category ? category.name : route.orivonOnly ? 'Orivon apps' : 'Explore'} · Orivon Explore`
  renderResults(main, { route, env, sites: SITES, categories: CATEGORIES, onClear: () => { location.hash = '#/' } })
}

/** Typing replaces the entry rather than adding one per keystroke. */
function setQuery (q) {
  const base = route.view === 'lab' ? { view: 'directory', category: null, orivonOnly: false, q } : { ...route, q }
  const hash = buildHash(base)
  if (route.view === 'lab') {
    location.hash = hash
    return
  }
  history.replaceState(null, '', hash)
  render()
}

search.addEventListener('input', () => { setQuery(search.value) })
window.addEventListener('hashchange', render)

document.addEventListener('keydown', (event) => {
  const target = /** @type {HTMLElement} */ (event.target)
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable
  if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault()
    search.focus()
    search.select()
  } else if (event.key === 'Escape' && (target === search || search.value !== '')) {
    search.value = ''
    setQuery('')
  }
})

render()
