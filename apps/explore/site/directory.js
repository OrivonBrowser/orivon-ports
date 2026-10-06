// The directory's DOM: the navigation, the environment pill, and the cards under their
// categories. It renders a route it is given and holds no state of its own.

import { chipsFor, isPublished, upstreamChip } from './addresses.js'
import { filterSites, groupByCategory, SCORE_SECTIONS } from './filter.js'
import { browsedSection, buildHash } from './router.js'
import { describeScore } from './score.js'
import { el, fill } from './dom.js'

/**
 * @typedef {import('./router.js').Route} Route
 * @typedef {import('./addresses.js').Env} Env
 * @typedef {import('./catalog.js').Site} Site
 * @typedef {import('./catalog.js').Category} Category
 * @typedef {(site: Site) => import('./score.js').Score | null} ScoreFor
 */

const KIND_BADGE = { native: 'Built for Orivon', port: 'Ported to Orivon' }

const SECTION_NAMES = { web3: 'Web3 sites', web25: 'Web2.5 sites', web2: 'Web2 sites', all: 'All sites', orivon: 'Orivon apps' }

/**
 * The navigation: the sections, the Orivon apps, and the categories of the section
 * being browsed, each with how many sites it shows.
 * @param {HTMLElement} nav
 * @param {Route} route
 * @param {import('./filter.js').Counts} counts
 * @param {readonly Category[]} categories
 */
export function renderNav (nav, route, counts, categories) {
  const here = route.view === 'directory' ? buildHash(route) : ''
  const section = browsedSection(route)
  const parent = route.view === 'directory' && route.category ? buildHash({ ...route, category: null }) : ''
  /** @param {string} hash @param {string} label @param {number} count @param {string} [extra] */
  const link = (hash, label, count, extra) => el('a', {
    href: hash,
    class: ['nav-link', extra, count === 0 ? 'nav-empty' : ''].filter(Boolean).join(' '),
    'aria-current': hash === here ? 'page' : hash === parent ? 'true' : null
  }, el('span', { class: 'nav-label', text: label }), el('span', { class: 'nav-count', text: String(count) }))
  /** @param {'web3' | 'web25' | 'web2' | 'all' | 'orivon'} name @param {string} [extra] */
  const sectionLink = (name, extra) => link(buildHash({ ...route, view: 'directory', section: name, category: null, q: '' }), SECTION_NAMES[name], counts[name], extra)
  fill(nav,
    sectionLink('web3', 'nav-web3'),
    sectionLink('web25'),
    sectionLink('web2'),
    sectionLink('all'),
    el('hr', { class: 'nav-rule' }),
    sectionLink('orivon', 'nav-orivon'),
    el('hr', { class: 'nav-rule' }),
    categories.map((category) => link(
      buildHash({ view: 'directory', section, category: category.id, q: '', web2: false }),
      category.name,
      counts.byCategory[section][category.id] ?? 0)))
}

/**
 * @param {HTMLElement} pill
 * @param {Env} env
 */
export function renderPill (pill, env) {
  pill.className = env.inOrivon ? 'pill pill-on' : 'pill'
  fill(pill, el('span', { class: 'pill-dot', 'aria-hidden': 'true' }), env.inOrivon ? 'Running in Orivon' : 'Open in Orivon for verified .eth links')
}

/** @param {Site} site */
function tile (site) {
  return el('img', {
    class: 'tile tile-icon', src: `icons/${site.id}.svg`, alt: '', width: '44', height: '44',
    loading: 'lazy', decoding: 'async', 'aria-hidden': 'true'
  })
}

/**
 * Paints a card's Web3 Score mark. A later answer from Orivon repaints it in place, so the
 * card around it, and the focus inside it, are left alone.
 * @param {HTMLElement} node
 * @param {import('./score.js').Score | null} score
 */
export function paintMark (node, score) {
  node.hidden = score === null
  if (score === null) return
  const sentence = describeScore(score)
  node.dataset.mark = score.mark
  node.title = sentence
  node.setAttribute('aria-label', `Web3 Score: ${sentence}`)
  node.textContent = score.mark
}

/** @param {Site} site @param {ScoreFor} scoreFor */
function mark (site, scoreFor) {
  const node = el('span', { class: 'mark', role: 'img', 'data-mark-site': site.id })
  paintMark(node, scoreFor(site))
  return node
}

/** @param {Site} site */
function badges (site) {
  if (!site.orivon) return null
  return el('ul', { class: 'badges', 'aria-label': 'Orivon' },
    el('li', { class: 'badge badge-orivon', text: 'Orivon app' }),
    el('li', { class: 'badge badge-kind', text: KIND_BADGE[site.orivon.kind] }),
    site.orivon.needsOrivon ? el('li', { class: 'badge badge-needs', text: 'Runs only in Orivon' }) : null)
}

/**
 * The open button is a link when there is somewhere to go. For an app that runs only in
 * Orivon, outside it, it is a button that says why instead.
 * @param {Site} site
 * @param {Env} env
 */
function openAction (site, env) {
  if (!isPublished(site)) return el('p', { class: 'unpublished', text: 'Coming soon: not published yet' })
  const chips = chipsFor(site, env)
  const href = chips.find((chip) => chip.href !== null)?.href ?? null
  if (href) {
    return el('a', { class: 'open', href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open ${site.name}` }, 'Open')
  }
  const note = el('p', { class: 'needs-note', role: 'status', hidden: true, id: `needs-${site.id}`, text: `${site.name} runs only in Orivon. Open this page in Orivon to use it.` })
  const button = el('button', {
    type: 'button',
    class: 'open open-blocked',
    'aria-describedby': note.id,
    on: { click: () => { note.hidden = !note.hidden } }
  }, 'Needs Orivon')
  return [button, note]
}

/**
 * @param {Site} site
 * @param {Env} env
 * @param {ScoreFor} scoreFor
 */
function card (site, env, scoreFor) {
  const chips = chipsFor(site, env)
  const upstream = upstreamChip(site)
  return el('article', { class: site.orivon ? 'card card-orivon' : 'card' },
    el('div', { class: 'card-head' },
      tile(site),
      el('div', { class: 'card-text' },
        el('h3', { class: 'card-name', text: site.name }),
        el('p', { class: 'card-summary', text: site.summary }))),
    badges(site),
    chips.length === 0 && !upstream ? null : el('ul', { class: 'chips', 'aria-label': 'Addresses' },
      chips.map((chip) => el('li', {},
        chip.href
          ? el('a', { class: `chip chip-${chip.kind}`, href: chip.href, target: '_blank', rel: 'noopener noreferrer', title: chip.title, text: chip.text })
          : el('span', { class: `chip chip-${chip.kind}`, title: chip.title, text: chip.text }))),
      upstream && el('li', {}, el('a', { class: 'chip chip-upstream', href: upstream.href, target: '_blank', rel: 'noopener noreferrer', title: upstream.title, text: upstream.text }))),
    el('div', { class: 'card-actions' }, openAction(site, env), mark(site, scoreFor)))
}

const LEADS = {
  web3: 'Orivon apps, and every content-addressed site the Web3 Score provider judged Level 4 -- Web3: in Orivon, every file they show is checked against its address. Each card carries the site\'s Web3 Score.',
  web25: 'Sites published at an ENS name or an IPFS address, which Orivon checks file by file, whose score falls short of Web3: Level 2, Level 3, or no judgement yet. Each card carries the site\'s Web3 Score.',
  web2: 'Projects reached at an ordinary web address. The server decides what you get and nothing can be checked, so each one scores Web2.',
  all: 'Every site listed here: the Web3 sites, then the Web2.5 ones, then the Web2 ones.',
  orivon: 'Apps that use what only Orivon gives a page, such as network sockets and files. Built for Orivon or ported to it, each gets only the capabilities its manifest declares, and only after you agree.'
}

/**
 * @typedef {{
 *   route: Route, env: Env, sites: readonly Site[], categories: readonly Category[],
 *   scoreFor: ScoreFor, onClear: () => void, onIncludeWeb2: () => void
 * }} ResultsState
 */

/** @param {string} label @param {() => void} onClick */
function textButton (label, onClick) {
  return el('button', { type: 'button', class: 'text-button', on: { click: onClick } }, label)
}

/** @param {number} count @param {string} [kind] */
function sitesWord (count, kind) {
  return `${count} ${kind ? `${kind} ` : ''}${count === 1 ? 'site' : 'sites'}`
}

/**
 * A search runs over the Web3 and Web2.5 sites -- every site with a Web3 address -- and over
 * the Web2 ones too when Include Web2 is on. With it off, a Web2 match is never shown but
 * always offered, so a search never looks emptier than the directory is.
 * @param {ResultsState} state
 */
function searchView ({ route, sites, categories, scoreFor, onClear, onIncludeWeb2 }) {
  const levelOf = (site) => scoreFor(site)?.level ?? null
  const q = route.q.trim()
  const matches = filterSites(sites, categories, { query: route.q, sections: route.web2 ? SCORE_SECTIONS : ['web3', 'web25'] }, levelOf)
  const hidden = route.web2 ? 0 : filterSites(sites, categories, { query: route.q, sections: ['web2'] }, levelOf).length
  const count = el('p', { class: 'result-count', role: 'status' },
    `${sitesWord(matches.length, route.web2 ? '' : 'Web3 or Web2.5')} matching “${q}”`,
    hidden > 0 ? [' · ', textButton(`${sitesWord(hidden, 'Web2')} more`, onIncludeWeb2)] : null)
  if (matches.length > 0) return { title: 'Search', lead: '', count, matches, empty: null }
  const empty = hidden > 0
    ? el('div', { class: 'empty' },
      el('p', { class: 'empty-title', text: 'No Web3 site matches that.' }),
      el('p', { text: `${sitesWord(hidden, 'Web2')} ${hidden === 1 ? 'does' : 'do'}.` }),
      el('button', { type: 'button', class: 'open', on: { click: onIncludeWeb2 } }, 'Include Web2'))
    : el('div', { class: 'empty' },
      el('p', { class: 'empty-title', text: 'Nothing matches that.' }),
      el('p', { text: 'Try a shorter search.' }),
      el('button', { type: 'button', class: 'open open-quiet', on: { click: onClear } }, 'Clear search'))
  return { title: 'Search', lead: '', count, matches, empty }
}

/**
 * A section, or one category of it. An empty category points at another of the three score
 * sections, one where its sites are.
 * @param {ResultsState} state
 */
function sectionView ({ route, sites, categories, scoreFor }) {
  const levelOf = (site) => scoreFor(site)?.level ?? null
  const matches = filterSites(sites, categories, { sections: [route.section], category: route.category }, levelOf)
  const category = categories.find((candidate) => candidate.id === route.category)
  const count = el('p', { class: 'result-count', role: 'status', text: sitesWord(matches.length) })
  if (!category) return { title: SECTION_NAMES[route.section], lead: LEADS[route.section], count, matches, empty: null }
  const other = SCORE_SECTIONS.find((name) => name !== route.section &&
    filterSites(sites, categories, { sections: [name], category: category.id }, levelOf).length > 0)
  const empty = matches.length > 0 || other === undefined ? null : el('div', { class: 'empty' },
    el('p', { class: 'empty-title', text: `No ${SECTION_NAMES[route.section]} in ${category.name} yet.` }),
    el('a', { class: 'open open-quiet', href: buildHash({ ...route, section: other }) }, `See its ${SECTION_NAMES[other]}`))
  return { title: category.name, lead: LEADS[route.section], count, matches, empty }
}

/**
 * The results for a route: a heading, then one group per category that has a match.
 * @param {HTMLElement} root
 * @param {ResultsState} state
 */
export function renderResults (root, state) {
  const levelOf = (site) => state.scoreFor(site)?.level ?? null
  const { title, lead, count, matches, empty } = state.route.view === 'search' ? searchView(state) : sectionView(state)
  const grouped = !state.route.category
  const groups = empty ?? groupByCategory(matches, state.categories, levelOf).map((group) => el('section', { class: 'group', 'aria-labelledby': grouped ? `group-${group.category.id}` : null },
    grouped ? el('h2', { class: 'group-title', id: `group-${group.category.id}` }, group.category.name, el('span', { class: 'group-count', text: String(group.sites.length) })) : null,
    el('div', { class: 'grid' }, group.sites.map((site) => card(site, state.env, state.scoreFor)))))
  fill(root, el('h1', { class: 'view-title', text: title }), lead ? el('p', { class: 'lead', text: lead }) : null, count, groups)
}
