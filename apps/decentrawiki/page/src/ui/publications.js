// The versions of a wiki published from this browser, and the address they went under.

import { h, icon } from '../dom.js'
import { formatAgo, formatBytes, shortCid } from '../format.js'
import { getName } from '../names.js'
import { addressesOf, nameAddressesOf } from '../publish/publish.js'
import { copyText, openDialog } from './dialog.js'
import { downloadKey, downloadRecord, keepAgain } from './name-actions.js'

/** @typedef {import('../store.js').Wiki} Wiki */

/** The wiki's address at the top: copy, open, its key and record, and a way to send a record Orivon's node has not taken. @param {string} name @param {boolean} held @param {boolean} again @param {() => void} onAgain */
function addressHead (name, held, again, onAgain) {
  const where = nameAddressesOf(name)
  return h('div', { class: 'address-head' },
    h('p', { class: 'field-label' }, 'The wiki\'s address'),
    h('div', { class: 'cid-box' },
      h('code', { class: 'cid' }, where.ipns),
      h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Copy the address', onclick: () => copyText(where.ipns, 'Address') }, icon('copy')),
      h('a', { class: 'icon-button', href: where.ipns, target: '_blank', rel: 'noopener', 'aria-label': 'Open the address' }, icon('open'))),
    held
      ? h('div', { class: 'row' },
        h('button', { type: 'button', class: 'button button-ghost button-small', onclick: () => { void downloadKey(name) } }, icon('download'), 'Download the key'),
        h('button', { type: 'button', class: 'button button-ghost button-small', onclick: () => { void downloadRecord(name) } }, icon('download'), 'Download the public record'),
        again ? h('button', { type: 'button', class: 'button button-secondary button-small', onclick: onAgain }, 'Publish the address again') : null)
      : h('p', { class: 'muted small' }, 'This browser does not hold its key, so it cannot update this address.'))
}

/** Every version of a wiki that was published from this browser. @param {Wiki} wiki */
export async function openPublications (wiki) {
  const list = [...wiki.publications].reverse()
  const name = wiki.name ?? null
  const entry = name === null ? undefined : await getName(name)
  const dialog = openDialog({
    title: `Publications of “${wiki.title}”`,
    wide: true,
    body: [
      name === null ? null : addressHead(name, entry !== undefined, entry !== undefined && entry.record !== null && !entry.accepted, () => { void keepAgain(name).then(() => dialog.close()) }),
      list.length === 0
        ? h('p', { class: 'muted' }, 'Not published from this browser yet.')
        : h('ul', { class: 'publications' }, list.map((p) => {
          const where = addressesOf(p.cid)
          const under = p.name === undefined || p.sequence === undefined ? '' : ` · address ${shortCid(p.name)}, sequence ${p.sequence}`
          return h('li', { class: 'publication' },
            h('div', {}, h('code', { class: 'cid', title: p.cid }, shortCid(p.cid)), h('p', { class: 'muted small' }, `${formatAgo(p.at)} · ${p.target} · ${formatBytes(p.size)}${under}`)),
            h('div', { class: 'row' },
              h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Copy the version\'s address', onclick: () => copyText(where.ipfs, 'Address') }, icon('copy')),
              h('a', { class: 'icon-button', href: where.ipfs, target: '_blank', rel: 'noopener', 'aria-label': 'Open it' }, icon('open'))))
        }))
    ],
    actions: [{ label: 'Close', kind: 'primary', onClick: () => dialog.close() }]
  })
}
