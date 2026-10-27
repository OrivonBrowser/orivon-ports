// The one module the page imports from the engine: the facade over IPFS addresses, ZIP and age, keeping and serving
// a share on this computer, reading a share by its link, and showing a protected website inside Share.

/**
 * @typedef {import('./lib/selection.js').Entry} Entry A picked file: a POSIX relative path, no leading slash, no `..`, and its Blob.
 * @typedef {import('./lib/selection.js').Kind} Kind
 * @typedef {import('./publish/targets.js').Target} Target A service that keeps a share online while Share is closed.
 * @typedef {import('./publish/share.js').Progress} Progress
 * @typedef {import('./serve/manager.js').ServingState} ServingState
 */

import { generatePassword, passwordStrength } from './lib/passwords.js'
import { MAX_FILES, MAX_SHARE_BYTES, MIN_PASSWORD_LENGTH } from './lib/limits.js'
import { parseShareLink, shareLink } from './lib/links.js'
import { checkSelection, entriesFromDrop, entriesFromInput } from './lib/selection.js'
import { writeZip } from './lib/zip.js'
import { MAX_DIRECTORY_ENTRIES } from './ipfs/unixfs.js'
import { pageNodeAvailable } from './node/provide.js'
import { pinElsewhere as pinKept } from './publish/elsewhere.js'
import { publishShare } from './publish/share.js'
import { TARGET_KINDS, check } from './publish/targets.js'
import { closeShare, openShare as openByCid, readPublicFile, zipPublic } from './receive/read.js'
import { unlockShare } from './receive/unlock.js'
import { currentRuntime, getRuntime, onRuntime } from './runtime.js'
import { createSiteServer, mimeTypeOf } from './viewer/server.js'

export { checkSelection, closeShare, entriesFromDrop, entriesFromInput, generatePassword, mimeTypeOf, parseShareLink, passwordStrength, publishShare, readPublicFile, shareLink, TARGET_KINDS, unlockShare, zipPublic }

export const LIMITS = {
  maxShareBytes: MAX_SHARE_BYTES,
  maxFiles: MAX_FILES,
  maxFolderEntries: MAX_DIRECTORY_ENTRIES,
  minPasswordLength: MIN_PASSWORD_LENGTH
}

/** What this page can do. `embed` is whether the page has the means to show a site inside itself; `embedAvailable` asks whether the person allowed it. */
export function environment () {
  const orivon = globalThis.window?.orivon
  return {
    orivon: orivon !== undefined,
    pageNode: pageNodeAvailable(),
    embed: typeof orivon?.net?.listen === 'function' && typeof orivon?.web?.setEmbedScript === 'function',
    webrtc: typeof WebSocket === 'function' && typeof RTCPeerConnection === 'function'
  }
}

/** Whether the person granted this page the right to show a site inside itself. */
export async function embedAvailable () {
  if (!environment().embed) return false
  try {
    await globalThis.window.orivon.web.setEmbedScript('')
    return true
  } catch {
    return false
  }
}

/** Resolves, or throws an Error with a message for the person. @param {import('./publish/targets.js').Target} target @param {{ signal?: AbortSignal }} [options] */
export async function testTarget (target, { signal } = {}) {
  await check(target, signal)
}

/**
 * The share at an address (or a link to one): what it is and what it holds, every block checked.
 * @param {string} cid @param {import('./receive/read.js').ReceiveOptions} [options]
 */
export async function openShare (cid, options = {}) {
  const parsed = parseShareLink(cid)
  return await openByCid(parsed === null ? cid : parsed.cid, options)
}

/** Every file as one store-only ZIP, without a description. @param {{ path: string, file: Blob }[]} entries @returns {Promise<Blob>} */
export async function zipEntries (entries) {
  return await writeZip(entries.map((entry) => ({ name: entry.path, file: entry.file })))
}

/** @type {ReturnType<typeof createSiteServer> | null} */
let siteServer = null

/**
 * Serves a protected website from this page and returns where to show it. Orivon with the `web.embed` grant only.
 * @param {string} cid @param {{ path: string, size: number, file: Blob }[]} entries @param {Uint8Array | string} secret
 */
export async function startSiteServer (cid, entries, secret) {
  if (!(await embedAvailable())) throw new Error('Showing a website inside Share needs Orivon and its permission to show sites. Download the website as a ZIP instead.')
  siteServer ??= createSiteServer({ listen: (options) => globalThis.window.orivon.net.listen(options) })
  const key = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret
  const site = await siteServer.add(cid, entries, key)
  return { url: site.url, origin: site.origin, stop: () => { void site.stop() } }
}

// What is kept and served on this computer.

/** Starts serving every kept share marked online. Call it once when the page loads; again does nothing. */
export async function startServing () {
  await (await getRuntime()).serving.start()
}

/** @returns {import('./serve/manager.js').ServingState} */
export function servingState () {
  return currentRuntime()?.serving.state() ?? { shares: [], trackers: { connected: 0, total: 0 }, supported: false }
}

/** @type {Set<(state: import('./serve/manager.js').ServingState) => void>} */
const listeners = new Set()
onRuntime((runtime) => { runtime.serving.subscribe((state) => { for (const listener of listeners) listener(state) }) })

/** @param {(state: import('./serve/manager.js').ServingState) => void} listener @returns {() => void} */
export function onServingChange (listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** @param {string} cid @param {boolean} online */
export async function setOnline (cid, online) {
  await (await getRuntime()).serving.setOnline(cid, online)
}

/** Stops sharing and deletes the share from this computer. @param {string} cid */
export async function deleteKept (cid) {
  const { keep, serving } = await getRuntime()
  await serving.removed(cid)
  await keep.remove(cid)
}

/** The kept share as a CAR file, made from the kept bytes. @param {string} cid @returns {Promise<Blob>} */
export async function exportCar (cid) {
  return await (await getRuntime()).keep.car(cid)
}

/** Keeps a kept share on a service too, from the kept bytes. @param {string} cid @param {import('./publish/targets.js').Target} service @param {{ signal?: AbortSignal, onProgress?: (progress: { step: 'send' | 'check', text?: string }) => void }} [options] */
export async function pinElsewhere (cid, service, options = {}) {
  return await pinKept((await getRuntime()).keep, cid, service, options)
}

/** What kept shares take of this site's storage. @returns {Promise<{ used: number, quota: number, persisted: boolean, kept: number, durable: boolean }>} */
export async function storageInfo () {
  const storage = globalThis.navigator?.storage
  const estimate = storage === undefined ? {} : await storage.estimate().catch(() => ({}))
  const runtime = await getRuntime()
  return {
    used: estimate.usage ?? 0,
    quota: estimate.quota ?? 0,
    persisted: storage === undefined ? false : await storage.persisted().catch(() => false),
    kept: await runtime.keep.usage(),
    durable: runtime.storage.durable
  }
}

/** The shares kept on this computer, newest first. */
export async function keptShares () {
  return await (await getRuntime()).keep.list()
}
