// What the page keeps, in this browser's IndexedDB for the page's origin: the
// settings (pinning targets and their keys included), the shares sent from here
// with the password of those the person asked to remember, and the secret that
// gives each protected website an origin of its own. A protected website runs in
// a webview at an origin of its own, so none of this is readable there.

const DB_NAME = 'orivon-share'
const DB_VERSION = 1

/**
 * @typedef {{ cid: string, kind: 'files' | 'folder' | 'website', encrypted: boolean, title: string, bytes: number, files: number,
 *   at: number, keyInLink: boolean, password?: string, services: { label: string, at: number }[] }} ShareRecord
 * The share's bytes are not here: the engine keeps them. A record is what My shares lists, and its password when the person asked.
 */

/** @type {Promise<IDBDatabase> | undefined} */
let opened

/** @returns {Promise<IDBDatabase>} */
function db () {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('settings', { keyPath: 'key' })
      request.result.createObjectStore('shares', { keyPath: 'cid' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('This browser refused to open the page\'s storage'))
    request.onblocked = () => reject(new Error('Another tab holds the page\'s storage open: close it and reload'))
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

/** The shares sent from this browser, newest first. @returns {Promise<ShareRecord[]>} */
export async function listShares () {
  /** @type {ShareRecord[]} */
  const rows = await result((await db()).transaction('shares').objectStore('shares').getAll())
  return rows.sort((a, b) => b.at - a.at)
}

/** @param {ShareRecord} share */
export async function putShare (share) {
  const tx = (await db()).transaction('shares', 'readwrite')
  tx.objectStore('shares').put(share)
  await done(tx)
}

/** Notes that a service now keeps the share too. @param {string} cid @param {string} label */
export async function addService (cid, label) {
  const tx = (await db()).transaction('shares', 'readwrite')
  const shares = tx.objectStore('shares')
  /** @type {ShareRecord | undefined} */
  const row = await result(shares.get(cid))
  if (row !== undefined) shares.put({ ...row, services: [...row.services.filter((service) => service.label !== label), { label, at: Date.now() }] })
  await done(tx)
}

/** @param {string} cid */
export async function deleteShare (cid) {
  const tx = (await db()).transaction('shares', 'readwrite')
  tx.objectStore('shares').delete(cid)
  await done(tx)
}

export async function clearShares () {
  const tx = (await db()).transaction('shares', 'readwrite')
  tx.objectStore('shares').clear()
  await done(tx)
}

/** Drops every remembered password and keeps the rest of the history. @returns {Promise<number>} how many were dropped */
export async function forgetPasswords () {
  const tx = (await db()).transaction('shares', 'readwrite')
  const shares = tx.objectStore('shares')
  /** @type {ShareRecord[]} */
  const rows = await result(shares.getAll())
  let dropped = 0
  for (const row of rows) {
    if (row.password === undefined) continue
    const { password, ...rest } = row
    shares.put(rest)
    dropped += 1
  }
  await done(tx)
  return dropped
}

/**
 * Thirty-two random bytes, made once and kept: the label of every protected website derives from them,
 * so a site keeps its own storage across openings, and no other program on this computer can guess its address.
 * @returns {Promise<Uint8Array>}
 */
export async function viewerSecret () {
  const tx = (await db()).transaction('settings', 'readwrite')
  const settings = tx.objectStore('settings')
  const row = await result(settings.get('viewerSecret'))
  /** @type {Uint8Array} */
  const secret = row?.value instanceof Uint8Array && row.value.length === 32 ? row.value : crypto.getRandomValues(new Uint8Array(32))
  if (row === undefined || secret !== row.value) settings.put({ key: 'viewerSecret', value: secret })
  await done(tx)
  return secret
}

/** Asks the browser not to clear the page's storage under pressure. Best effort: the answer is the browser's. */
export async function askToPersist () {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) return true
    return navigator.storage?.persist ? await navigator.storage.persist() : false
  } catch {
    return false
  }
}
