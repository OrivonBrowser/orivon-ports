// The list of what a share holds, with Preview and Download on each file and a zip of the whole.

import { h, icon } from '../dom.js'
import { baseName, count, formatBytes } from '../format.js'
import { downloadBlob, toast } from '../ui/dialog.js'
import { previewKind, showPreview } from '../ui/preview.js'

const PAGE = 100

/**
 * @param {{ path: string, size: number }[]} entries
 * @param {{ read: (path: string, onProgress: (text: string) => void) => Promise<Blob> }} source gives a file's bytes, verified
 */
export function fileList ({ entries, read }) {
  const list = h('ul', { class: 'files' })
  const more = h('div', { class: 'file-more hidden' })
  let shown = 0

  /** @param {{ path: string, size: number }} entry */
  function row (entry) {
    const detail = h('span', { class: 'muted small' }, formatBytes(entry.size))
    /** @param {(blob: Blob) => unknown} then @param {HTMLButtonElement} button @param {string} busyLabel */
    const act = async (then, button, busyLabel) => {
      const label = button.textContent ?? ''
      button.disabled = true
      button.textContent = busyLabel
      try {
        await then(await read(entry.path, (text) => { detail.textContent = text }))
        detail.textContent = formatBytes(entry.size)
      } catch (error) {
        detail.textContent = formatBytes(entry.size)
        toast(error instanceof Error ? error.message : String(error), { kind: 'error', timeout: 8000 })
      } finally {
        button.disabled = false
        button.textContent = label
      }
    }
    const download = h('button', { type: 'button', class: 'button button-secondary button-small', 'aria-label': `Download ${baseName(entry.path)}` }, 'Download')
    download.addEventListener('click', () => { void act((blob) => downloadBlob(blob, baseName(entry.path)), /** @type {HTMLButtonElement} */ (download), 'Reading…') })
    const preview = previewKind(entry.path, entry.size) === null ? null : h('button', { type: 'button', class: 'button button-secondary button-small', 'aria-label': `Preview ${baseName(entry.path)}` }, 'Preview')
    preview?.addEventListener('click', () => { void act((blob) => showPreview(entry.path, blob), /** @type {HTMLButtonElement} */ (preview), 'Reading…') })
    return h('li', { class: 'file' }, icon('file'),
      h('div', { class: 'file-main' }, h('span', { class: 'file-name' }, entry.path), detail),
      h('div', { class: 'file-actions' }, preview, download))
  }

  function showMore () {
    for (const entry of entries.slice(shown, shown + PAGE)) list.append(row(entry))
    shown = Math.min(entries.length, shown + PAGE)
    more.classList.toggle('hidden', shown >= entries.length)
    more.replaceChildren(h('button', { type: 'button', class: 'button button-secondary', onclick: showMore }, `Show more (${count(entries.length - shown, 'file')} left)`))
  }
  showMore()
  return h('div', {}, list, more)
}
