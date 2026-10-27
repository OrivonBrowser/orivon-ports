// Where a kept share's bytes live on this computer. A share is one pack (its blocks one after the other) and two
// small records, its description and its index. Three places hold them: the origin's private file system (OPFS),
// IndexedDB when that is not there, and memory when neither is (kept until the page closes, and said so).

const SEGMENT_BYTES = 4 * 1024 * 1024

/**
 * @typedef {object} PackWriter
 * @property {(bytes: Uint8Array) => Promise<void>} append
 * @property {() => Promise<void>} close commits the pack
 * @property {() => Promise<void>} abort drops what was written
 * @typedef {object} Pack
 * @property {number} size
 * @property {(offset: number, length: number) => Promise<Uint8Array>} read
 * @property {(offset: number, length: number) => Blob} slice a Blob that refers to the bytes where they are kept
 * @typedef {object} Backend
 * @property {'opfs' | 'idb' | 'memory'} kind
 * @property {boolean} durable whether what is kept survives the page closing
 * @property {(root: string) => Promise<PackWriter>} create
 * @property {(root: string) => Promise<Pack | null>} open
 * @property {(root: string, part: 'meta' | 'index', value: unknown) => Promise<void>} put
 * @property {(root: string, part: 'meta' | 'index') => Promise<any>} get null when there is none or it is unreadable
 * @property {() => Promise<string[]>} list the roots that have a description
 * @property {(root: string) => Promise<void>} remove
 */

/** @param {Pack['read']} read @param {number} size @param {Pack['slice']} slice @returns {Pack} */
const pack = (read, size, slice) => ({ read, size, slice })

/** @returns {Backend} */
export function memoryBackend () {
  /** @type {Map<string, Blob>} */
  const packs = new Map()
  /** @type {Map<string, unknown>} */
  const records = new Map()
  return {
    kind: 'memory',
    durable: false,
    async create (root) {
      /** @type {BlobPart[]} */
      const parts = []
      return {
        append: async (bytes) => { parts.push(/** @type {BlobPart} */ (bytes.slice())) },
        close: async () => { packs.set(root, new Blob(parts)) },
        abort: async () => { parts.length = 0 }
      }
    },
    async open (root) {
      const blob = packs.get(root)
      if (blob === undefined) return null
      return pack(async (o, l) => new Uint8Array(await blob.slice(o, o + l).arrayBuffer()), blob.size, (o, l) => blob.slice(o, o + l))
    },
    async put (root, part, value) { records.set(`${root}/${part}`, JSON.parse(JSON.stringify(value))) },
    async get (root, part) { return records.get(`${root}/${part}`) ?? null },
    async list () { return [...records.keys()].filter((key) => key.endsWith('/meta')).map((key) => key.slice(0, -5)) },
    async remove (root) {
      packs.delete(root)
      records.delete(`${root}/meta`)
      records.delete(`${root}/index`)
    }
  }
}

/**
 * The origin's private file system. `directory` is what `navigator.storage.getDirectory()` returns.
 * @param {FileSystemDirectoryHandle} directory
 * @returns {Promise<Backend>}
 */
export async function opfsBackend (directory) {
  const dir = await directory.getDirectoryHandle('orivon-share-kept', { create: true })
  /** @param {string} name */
  const remove = async (name) => { try { await dir.removeEntry(name) } catch { /* not there */ } }
  return {
    kind: 'opfs',
    durable: true,
    async create (root) {
      const handle = await dir.getFileHandle(`${root}.pack`, { create: true })
      const writable = await handle.createWritable()
      return {
        append: async (bytes) => { await writable.write(/** @type {any} */ (bytes)) },
        close: async () => { await writable.close() },
        abort: async () => { await writable.abort().catch(() => {}); await remove(`${root}.pack`) }
      }
    },
    async open (root) {
      let file
      try {
        file = await (await dir.getFileHandle(`${root}.pack`)).getFile()
      } catch {
        return null
      }
      const kept = file
      return pack(async (o, l) => new Uint8Array(await kept.slice(o, o + l).arrayBuffer()), kept.size, (o, l) => kept.slice(o, o + l))
    },
    async put (root, part, value) {
      const writable = await (await dir.getFileHandle(`${root}.${part}.json`, { create: true })).createWritable()
      await writable.write(JSON.stringify(value))
      await writable.close()
    },
    async get (root, part) {
      try {
        return JSON.parse(await (await (await dir.getFileHandle(`${root}.${part}.json`)).getFile()).text())
      } catch {
        return null
      }
    },
    async list () {
      /** @type {string[]} */
      const roots = []
      for await (const name of /** @type {AsyncIterable<string>} */ (/** @type {any} */ (dir).keys())) {
        if (name.endsWith('.meta.json')) roots.push(name.slice(0, -'.meta.json'.length))
      }
      return roots
    },
    async remove (root) {
      await Promise.all([`${root}.pack`, `${root}.meta.json`, `${root}.index.json`].map(remove))
    }
  }
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

/**
 * IndexedDB: a pack is Blobs of about 4 MiB, each with where it starts.
 * @param {IDBFactory} factory
 * @returns {Promise<Backend>}
 */
export async function idbBackend (factory) {
  const db = await new Promise((/** @type {(db: IDBDatabase) => void} */ resolve, reject) => {
    const request = factory.open('orivon-share-kept', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('segments', { keyPath: ['root', 'n'] })
      request.result.createObjectStore('records', { keyPath: ['root', 'part'] })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('The storage is held open by another tab.'))
  })
  /** @param {string} store @param {(s: IDBObjectStore) => IDBRequest | void} use */
  const run = async (store, use) => {
    const tx = db.transaction(store, 'readwrite')
    const value = await (() => { const request = use(tx.objectStore(store)); return request ? result(request) : undefined })()
    await done(tx)
    return value
  }
  return {
    kind: 'idb',
    durable: true,
    async create (root) {
      let n = 0
      let start = 0
      /** @type {BlobPart[]} */
      let pending = []
      let held = 0
      const flush = async () => {
        if (held === 0) return
        const blob = new Blob(pending)
        await run('segments', (s) => s.put({ root, n, start, length: blob.size, blob }))
        n += 1
        start += blob.size
        pending = []
        held = 0
      }
      return {
        append: async (bytes) => {
          pending.push(/** @type {BlobPart} */ (bytes.slice()))
          held += bytes.length
          if (held >= SEGMENT_BYTES) await flush()
        },
        close: flush,
        abort: async () => { await remove(root) }
      }
    },
    async open (root) {
      /** @type {{ start: number, length: number, blob: Blob }[]} */
      const segments = await run('segments', (s) => s.getAll(IDBKeyRange.bound([root, 0], [root, Number.MAX_SAFE_INTEGER])))
      if (segments.length === 0) return null
      const last = /** @type {{ start: number, length: number }} */ (segments[segments.length - 1])
      const size = last.start + last.length
      /** @type {Pack['slice']} */
      const slice = (offset, length) => new Blob(segments.filter((s) => s.start < offset + length && s.start + s.length > offset)
        .map((s) => s.blob.slice(Math.max(offset - s.start, 0), Math.min(offset + length - s.start, s.length))))
      return pack(async (o, l) => new Uint8Array(await slice(o, l).arrayBuffer()), size, slice)
    },
    async put (root, part, value) { await run('records', (s) => s.put({ root, part, value })) },
    async get (root, part) {
      const row = await run('records', (s) => s.get([root, part]))
      return row === undefined ? null : row.value
    },
    async list () {
      /** @type {{ root: string, part: string }[]} */
      const rows = await run('records', (s) => s.getAll())
      return rows.filter((row) => row.part === 'meta').map((row) => row.root)
    },
    remove
  }

  /** @param {string} root */
  async function remove (root) {
    await run('segments', (s) => s.delete(IDBKeyRange.bound([root, 0], [root, Number.MAX_SAFE_INTEGER])))
    await run('records', (s) => { s.delete([root, 'meta']); s.delete([root, 'index']) })
  }
}

/**
 * The best place this page has. Asks OPFS first and gives it a file to write, since a browser can offer the
 * directory and refuse the write.
 * @param {{ storage?: StorageManager, indexedDB?: IDBFactory }} [env]
 * @returns {Promise<Backend>}
 */
export async function openBackend (env = /** @type {any} */ (globalThis.navigator === undefined ? {} : { storage: globalThis.navigator.storage, indexedDB: globalThis.indexedDB })) {
  if (typeof env.storage?.getDirectory === 'function') {
    try {
      const backend = await opfsBackend(await env.storage.getDirectory())
      const probe = await backend.create('probe')
      await probe.append(new Uint8Array(1))
      await probe.close()
      await backend.remove('probe')
      return backend
    } catch {
      // Fall through to IndexedDB.
    }
  }
  if (env.indexedDB !== undefined) {
    try {
      return await idbBackend(env.indexedDB)
    } catch {
      // Fall through to memory.
    }
  }
  return memoryBackend()
}
