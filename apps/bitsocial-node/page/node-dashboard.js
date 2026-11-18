// The node dashboard an app's "node" link opens, as one module for every app that runs the node. The build bundles this file
// into `node-dashboard.js`, which gives a page `globalThis.BitsocialNodeDashboard`. The app owns the page around it (its frame,
// its stylesheet, its wording); this draws the node's numbers into the frame's `root` and, for each feature the app names and
// the node answers, one more section. The page's state is left in `window.nodeDashboard` for a test to read.

import { boardManager } from './dashboard/board-manager.js'
import { challenges } from './dashboard/challenges.js'
import { h } from './dashboard/dom.js'
import { listing, listingSignature } from './dashboard/listing.js'
import { name } from './dashboard/name.js'
import { reach } from './dashboard/reach.js'
import { seeding } from './dashboard/seeding.js'
import { createStats } from './dashboard/stats.js'

export const REFRESH_MS = 5_000

/** A section is `{ name, feature, mount(context) }`: `mount` returns `{ element, refresh }`, or null when the handle cannot offer it. */
export const SECTIONS = [boardManager, listing, listingSignature, name, challenges, seeding, reach]

/**
 * The classes every element carries, which the app's frame styles (`nd-` and the element's role). An app that wants its own
 * stylesheet's class on a role names it in `app.classes`, and the element carries both.
 */
const CLASS_NAMES = {
  status: 'nd-status', detail: 'nd-detail', stats: 'nd-stats', section: 'nd-section', sectionTitle: 'nd-section-title', note: 'nd-note',
  error: 'nd-error', list: 'nd-list', board: 'nd-board', boardHead: 'nd-board-head', address: 'nd-address', badge: 'nd-badge', facts: 'nd-facts',
  form: 'nd-form', field: 'nd-field', label: 'nd-label', control: 'nd-control', input: 'nd-input', unit: 'nd-unit', hint: 'nd-hint',
  fieldError: 'nd-field-error', formMessage: 'nd-form-message', actions: 'nd-actions', button: 'nd-button',
  challenge: 'nd-challenge', challengeHead: 'nd-challenge-head', challengeTitle: 'nd-challenge-title', challengeBody: 'nd-challenge-body',
  rule: 'nd-rule', ruleHead: 'nd-rule-head', more: 'nd-more', choice: 'nd-choice', changes: 'nd-changes',
  requirements: 'nd-requirements', requirement: 'nd-requirement', request: 'nd-request', preview: 'nd-preview'
}

/** @param {Record<string, string>} [own] */
export function classesOf (own = {}) {
  return Object.fromEntries(Object.entries(CLASS_NAMES).map(([role, name]) => [role, own[role] === undefined ? name : `${name} ${own[role]}`]))
}

/**
 * @param {{
 *   root: HTMLElement,
 *   node: { ready: Promise<any>, error?: string | null },
 *   app: { name: string, term?: 'board' | 'community', features?: string[], classes?: Record<string, string>, addressSetting?: string },
 *   document?: Document, window?: any, now?: () => number, refreshMs?: number, sections?: typeof SECTIONS,
 *   fetch?: typeof fetch, open?: (url: string) => void, copy?: (text: string) => Promise<void>
 * }} options `node` is the page's `window.orivonBitsocialNode`: its `ready` settles with the handle, or with null when the node did not start.
 */
export function mountNodeDashboard ({ root, node, app, document: doc = globalThis.document, window: win = globalThis, now = Date.now, refreshMs = REFRESH_MS, sections = SECTIONS, fetch = (/** @type {any} */ ...args) => win.fetch(...args), open = (/** @type {string} */ url) => { win.open(url, '_blank', 'noopener,noreferrer') }, copy = (/** @type {string} */ text) => win.navigator.clipboard.writeText(text) }) {
  const classes = classesOf(app.classes)
  const view = { state: 'Starting', detail: '', stats: /** @type {any} */ (null), sections: /** @type {Record<string, any>} */ ({}) }
  win.nodeDashboard = view
  const stats = createStats({ doc, view, classes })
  const holder = h(doc, 'div', { 'data-nd-sections': '' })
  root.append(...stats.elements, holder)
  /** @type {Array<{ refresh: () => Promise<void> }>} */
  const running = []
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null

  /** The stats and every section, each on its own: one that fails leaves the others as they were. */
  const refreshAll = (/** @type {any} */ handle) => Promise.allSettled([stats.refresh(handle), ...running.map((one) => one.refresh())])

  async function main () {
    stats.draw()
    const handle = await node.ready
    if (handle === null) {
      view.state = 'Not running'
      view.detail = node.error ?? ''
      stats.draw()
      return
    }
    view.state = handle.reused ? `Running (started by another tab of ${app.name})` : 'Running'
    stats.draw()
    stats.setAddresses(`ws://localhost:${String(handle.ports.rpc)}/<key>`, handle.gatewayUrl)
    for (const section of sections) {
      if (!(app.features ?? []).includes(section.feature)) continue
      const state = { shown: false, boards: [], defaults: null, error: null }
      const made = section.mount({ doc, handle, app, classes, now, state, fetch, open, copy, wallet: () => win.ethereum ?? null })
      if (made === null) continue
      view.sections[section.name] = state
      holder.append(made.element)
      running.push(made)
    }
    await refreshAll(handle)
    timer = setInterval(() => { refreshAll(handle).catch(() => {}) }, refreshMs)
  }

  const started = main().catch((error) => { view.state = 'Not running'; view.detail = String(error); stats.draw() })
  return { view, started, stop () { if (timer !== null) clearInterval(timer) } }
}
