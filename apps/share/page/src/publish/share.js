// Sharing: check what was picked, lay it out as the kind says (protected: a ZIP in an age file beside a note),
// compute its IPFS address here, keep the bytes on this computer and serve them from it, and if the person named a
// service, keep it there too, accepting that only when the service reports the same address. The address comes from
// the bytes on this side, so nowhere can store something else under it. When the person ticked the box, the share
// is also sent to Orivon's copy service (orivon-copy.js), under the same rule.

import { importTree } from '../ipfs/unixfs.js'
import { encryptBlob } from '../crypto/client.js'
import { MAX_SHARE_BYTES } from '../lib/limits.js'
import { shareLink } from '../lib/links.js'
import { manifestText, MANIFEST_NAME } from '../lib/manifest.js'
import { passwordStrength } from '../lib/passwords.js'
import { checkSelection } from '../lib/selection.js'
import { writeZip } from '../lib/zip.js'
import { getRuntime } from '../runtime.js'
import { HOW_TO_OPEN } from './how-to-open.js'
import { pinElsewhere } from './elsewhere.js'
import { COPY_LABEL, keepOnOrivon } from './orivon-copy.js'
import { describe } from './targets.js'

const MEGABYTE = 1048576

/**
 * @typedef {import('../lib/selection.js').Entry} Entry
 * @typedef {import('../lib/selection.js').Kind} Kind
 * @typedef {import('./targets.js').Target} Target
 * @typedef {{ step: 'read' | 'encrypt' | 'address' | 'node' | 'send' | 'check' | 'download' | 'decrypt', done?: number, total?: number, text?: string }} Progress
 * @typedef {{ kind: Kind, entries: Entry[], password?: string, keyInLink?: boolean, title?: string, message?: string, service?: Target | null, orivonCopy?: boolean, signal?: AbortSignal, onProgress?: (progress: Progress) => void }} Request
 */

/** @param {number} bytes */
function megabytes (bytes) {
  return `${(bytes / MEGABYTE).toFixed(bytes < 10 * MEGABYTE ? 1 : 0)} MB`
}

/** @param {number} bytes */
function checkSize (bytes) {
  if (bytes > MAX_SHARE_BYTES) throw new Error(`This share is ${megabytes(bytes)}, and a share holds ${megabytes(MAX_SHARE_BYTES)} at most.`)
}

/**
 * The files the directory holds, laid out for the kind: the picked entries as they are, or for a password the age
 * file and the note.
 * @param {Request} request
 * @param {{ entries: Entry[], bytes: number, files: number }} picked
 * @returns {Promise<{ path: string, blob: Blob }[]>}
 */
async function layOut (request, picked) {
  const { kind, password, title, message, signal, onProgress = () => {} } = request
  if (password === undefined || password === '') {
    onProgress({ step: 'read', done: picked.bytes, total: picked.bytes })
    return picked.entries.map((entry) => ({ path: entry.path, blob: entry.file }))
  }
  const manifest = new Blob([manifestText({ kind, ...(title === undefined ? {} : { title }), ...(message === undefined ? {} : { message }), files: picked.files, bytes: picked.bytes })], { type: 'application/json' })
  let read = 0
  const zip = await writeZip([{ name: MANIFEST_NAME, file: manifest }, ...picked.entries.map((entry) => ({ name: entry.path, file: entry.file }))], {
    ...(signal ? { signal } : {}),
    onBytes: (n) => { read += n; onProgress({ step: 'read', done: read, total: picked.bytes }) }
  })
  const cipher = await encryptBlob(zip, password, { ...(signal ? { signal } : {}), onProgress: ({ done, total }) => onProgress({ step: 'encrypt', done, total }) })
  return [{ path: 'HOW-TO-OPEN.txt', blob: new Blob([HOW_TO_OPEN], { type: 'text/plain' }) }, { path: 'share.age', blob: cipher }]
}

/**
 * Asks the browser to keep this site's storage, and whether the share fits in what is left. Both are best effort: a
 * browser that does not answer does not stop a share.
 * @param {number} needed
 */
async function prepareStorage (needed) {
  const storage = globalThis.navigator?.storage
  if (storage === undefined) return
  try {
    if (typeof storage.persist === 'function' && !(await storage.persisted())) await storage.persist()
  } catch {
    // Not granted: the share is kept all the same, and the browser may clear it under pressure.
  }
  try {
    const { usage = 0, quota = Infinity } = await storage.estimate()
    if (quota - usage < needed * 1.02 + 16 * MEGABYTE) {
      throw new Error(`This computer has ${megabytes(Math.max(quota - usage, 0))} left for Share and this share needs ${megabytes(needed)}. Delete a share you no longer send, or free some disk space.`)
    }
  } catch (error) {
    if (error instanceof Error && /left for Share/.test(error.message)) throw error
  }
}

/**
 * Shares and resolves with what the person needs to send it on.
 * @param {Request} request
 */
export async function publishShare (request) {
  const { kind, entries, password, keyInLink = false, service = null, orivonCopy = false, signal, onProgress = () => {} } = request
  const picked = checkSelection(entries, kind)
  if (!picked.ok) throw new Error(picked.reason)
  const encrypted = password !== undefined && password !== ''
  if (encrypted) {
    const strength = passwordStrength(password)
    if (!strength.acceptable) throw new Error(`This password is too weak. ${strength.hint}`)
  }
  checkSize(picked.bytes)
  const { keep, serving, supported } = await getRuntime()
  await prepareStorage(picked.bytes)

  const files = await layOut(request, picked)
  const published = files.reduce((sum, file) => sum + file.blob.size, 0)
  checkSize(published)

  const tree = files.map((file) => ({ path: file.path, content: file.blob }))
  let counted = 0
  const imported = await importTree(tree, () => {}, {
    ...(signal ? { signal } : {}),
    onBytes: (n) => { counted += n; onProgress({ step: 'address', done: counted, total: published }) }
  })
  const cid = imported.cid

  if (await keep.meta(cid) === null) {
    let stored = 0
    await keep.add(cid, { kind, encrypted, bytes: picked.bytes, files: picked.files, online: supported }, async (sink) => {
      await importTree(tree, sink, {
        ...(signal ? { signal } : {}),
        onBytes: (n) => { stored += n; onProgress({ step: 'send', done: stored, total: published, text: 'Keeping it on this computer' }) }
      })
    })
  } else {
    await keep.setOnline(cid, supported)
  }
  await serving.added(cid, supported)

  /** @type {{ label: string, ok: boolean, error?: string, keptUntil?: number | null } | null} */
  let copy = null
  if (orivonCopy) {
    try {
      copy = await keepOnOrivon(keep, cid, { ...(signal ? { signal } : {}), onProgress })
    } catch (error) {
      if (signal?.aborted) throw error
      copy = { label: COPY_LABEL, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** @type {{ label: string, ok: boolean, error?: string } | null} */
  let kept = null
  if (service !== null) {
    try {
      kept = await pinElsewhere(keep, cid, service, { ...(signal ? { signal } : {}), onProgress })
    } catch (error) {
      if (signal?.aborted) throw error
      kept = { label: describe(service), ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    cid,
    kind,
    encrypted,
    bytes: picked.bytes,
    files: picked.files,
    link: shareLink(cid, encrypted && keyInLink ? password : undefined),
    ipfsUrl: `ipfs://${cid}`,
    gatewayUrl: `https://${cid}.ipfs.dweb.link/`,
    online: supported,
    service: kept,
    copy
  }
}
