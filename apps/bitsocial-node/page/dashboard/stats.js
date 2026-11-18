// The node's own numbers: its state, peer id, peer count, reachability, repository size, and the two addresses an app talks to it on.

import { h } from './dom.js'
import { REACHABILITY, sizeOf } from './format.js'

/** What a person reads, in the order it is shown: the element's id, and its label. */
const ROWS = [['peer', 'Peer ID'], ['peers', 'Connected peers'], ['reach', 'Reachability'], ['repo', 'Repository'], ['rpc', 'RPC'], ['gateway', 'Media gateway']]

/**
 * @param {{ doc: Document, view: { state: string, detail: string, stats: any }, classes: Record<string, string> }} options
 * `view` is the page's state, which the stats keep up to date and a test reads.
 */
export function createStats ({ doc, view, classes }) {
  const cells = Object.fromEntries(ROWS.map(([id]) => [id, h(doc, 'dd', { id })]))
  const state = h(doc, 'h2', { id: 'state', class: classes['status'] ?? '', text: view.state })
  const detail = h(doc, 'p', { id: 'detail', class: classes['detail'] ?? '' })
  const list = h(doc, 'dl', { class: classes['stats'] ?? '' }, ...ROWS.flatMap(([id, label]) => [h(doc, 'dt', { text: label }), cells[id]]))

  function draw () {
    const { stats } = view
    state.textContent = view.state
    detail.textContent = view.detail
    cells['peer'].textContent = stats?.peer ?? ''
    cells['peers'].textContent = stats?.peers == null ? '' : String(stats.peers)
    cells['reach'].textContent = stats === null ? '' : REACHABILITY[/** @type {keyof typeof REACHABILITY} */ (stats.reachability)]
    cells['repo'].textContent = stats?.repoBytes == null ? '' : `${sizeOf(stats.repoBytes)}${stats.storageMax == null ? '' : ` of ${sizeOf(stats.storageMax)}`}`
  }

  let refreshing = false

  return {
    elements: [state, detail, list],
    draw,
    /** @param {string} rpc @param {string} gateway */
    setAddresses (rpc, gateway) { cells['rpc'].textContent = rpc; cells['gateway'].textContent = gateway },
    /** A busy node answers some calls late: a value that did not come this time stays what it was. @param {{ stats: () => Promise<Record<string, any>> }} handle */
    async refresh (handle) {
      if (refreshing) return
      refreshing = true
      try {
        const fresh = await handle.stats()
        const kept = view.stats ?? {}
        view.stats = Object.fromEntries(Object.entries(fresh).map(([name, value]) => [name, value === null || value === 'unknown' ? (kept[name] ?? value) : value]))
        draw()
      } finally { refreshing = false }
    }
  }
}
