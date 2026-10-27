// What a person picked or dropped, as a list of entries (a relative path and a Blob), and whether it can be shared
// as the kind they chose. Paths are POSIX, relative, with no `..`; a folder's files keep the folder's name.

import { directoryProblem } from '../ipfs/unixfs.js'
import { MAX_FILES, MAX_SHARE_BYTES } from './limits.js'

const MAX_NAME_BYTES = 255

/**
 * @typedef {{ path: string, file: Blob }} Entry
 * @typedef {'files' | 'folder' | 'website'} Kind
 * @typedef {{ ok: true, entries: Entry[], bytes: number, files: number } | { ok: false, reason: string }} SelectionCheck
 */

/** @param {number} bytes */
function sizeText (bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

/**
 * Entries of a drop. The items are read at once, before anything is awaited, because the browser empties the list
 * when the drop event ends; folders are then walked entry by entry.
 * @param {DataTransfer} dataTransfer
 * @returns {Promise<Entry[]>}
 */
export async function entriesFromDrop (dataTransfer) {
  /** @type {(FileSystemEntry | File)[]} */
  const roots = []
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== 'file') continue
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    const file = entry === null ? item.getAsFile() : null
    if (entry !== null) roots.push(entry)
    else if (file !== null) roots.push(file)
  }
  if (roots.length === 0) roots.push(...Array.from(dataTransfer.files ?? []))
  /** @type {Entry[]} */
  const entries = []
  for (const root of roots) {
    if (root instanceof File) entries.push({ path: root.name, file: root })
    else await walk(root, '', entries)
    if (entries.length > MAX_FILES) break
  }
  return entries
}

/** @param {FileSystemEntry} entry @param {string} prefix @param {Entry[]} out */
async function walk (entry, prefix, out) {
  const path = `${prefix}${entry.name}`
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => /** @type {FileSystemFileEntry} */ (entry).file(resolve, reject))
    out.push({ path, file: /** @type {File} */ (file) })
    return
  }
  const reader = /** @type {FileSystemDirectoryEntry} */ (entry).createReader()
  for (;;) {
    /** @type {FileSystemEntry[]} */
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
    if (batch.length === 0) return
    for (const child of batch) {
      await walk(child, `${path}/`, out)
      if (out.length > MAX_FILES) return
    }
  }
}

/** Entries of an `<input type=file>`, multiple or `webkitdirectory`. @param {FileList | File[]} fileList @returns {Entry[]} */
export function entriesFromInput (fileList) {
  return Array.from(fileList, (file) => {
    const relative = /** @type {{ webkitRelativePath?: string }} */ (file).webkitRelativePath
    return { path: relative !== undefined && relative !== '' ? relative : file.name, file }
  })
}

/** What is wrong with a path, in words, or null. @param {string} path */
function pathProblem (path) {
  const segments = path.split('/')
  for (const segment of segments) {
    const shown = JSON.stringify(segment.length > 60 ? `${segment.slice(0, 60)}…` : segment)
    if (segment === '' || segment === '.' || segment === '..') return `The name ${JSON.stringify(path)} is not one Share can keep.`
    if (segment.includes('\\')) return `The name ${shown} has a backslash in it. Rename it.`
    if (/[\u0000-\u001f\u007f]/.test(segment)) return `The name ${shown} has a character that cannot be kept. Rename it.`
    if (segment.isWellFormed && !segment.isWellFormed()) return `The name ${shown} is not valid text. Rename it.`
    if (new TextEncoder().encode(segment).length > MAX_NAME_BYTES) return `The name ${shown} is too long. Rename it.`
  }
  return null
}

/** The names each directory of the tree holds. @param {string[]} paths @returns {Map<string, Set<string>>} */
function directories (paths) {
  /** @type {Map<string, Set<string>>} */
  const dirs = new Map()
  for (const path of paths) {
    const segments = path.split('/')
    for (let depth = 0; depth < segments.length; depth++) {
      const dir = segments.slice(0, depth).join('/')
      let names = dirs.get(dir)
      if (!names) dirs.set(dir, (names = new Set()))
      names.add(/** @type {string} */ (segments[depth]))
    }
  }
  return dirs
}

/**
 * Whether the entries can be shared as `kind`, and the entries as they will be shared: a website's top folder
 * taken off, so that `index.html` sits at the root.
 * @param {Entry[]} entries
 * @param {Kind} kind
 * @returns {SelectionCheck}
 */
export function checkSelection (entries, kind) {
  if (entries.length === 0) return { ok: false, reason: kind === 'website' ? 'Pick the folder that holds the website.' : 'Pick at least one file.' }
  let list = entries.map((entry) => ({ path: entry.path.replace(/^\/+/, ''), file: entry.file }))
  for (const entry of list) {
    const problem = pathProblem(entry.path)
    if (problem !== null) return { ok: false, reason: problem }
  }
  const top = new Set(list.map((entry) => entry.path.split('/')[0]))
  const nested = list.every((entry) => entry.path.includes('/'))
  if (kind === 'folder' && !(top.size === 1 && nested)) return { ok: false, reason: 'Pick one folder to share a folder.' }
  if (kind === 'website' && top.size === 1 && nested) {
    list = list.map((entry) => ({ path: entry.path.slice(entry.path.indexOf('/') + 1), file: entry.file }))
  }
  if (kind === 'website' && !list.some((entry) => entry.path === 'index.html')) {
    return { ok: false, reason: 'A website needs a file called index.html at the top of its folder. Pick the folder that holds it.' }
  }
  const seen = new Set()
  for (const entry of list) {
    if (seen.has(entry.path)) return { ok: false, reason: `Two items are called ${JSON.stringify(entry.path)}. Rename one of them.` }
    seen.add(entry.path)
  }
  for (const entry of list) {
    const segments = entry.path.split('/')
    for (let depth = 1; depth < segments.length; depth++) {
      if (seen.has(segments.slice(0, depth).join('/'))) return { ok: false, reason: `${JSON.stringify(segments.slice(0, depth).join('/'))} is both a file and a folder.` }
    }
  }
  if (list.length > MAX_FILES) return { ok: false, reason: `A share holds ${MAX_FILES.toLocaleString('en-US')} files at most; this has ${list.length.toLocaleString('en-US')}.` }
  const bytes = list.reduce((sum, entry) => sum + entry.file.size, 0)
  if (bytes > MAX_SHARE_BYTES) return { ok: false, reason: `A share holds ${sizeText(MAX_SHARE_BYTES)} at most; this is ${sizeText(bytes)}.` }
  for (const [dir, names] of directories(list.map((entry) => entry.path))) {
    const problem = directoryProblem(dir, [...names])
    if (problem !== null) return { ok: false, reason: problem }
  }
  return { ok: true, entries: list, bytes, files: list.length }
}
