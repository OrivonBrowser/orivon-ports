// The editor page: the address bar decides the view, and the top bar follows it.
//   #/                      the library
//   #/wiki/<id>             a wiki being edited
//   #/receive/<nonce>[/…]   a published wiki's pen handing its wiki over
//   #/settings              publishing services and backups

import { h, icon, logo, replace } from './dom.js'
import { displayAddress } from './format.js'
import { ImportError, normaliseFields, prepareImport } from './import.js'
import { receive } from './receive.js'
import * as store from './store.js'
import { createWiki } from './wikis.js'
import { Workspace } from './workspace.js'
import { openDialog, toast } from './ui/dialog.js'
import { confirmImport } from './ui/confirm-import.js'
import { openImportDialog } from './ui/import-dialog.js'
import { openPublishDialog } from './ui/publish-dialog.js'
import { openPublications } from './ui/publications.js'
import { renderLibrary } from './views/library.js'
import { renderSettings } from './views/settings.js'

const topbar = /** @type {HTMLElement} */ (document.getElementById('topbar'))
const view = /** @type {HTMLElement} */ (document.getElementById('view'))

/** @type {Workspace | null} */
let workspace = null
/** A tiddler to open when the next wiki starts, as a published wiki's pen asked. @type {{ title: string, edit: boolean } | null} */
let pendingOpen = null

function brand () {
  return h('a', { class: 'brand', href: '#/', 'aria-label': 'DecentraWiki library' }, logo(), h('span', {}, 'DecentraWiki'))
}

/** @param {string} hash */
function go (hash) {
  if (location.hash === hash) void route()
  else location.hash = hash
}

async function closeWorkspace () {
  if (workspace === null) return
  const leaving = workspace
  workspace = null
  try {
    await leaving.settled()
  } finally {
    leaving.destroy()
  }
}

function openNewWikiDialog () {
  const title = /** @type {HTMLInputElement} */ (h('input', { class: 'input', type: 'text', placeholder: 'Bisq Wiki', maxlength: '120', required: true, autocomplete: 'off' }))
  const subtitle = /** @type {HTMLInputElement} */ (h('input', { class: 'input', type: 'text', placeholder: 'How to use Bisq, written by its users', maxlength: '200', autocomplete: 'off' }))
  const create = async () => {
    const name = title.value.trim()
    if (name === '') {
      title.focus()
      return
    }
    dialog.setBusy(true)
    const wiki = await createWiki({ title: name, subtitle: subtitle.value.trim() })
    dialog.close()
    go(`#/wiki/${encodeURIComponent(wiki.id)}`)
  }
  const form = h('form', { class: 'fields' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Title'), title),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Subtitle'), subtitle),
    h('button', { type: 'submit', class: 'hidden', tabindex: '-1' }))
  form.addEventListener('submit', (event) => { event.preventDefault(); void create() })
  const dialog = openDialog({
    title: 'New wiki',
    body: [form, h('p', { class: 'muted small' }, 'Both can be changed later, in the wiki itself.')],
    actions: [{ label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() }, { label: 'Create the wiki', kind: 'primary', onClick: create }]
  })
  title.focus()
}

const libraryActions = {
  newWiki: openNewWikiDialog,
  importWiki: () => openImportDialog({ onOpen: (id) => go(id === null ? '#/' : `#/wiki/${encodeURIComponent(id)}`) }),
  openWiki: (/** @type {string} */ id) => go(`#/wiki/${encodeURIComponent(id)}`),
  publications: openPublications
}

async function showLibrary () {
  document.title = 'DecentraWiki'
  replace(topbar, brand(), h('div', { class: 'spacer' }),
    h('a', { class: 'button button-ghost', href: '#/settings' }, icon('settings'), h('span', { class: 'hide-narrow' }, 'Settings')))
  view.className = 'view view-page'
  await renderLibrary(view, libraryActions)
}

async function showSettings () {
  document.title = 'Settings · DecentraWiki'
  replace(topbar, brand(), h('div', { class: 'spacer' }), h('a', { class: 'button button-ghost', href: '#/' }, icon('back'), 'Library'))
  view.className = 'view view-page'
  await renderSettings(view)
}

/** @param {string} id */
async function showWiki (id) {
  let wiki = await store.getWiki(id)
  if (wiki === undefined) {
    toast('That wiki is not in this browser\'s library.', { kind: 'error' })
    go('#/')
    return
  }
  document.title = `${wiki.title} · DecentraWiki`
  const status = h('span', { class: 'save-status', role: 'status', 'aria-live': 'polite' })
  const titleEl = h('span', { class: 'wiki-title' }, wiki.title)
  /** @param {import('./workspace.js').Status} state @param {string} [detail] */
  const onStatus = (state, detail) => {
    status.dataset.state = state
    status.textContent = state === 'loading' ? 'Opening…' : state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved in this browser' : 'Not saved'
    if (detail) toast(detail, { kind: 'error', timeout: 8000 })
    if (state === 'saved') {
      void store.getWiki(id).then((latest) => {
        if (latest === undefined || workspace?.wiki.id !== id) return
        wiki = latest
        workspace.wiki = latest
        titleEl.textContent = latest.title
        document.title = `${latest.title} · DecentraWiki`
      })
    }
  }
  const publish = h('button', { type: 'button', class: 'button button-primary' }, icon('cloud'), 'Publish')
  publish.addEventListener('click', () => {
    if (workspace === null || wiki === undefined) return
    void openPublishDialog({
      wiki,
      workspace,
      onSettings: () => go('#/settings'),
      onPublished: (updated) => { wiki = updated; if (workspace) workspace.wiki = updated }
    })
  })
  replace(topbar,
    h('a', { class: 'icon-button', href: '#/', 'aria-label': 'Back to the library' }, icon('back')),
    brand(),
    h('div', { class: 'wiki-heading' }, titleEl, status),
    h('div', { class: 'spacer' }),
    h('button', { type: 'button', class: 'button button-ghost', onclick: () => { if (wiki) openPublications(wiki) } }, icon('history'), h('span', { class: 'hide-narrow' }, 'Publications')),
    publish)
  view.className = 'view view-workspace'
  replace(view)
  workspace = new Workspace(wiki, { onStatus, open: pendingOpen })
  pendingOpen = null
  workspace.mount(view)
}

/** @param {string} hash */
async function showReceive (hash) {
  document.title = 'Opening a wiki · DecentraWiki'
  replace(topbar, brand())
  view.className = 'view view-page'
  const card = h('section', { class: 'receiving' }, h('span', { class: 'spinner spinner-large' }), h('h1', {}, 'Opening the wiki for editing…'), h('p', { class: 'muted' }, 'The wiki you came from is handing itself over to this editor.'))
  replace(view, card)
  try {
    const handoff = await receive(hash)
    const prepared = prepareImport(handoff.tiddlers.map(normaliseFields).filter((fields) => fields !== null))
    const id = await confirmImport({
      prepared,
      source: { kind: 'pen', address: handoff.source.url, title: handoff.source.title, at: Date.now() },
      from: displayAddress(handoff.source.url)
    })
    if (id === null) {
      go('#/')
      return
    }
    pendingOpen = handoff.focus
    go(`#/wiki/${encodeURIComponent(id)}`)
  } catch (error) {
    replace(card, icon('alert', 'icon icon-large icon-danger'), h('h1', {}, 'The wiki could not be opened'),
      h('p', {}, error instanceof ImportError || error instanceof Error ? error.message : String(error)),
      h('div', { class: 'row center' }, h('a', { class: 'button button-secondary', href: '#/' }, 'Go to the library'),
        h('button', { type: 'button', class: 'button button-primary', onclick: libraryActions.importWiki }, icon('upload'), 'Import a file instead')))
  }
}

async function route () {
  const hash = location.hash || '#/'
  await closeWorkspace()
  try {
    if (hash.startsWith('#/receive/')) await showReceive(hash)
    else if (hash.startsWith('#/wiki/')) await showWiki(decodeURIComponent(hash.slice('#/wiki/'.length)))
    else if (hash === '#/settings') await showSettings()
    else await showLibrary()
  } catch (error) {
    replace(view, h('section', { class: 'receiving' }, icon('alert', 'icon icon-large icon-danger'), h('h1', {}, 'Something went wrong'),
      h('p', {}, error instanceof Error ? error.message : String(error)), h('a', { class: 'button button-secondary', href: '#/' }, 'Back to the library')))
  }
}

window.addEventListener('hashchange', () => { void route() })
window.addEventListener('beforeunload', (event) => {
  if (workspace !== null && workspace.pending > 0) event.preventDefault()
})
void route()
