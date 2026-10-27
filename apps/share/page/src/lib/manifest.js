// `.orivon-share.json`, the first file in the archive of an encrypted share: what the share is, written by the
// sender and read back by the receiver after the password opened it. It is read as untrusted text: a share
// anyone can make is a share anyone can make wrongly.

import { MAX_MESSAGE_CHARACTERS, MAX_TITLE_CHARACTERS } from './limits.js'

export const MANIFEST_NAME = '.orivon-share.json'
const KINDS = ['files', 'folder', 'website']

/**
 * @typedef {{ format: 'orivon-share', version: 1, kind: 'files' | 'folder' | 'website', title: string, message: string, created: string, files: number, bytes: number }} ShareManifest
 */

/** @param {{ kind: string, title?: string, message?: string, files: number, bytes: number, now?: Date }} fields @returns {string} */
export function manifestText ({ kind, title = '', message = '', files, bytes, now = new Date() }) {
  return JSON.stringify({
    format: 'orivon-share',
    version: 1,
    kind,
    title: [...title].slice(0, MAX_TITLE_CHARACTERS).join(''),
    message: [...message].slice(0, MAX_MESSAGE_CHARACTERS).join(''),
    created: now.toISOString(),
    files,
    bytes
  })
}

/**
 * @param {string} text
 * @returns {ShareManifest}
 */
export function parseManifest (text) {
  /** @type {any} */
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('This share has no readable description.')
  }
  const bad = (/** @type {string} */ what) => new Error(`This share's description is not valid (${what}).`)
  if (json === null || typeof json !== 'object' || json.format !== 'orivon-share') throw bad('format')
  if (json.version !== 1) throw new Error('This share was made by a newer version of Orivon Share. Update the app and open it again.')
  if (!KINDS.includes(json.kind)) throw bad('kind')
  if (typeof json.title !== 'string' || [...json.title].length > MAX_TITLE_CHARACTERS) throw bad('title')
  if (typeof json.message !== 'string' || [...json.message].length > MAX_MESSAGE_CHARACTERS) throw bad('message')
  if (typeof json.created !== 'string' || Number.isNaN(Date.parse(json.created))) throw bad('date')
  if (!Number.isSafeInteger(json.files) || json.files < 0 || !Number.isSafeInteger(json.bytes) || json.bytes < 0) throw bad('size')
  return { format: 'orivon-share', version: 1, kind: json.kind, title: json.title, message: json.message, created: json.created, files: json.files, bytes: json.bytes }
}
