// The library: every wiki kept in this browser, and the way in for a new one.

import { h, icon, logo, replace } from '../dom.js'
import { displayAddress, fileNameFor, formatAgo, shortCid } from '../format.js'
import { confirmDialog, downloadFile, toast } from '../ui/dialog.js'
import { openMenu } from '../ui/menu.js'
import { hosting } from '../publish/hosting.js'
import * as store from '../store.js'
import { backup } from '../wikis.js'

/** @typedef {import('../store.js').Wiki} Wiki */
/** @typedef {{ newWiki: () => void, importWiki: () => void, openWiki: (id: string) => void, publications: (wiki: Wiki) => void }} LibraryActions */

/** Where a wiki came from, as its card says it. @param {Wiki} wiki */
function origin (wiki) {
  switch (wiki.source.kind) {
    case 'pen': return `Edited from ${displayAddress(wiki.source.address ?? '')}`
    case 'ipfs': return `Imported from ${displayAddress(wiki.source.address ?? '')}`
    case 'file': return 'Imported from a file'
    case 'backup': return 'Restored from a backup'
    default: return 'Started here'
  }
}

/** @param {Wiki} wiki @param {LibraryActions} actions @param {() => void} refresh */
function card (wiki, actions, refresh) {
  const last = wiki.publications.at(-1)
  const more = h('button', { type: 'button', class: 'icon-button', 'aria-label': `More for ${wiki.title}`, 'aria-haspopup': 'menu' }, icon('more'))
  more.addEventListener('click', () => openMenu(more, [
    { label: 'Open', icon: 'pen', onSelect: () => actions.openWiki(wiki.id) },
    { label: 'Publications', icon: 'history', onSelect: () => actions.publications(wiki) },
    {
      label: 'Download a backup',
      icon: 'download',
      onSelect: async () => downloadFile(await backup([wiki.id]), `${fileNameFor(wiki.title)}.decentrawiki-backup.json`, 'application/json')
    },
    {
      label: 'Delete',
      icon: 'trash',
      danger: true,
      onSelect: async () => {
        const published = wiki.publications.length > 0
        const sure = await confirmDialog({
          title: `Delete “${wiki.title}”?`,
          message: published
            ? `This removes the wiki and its unpublished changes from this browser. Its published versions stay on IPFS wherever they are pinned.${wiki.name ? ' Its address and the key of it stay in this browser, under Addresses in Settings.' : ''}`
            : 'This removes the wiki from this browser. It was never published, so no other copy of it exists.',
          confirm: 'Delete',
          danger: true
        })
        if (!sure) return
        // The wiki goes first and the node is told after, unawaited: a node that is starting can take a minute to answer, and the delete is confirmed.
        const hosted = await hosting.hostedVersion(wiki.id)
        await store.deleteWiki(wiki.id)
        void hosting.forget(wiki.id, hosted)
        toast(`“${wiki.title}” was deleted`)
        refresh()
      }
    }
  ]))
  return h('article', { class: 'card' },
    h('a', { class: 'card-main', href: `#/wiki/${encodeURIComponent(wiki.id)}` },
      h('h3', { class: 'card-title' }, wiki.title),
      wiki.subtitle ? h('p', { class: 'card-subtitle' }, wiki.subtitle) : null,
      h('p', { class: 'card-meta' }, `Edited ${formatAgo(wiki.updatedAt)}`, h('span', { class: 'dot' }, '·'), origin(wiki))),
    h('footer', { class: 'card-foot' },
      last
        ? h('span', { class: 'badge badge-ok', title: last.cid }, icon('check'), `Published ${formatAgo(last.at)} · ${shortCid(last.cid)}`)
        : h('span', { class: 'badge' }, 'Not published yet'),
      more))
}

/** @param {LibraryActions} actions */
function hero (actions) {
  const step = (n, title, text) => h('li', { class: 'step' }, h('span', { class: 'step-n' }, n), h('div', {}, h('h3', {}, title), h('p', {}, text)))
  return h('section', { class: 'hero' },
    logo('hero-logo'),
    h('h1', {}, 'Wikis anyone can edit, published on IPFS'),
    h('p', { class: 'lead' }, 'Write a wiki here, in your browser. Publish it and it gets an address anyone can open, that keeps showing its newest version. Every reader can press the pen, edit a copy of their own here and publish it in turn. No account, and no server between you and the wiki.'),
    h('div', { class: 'row center' },
      h('button', { type: 'button', class: 'button button-primary button-large', onclick: actions.newWiki }, icon('plus'), 'New wiki'),
      h('button', { type: 'button', class: 'button button-secondary button-large', onclick: actions.importWiki }, icon('upload'), 'Import a wiki')),
    h('ol', { class: 'steps' },
      step('1', 'Edit', 'Your copy lives in this browser and is kept as you type.'),
      step('2', 'Publish', 'The editor builds the wiki, pins it where you choose and points the wiki\'s address at it.'),
      step('3', 'Share', 'Send the address, or point an ENS name at it once. Readers edit it the same way.')))
}

/**
 * @param {HTMLElement} view
 * @param {LibraryActions} actions
 */
export async function renderLibrary (view, actions) {
  const wikis = await store.listWikis()
  const refresh = () => { void renderLibrary(view, actions) }
  if (wikis.length === 0) {
    replace(view, hero(actions))
    return
  }
  replace(view, h('section', { class: 'library' },
    h('div', { class: 'library-head' },
      h('div', {},
        h('h1', {}, 'Your wikis'),
        h('p', { class: 'muted' }, 'Kept in this browser. Publish a wiki to give it an address anyone can open and edit.')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'button button-secondary', onclick: actions.importWiki }, icon('upload'), 'Import'),
        h('button', { type: 'button', class: 'button button-primary', onclick: actions.newWiki }, icon('plus'), 'New wiki'))),
    h('div', { class: 'grid' }, wikis.map((wiki) => card(wiki, actions, refresh))),
    h('p', { class: 'footnote' }, icon('alert'), h('span', {}, 'Clearing this browser\'s site data deletes these wikis. Publish them, or keep a backup from ', h('a', { href: '#/settings' }, 'Settings'), '.'))))
}
