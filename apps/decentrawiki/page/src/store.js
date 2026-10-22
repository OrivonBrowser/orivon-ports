// What the editor keeps, in this browser's IndexedDB for the editor's origin:
// the wikis (their description and their publications), every wiki's tiddlers,
// and the settings, publishing keys included. A wiki being edited runs in a
// sandboxed frame with an origin of its own, so none of this is readable there.

const DB_NAME = 'decentrawiki'
const DB_VERSION = 1

/**
 * @typedef {{ kind: 'new' | 'pen' | 'file' | 'ipfs' | 'backup', address?: string, title?: string, at: number }} WikiSource
 * @typedef {{ cid: string, at: number, target: string, size: number }} Publication
 * @typedef {{ id: string, title: string, subtitle: string, createdAt: number, updatedAt: number,
 *   source: WikiSource, lineage: string, previous: string | null, publications: Publication[] }} Wiki
 * @typedef {Record<string, string>} Fields
 */

/** @type {Promise<IDBDatabase> | undefined} */
let opened

/** @returns {Promise<IDBDatabase>} */
function db () {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      database.createObjectStore('wikis', { keyPath: 'id' })
      const tiddlers = database.createObjectStore('tiddlers', { keyPath: ['wiki', 'title'] })
      tiddlers.createIndex('wiki', 'wiki')
      database.createObjectStore('settings', { keyPath: 'key' })
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
  const tx = (await db()).transaction(['wikis', 'tiddlers'], 'readwrite')
  tx.objectStore('wikis').delete(id)
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

/** Asks the browser not to clear the editor's storage under pressure. Best effort: the answer is the browser's. */
export async function askToPersist () {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) return true
    return navigator.storage?.persist ? await navigator.storage.persist() : false
  } catch {
    return false
  }
}
