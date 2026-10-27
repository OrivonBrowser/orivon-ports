// The question every import ends in: it knows when the library already holds a version of the same wiki,
// and links the wiki taken in to the address it was published under when this browser holds that address.

import { h, icon } from '../dom.js'
import { formatAgo, formatBytes } from '../format.js'
import { compareTiddlers } from '../import.js'
import { getName } from '../names.js'
import * as store from '../store.js'
import { addImported, copiesOf, linkWikiToName, replaceWithVersion } from '../wikis.js'
import { openDialog } from './dialog.js'

/** @typedef {ReturnType<typeof import('../import.js').prepareImport>} Prepared @typedef {import('../store.js').WikiSource} WikiSource */

/**
 * The address a wiki taken in is linked to: the one it was fetched from, else the one its lineage names,
 * and only an address whose key this browser holds. @param {string | null | undefined} fetchedFrom @param {Prepared} prepared
 */
export async function addressToLink (fetchedFrom, prepared) {
  for (const name of [fetchedFrom, prepared.lineage?.name]) {
    if (name && await getName(name) !== undefined) return name
  }
  return null
}

/**
 * Resolves with the wiki to open, or null.
 * @param {{ prepared: Prepared, source: WikiSource, from: string, name?: string | null }} input `name`: the address the wiki was fetched from, if it was fetched by one.
 * @returns {Promise<string | null>}
 */
export async function confirmImport ({ prepared, source, from, name = null }) {
  const copies = await copiesOf(prepared.lineage?.id)
  const copy = copies[0]
  const diff = copy ? compareTiddlers(await store.getTiddlers(copy.id), prepared.tiddlers) : null
  const same = diff !== null && diff.added.length + diff.changed.length + diff.removed.length + diff.system === 0
  const linked = await addressToLink(name, prepared)
  /** @param {string} id */
  const link = async (id) => {
    if (linked !== null) await linkWikiToName(id, linked)
    return id
  }
  return await new Promise((resolve) => {
    let answered = false
    /** @param {string | null} id */
    const answer = (id) => {
      answered = true
      resolve(id)
      dialog.close()
    }
    const facts = h('dl', { class: 'facts' },
      h('div', {}, h('dt', {}, 'From'), h('dd', {}, from)),
      h('div', {}, h('dt', {}, 'Tiddlers'), h('dd', {}, String(prepared.count))),
      h('div', {}, h('dt', {}, 'Size'), h('dd', {}, formatBytes(prepared.bytes))))
    /** @type {any[]} */
    const body = [prepared.subtitle ? h('p', { class: 'muted' }, prepared.subtitle) : null, facts]
    /** @type {import('./dialog.js').Action[]} */
    let actions
    const addNew = async () => answer(await link((await addImported(prepared, source)).id))
    if (copy === undefined || diff === null) {
      body.push(h('p', {}, 'The editor makes a copy of this wiki in this browser. Your changes stay here until you publish them.'))
      if (linked !== null) body.push(h('p', { class: 'muted small' }, 'This browser holds the key of the address it is published under, so publishing your copy will offer to update that address.'))
      actions = [{ label: 'Cancel', kind: 'ghost', onClick: () => answer(null) }, { label: 'Edit this wiki', kind: 'primary', autofocus: true, onClick: addNew }]
    } else {
      const counts = [
        diff.changed.length ? `${diff.changed.length} changed` : '',
        diff.added.length ? `${diff.added.length} new` : '',
        diff.removed.length ? `${diff.removed.length} removed` : '',
        diff.system ? `${diff.system} settings or plugins differ` : ''
      ].filter(Boolean).join(', ')
      body.push(h('div', { class: 'notice' }, icon('history'),
        h('div', {},
          h('strong', {}, same ? 'You already have this version.' : 'You already have a copy of this wiki.'),
          h('p', {}, `Your copy “${copy.title}” was edited ${formatAgo(copy.updatedAt)}.`, same ? '' : ` Compared with it, this version has ${counts}.`),
          !same && diff.changed.length + diff.added.length > 0
            ? h('p', { class: 'muted small' }, [...diff.changed, ...diff.added].slice(0, 6).join(', '), diff.changed.length + diff.added.length > 6 ? '…' : '')
            : null)))
      actions = [
        { label: 'Add as a new wiki', kind: 'ghost', onClick: addNew },
        ...(same ? [] : [{ label: 'Replace my copy', kind: /** @type {const} */ ('secondary'), onClick: async () => { await replaceWithVersion(copy.id, prepared, source); answer(await link(copy.id)) } }]),
        { label: 'Open my copy', kind: 'primary', autofocus: true, onClick: () => answer(copy.id) }
      ]
    }
    const dialog = openDialog({ title: `Edit “${prepared.title}”`, body, actions, onClose: () => { if (!answered) resolve(null) } })
  })
}
