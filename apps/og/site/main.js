// Starts the page: builds the app object, draws the bar, and draws the view the address bar names, again whenever it changes. A view
// that cannot be drawn is shown as an error with its message, never left blank.

import { createApp } from './app.js'
import { el, fill } from './dom.js'
import { mountHeader } from './header.js'
import { bannerOf } from './header-model.js'
import { notice } from './parts.js'
import { parseRoute } from './router.js'
import { mountManage } from './view-manage.js'
import { mountNames } from './view-names.js'
import { mountSearch } from './view-search.js'

const TITLES = Object.freeze({ search: 'Register a name', names: 'My names', manage: 'Manage a name', notFound: 'Not found' })

const app = createApp()
const top = /** @type {HTMLElement} */ (document.getElementById('top'))
const main = /** @type {HTMLElement} */ (document.getElementById('main'))
const banner = /** @type {HTMLElement} */ (document.getElementById('banner'))
const header = mountHeader(top, app)

/** @type {{ unmount?: () => void } | null} */
let view = null
let first = true
let route = parseRoute(location.hash)

/** Says that a registration or a change to a name is under way on a page that does not show it. */
function drawBanner () {
  const here = route.name === 'manage' && route.label === app.managing.state['label']
  const said = (route.name === 'search' ? null : bannerOf(app.registration.state)) ?? (here ? null : bannerOf(app.managing.state))
  if (said === null) { fill(banner); return }
  fill(banner, el('div', { class: 'banner' }, notice(said.tone, said.words, el('p', {}, el('a', { href: said.href, text: 'Open it' })))))
}

/** @param {unknown} error */
const describe = (error) => error instanceof Error ? `${error.name}: ${error.message}` : String(error)

/** A failure outside any view's own handling: shown above the page, which stays as it is. @param {unknown} error */
function reportProblem (error) {
  fill(banner, el('div', { class: 'banner' }, notice('bad', 'Something went wrong in this page.',
    el('details', { class: 'detail' }, el('summary', { text: 'Technical detail' }), el('pre', { text: describe(error) })))))
}

/** @param {unknown} error */
function crashed (error) {
  fill(main, el('div', { class: 'page narrow' },
    el('h1', { text: 'This page could not be drawn' }),
    notice('bad', 'Something went wrong in this page.', el('details', { class: 'detail', open: true }, el('summary', { text: 'Technical detail' }), el('pre', { text: describe(error) })))))
}

function draw () {
  route = parseRoute(location.hash)
  view?.unmount?.()
  view = null
  main.replaceChildren()
  try {
    if (route.name === 'search') view = mountSearch(main, app, route)
    else if (route.name === 'names') view = mountNames(main, app)
    else if (route.name === 'manage') view = mountManage(main, app, route)
    else main.append(el('div', { class: 'page narrow' }, el('h1', { text: 'There is no such page' }), el('p', {}, el('a', { href: '#/', text: 'Go to the start' }))))
  } catch (error) {
    crashed(error)
  }
  header.setActive(route.name === 'manage' ? 'names' : route.name)
  document.title = `${TITLES[route.name]} · OG names`
  drawBanner()
  if (!first) {
    window.scrollTo(0, 0)
    main.focus({ preventScroll: true })
  }
  first = false
}

window.addEventListener('hashchange', draw)
window.addEventListener('error', (event) => { if (event.error !== undefined) reportProblem(event.error) })
window.addEventListener('unhandledrejection', (event) => { reportProblem(event.reason) })
document.getElementById('skip')?.addEventListener('click', () => main.focus())
app.onRegistration(drawBanner)
app.onManage(drawBanner)

draw()
