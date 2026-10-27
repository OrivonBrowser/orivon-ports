// Opening and reading a share by its address: what it is, its files, one file, all of them as a ZIP. Everything is
// read from where the blocks come from (session.js) and checked against the address; a share over the size limit is
// refused from the sizes its directory states, before any file is downloaded.

import { parseCid, DAG_PB } from '../ipfs/cid.js'
import { describeBlock } from '../ipfs/dagread.js'
import { listTree } from '../ipfs/dagwalk.js'
import { MAX_SHARE_BYTES } from '../lib/limits.js'
import { writeZip } from '../lib/zip.js'
import { isEncrypted, kindOf } from './classify.js'
import { sessionFor, closeSession } from './session.js'

const MEGABYTE = 1048576

/**
 * @typedef {{ step: 'download' | 'decrypt', done?: number, total?: number, text?: string, source?: 'peer' | 'gateway' | 'local' }} ReceiveProgress
 * @typedef {{ cid: string, encrypted: boolean, kind: 'files' | 'folder' | 'website' | null, bytes: number, entries: { path: string, size: number }[], cids: Record<string, string> }} OpenedShare
 * @typedef {{ signal?: AbortSignal, onProgress?: (progress: ReceiveProgress) => void }} ReceiveOptions
 */

/** Where a session gets what it needs from this page: the kept shares and the trackers, from the runtime made on first use. A test sets its own. @type {() => Promise<import('./session.js').SessionDeps>} */
let depsProvider = async () => {
  const { getRuntime } = await import('../runtime.js')
  const runtime = await getRuntime()
  return { keep: runtime.keep, hub: runtime.supported ? runtime.hub : null }
}

/** @param {() => Promise<import('./session.js').SessionDeps>} provider */
export function configureReceive (provider) {
  depsProvider = provider
}

/** What a session is made from, as the engine configured it. */
export function receiveDeps () {
  return depsProvider()
}

/** @param {number} bytes */
function limit (bytes) {
  return Math.ceil(bytes * 1.05) + 64 * 1024
}

/**
 * What the address is: a directory of files, or Share refuses.
 * @param {string} cid
 * @param {ReceiveOptions} [options]
 * @returns {Promise<OpenedShare>}
 */
export async function openShare (cid, { signal, onProgress = () => {} } = {}) {
  const root = parseCid(cid)
  if (root.codec !== DAG_PB) throw new Error('This address is a single file, not a share made with Orivon Share.')
  const session = await sessionFor(root.string, await depsProvider())
  onProgress({ step: 'download', text: 'Looking for the share' })
  /** Reads a block and says which source gave it. @param {string} block */
  const read = (block) => session.block(block, { ...(signal ? { signal } : {}), onSource: (source) => onProgress({ step: 'download', text: 'Reading the list of files', source }) })
  const info = describeBlock(root.string, await read(root.string))
  if (info.type !== 'directory') throw new Error('This address is not a share made with Orivon Share: it is not a folder.')
  const declared = info.entries.reduce((sum, entry) => sum + entry.tsize, 0)
  if (declared > MAX_SHARE_BYTES * 1.02) throw new Error(`This share is larger than Share opens (${MAX_SHARE_BYTES / (1024 * MEGABYTE)} GB).`)
  const names = info.entries.map((entry) => entry.name)

  if (isEncrypted(names)) {
    const age = /** @type {{ name: string, cid: string, tsize: number }} */ (info.entries.find((entry) => entry.name === 'share.age'))
    const how = /** @type {{ name: string, cid: string }} */ (info.entries.find((entry) => entry.name === 'HOW-TO-OPEN.txt'))
    const size = parseCid(age.cid).codec === DAG_PB ? describeBlock(age.cid, await read(age.cid)).size : age.tsize
    return { cid: root.string, encrypted: true, kind: null, bytes: size, entries: [], cids: { 'share.age': age.cid, 'HOW-TO-OPEN.txt': how.cid } }
  }

  const files = await listTree({ block: read }, root.string, { ...(signal ? { signal } : {}) })
  const bytes = files.reduce((sum, file) => sum + file.size, 0)
  if (bytes > MAX_SHARE_BYTES) throw new Error(`This share is larger than Share opens (${MAX_SHARE_BYTES / (1024 * MEGABYTE)} GB).`)
  return {
    cid: root.string,
    encrypted: false,
    kind: kindOf(names, files.map((file) => file.path)),
    bytes,
    entries: files.map((file) => ({ path: file.path, size: file.size })),
    cids: Object.fromEntries(files.map((file) => [file.path, file.cid]))
  }
}

/**
 * One file of a public share, checked against its address.
 * @param {OpenedShare} share @param {string} path @param {ReceiveOptions} [options]
 * @returns {Promise<Blob>}
 */
export async function readPublicFile (share, path, { signal, onProgress = () => {} } = {}) {
  const cid = share.cids[path]
  if (cid === undefined) throw new Error(`This share has no file called ${path}.`)
  const size = share.entries.find((entry) => entry.path === path)?.size ?? 0
  const session = await sessionFor(share.cid, await depsProvider())
  const { blob } = await session.file(cid, {
    ...(signal ? { signal } : {}), total: size, maxBytes: limit(size),
    onProgress: ({ done, total, source }) => onProgress({ step: 'download', done, total, source })
  })
  return blob
}

/**
 * Every file of a public share as one ZIP archive, without compression.
 * @param {OpenedShare} share @param {ReceiveOptions} [options]
 * @returns {Promise<Blob>}
 */
export async function zipPublic (share, { signal, onProgress = () => {} } = {}) {
  let finished = 0
  /** @type {{ name: string, file: Blob }[]} */
  const files = []
  for (const entry of share.entries) {
    const file = await readPublicFile(share, entry.path, {
      ...(signal ? { signal } : {}),
      onProgress: ({ done = 0, source }) => onProgress({ step: 'download', done: finished + done, total: share.bytes, ...(source ? { source } : {}) })
    })
    finished += entry.size
    files.push({ name: entry.path, file })
  }
  return await writeZip(files, signal ? { signal } : {})
}

/** Lets go of the connections made to read a share. @param {string} cid */
export function closeShare (cid) {
  closeSession(cid)
}
