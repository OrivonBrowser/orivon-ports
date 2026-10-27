// The first half of the Send page: the drop zone with its three pickers, and the list of what was chosen.

import * as engine from '../engine.js'
import { dropArt, h, icon } from '../dom.js'
import { baseName, count, formatBytes, topFolder } from '../format.js'

/** @typedef {import('../engine.js').Entry} Entry @typedef {import('../engine.js').Kind} Kind */
/** @typedef {'files' | 'folder' | 'website' | 'drop'} Origin */

/**
 * @param {{ compact: boolean, onPick: (origin: Origin, entries: Entry[] | Promise<Entry[]>) => void }} options
 */
export function dropZone ({ compact, onPick }) {
  /** @param {Origin} origin @param {boolean} directory @param {string} label */
  const picker = (origin, directory, label) => {
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'file', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', multiple: !directory, webkitdirectory: directory }))
    input.addEventListener('change', () => {
      if (input.files && input.files.length > 0) onPick(origin, engine.entriesFromInput(input.files))
      input.value = ''
    })
    return { input, label, open: () => input.click() }
  }
  const files = picker('files', false, 'Choose files')
  const folder = picker('folder', true, 'Choose a folder')
  const site = picker('website', true, 'Share a website')
  const zone = h('div', { class: compact ? 'dropzone dropzone-compact' : 'dropzone', role: 'group', 'aria-label': 'What to share' },
    dropArt(),
    h('h2', {}, compact ? 'Add more' : 'Drop files or a folder here'),
    h('p', {}, 'or choose what to share'),
    h('div', { class: 'pickers' },
      h('button', { type: 'button', class: compact ? 'button button-secondary' : 'button button-primary', onclick: files.open }, icon('files'), files.label),
      h('button', { type: 'button', class: 'button button-secondary', onclick: folder.open }, icon('folder'), folder.label),
      h('button', { type: 'button', class: 'button button-secondary', onclick: site.open }, icon('globe'), site.label)),
    files.input, folder.input, site.input)
  zone.addEventListener('dragover', (event) => {
    event.preventDefault()
    zone.classList.add('dropzone-over')
  })
  zone.addEventListener('dragleave', (event) => {
    if (!zone.contains(/** @type {Node | null} */ (event.relatedTarget))) zone.classList.remove('dropzone-over')
  })
  zone.addEventListener('drop', (event) => {
    event.preventDefault()
    zone.classList.remove('dropzone-over')
    if (event.dataTransfer) onPick('drop', engine.entriesFromDrop(event.dataTransfer))
  })
  return zone
}

/** What a dropped selection is: one folder, or files (loose, or several folders). @param {Entry[]} entries @returns {Kind} */
export function kindOfDrop (entries) {
  return topFolder(entries) !== null ? 'folder' : 'files'
}

/** @param {Entry[]} list @param {Entry[]} extra the entries not already in `list`, by path and size */
export function withoutDuplicates (list, extra) {
  const seen = new Set(list.map((entry) => `${entry.path}\0${entry.file.size}`))
  return extra.filter((entry) => !seen.has(`${entry.path}\0${entry.file.size}`))
}

const SHOWN_PATHS = 200

/**
 * @param {{ entries: Entry[], kind: Kind }} form
 * @param {ReturnType<typeof engine.checkSelection>} check
 * @param {{ onRemove: (index: number) => void, onClear: () => void, onKind: (kind: Kind) => void }} actions
 */
export function selectionCard (form, check, { onRemove, onClear, onKind }) {
  const folderShaped = form.kind !== 'files'
  const name = topFolder(form.entries) ?? (form.kind === 'website' ? 'Website' : 'Folder')
  const bytes = form.entries.reduce((sum, entry) => sum + entry.file.size, 0)
  const rows = folderShaped
    ? [h('li', { class: 'selection-item' },
        icon(form.kind === 'website' ? 'globe' : 'folder'),
        h('div', { class: 'selection-main' }, h('span', { class: 'selection-name' }, name), h('span', { class: 'muted small' }, `${count(form.entries.length, 'file')}, ${formatBytes(bytes)}`)),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': `Remove ${name}`, onclick: onClear }, icon('close')))]
    : form.entries.map((entry, index) => h('li', { class: 'selection-item' },
        icon('file'),
        h('div', { class: 'selection-main' }, h('span', { class: 'selection-name' }, entry.path), h('span', { class: 'muted small' }, formatBytes(entry.file.size))),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': `Remove ${baseName(entry.path)}`, onclick: () => onRemove(index) }, icon('close'))))
  const websiteOk = folderShaped && engine.checkSelection(form.entries, 'website').ok
  const chooser = folderShaped
    ? h('div', { class: 'field' },
        h('span', { class: 'field-label', id: 'kind-label' }, 'Share it as'),
        h('div', { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'kind-label' },
          ['folder', 'website'].map((kind) => {
            const disabled = kind === 'website' && !websiteOk
            return h('button', {
              type: 'button', role: 'radio', class: 'segment', 'aria-checked': String(form.kind === kind), disabled,
              title: disabled ? 'A website needs an index.html at its top' : null,
              onclick: () => onKind(/** @type {Kind} */ (kind))
            }, kind === 'folder' ? 'A folder of files' : 'A website')
          })),
        h('span', { class: 'field-help' }, form.kind === 'website'
          ? 'People who open the link see the website itself, starting at its index.html. It can also be browsed as files.'
          : websiteOk ? 'This folder has an index.html, so it can also be shared as a website.' : 'People who open the link see the files and can download them.'))
    : null
  const listing = folderShaped
    ? h('details', { class: 'explain' }, h('summary', {}, 'Show the files'),
        h('ul', { class: 'selection-more' }, form.entries.slice(0, SHOWN_PATHS).map((entry) => h('li', {}, entry.path)),
          form.entries.length > SHOWN_PATHS ? h('li', { class: 'muted' }, `… and ${count(form.entries.length - SHOWN_PATHS, 'more file')}`) : null))
    : null
  return h('section', { class: 'card', 'aria-label': 'What you are sharing' },
    h('div', { class: 'card-head' }, h('h2', {}, 'What you are sharing'), h('button', { type: 'button', class: 'button button-ghost button-small', onclick: onClear }, 'Clear')),
    h('ul', { class: 'selection' }, rows),
    chooser ? h('div', { class: 'block' }, chooser) : null,
    listing,
    h('div', { class: 'totals' },
      h('span', {}, check.ok ? `${count(check.files, 'file')}, ${formatBytes(check.bytes)}` : `${count(form.entries.length, 'file')}, ${formatBytes(bytes)}`)),
    check.ok ? null : h('div', { class: 'notice notice-error', role: 'alert' }, icon('alert'), h('div', {}, check.reason)))
}
