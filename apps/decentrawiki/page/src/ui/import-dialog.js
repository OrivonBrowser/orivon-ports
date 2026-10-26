// Taking a wiki in: from a file, from an IPFS or IPNS address, from the key of an address, or from a
// published wiki's pen. Every way to a wiki ends in the same question (confirm-import.js).

import { h, icon, replace } from '../dom.js'
import { displayAddress, shortCid } from '../format.js'
import { ImportError, parseJson, prepareImport, tiddlersFromHtml } from '../import.js'
import { looksLikeKey } from '../name-files.js'
import { findRecord, parseIpnsAddress } from '../name-lookup.js'
import { fetchVersion, parseIpfsAddress } from '../version-fetch.js'
import { restore } from '../wikis.js'
import { confirmImport } from './confirm-import.js'
import { openDialog, toast } from './dialog.js'
import { takeKey } from './import-key.js'

export { parseIpfsAddress }

/** @typedef {import('../store.js').WikiSource} WikiSource */

const MAX_KEY_FILE_BYTES = 200_000

/** @param {string} text @param {string} fileName */
async function tiddlersFromText (text, fileName) {
  if (/\.json$/i.test(fileName) || /^\s*[[{]/.test(text)) return parseJson(text)
  return { kind: /** @type {const} */ ('tiddlers'), tiddlers: tiddlersFromHtml(text) }
}

/**
 * The Import dialog: a file, or an IPFS or IPNS address. `onOpen` gets the wiki to open.
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
  /** @param {import('../store.js').Fields[]} tiddlers @param {WikiSource} source @param {string} from @param {string | null} [name] */
  const proceed = async (tiddlers, source, from, name = null) => {
    const prepared = prepareImport(tiddlers)
    dialog.close()
    onOpen(await confirmImport({ prepared, source, from, name }))
  }

  const input = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: '.html,.htm,.json,.key,.pem,text/html,application/json', class: 'hidden' }))
  const drop = h('label', { class: 'dropzone', tabindex: '0' }, icon('file', 'icon icon-large'),
    h('strong', {}, 'Choose a file'),
    h('span', { class: 'muted' }, 'A TiddlyWiki page (.html), a JSON file of tiddlers, a DecentraWiki backup, or the key of a wiki\'s address (.json, .key, .pem). Or drop it here.'),
    input)
  drop.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') input.click() })
  /** @param {File | undefined} file */
  const takeFile = async (file) => {
    if (file === undefined) return
    dialog.setBusy(true)
    say(`Reading ${file.name}…`)
    try {
      if (file.size <= MAX_KEY_FILE_BYTES && looksLikeKey(file.name, new Uint8Array(await file.slice(0, 4096).arrayBuffer()))) {
        await takeKey({ bytes: new Uint8Array(await file.arrayBuffer()), dialog, onOpen })
        return
      }
      const read = await tiddlersFromText(await file.text(), file.name)
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

  const address = /** @type {HTMLInputElement} */ (h('input', { type: 'text', class: 'input', placeholder: 'ipns://k51… or ipfs://bafy…', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'IPNS or IPFS address' }))
  const fetchButton = h('button', { type: 'submit', class: 'button button-secondary' }, 'Fetch')
  const form = h('form', { class: 'inline-form' }, address, fetchButton)

  /** The version an IPNS address shows now, found without trusting any source. @param {{ name: string, path: string }} named */
  async function resolveVersion (named) {
    say('Looking for what the address shows…')
    const found = await findRecord(named.name)
    if (found === null) throw new Error('Nobody keeps this address up right now, or what it points at is not a wiki. If you hold its key, import the key to publish under it.')
    return { cid: found.cid, path: named.path }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    dialog.setBusy(true)
    try {
      const named = parseIpnsAddress(address.value)
      const parsed = named === null ? parseIpfsAddress(address.value) : await resolveVersion(named)
      if (parsed === null) {
        dialog.setBusy(false)
        say('Enter an address such as ipns://k51… or ipfs://bafy…, or a CID alone.', 'error')
        return
      }
      say('Fetching the wiki and checking every block against its address…')
      const { tiddlers, gateway } = await fetchVersion(parsed.cid, parsed.path)
      const where = `ipfs://${parsed.cid}`
      const through = `through ${new URL(gateway).host}`
      await proceed(tiddlers, { kind: 'ipfs', address: where, at: Date.now() },
        named === null ? `${displayAddress(where)} (${through})` : `ipns://${shortCid(named.name)}, which shows ${displayAddress(where)} (${through})`, named?.name ?? null)
    } catch (error) {
      fail(error)
    }
  })

  const dialog = openDialog({
    title: 'Import a wiki',
    body: [
      drop,
      h('div', { class: 'divider' }, h('span', {}, 'or')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'From an IPNS or IPFS address'), form,
        h('span', { class: 'field-help' }, 'Fetched from public IPFS gateways. Nothing is accepted unless it matches the address: an IPNS address by its signature, then its version by its content address.')),
      status
    ],
    actions: [{ label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() }]
  })
  replace(status)
}
