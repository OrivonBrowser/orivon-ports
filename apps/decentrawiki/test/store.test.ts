import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The least of IndexedDB the editor's store needs: versioned databases with upgrades, object stores keyed by a
// path (or an array of paths), one index, and transactions that finish once no request is left in them.
type Row = Record<string, unknown>
const keyOf = (key: unknown) => JSON.stringify(key)
const copy = (value: unknown) => value !== null && typeof value === 'object' ? { ...value } : value

class FakeStore {
  rows = new Map<string, Row>()
  indexes = new Map<string, string>()
  constructor(readonly keyPath: string | string[]) {}
  primary(value: Row) { return Array.isArray(this.keyPath) ? this.keyPath.map((path) => value[path]) : value[this.keyPath] }
  put(value: Row) { this.rows.set(keyOf(this.primary(value)), copy(value) as Row) }
}

class FakeDatabase {
  version = 0
  stores = new Map<string, FakeStore>()
}

function fakeIndexedDB() {
  const databases = new Map<string, FakeDatabase>()
  const transaction = (database: FakeDatabase, names: string | string[]) => {
    const allowed = Array.isArray(names) ? names : [names]
    let pending = 0
    let finished = false
    const tx: { oncomplete: (() => void) | null, onerror: unknown, onabort: unknown, objectStore: (name: string) => unknown } = {
      oncomplete: null, onerror: null, onabort: null,
      objectStore (name: string) {
        const store = database.stores.get(name)
        if (store === undefined || !allowed.includes(name)) throw new Error(`NotFoundError: ${name} is not in this transaction`)
        const request = <T>(run: () => T) => {
          pending++
          const req: { result?: T, onsuccess: (() => void) | null, onerror: unknown } = { onsuccess: null, onerror: null }
          queueMicrotask(() => {
            req.result = run()
            pending--
            req.onsuccess?.()
            setTimeout(() => { if (pending === 0 && !finished) { finished = true; tx.oncomplete?.() } }, 0)
          })
          return req
        }
        const matching = (path: string, range: { only: unknown }) => [...store.rows.values()].filter((row) => keyOf(row[path]) === keyOf(range.only))
        return {
          get: (key: unknown) => request(() => copy(store.rows.get(keyOf(key)))),
          getAll: () => request(() => [...store.rows.values()].map(copy)),
          put: (value: Row) => request(() => { store.put(value); return store.primary(value) }),
          delete: (key: unknown) => request(() => { store.rows.delete(keyOf(key)) }),
          index: (name: string) => {
            const path = store.indexes.get(name)!
            return {
              getAll: (range: { only: unknown }) => request(() => matching(path, range).map(copy)),
              getAllKeys: (range: { only: unknown }) => request(() => matching(path, range).map((row) => store.primary(row)))
            }
          }
        }
      }
    }
    return tx
  }
  const indexedDB = {
    open (name: string, version: number) {
      const request: { result?: unknown, error: null, onsuccess: (() => void) | null, onerror: unknown, onblocked: unknown, onupgradeneeded: ((event: { oldVersion: number }) => void) | null } = {
        error: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null
      }
      setTimeout(() => {
        const database = databases.get(name) ?? new FakeDatabase()
        databases.set(name, database)
        const oldVersion = database.version
        request.result = {
          createObjectStore (storeName: string, options: { keyPath: string | string[] }) {
            const store = new FakeStore(options.keyPath)
            database.stores.set(storeName, store)
            return { createIndex: (indexName: string, path: string) => { store.indexes.set(indexName, path) } }
          },
          transaction: (names: string | string[]) => transaction(database, names)
        }
        if (version > oldVersion) {
          database.version = version
          request.onupgradeneeded?.({ oldVersion })
        }
        request.onsuccess?.()
      }, 0)
      return request
    }
  }
  return { indexedDB, databases }
}

/** A database as editors before the hosting store left it: version 1, with a wiki, its tiddlers and a setting. */
function version1(fake: ReturnType<typeof fakeIndexedDB>) {
  const database = new FakeDatabase()
  database.version = 1
  const wikis = new FakeStore('id')
  const tiddlers = new FakeStore(['wiki', 'title'])
  tiddlers.indexes.set('wiki', 'wiki')
  const settings = new FakeStore('key')
  database.stores.set('wikis', wikis)
  database.stores.set('tiddlers', tiddlers)
  database.stores.set('settings', settings)
  wikis.put({ id: 'old', title: 'Kept', subtitle: '', createdAt: 1, updatedAt: 2, source: { kind: 'new', at: 1 }, lineage: 'l', previous: null, name: null, publications: [] })
  tiddlers.put({ wiki: 'old', title: 'Home', fields: { title: 'Home', text: 'hello' } })
  settings.put({ key: 'nodeKey', value: 'ab'.repeat(32) })
  fake.databases.set('decentrawiki', database)
  return database
}

function wiki(id: string, extra: Row = {}): Row {
  return { id, title: id, subtitle: '', createdAt: 1, updatedAt: 1, source: { kind: 'new', at: 1 }, lineage: id, previous: null, name: null, publications: [{ cid: `bafy${id}`, at: 1, target: 'x', size: 1 }], ...extra }
}

let fake: ReturnType<typeof fakeIndexedDB>

async function freshStore() {
  vi.resetModules()
  vi.stubGlobal('indexedDB', fake.indexedDB)
  vi.stubGlobal('IDBKeyRange', { only: (value: unknown) => ({ only: value }) })
  return await import('../page/src/store.js')
}

beforeEach(() => { fake = fakeIndexedDB() })
afterEach(() => { vi.unstubAllGlobals() })

describe('the editor\'s storage', () => {
  it('makes the wikis, the tiddlers, the settings and the hosted versions in a new browser', async () => {
    const store = await freshStore()
    await store.putWiki(wiki('a') as never)
    expect((await store.getWiki('a'))?.title).toBe('a')
    await store.setSetting('hostWikis', true)
    expect(await store.getSetting('hostWikis', false)).toBe(true)
    expect(fake.databases.get('decentrawiki')?.version).toBe(2)
    expect([...fake.databases.get('decentrawiki')!.stores.keys()].sort()).toEqual(['hosted', 'settings', 'tiddlers', 'wikis'])
  })

  it('upgrades an editor\'s version 1 storage and keeps its wikis, tiddlers and settings', async () => {
    version1(fake)
    const store = await freshStore()
    expect((await store.listWikis()).map((entry) => entry.title)).toEqual(['Kept'])
    expect(await store.getTiddlers('old')).toEqual([{ title: 'Home', text: 'hello' }])
    expect(await store.getSetting('nodeKey', null)).toBe('ab'.repeat(32))
    expect(fake.databases.get('decentrawiki')?.version).toBe(2)
    expect([...fake.databases.get('decentrawiki')!.stores.keys()].sort()).toEqual(['hosted', 'settings', 'tiddlers', 'wikis'])
    expect(await store.listHosted()).toEqual([])
    await store.updateWiki('old', (current) => ({ ...current, title: 'Still edited' }))
    expect((await store.getWiki('old'))?.title).toBe('Still edited')
  })

  it('keeps a wiki\'s newest version to host in place of the one before, one row for each wiki', async () => {
    const store = await freshStore()
    const car = new Blob([new Uint8Array([1, 2, 3])])
    await store.putHosted({ wiki: 'a', cid: 'bafyone', car, at: 1 })
    await store.putHosted({ wiki: 'b', cid: 'bafyother', car, at: 2 })
    await store.putHosted({ wiki: 'a', cid: 'bafytwo', car, at: 3 })
    expect((await store.getHosted('a'))?.cid).toBe('bafytwo')
    expect((await store.getHosted('a'))?.car).toBeInstanceOf(Blob)
    expect(await store.getHosted('missing')).toBeUndefined()
    expect((await store.listHosted()).map((row) => row.cid).sort()).toEqual(['bafyother', 'bafytwo'])
  })

  it('deletes a wiki\'s hosted version with the wiki and its tiddlers, and no other wiki\'s', async () => {
    const store = await freshStore()
    const car = new Blob([new Uint8Array([1])])
    for (const id of ['a', 'b']) {
      await store.putWiki(wiki(id) as never)
      await store.putTiddlers(id, [{ title: 'Home', text: id }])
      await store.putHosted({ wiki: id, cid: `bafy${id}`, car, at: 1 })
    }
    await store.deleteWiki('a')
    expect(await store.getWiki('a')).toBeUndefined()
    expect(await store.getTiddlers('a')).toEqual([])
    expect(await store.getHosted('a')).toBeUndefined()
    expect((await store.getWiki('b'))?.title).toBe('b')
    expect(await store.getTiddlers('b')).toHaveLength(1)
    expect((await store.getHosted('b'))?.cid).toBe('bafyb')
  })

  it('leaves the hosted versions out of a backup', async () => {
    const store = await freshStore()
    const { backup } = await import('../page/src/wikis.js')
    await store.putWiki(wiki('a') as never)
    await store.putTiddlers('a', [{ title: 'Home', text: 'hello' }])
    await store.putHosted({ wiki: 'a', cid: 'bafya', car: new Blob([new Uint8Array(1000)]), at: 1 })
    const text = await backup()
    const parsed = JSON.parse(text)
    expect(parsed.wikis).toHaveLength(1)
    expect(Object.keys(parsed.wikis[0]).sort()).toEqual(['tiddlers', 'wiki'])
    expect(text).not.toContain('"car"')
    expect(text).not.toContain('"hosted"')
  })
})
