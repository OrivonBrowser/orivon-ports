// The Lab's DOM: what Orivon says about this page, and the probes that check it. The
// probe contract is in the app's README.

import { el, fill } from '../dom.js'
import { describeError, request, snapshot, api } from '../orivon.js'
import { canRequest, canRun, probeState } from './state.js'
import { PROBES } from './probes.js'

/** Results survive a re-render, so pressing Request does not wipe what Run said. */
const results = new Map()
let generation = 0

/** The manifest this page is served with, read from the same origin. */
const served = {
  async manifest () {
    const response = await fetch('.well-known/orivon.json')
    if (!response.ok) throw new Error(`The published manifest answered ${response.status}`)
    return response.json()
  }
}

/** @param {unknown} value */
function declared (value) {
  const text = JSON.stringify(value)
  return text === '{}' || text === undefined ? 'none' : text
}

/** @param {import('../orivon.js').Snapshot} view */
function environmentRows (view) {
  const manifest = view.manifest
  return [
    ['Running in Orivon', view.inOrivon ? 'yes' : 'no'],
    ['API version', view.version === null ? 'none' : String(view.version)],
    ['Origin registered', view.registered ? 'yes' : 'no'],
    ['Consent granularity', manifest?.consentGranularity ?? 'unknown'],
    ['Declared capabilities', manifest ? declared(manifest.capabilities) : 'unknown'],
    ['Grants held', view.grants.length === 0 ? 'none' : view.grants.map((grant) => grant.capability).join(', ')]
  ]
}

/** @param {import('../orivon.js').Snapshot} view */
function environmentPanel (view) {
  return el('section', { class: 'panel', 'aria-labelledby': 'lab-env' },
    el('h2', { class: 'panel-title', id: 'lab-env', text: 'Environment' }),
    el('dl', { class: 'facts' }, environmentRows(view).map(([term, value]) => [
      el('dt', { text: term }), el('dd', { text: value })])),
    view.notes.map((note) => el('p', { class: 'note', text: note })),
    view.inOrivon ? null : el('p', { class: 'note', text: 'These probes need Orivon. Open this page in Orivon to run them.' }))
}

/**
 * @param {import('./probes.js').Probe} probe
 * @param {import('../orivon.js').Snapshot} view
 * @param {() => void} refresh
 */
function probeCard (probe, view, refresh) {
  const state = probeState(probe, view)
  const last = results.get(probe.id)
  const output = el('p', { class: last ? `result result-${last.ok ? 'ok' : 'fail'}` : 'result', role: 'status' })
  if (last) output.textContent = `${last.ok ? 'ok' : 'fail'}: ${last.detail} (${last.ms} ms)`
  const run = el('button', { type: 'button', class: 'open', disabled: !canRun(state), on: { click: async () => {
    const found = api()
    if (!found) return
    const started = performance.now()
    /** @type {{ ok: boolean, detail: string }} */
    let outcome
    try {
      outcome = await probe.run({ orivon: found, served })
    } catch (error) {
      outcome = { ok: false, detail: describeError(error) }
    }
    results.set(probe.id, { ...outcome, ms: Math.round(performance.now() - started) })
    refresh()
  } } }, 'Run')
  const ask = canRequest(state) && probe.capability
    ? el('button', { type: 'button', class: 'open open-quiet', on: { click: async () => {
      try {
        const granted = await request(String(probe.capability))
        results.set(probe.id, { ok: granted, detail: granted ? 'granted' : 'not granted', ms: 0 })
      } catch (error) {
        results.set(probe.id, { ok: false, detail: describeError(error), ms: 0 })
      }
      refresh()
    } } }, 'Request')
    : null
  return el('article', { class: 'card probe' },
    el('div', { class: 'card-text' },
      el('h3', { class: 'card-name', text: probe.title }),
      el('p', { class: 'card-summary' }, el('code', { text: probe.id }))),
    el('ul', { class: 'badges', 'aria-label': 'Probe' },
      el('li', { class: 'badge', text: `needs: ${probe.capability ?? 'none'}` }),
      el('li', { class: `badge ${state === 'granted' || state === 'ready' ? 'badge-ok' : 'badge-kind'}`, text: state })),
    el('div', { class: 'card-actions' }, ask, run),
    output)
}

/**
 * Render the Lab into `root`. A later render replaces an earlier one that is still waiting
 * on Orivon.
 * @param {HTMLElement} root
 */
export async function renderLab (root) {
  const mine = ++generation
  const view = await snapshot()
  if (mine !== generation) return
  const refresh = () => { void renderLab(root) }
  fill(root,
    el('h1', { class: 'view-title', text: 'Lab' }),
    el('p', { class: 'lead', text: 'Probes that check what Orivon gives this page, one capability at a time.' }),
    environmentPanel(view),
    el('h2', { class: 'group-title' }, 'Probes', el('span', { class: 'group-count', text: String(PROBES.length) })),
    el('div', { class: 'grid' }, PROBES.map((probe) => probeCard(probe, view, refresh))))
}
