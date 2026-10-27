// What the page keeps about its IPFS node between tabs and reloads: the key every tab shares with the node, and the
// port it last ran on. A database of its own, so that publishing needs nothing of the page's settings; where
// IndexedDB is not there, the values live as long as the page does.

const DB_NAME = 'orivon-share-node'

/** @typedef {{ getOrCreate: (name: string, make: () => unknown) => Promise<any>, get: (name: string, fallback: unknown) => Promise<any>, set: (name: string, value: unknown) => Promise<void> }} NodeState */

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

/** @param {IDBFactory | undefined} factory @returns {NodeState} */
export function createNodeState (factory = globalThis.indexedDB) {
  /** @type {Map<string, unknown>} */
  const memory = new Map()
  /** @type {Promise<IDBDatabase> | null} */
  let opened = null
  const db = () => {
    opened ??= new Promise((resolve, reject) => {
      const request = /** @type {IDBFactory} */ (factory).open(DB_NAME, 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('state', { keyPath: 'name' }) }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('The storage is held open by another tab.'))
    })
    return opened
  }
  /** Runs `use` on the store; where storage is missing or refused, on memory. @template T @param {(tx: IDBTransaction, store: IDBObjectStore) => Promise<T>} use @param {() => T} fallback */
  async function withStore (use, fallback) {
    if (factory === undefined) return fallback()
    try {
      const tx = (await db()).transaction('state', 'readwrite')
      const value = await use(tx, tx.objectStore('state'))
      await done(tx)
      return value
    } catch {
      return fallback()
    }
  }
  return {
    async getOrCreate (name, make) {
      return await withStore(async (_tx, store) => {
        const saved = await result(store.get(name))
        if (saved !== undefined) return saved.value
        const value = make()
        store.put({ name, value })
        return value
      }, () => {
        if (!memory.has(name)) memory.set(name, make())
        return memory.get(name)
      })
    },
    async get (name, fallback) {
      return await withStore(async (_tx, store) => {
        const saved = await result(store.get(name))
        return saved === undefined ? fallback : saved.value
      }, () => memory.has(name) ? memory.get(name) : fallback)
    },
    async set (name, value) {
      await withStore(async (_tx, store) => { store.put({ name, value }) }, () => { memory.set(name, value) })
    }
  }
}

/** The state of this page, opened on first use. @type {NodeState | undefined} */
let shared

/** @returns {NodeState} */
export function nodeState () {
  shared ??= createNodeState()
  return shared
}
