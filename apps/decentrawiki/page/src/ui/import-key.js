// Importing the key of an address: from a file, then what the address shows now, with a way to edit it.
// The Import dialog hands its key files here too.

import { h, icon } from '../dom.js'
import { formatAgo, shortCid } from '../format.js'
import { readKeyFile } from '../name-files.js'
import { findRecord } from '../name-lookup.js'
import { importKey, nameLabel, raiseSequence, sequenceTime } from '../names.js'
import { fetchVersion } from '../version-fetch.js'
import { confirmImport } from './confirm-import.js'
import { openDialog, toast } from './dialog.js'

/** @typedef {import('./dialog.js').DialogHandle} DialogHandle */

const MAX_KEY_FILE_BYTES = 200_000

/** @param {unknown} error */
const wordsOf = (error) => error instanceof Error ? error.message : String(error)

/**
 * Reads a key file, keeps its address, and shows what the address shows. `lookup: false` stops after keeping.
 * @param {{ bytes: Uint8Array, dialog: DialogHandle, onChanged?: () => unknown, onOpen?: (id: string | null) => void, lookup?: boolean }} options
 */
export async function takeKey ({ bytes, dialog, onChanged, onOpen, lookup = true }) {
  const key = await readKeyFile(bytes)
  const { entry, existed } = await importKey(key)
  toast(existed ? `This browser already held ipns://${shortCid(entry.name)}; what the file lists was added.` : `The address ipns://${shortCid(entry.name)} was added.`, { kind: 'success' })
  await onChanged?.()
  if (!lookup) {
    dialog.close()
    return
  }
  const name = entry.name
  /** @type {import('../name-lookup.js').Found | null} */
  let found = null

  /** @param {...any} body */
  const show = (...body) => {
    dialog.setBusy(false)
    dialog.setBody(h('p', { class: 'success-line' }, icon('check'), h('span', {}, `ipns://${shortCid(name)} is kept in this browser.`)), ...body)
  }
  async function look () {
    dialog.setBusy(true)
    dialog.setBody(h('p', { class: 'success-line' }, icon('check'), h('span', {}, `ipns://${shortCid(name)} is kept in this browser.`)),
      h('p', { class: 'form-status' }, h('span', { class: 'spinner' }), ' Looking for what it shows…'))
    dialog.setActions([{ label: 'Close', kind: 'ghost', onClick: () => dialog.close() }])
    try {
      found = await findRecord(name)
    } catch (error) {
      show(h('p', { class: 'form-status form-status-error' }, wordsOf(error)))
      dialog.setActions([{ label: 'Close', kind: 'ghost', onClick: () => dialog.close() }, { label: 'Look again', kind: 'primary', onClick: () => { void look() } }])
      return
    }
    if (found === null) {
      show(h('p', {}, 'Nobody keeps this address up now, so it shows nothing yet. Publish a wiki under it: choose it in Publish, under “Its address”.'))
      dialog.setActions([{ label: 'Done', kind: 'primary', autofocus: true, onClick: () => dialog.close() }])
      return
    }
    await raiseSequence(name, found.record.sequence)
    const known = entry.history.find((version) => version.cid === found?.cid)
    /** @type {Awaited<ReturnType<typeof fetchVersion>> | null} */
    let fetched = null
    let title = known?.title
    if (title === undefined) {
      try {
        fetched = await fetchVersion(found.cid, 'index.html')
        title = fetched.prepared.title
      } catch (error) {
        show(h('p', {}, `This address shows ipfs://${shortCid(found.cid)}, but this editor could not read that version now: ${wordsOf(error)}`))
        dialog.setActions([{ label: 'Close', kind: 'ghost', onClick: () => dialog.close() }, { label: 'Look again', kind: 'primary', onClick: () => { void look() } }])
        return
      }
    }
    await nameLabel(name, title)
    const when = known?.at ?? sequenceTime(found.record.sequence)
    show(h('p', {}, `This address shows “${title}”${when === null ? '' : `, published ${formatAgo(when)}`}.`))
    const version = found.cid
    dialog.setActions([
      { label: 'Close', kind: 'ghost', onClick: () => dialog.close() },
      { label: 'Edit it', kind: 'primary', autofocus: true, onClick: async () => {
        dialog.setBusy(true)
        try {
          fetched ??= await fetchVersion(version, 'index.html')
          const where = `ipfs://${version}`
          dialog.close()
          onOpen?.(await confirmImport({ prepared: fetched.prepared, source: { kind: 'ipfs', address: where, at: Date.now() }, from: `ipns://${shortCid(name)} (${shortCid(version)}, through ${new URL(fetched.gateway).host})`, name }))
        } catch (error) {
          show(h('p', { class: 'form-status form-status-error' }, wordsOf(error)))
        }
      } }
    ])
  }
  await look()
}

/**
 * The dialog that takes a key file and nothing else. `onChanged` runs once an address was added.
 * @param {{ onChanged?: () => unknown, onOpen?: (id: string | null) => void, lookup?: boolean }} [options]
 */
export function openKeyDialog ({ onChanged, onOpen, lookup = true } = {}) {
  const status = h('p', { class: 'form-status', role: 'status' })
  const input = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: '.json,.key,.pem,application/json', class: 'hidden' }))
  const drop = h('label', { class: 'dropzone', tabindex: '0' }, icon('file', 'icon icon-large'),
    h('strong', {}, 'Choose an address key'),
    h('span', { class: 'muted' }, 'The key file DecentraWiki saved (.json), or a Kubo key (.key or .pem). Or drop it here.'),
    input)
  drop.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') input.click() })
  /** @param {File | undefined} file */
  const take = async (file) => {
    if (file === undefined) return
    if (file.size > MAX_KEY_FILE_BYTES) {
      status.className = 'form-status form-status-error'
      status.textContent = 'That file is too large to be an address key.'
      return
    }
    dialog.setBusy(true)
    status.className = 'form-status'
    status.textContent = `Reading ${file.name}…`
    try {
      await takeKey({ bytes: new Uint8Array(await file.arrayBuffer()), dialog, ...(onChanged ? { onChanged } : {}), ...(onOpen ? { onOpen } : {}), lookup })
    } catch (error) {
      dialog.setBusy(false)
      status.className = 'form-status form-status-error'
      status.textContent = wordsOf(error)
    }
  }
  input.addEventListener('change', () => { void take(input.files?.[0]) })
  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('dropzone-over') })
  drop.addEventListener('dragleave', () => drop.classList.remove('dropzone-over'))
  drop.addEventListener('drop', (event) => {
    event.preventDefault()
    drop.classList.remove('dropzone-over')
    void take(event.dataTransfer?.files?.[0])
  })
  const dialog = openDialog({
    title: 'Import an address key',
    body: [
      h('p', {}, 'The key of a wiki\'s address lets this browser update what the address shows. It stays in this browser; it is never sent anywhere.'),
      drop,
      status
    ],
    actions: [{ label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() }]
  })
  return dialog
}
