// The directory's DOM: the navigation, the environment pill, and the cards under their
// categories. It renders a route it is given and holds no state of its own.

import { chipsFor, isPublished, upstreamChip } from './addresses.js'
import { filterSites, groupByCategory } from './filter.js'
import { hue, initials } from './monogram.js'
import { buildHash } from './router.js'
import { el, fill } from './dom.js'

/**
 * @typedef {import('./router.js').Route} Route
 * @typedef {import('./addresses.js').Env} Env
 */

const KIND_BADGE = { native: 'Built for Orivon', port: 'Ported to Orivon' }

/**
 * The navigation: All, each category, and the Orivon apps, each with how many sites it shows.
 * @param {HTMLElement} nav
 * @param {Route} route
 * @param {{ total: number, orivon: number, byCategory: Record<string, number> }} counts
 * @param {readonly import('./catalog.js').Category[]} categories
 */
export function renderNav (nav, route, counts, categories) {
  const onDirectory = route.view === 'directory'
  const here = onDirectory ? buildHash({ ...route, q: '' }) : ''
  /** @param {string} hash @param {string} label @param {number} count @param {string} [extra] */
  const link = (hash, label, count, extra) => el('a', {
    href: hash,
    class: extra ? `nav-link ${extra}` : 'nav-link',
    'aria-current': hash === here ? 'page' : null
  }, el('span', { class: 'nav-label', text: label }), el('span', { class: 'nav-count', text: String(count) }))
  fill(nav,
    link('#/', 'All sites', counts.total),
    link('#/orivon', 'Orivon apps', counts.orivon, 'nav-orivon'),
    el('hr', { class: 'nav-rule' }),
    categories.map((category) => link(`#/c/${category.id}`, category.name, counts.byCategory[category.id] ?? 0)))
}

/**
 * @param {HTMLElement} pill
 * @param {Env} env
 */
export function renderPill (pill, env) {
  pill.className = env.inOrivon ? 'pill pill-on' : 'pill'
  fill(pill, el('span', { class: 'pill-dot', 'aria-hidden': 'true' }), env.inOrivon ? 'Running in Orivon' : 'Open in Orivon for verified .eth links')
}

/** @param {import('./catalog.js').Site} site */
function tile (site) {
  const node = el('span', { class: 'tile', 'aria-hidden': 'true', text: initials(site.name) })
  node.style.setProperty('--tile-hue', String(hue(site.id)))
  return node
}

/** @param {import('./catalog.js').Site} site */
function badges (site) {
  if (!site.orivon) return null
  return el('ul', { class: 'badges', 'aria-label': 'Orivon' },
    el('li', { class: 'badge badge-orivon', text: 'Orivon app' }),
    el('li', { class: 'badge badge-kind', text: KIND_BADGE[site.orivon.kind] }),
    site.orivon.needsOrivon ? el('li', { class: 'badge badge-needs', text: 'Runs only in Orivon' }) : null,
    isPublished(site) ? null : el('li', { class: 'badge', text: 'Coming soon' }))
}

/**
 * The open button is a link when there is somewhere to go. For an app that runs only in
 * Orivon, outside it, it is a button that says why instead.
 * @param {import('./catalog.js').Site} site
 * @param {Env} env
 */
function openAction (site, env) {
  if (!isPublished(site)) return el('p', { class: 'unpublished', text: 'Not published yet' })
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
 * @param {import('./catalog.js').Site} site
 * @param {Env} env
 */
function card (site, env) {
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
    el('div', { class: 'card-actions' }, openAction(site, env)))
}

const HEADINGS = {
  all: ['All sites', 'Web3 sites by category. Those marked Orivon app are built for Orivon or ported to it.'],
  orivon: ['Orivon apps', 'Built for Orivon or ported to it. Each one gets only the capabilities its manifest declares, and only after you agree.']
}

/**
 * The results for a route: a heading, then one group per category that has a match.
 * @param {HTMLElement} root
 * @param {{
 *   route: Route, env: Env,
 *   sites: readonly import('./catalog.js').Site[],
 *   categories: readonly import('./catalog.js').Category[],
 *   onClear: () => void
 * }} state
 */
export function renderResults (root, { route, env, sites, categories, onClear }) {
  const matches = filterSites(sites, categories, { query: route.q, category: route.category, orivonOnly: route.orivonOnly })
  const category = categories.find((candidate) => candidate.id === route.category)
  const [title, lead] = category
    ? [category.name, '']
    : route.orivonOnly ? HEADINGS.orivon : HEADINGS.all
  const searching = route.q.trim() !== ''
  const summary = el('p', { class: 'result-count', role: 'status', text: `${matches.length} ${matches.length === 1 ? 'site' : 'sites'}${searching ? ` matching “${route.q.trim()}”` : ''}` })
  const groups = matches.length === 0
    ? el('div', { class: 'empty' },
      el('p', { class: 'empty-title', text: 'Nothing matches that.' }),
      el('p', { text: 'Try a shorter search, or look at all sites.' }),
      el('button', { type: 'button', class: 'open open-quiet', on: { click: onClear } }, 'Clear search and filters'))
    : groupByCategory(matches, categories).map((group) => el('section', { class: 'group', 'aria-labelledby': category ? null : `group-${group.category.id}` },
      category ? null : el('h2', { class: 'group-title', id: `group-${group.category.id}` }, group.category.name, el('span', { class: 'group-count', text: String(group.sites.length) })),
      el('div', { class: 'grid' }, group.sites.map((site) => card(site, env)))))
  fill(root, el('h1', { class: 'view-title', text: title }), lead ? el('p', { class: 'lead', text: lead }) : null, summary, groups)
}
