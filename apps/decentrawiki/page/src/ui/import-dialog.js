// Taking a wiki in: from a file, from an IPFS address, or from a published
// wiki's pen. Every way ends in the same question, which knows when the
// library already holds a version of the same wiki.

import { h, icon, replace } from '../dom.js'
import { displayAddress, formatAgo, formatBytes } from '../format.js'
import { ImportError, compareTiddlers, parseJson, prepareImport, tiddlersFromHtml } from '../import.js'
import { fetchVerified } from '../ipfs/gateway.js'
import { parseCid } from '../ipfs/cid.js'
import * as store from '../store.js'
import { addImported, copiesOf, replaceWithVersion, restore } from '../wikis.js'
import { openDialog, toast } from './dialog.js'

/** Public gateways that answer verifiable CAR files. Each block is checked here against its CID. */
export const GATEWAYS = ['https://ipfs.orbitor.dev', 'https://ipfs.filebase.io', 'https://trustless-gateway.link']

/** @typedef {ReturnType<typeof prepareImport>} Prepared @typedef {import('../store.js').WikiSource} WikiSource */

/**
 * `ipfs://<cid>/path`, `/ipfs/<cid>`, a bare CID, or a gateway address of either form.
 * @param {string} text @returns {{ cid: string, path: string } | null}
 */
export function parseIpfsAddress (text) {
  const value = text.trim()
  /** @param {string} cid @param {string} path */
  const result = (cid, path) => {
    try {
      const clean = decodeURIComponent(path.replace(/^\/+/, '').split(/[?#]/)[0] ?? '')
      return { cid: parseCid(cid).string, path: clean === '' || clean.endsWith('/') ? `${clean}index.html` : clean }
    } catch {
      return null
    }
  }
  let match = /^ipfs:\/\/([^/?#]+)(.*)$/i.exec(value) ?? /^\/ipfs\/([^/?#]+)(.*)$/.exec(value)
  if (match) return result(match[1] ?? '', match[2] ?? '')
  if (/^[a-zA-Z0-9]{46,}$/.test(value)) return result(value, '')
  try {
    const url = new URL(value)
    match = /^([a-z0-9]+)\.ipfs\./.exec(url.hostname)
    if (match) return result(match[1] ?? '', url.pathname)
    match = /^\/ipfs\/([^/]+)(.*)$/.exec(url.pathname)
    if (match) return result(match[1] ?? '', match[2] ?? '')
  } catch {}
  return null
}

/**
 * The question every import ends in. Resolves with the wiki to open, or null.
 * @param {{ prepared: Prepared, source: WikiSource, from: string }} input
 * @returns {Promise<string | null>}
 */
export async function confirmImport ({ prepared, source, from }) {
  const copies = await copiesOf(prepared.lineage?.id)
  const copy = copies[0]
  const diff = copy ? compareTiddlers(await store.getTiddlers(copy.id), prepared.tiddlers) : null
  const same = diff !== null && diff.added.length + diff.changed.length + diff.removed.length + diff.system === 0
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
    const addNew = async () => answer((await addImported(prepared, source)).id)
    if (copy === undefined || diff === null) {
      body.push(h('p', {}, 'The editor makes a copy of this wiki in this browser. Your changes stay here until you publish them.'))
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
        ...(same ? [] : [{ label: 'Replace my copy', kind: /** @type {const} */ ('secondary'), onClick: async () => { await replaceWithVersion(copy.id, prepared, source); answer(copy.id) } }]),
        { label: 'Open my copy', kind: 'primary', autofocus: true, onClick: () => answer(copy.id) }
      ]
    }
    const dialog = openDialog({ title: `Edit “${prepared.title}”`, body, actions, onClose: () => { if (!answered) resolve(null) } })
  })
}

/** @param {File} file */
async function tiddlersFromFile (file) {
  const text = await file.text()
  if (/\.json$/i.test(file.name) || /^\s*[[{]/.test(text)) return parseJson(text)
  return { kind: /** @type {const} */ ('tiddlers'), tiddlers: tiddlersFromHtml(text) }
}

/**
 * The Import dialog: a file, or an IPFS address. `onOpen` gets the wiki to open.
 * @param {{ onOpen: (id: string | null) => void }} options
 */
export function openImportDialog ({ onOpen }) {
  const status = h('p', { class: 'form-status', role: 'status' })
  /** @param {string} message @param {'error' | 'info'} [kind] */
  const say = (message, kind = 'info') => {
    status.className = `form-status form-status-${kind}`
    status.textContent = message
  }
  /** @param {unknown} error */
  const fail = (error) => {
    dialog.setBusy(false)
    say(error instanceof ImportError || error instanceof Error ? error.message : String(error), 'error')
  }
  /** @param {import('../store.js').Fields[]} tiddlers @param {WikiSource} source @param {string} from */
  const proceed = async (tiddlers, source, from) => {
    const prepared = prepareImport(tiddlers)
    dialog.close()
    onOpen(await confirmImport({ prepared, source, from }))
  }

  const input = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: '.html,.htm,.json,text/html,application/json', class: 'hidden' }))
  const drop = h('label', { class: 'dropzone', tabindex: '0' }, icon('file', 'icon icon-large'),
    h('strong', {}, 'Choose a wiki file'),
    h('span', { class: 'muted' }, 'A TiddlyWiki page (.html), a JSON file of tiddlers, or a DecentraWiki backup. Or drop it here.'),
    input)
  drop.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') input.click() })
  /** @param {File | undefined} file */
  const takeFile = async (file) => {
    if (file === undefined) return
    dialog.setBusy(true)
    say(`Reading ${file.name}…`)
    try {
      const read = await tiddlersFromFile(file)
      if (read.kind === 'backup') {
        const added = await restore(read.wikis)
        dialog.close()
        toast(added === 0 ? 'Every wiki in this backup is already in the library' : `${added} ${added === 1 ? 'wiki' : 'wikis'} restored`, { kind: 'success' })
        onOpen(null)
        return
      }
      await proceed(read.tiddlers, { kind: 'file', title: file.name, at: Date.now() }, `the file ${file.name}`)
    } catch (error) {
      fail(error)
    }
  }
  input.addEventListener('change', () => { void takeFile(input.files?.[0]) })
  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('dropzone-over') })
  drop.addEventListener('dragleave', () => drop.classList.remove('dropzone-over'))
  drop.addEventListener('drop', (event) => {
    event.preventDefault()
    drop.classList.remove('dropzone-over')
    void takeFile(event.dataTransfer?.files?.[0])
  })

  const address = /** @type {HTMLInputElement} */ (h('input', { type: 'text', class: 'input', placeholder: 'ipfs://bafy…', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'IPFS address' }))
  const fetchButton = h('button', { type: 'submit', class: 'button button-secondary' }, 'Fetch')
  const form = h('form', { class: 'inline-form' }, address, fetchButton)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const parsed = parseIpfsAddress(address.value)
    if (parsed === null) {
      say('Enter an IPFS address such as ipfs://bafy… or the CID alone.', 'error')
      return
    }
    dialog.setBusy(true)
    say('Fetching the wiki and checking every block against its address…')
    try {
      const { bytes, gateway } = await fetchVerified(parsed.cid, parsed.path, { gateways: GATEWAYS })
      const tiddlers = tiddlersFromHtml(new TextDecoder().decode(bytes))
      const where = `ipfs://${parsed.cid}`
      await proceed(tiddlers, { kind: 'ipfs', address: where, at: Date.now() }, `${displayAddress(where)} (through ${new URL(gateway).host})`)
    } catch (error) {
      fail(error)
    }
  })

  const dialog = openDialog({
    title: 'Import a wiki',
    body: [
      drop,
      h('div', { class: 'divider' }, h('span', {}, 'or')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'From an IPFS address'), form,
        h('span', { class: 'field-help' }, 'Fetched from public IPFS gateways. Nothing is accepted unless it matches the address.')),
      status
    ],
    actions: [{ label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() }]
  })
  replace(status)
}
