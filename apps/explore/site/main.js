// Entry: reads the address bar, renders the directory or the Lab, wires the search box, the
// Include Web2 box and the keyboard, and asks Orivon for the user's Web3 Score provider's
// judgements. Nothing here knows how a card is drawn or how a probe runs.

import { CATEGORIES, SITES } from './catalog.js'
import { countSites } from './filter.js'
import { SNAPSHOT } from './judgements.js'
import { buildHash, pageKey, parseHash } from './router.js'
import { observedLevel, scoreOf, snapshotJudgement } from './score.js'
import { primaryHref } from './addresses.js'
import { canAskProvider, detect, providerJudgement } from './orivon.js'
import { paintMark, renderNav, renderPill, renderResults } from './directory.js'
import { renderLab } from './lab/lab.js'

const env = { inOrivon: detect().inOrivon }
const counts = countSites(SITES)
const categoryIds = CATEGORIES.map((category) => category.id)

const search = /** @type {HTMLInputElement} */ (document.getElementById('search'))
const includeWeb2 = /** @type {HTMLInputElement} */ (document.getElementById('include-web2'))
const nav = /** @type {HTMLElement} */ (document.getElementById('nav'))
const main = /** @type {HTMLElement} */ (document.getElementById('main'))
const pill = /** @type {HTMLElement} */ (document.getElementById('env'))
const scoreSource = /** @type {HTMLElement} */ (document.getElementById('score-source'))

let route = parseHash(location.hash, categoryIds)
let shownPage = ''
/** Where clearing a search goes back to: the page it was started from. */
let returnTo = route.view === 'directory' ? buildHash(route) : '#/'

/**
 * The user's own provider, once Orivon has named one: its name and the levels it gave, by
 * site id. Until then, and whenever Orivon cannot say, the snapshot speaks.
 * @type {{ provider: string, levels: Map<string, number | null> } | null}
 */
let live = null

/** @param {import('./catalog.js').Site} site */
function scoreFor (site) {
  if (live?.levels.has(site.id)) {
    const level = live.levels.get(site.id)
    return scoreOf(site, level == null ? null : { level, provider: live.provider, read: null })
  }
  return scoreOf(site, snapshotJudgement(site, SNAPSHOT))
}

function renderScoreSource () {
  scoreSource.textContent = live
    ? `Web3 Scores judged by ${live.provider}, your Web3 Score provider in Orivon.`
    : `Web3 Scores judged by ${SNAPSHOT.provider} on ${SNAPSHOT.read}. In Orivon, your own Web3 Score provider's judgement takes its place.`
}

function repaintMarks () {
  for (const node of main.querySelectorAll('[data-mark-site]')) {
    const site = SITES.find((candidate) => candidate.id === node.getAttribute('data-mark-site'))
    if (site) paintMark(/** @type {HTMLElement} */ (node), scoreFor(site))
  }
  renderScoreSource()
}

function render () {
  route = parseHash(location.hash, categoryIds)
  if (search.value !== route.q) search.value = route.q
  if (route.view === 'search') includeWeb2.checked = route.web2
  search.placeholder = includeWeb2.checked ? 'Search Web3 and Web2 sites' : 'Search Web3 sites'
  renderPill(pill, env)
  renderNav(nav, route, counts, CATEGORIES)
  renderScoreSource()
  if (pageKey(route) !== shownPage) {
    shownPage = pageKey(route)
    window.scrollTo(0, 0)
  }
  if (route.view === 'lab') {
    document.title = 'Lab · Orivon Explore'
    void renderLab(main)
    return
  }
  if (route.view === 'directory') returnTo = buildHash(route)
  const category = CATEGORIES.find((candidate) => candidate.id === route.category)
  const sectionTitle = { web3: 'Web3 sites', web2: 'Web2 sites', all: 'All sites', orivon: 'Orivon apps' }[route.section]
  document.title = `${route.view === 'search' ? 'Search' : category ? category.name : sectionTitle} · Orivon Explore`
  renderResults(main, {
    route,
    env,
    sites: SITES,
    categories: CATEGORIES,
    scoreFor,
    onClear: () => { setQuery('') },
    onIncludeWeb2: () => {
      includeWeb2.checked = true
      onIncludeWeb2Change()
    }
  })
}

/**
 * Typing replaces the entry rather than adding one per keystroke, as does clearing, which
 * goes back to the page the search started from. A search started in the Lab adds one, so
 * the Lab stays in the history.
 * @param {string} q
 */
function setQuery (q) {
  if (q.trim() === '') {
    if (route.view !== 'search') return
    history.replaceState(null, '', returnTo)
    render()
    return
  }
  const hash = buildHash({ view: 'search', section: 'web3', category: null, q, web2: includeWeb2.checked })
  if (route.view === 'lab') history.pushState(null, '', hash)
  else history.replaceState(null, '', hash)
  render()
}

function onIncludeWeb2Change () {
  if (route.view === 'search') {
    history.replaceState(null, '', buildHash({ ...route, web2: includeWeb2.checked }))
  }
  render()
}

/**
 * Asks Orivon, once per content-addressed site, what the user's provider judged. A Web2 site
 * is Level 1 whatever a provider says, so it is not asked about. The first answer that names
 * a provider switches every card to it; a lookup that fails leaves its site unjudged by it.
 * If no answer names one, the user chose none and the snapshot stays.
 */
async function askOrivon () {
  if (!env.inOrivon || !canAskProvider()) return
  /** @type {Map<string, number | null>} */
  const levels = new Map()
  await Promise.all(SITES.filter((site) => observedLevel(site) === 2).map(async (site) => {
    const address = primaryHref(site, { inOrivon: true })
    if (address === null) return
    const answer = await providerJudgement(address)
    if (answer?.provider === null) return
    live ??= answer ? { provider: answer.provider, levels } : null
    levels.set(site.id, answer && answer.provider === live?.provider ? answer.level : null)
    repaintMarks()
  }))
}

search.addEventListener('input', () => { setQuery(search.value) })
includeWeb2.addEventListener('change', onIncludeWeb2Change)
window.addEventListener('hashchange', render)

document.addEventListener('keydown', (event) => {
  const target = /** @type {HTMLElement} */ (event.target)
  const typing = (target instanceof HTMLInputElement && target.type !== 'checkbox') || target instanceof HTMLTextAreaElement || target.isContentEditable
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
void askOrivon()
