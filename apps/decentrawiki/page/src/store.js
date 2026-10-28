// What the editor keeps, in this browser's IndexedDB for the editor's origin:
// the wikis (their description and their publications), every wiki's tiddlers,
// the settings, publishing keys included, and the newest published version of
// each wiki as a CAR, for hosting it (publish/hosting.js). A wiki being edited
// runs in a sandboxed frame with an origin of its own, so none of this is
// readable there.

const DB_NAME = 'decentrawiki'
const DB_VERSION = 2

/**
 * @typedef {{ kind: 'new' | 'pen' | 'file' | 'ipfs' | 'backup', address?: string, title?: string, at: number }} WikiSource
 * @typedef {{ cid: string, at: number, target: string, size: number, name?: string, sequence?: number }} Publication
 * @typedef {{ id: string, title: string, subtitle: string, createdAt: number, updatedAt: number,
 *   source: WikiSource, lineage: string, previous: string | null, name: string | null, publications: Publication[] }} Wiki
 * @typedef {Record<string, string>} Fields
 * @typedef {{ wiki: string, cid: string, car: Blob, at: number }} Hosted The newest published version of a wiki, as a CAR the editor's node can be given again
 */

/** @type {Promise<IDBDatabase> | undefined} */
let opened

/** @returns {Promise<IDBDatabase>} */
function db () {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => {
      const database = request.result
      if (event.oldVersion < 1) {
        database.createObjectStore('wikis', { keyPath: 'id' })
        const tiddlers = database.createObjectStore('tiddlers', { keyPath: ['wiki', 'title'] })
        tiddlers.createIndex('wiki', 'wiki')
        database.createObjectStore('settings', { keyPath: 'key' })
      }
      if (event.oldVersion < 2) database.createObjectStore('hosted', { keyPath: 'wiki' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('This browser refused to open the editor\'s storage'))
    request.onblocked = () => reject(new Error('Another tab holds the editor\'s storage open: close it and reload'))
  })
  return opened
}

/** @template T @param {IDBRequest<T>} request @returns {Promise<T>} */
function result (request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** @param {IDBTransaction} tx @returns {Promise<void>} */
function done (tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('The change was not saved'))
  })
}

/** @returns {Promise<Wiki[]>} newest edit first */
export async function listWikis () {
  const tx = (await db()).transaction('wikis')
  /** @type {Wiki[]} */
  const wikis = await result(tx.objectStore('wikis').getAll())
  return wikis.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** @param {string} id @returns {Promise<Wiki | undefined>} */
export async function getWiki (id) {
  return await result((await db()).transaction('wikis').objectStore('wikis').get(id))
}

/** @param {Wiki} wiki */
export async function putWiki (wiki) {
  const tx = (await db()).transaction('wikis', 'readwrite')
  tx.objectStore('wikis').put(wiki)
  await done(tx)
}

/** @param {string} id @param {(wiki: Wiki) => Wiki} change @returns {Promise<Wiki | undefined>} */
export async function updateWiki (id, change) {
  const tx = (await db()).transaction('wikis', 'readwrite')
  const store = tx.objectStore('wikis')
  /** @type {Wiki | undefined} */
  const current = await result(store.get(id))
  if (current === undefined) return undefined
  const next = change(current)
  store.put(next)
  await done(tx)
  return next
}

/** @param {string} id */
export async function deleteWiki (id) {
  const tx = (await db()).transaction(['wikis', 'tiddlers', 'hosted'], 'readwrite')
  tx.objectStore('wikis').delete(id)
  tx.objectStore('hosted').delete(id)
  const index = tx.objectStore('tiddlers').index('wiki')
  const keys = await result(index.getAllKeys(IDBKeyRange.only(id)))
  for (const key of keys) tx.objectStore('tiddlers').delete(key)
  await done(tx)
}

/** @param {string} wiki @returns {Promise<Fields[]>} */
export async function getTiddlers (wiki) {
  const index = (await db()).transaction('tiddlers').objectStore('tiddlers').index('wiki')
  /** @type {{ fields: Fields }[]} */
  const rows = await result(index.getAll(IDBKeyRange.only(wiki)))
  return rows.map((row) => row.fields)
}

/** Writes `put` and removes `removed` in one transaction. @param {string} wiki @param {Fields[]} put @param {string[]} [removed] */
export async function putTiddlers (wiki, put, removed = []) {
  const tx = (await db()).transaction('tiddlers', 'readwrite')
  const store = tx.objectStore('tiddlers')
  for (const title of removed) store.delete([wiki, title])
  for (const fields of put) store.put({ wiki, title: fields.title, fields })
  await done(tx)
}

/** Makes `fields` the wiki's whole set of tiddlers, in one transaction. @param {string} wiki @param {Fields[]} fields */
export async function replaceTiddlers (wiki, fields) {
  const tx = (await db()).transaction('tiddlers', 'readwrite')
  const store = tx.objectStore('tiddlers')
  const keys = await result(store.index('wiki').getAllKeys(IDBKeyRange.only(wiki)))
  for (const key of keys) store.delete(key)
  for (const row of fields) store.put({ wiki, title: row.title, fields: row })
  await done(tx)
}

/** Keeps a wiki's newest published version to host, in place of the one before. @param {Hosted} row */
export async function putHosted (row) {
  const tx = (await db()).transaction('hosted', 'readwrite')
  tx.objectStore('hosted').put(row)
  await done(tx)
}

/** Takes back a version kept to host, for a wiki that is not deleted. @param {string} wiki */
export async function deleteHosted (wiki) {
  const tx = (await db()).transaction('hosted', 'readwrite')
  tx.objectStore('hosted').delete(wiki)
  await done(tx)
}

/** @param {string} wiki @returns {Promise<Hosted | undefined>} */
export async function getHosted (wiki) {
  return await result((await db()).transaction('hosted').objectStore('hosted').get(wiki))
}

/** @returns {Promise<Hosted[]>} the version of every wiki that has one */
export async function listHosted () {
  return await result((await db()).transaction('hosted').objectStore('hosted').getAll())
}

/** @template T @param {string} key @param {T} fallback @returns {Promise<T>} */
export async function getSetting (key, fallback) {
  const row = await result((await db()).transaction('settings').objectStore('settings').get(key))
  return row === undefined ? fallback : row.value
}

/** @param {string} key @param {unknown} value */
export async function setSetting (key, value) {
  const tx = (await db()).transaction('settings', 'readwrite')
  tx.objectStore('settings').put({ key, value })
  await done(tx)
}

/**
 * Changes one setting in a single transaction, so two tabs never write over each other.
 * @template T @param {string} key @param {T} fallback @param {(current: T) => T} change @returns {Promise<T>}
 */
export async function updateSetting (key, fallback, change) {
  const tx = (await db()).transaction('settings', 'readwrite')
  const settings = tx.objectStore('settings')
  const row = await result(settings.get(key))
  const next = change(row === undefined ? fallback : row.value)
  settings.put({ key, value: next })
  await done(tx)
  return next
}

/** Asks the browser not to clear the editor's storage under pressure. Best effort: the answer is the browser's. */
export async function askToPersist () {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) return true
    return navigator.storage?.persist ? await navigator.storage.persist() : false
  } catch {
    return false
  }
}
