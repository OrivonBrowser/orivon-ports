// Entry: reads the address bar, renders the directory or the Lab, wires the search box, the
// Include Web2 box and the keyboard, and asks Orivon for the user's Web3 Score provider's
// judgements. Nothing here knows how a card is drawn or how a probe runs.

import { CATEGORIES, SITES } from './catalog.js'
import { countSites } from './filter.js'
import { SNAPSHOT } from './judgements.js'
import { buildHash, pageKey, parseHash } from './router.js'
import { judgementFor, observedLevel, scoreOf } from './score.js'
import { primaryHref } from './addresses.js'
import { canAskProvider, detect, hasScoreGrant, providerJudgement } from './orivon.js'
import { renderNav, renderPill, renderResults } from './directory.js'
import { renderLab } from './lab/lab.js'

const env = { inOrivon: detect().inOrivon }
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
 * site id. A site it gave no level keeps the snapshot's judgement (score.js's `judgementFor`).
 * Set once, when every lookup has answered, so the sections, the counts and the marks all
 * change together.
 * @type {{ provider: string, levels: Map<string, number> } | null}
 */
let live = null

/** Past this a lookup counts as unanswered, so one stuck name cannot hold the others back. */
const LOOKUP_TIMEOUT_MS = 20_000

/** @param {import('./catalog.js').Site} site */
const scoreFor = (site) => scoreOf(site, judgementFor(site, live, SNAPSHOT))

/** The level each section filter reads: the one the site's own card shows. */
const levelOf = (site) => scoreFor(site)?.level ?? null

function renderScoreSource () {
  scoreSource.textContent = live
    ? `Web3 Scores judged by ${live.provider}, your Web3 Score provider in Orivon. A site it has given no level shows ${SNAPSHOT.provider}'s judgement of ${SNAPSHOT.read}.`
    : `Web3 Scores judged by ${SNAPSHOT.provider} on ${SNAPSHOT.read}; a .eth site's score covers what its name served that day. In Orivon, your own Web3 Score provider's judgement takes its place.`
}

function render () {
  route = parseHash(location.hash, categoryIds)
  if (search.value !== route.q) search.value = route.q
  if (route.view === 'search') includeWeb2.checked = route.web2
  search.placeholder = includeWeb2.checked ? 'Search Web3, Web2.5 and Web2 sites' : 'Search Web3 and Web2.5 sites'
  renderPill(pill, env)
  renderNav(nav, route, countSites(SITES, levelOf), CATEGORIES)
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
  const sectionTitle = { web3: 'Web3 sites', web25: 'Web2.5 sites', web2: 'Web2 sites', all: 'All sites', orivon: 'Orivon apps' }[route.section]
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

/** @template T @param {Promise<T>} promise @param {number} ms @returns {Promise<T | null>} */
function within (promise, ms) {
  return Promise.race([promise, new Promise((resolve) => { setTimeout(() => { resolve(null) }, ms) })])
}

/**
 * Asks Orivon, once per content-addressed site, what the user's provider judged. A Web2 site
 * is Level 1 whatever a provider says, so it is not asked about. The answers are applied
 * together, once all are in: the page shows the snapshot until then, and never a mix that
 * depends on which lookups happened to finish first. If no answer names a provider, the user
 * chose none and the snapshot stays. Without the `trust.score` grant nothing is asked.
 */
async function askOrivon () {
  if (!env.inOrivon || !canAskProvider() || !(await hasScoreGrant())) return
  const answers = await Promise.all(SITES.filter((site) => observedLevel(site) === 2).map(async (site) => {
    const address = primaryHref(site, { inOrivon: true })
    return { site, answer: address === null ? null : await within(providerJudgement(address), LOOKUP_TIMEOUT_MS) }
  }))
  const provider = answers.find(({ answer }) => typeof answer?.provider === 'string')?.answer?.provider
  if (typeof provider !== 'string') return
  /** @type {Map<string, number>} */
  const levels = new Map()
  for (const { site, answer } of answers) {
    if (answer?.provider === provider && answer.level !== null) levels.set(site.id, answer.level)
  }
  live = { provider, levels }
  // The Lab keeps its page: only what reads a score is drawn again.
  if (route.view === 'lab') {
    renderNav(nav, route, countSites(SITES, levelOf), CATEGORIES)
    renderScoreSource()
  } else {
    // The cards are drawn again, so the link that held the keyboard is found again by its address.
    const held = document.activeElement instanceof HTMLAnchorElement && main.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null
    render()
    if (held !== null) /** @type {HTMLElement | null} */ (main.querySelector(`a[href="${CSS.escape(held)}"]`))?.focus()
  }
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
