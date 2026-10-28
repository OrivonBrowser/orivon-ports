// Settings, under Publishing: the two switches that decide where a published wiki lives. The first hosts the
// newest version of every wiki from this computer, with the line that says what the node is doing; the second
// keeps a copy with Orivon's free pinning. Neither adds anything to the main screen.

import { h } from '../dom.js'
import { hosting, hostingAvailable } from '../publish/hosting.js'
import { freePinningOn, hostingOn, setFreePinning, setHosting } from '../publish/page-node.js'
import { FREE_DAYS } from '../publish/targets.js'
import * as store from '../store.js'

const STOPS = 'It stops when you close the editor\'s last tab.'
/** How often the status line is read again from what the node reported. */
const REDRAW_MS = 5000

/** @typedef {ReturnType<typeof hosting.summary>} Summary */

/**
 * What the status line says. `reachability` is the node's own view of the computer: public when other nodes can
 * connect to it, private behind a router that refuses them. `stored` is how many wikis have a version to host, and
 * `failed` whether the node could not start for them. `summary.unplaced` counts the wikis the node would not take.
 * @param {boolean} on @param {Summary} summary @param {{ stored?: number, failed?: boolean }} [more]
 */
export function hostingStatus (on, summary, { stored = 0, failed = false } = {}) {
  if (!on) return 'Off.'
  const { wikis, state, reachability, relays, unplaced } = summary
  if (failed && wikis === 0) return 'The IPFS node did not start. Close the editor\'s other tabs and reload the editor to try again.'
  if (wikis === 0 && unplaced > 0) return `The IPFS node would not take ${unplaced === 1 ? 'a wiki' : `${unplaced} wikis`}: it may be full. Close the editor's other tabs and reload the editor to try again.`
  if (wikis === 0 && stored === 0) return `On. Nothing is hosted yet: a wiki is hosted from the moment it is published. Publish again to host one published before. ${STOPS}`
  if (wikis === 0 || state === 'starting') return `Starting… ${STOPS}`
  // A node behind a router with no place on the relay announces over its own outbound connections, which nobody can dial back.
  if (state === 'unreachable' || (reachability === 'private' && relays === 0)) return `Not reachable: your router refuses connections and Orivon's relay could not be reached. ${STOPS}`
  const how = reachability === 'public' ? 'reachable directly' : relays > 0 ? 'through Orivon\'s relay' : 'announced on IPFS'
  const left = unplaced > 0 ? ` ${unplaced} more not taken by the node, which may be full.` : ''
  return `Hosting ${wikis} ${wikis === 1 ? 'wiki' : 'wikis'}, ${how}.${left} ${STOPS}`
}

/** Why the first switch cannot be turned on here, or null. */
function unavailable () {
  if (hostingAvailable()) return null
  return typeof window.orivon?.net?.connect === 'function'
    ? 'Orivon has not allowed this editor to accept connections from the network, which hosting needs.'
    : 'Needs Orivon: other browsers give a page no IPFS node.'
}

/** @param {boolean} hostOn @param {boolean} freeOn */
function freeHint (hostOn, freeOn) {
  const kept = hostOn
    ? `Orivon's server fetches each new version from your computer over IPFS, keeps it for ${FREE_DAYS} days and keeps its IPNS address up, so the wiki stays online when the editor is closed.`
    : `The wiki is uploaded to Orivon's server, which keeps it for ${FREE_DAYS} days and keeps its IPNS address up.`
  return freeOn ? kept : `${kept} Off: Publish does not offer it. Orivon's server still keeps the IPNS address of a wiki you publish under one, pointing at its newest version.`
}

/**
 * One switch: a checkbox in a row of the same look as the Publish dialog's choices.
 * @param {{ label: string, hint: string, checked: boolean, disabled?: boolean, onChange: (on: boolean) => Promise<void>, extra?: HTMLElement[] }} options
 */
function row ({ label, hint, checked, disabled = false, onChange, extra = [] }) {
  const box = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked, disabled }))
  box.addEventListener('change', () => { void onChange(box.checked) })
  return h('label', { class: disabled ? 'choice choice-disabled' : 'choice' }, box,
    h('span', { class: 'choice-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, hint), ...extra))
}

/**
 * The two switches, with the hosting status line kept up to date while Settings is open.
 * @param {() => void} refresh draws Settings again after a switch changed
 */
export async function hostingSwitches (refresh) {
  const hostOn = await hostingOn()
  const freeOn = await freePinningOn()
  const blocked = unavailable()
  const stored = hostOn && blocked === null ? await store.listHosted().then((rows) => rows.length, () => 0) : 0
  let failed = false
  const status = h('span', { class: 'muted small', role: 'status' })
  const draw = () => { status.textContent = blocked ?? hostingStatus(hostOn, hosting.summary(), { stored, failed }) }
  draw()
  if (hostOn && blocked === null) {
    // The editor hands its stored wikis to the node when it loads; asking again joins that start, or tries once more after a failure.
    if (stored > 0) void hosting.node().then((node) => { failed = node === null; draw() }, () => {})
    void hosting.poll().then(draw, () => {})
    const timer = setInterval(() => { if (status.isConnected) draw(); else clearInterval(timer) }, REDRAW_MS)
  }
  return h('fieldset', { class: 'choices' }, h('legend', {}, 'Where your wikis live'),
    row({
      label: 'Host your wikis from this computer',
      hint: 'Orivon\'s IPFS node, in this editor, serves the newest version of every wiki you publish to anyone on IPFS, while the editor is open. People who open a wiki, and Orivon\'s relay, can see your IP address. Turned off, it stops announcing your wikis at once.',
      checked: hostOn && blocked === null,
      disabled: blocked !== null,
      onChange: async (on) => { await setHosting(on); refresh() },
      extra: [status]
    }),
    row({
      label: 'Also keep a copy with Orivon\'s free pinning',
      hint: freeHint(hostOn, freeOn),
      checked: freeOn,
      onChange: async (on) => { await setFreePinning(on); refresh() }
    }))
}
