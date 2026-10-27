// Previews of a file whose bytes are already here and verified: images, video, audio and PDF from a Blob
// URL, small text in a <pre>. A file is never opened as a page: its type is the one its name says, never its own.

import * as engine from '../engine.js'
import { h, replace } from '../dom.js'
import { baseName, formatBytes } from '../format.js'
import { downloadBlob, openDialog } from './dialog.js'

/** Text up to this size is shown in the page. */
export const TEXT_PREVIEW_BYTES = 1024 * 1024

const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/javascript', 'application/x-yaml'])

/** @param {string} path @param {number} size @returns {'image' | 'video' | 'audio' | 'pdf' | 'text' | null} */
export function previewKind (path, size) {
  const type = engine.mimeTypeOf(path)
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type === 'application/pdf') return 'pdf'
  if ((type.startsWith('text/') || TEXT_TYPES.has(type)) && size <= TEXT_PREVIEW_BYTES) return 'text'
  return null
}

/** Opens a dialog with the file. @param {string} path @param {Blob} blob */
export async function showPreview (path, blob) {
  const kind = previewKind(path, blob.size)
  const typed = new Blob([blob], { type: engine.mimeTypeOf(path) })
  const url = URL.createObjectURL(typed)
  const body = h('div', { class: 'preview' })
  const dialog = openDialog({
    title: baseName(path),
    wide: true,
    body: [body, h('p', { class: 'muted small' }, `${formatBytes(blob.size)}. Read from IPFS and checked against its address.`)],
    onClose: () => URL.revokeObjectURL(url),
    actions: [
      { label: 'Download', kind: 'secondary', onClick: () => downloadBlob(typed, baseName(path)) },
      { label: 'Close', kind: 'primary', autofocus: true, onClick: () => dialog.close() }
    ]
  })
  if (kind === 'image') replace(body, h('img', { src: url, alt: baseName(path) }))
  else if (kind === 'video') replace(body, h('video', { src: url, controls: true, preload: 'metadata' }))
  else if (kind === 'audio') replace(body, h('audio', { src: url, controls: true, preload: 'metadata' }))
  else if (kind === 'pdf') replace(body, h('iframe', { src: url, title: baseName(path) }))
  else if (kind === 'text') replace(body, h('pre', {}, await typed.text()))
  else replace(body, h('p', { class: 'muted' }, 'This kind of file has no preview. Download it to open it.'))
}
