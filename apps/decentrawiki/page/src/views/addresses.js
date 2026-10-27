// Settings, "Addresses": the IPNS names whose keys this browser holds, what each shows, and what Orivon's
// node is doing for it.

import { h, icon } from '../dom.js'
import { formatDay, shortCid } from '../format.js'
import { canKeepAgain, keepState, loadNames, removeName, shownTitle } from '../names.js'
import { nameAddressesOf } from '../publish/publish.js'
import { unlinkName } from '../wikis.js'
import { confirmDialog, copyText } from '../ui/dialog.js'
import { openKeyDialog } from '../ui/import-key.js'
import { downloadKey, downloadRecord, keepAgain } from '../ui/name-actions.js'

/** @typedef {import('../names.js').NameEntry} NameEntry */

/** What the address is doing, in a line. @param {NameEntry} entry */
function stateLine (entry) {
  const state = keepState(entry)
  switch (state.kind) {
    case 'unpublished': return 'Not published yet'
    case 'unconfirmed': return 'Signed here; Orivon\'s node has not taken the newest record yet'
    case 'lapsed': return `Orivon stopped keeping it on ${formatDay(state.until ?? 0)}`
    default: return state.until === null ? 'Orivon keeps it up' : `Orivon keeps it up until ${formatDay(state.until)}`
  }
}

/** @param {NameEntry} entry @param {() => void} refresh */
function row (entry, refresh) {
  const address = nameAddressesOf(entry.name).ipns
  return h('li', { class: 'target' },
    h('div', { class: 'target-main' },
      h('span', { class: 'row' },
        h('code', { class: 'cid', title: address }, `ipns://${shortCid(entry.name)}`),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Copy the address', onclick: () => copyText(address, 'Address') }, icon('copy'))),
      h('span', {}, `shows “${shownTitle(entry)}”`),
      h('span', { class: 'muted small' }, stateLine(entry))),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'button button-ghost button-small', onclick: () => { void downloadKey(entry.name) } }, 'Download the key'),
      entry.record === null ? null : h('button', { type: 'button', class: 'button button-ghost button-small', onclick: () => { void downloadRecord(entry.name) } }, 'Download the public record'),
      canKeepAgain(entry) ? h('button', { type: 'button', class: 'button button-secondary button-small', onclick: async () => { await keepAgain(entry.name); refresh() } }, 'Publish the address again') : null,
      h('button', { type: 'button', class: 'icon-button', 'aria-label': `Remove ipns://${shortCid(entry.name)}`, onclick: async () => {
        if (!await confirmDialog({ title: `Remove ipns://${shortCid(entry.name)}?`, message: 'Its key is deleted from this browser: download it first if this address may be updated again. Wikis that use it lose the link.', confirm: 'Remove', danger: true })) return
        await removeName(entry.name)
        await unlinkName(entry.name)
        refresh()
      } }, icon('trash'))))
}

/** @param {() => void} refresh */
export async function addressesPanel (refresh) {
  const names = await loadNames()
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('div', {}, h('h2', {}, 'Addresses'),
        h('p', { class: 'muted' }, 'Each wiki is published under an address of its own, an IPNS name whose key stays in this browser. A backup holds the wikis and which address each uses, not the keys: download each key and keep it safe.')),
      h('button', { type: 'button', class: 'button button-secondary', onclick: () => openKeyDialog({ onChanged: refresh, onOpen: (id) => { if (id !== null) location.hash = `#/wiki/${encodeURIComponent(id)}` } }) }, icon('upload'), 'Import a key')),
    names.length === 0
      ? h('p', { class: 'empty' }, 'No address yet. Publishing a wiki makes one, or Import a key brings one you made elsewhere.')
      : h('ul', { class: 'targets' }, names.map((entry) => row(entry, refresh))))
}
