import { describe, expect, it } from 'vitest'
import { readCar } from '../page/src/ipfs/car.js'
import { cidFor } from '../page/src/ipfs/cid.js'
import { importTree } from '../page/src/ipfs/unixfs.js'
import { idbBackend, memoryBackend, openBackend, opfsBackend } from '../page/src/keep/backends.js'
import type { Backend } from '../page/src/keep/backends.js'
import { createKeep } from '../page/src/keep/store.js'

const text = new TextEncoder()

function pattern (size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7 + (i >>> 18)) & 255
  return bytes
}

/** The origin's private file system, in memory: the calls the backend makes. */
function fakeDirectory () {
  const files = new Map<string, Blob>()
  const notFound = () => new DOMException('not found', 'NotFoundError')
  const dir = {
    files,
    async getDirectoryHandle () { return dir },
    async getFileHandle (name: string, options: { create?: boolean } = {}) {
      if (!files.has(name)) {
        if (options.create !== true) throw notFound()
        files.set(name, new Blob([]))
      }
      return {
        async getFile () { return new File([files.get(name)!], name) },
        async createWritable () {
          const parts: BlobPart[] = []
          return {
            async write (data: BlobPart) { parts.push(typeof data === 'string' ? data : (data as Uint8Array).slice()) },
            async close () { files.set(name, new Blob(parts)) },
            async abort () {}
          }
        }
      }
    },
    async removeEntry (name: string) { if (!files.delete(name)) throw notFound() },
    async * keys () { yield * files.keys() }
  }
  return dir
}

/** IndexedDB, in memory: stores of records by key path, the calls the backend makes, and key ranges. */
function fakeIndexedDB () {
  const databases = new Map<string, Map<string, { keyPath: string | string[], rows: Map<string, unknown> }>>()
  const keyOf = (path: string | string[], row: any) => JSON.stringify(Array.isArray(path) ? path.map((p) => row[p]) : row[path])
  const compare = (a: unknown[], b: unknown[]): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number) ? -1 : 1
    return a.length - b.length
  }
  const request = <T>(work: () => T) => {
    const r: { result?: T, error?: unknown, onsuccess?: () => void, onerror?: () => void } = {}
    setTimeout(() => { r.result = work(); r.onsuccess?.() }, 0)
    return r
  }
  const factory = {
    open (name: string) {
      const r: any = {}
      setTimeout(() => {
        const existing = databases.get(name)
        const stores = existing ?? new Map()
        const db = {
          createObjectStore (store: string, { keyPath }: { keyPath: string | string[] }) { stores.set(store, { keyPath, rows: new Map() }) },
          transaction (store: string) {
            const target = stores.get(store)!
            const tx: any = {
              objectStore: () => ({
                put: (row: unknown) => request(() => { target.rows.set(keyOf(target.keyPath, row), structuredClone(row)); return undefined }),
                get: (key: unknown) => request(() => target.rows.get(JSON.stringify(key))),
                getAll: (range?: { lower: unknown[], upper: unknown[] }) => request(() => [...target.rows].map(([k, v]) => [JSON.parse(k), v] as const)
                  .filter(([k]) => range === undefined || (compare(k as unknown[], range.lower) >= 0 && compare(k as unknown[], range.upper) <= 0))
                  .sort((a, b) => compare(a[0] as unknown[], b[0] as unknown[])).map(([, v]) => v)),
                delete: (key: unknown) => request(() => {
                  const range = key as { lower?: unknown[], upper?: unknown[] }
                  if (Array.isArray(key)) target.rows.delete(JSON.stringify(key))
                  else for (const k of [...target.rows.keys()]) if (compare(JSON.parse(k), range.lower!) >= 0 && compare(JSON.parse(k), range.upper!) <= 0) target.rows.delete(k)
                  return undefined
                })
              })
            }
            setTimeout(() => tx.oncomplete?.(), 3)
            return tx
          }
        }
        r.result = db
        if (existing === undefined) { databases.set(name, stores); r.onupgradeneeded?.() }
        r.onsuccess?.()
      }, 0)
      return r
    }
  }
  return factory
}

const backends: [string, () => Promise<Backend>][] = [
  ['memory', async () => memoryBackend()],
  ['OPFS', async () => await opfsBackend(fakeDirectory() as unknown as FileSystemDirectoryHandle)],
  ['IndexedDB', async () => {
    (globalThis as any).IDBKeyRange = { bound: (lower: unknown[], upper: unknown[]) => ({ lower, upper }) }
    return await idbBackend(fakeIndexedDB() as unknown as IDBFactory)
  }]
]

const files = () => [
  { path: 'a.txt', content: text.encode('hello') },
  { path: 'dir/big.bin', content: pattern(600_000) },
  { path: 'empty', content: new Uint8Array(0) }
]

describe.each(backends)('the kept shares in %s', (_name, make) => {
  async function kept () {
    const keep = createKeep(await make())
    const imported = await importTree(files(), () => {})
    const root = imported.cid
    const stored = await keep.add(root, { kind: 'files', encrypted: false, bytes: 600_005, files: 3, online: true }, async (sink) => { await importTree(files(), sink) })
    return { keep, root, stored, imported }
  }

  it('keeps every block once and describes the share', async () => {
    const { keep, root, stored, imported } = await kept()
    expect(stored).toMatchObject({ cid: root, kind: 'files', encrypted: false, bytes: 600_005, files: 3, online: true })
    expect(stored.blocks).toBeGreaterThan(4)
    expect(stored.stored).toBeGreaterThan(600_000)
    expect(await keep.meta(root)).toEqual(stored)
    expect((await keep.list()).map((m) => m.cid)).toContain(root)
    expect(await keep.usage()).toBeGreaterThanOrEqual(stored.stored)
  })

  it('refuses to keep a share whose root block was never made', async () => {
    const keep = createKeep(await make())
    await expect(keep.add('bafybeihmrsos2s6jext4jjcow7rsbfjjtr6pr3hrhscx74ccbimdonul6m', { kind: 'files', encrypted: false, bytes: 1, files: 1, online: false }, async (sink) => {
      await sink('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', new Uint8Array(0))
    })).rejects.toThrow('root block')
    expect(await keep.meta('bafybeihmrsos2s6jext4jjcow7rsbfjjtr6pr3hrhscx74ccbimdonul6m')).toBeNull()
  })

  it('gives a block of the share by CID, and nothing that is not in it', async () => {
    const { keep, root } = await kept()
    const hello = (await cidFor(0x55, text.encode('hello'))).string
    expect(await keep.has(root, root)).toBe(true)
    expect(await keep.has(root, hello)).toBe(true)
    expect(new TextDecoder().decode((await keep.block(root, hello))!)).toBe('hello')
    expect(await keep.has(root, 'bafkreigkgwdvr5wspzwpiutssn4xpj2i7wedshnwphhnu7ohx4pqaxxipe')).toBe(false)
    expect(await keep.block(root, 'bafkreigkgwdvr5wspzwpiutssn4xpj2i7wedshnwphhnu7ohx4pqaxxipe')).toBeNull()
    expect(await keep.block('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', hello)).toBeNull()
    expect(await (await keep.blob(root, hello))!.text()).toBe('hello')
  })

  it('exports the share as a CAR file that checks out, root first in its header', async () => {
    const { keep, root, stored } = await kept()
    const car = await keep.car(root)
    const blocks = await readCar(new Uint8Array(await car.arrayBuffer()), root)
    expect(blocks.size).toBe(stored.blocks)
    expect(blocks.has(root)).toBe(true)
  })

  it('gives its blocks in batches that each check out and stay under the limit', async () => {
    const { keep, root, stored } = await kept()
    const batches: Blob[] = []
    await keep.eachBatch(root, 300_000, async (batch) => { batches.push(batch) })
    expect(batches.length).toBeGreaterThanOrEqual(3)
    let total = 0
    for (const batch of batches) {
      expect(batch.size).toBeLessThanOrEqual(300_000)
      total += (await readCar(new Uint8Array(await batch.arrayBuffer()))).size
    }
    expect(total).toBe(stored.blocks)
  })

  it('remembers whether it is online, and forgets a share it is told to', async () => {
    const { keep, root } = await kept()
    await keep.setOnline(root, false)
    expect((await keep.meta(root))!.online).toBe(false)
    await expect(keep.setOnline((await cidFor(0x55, text.encode('hello'))).string, true)).rejects.toThrow('not kept')
    await keep.remove(root)
    expect(await keep.meta(root)).toBeNull()
    expect(await keep.block(root, root)).toBeNull()
    await expect(keep.car(root)).rejects.toThrow('not kept')
  })

  it('replaces a share kept again under the same address', async () => {
    const { keep, root } = await kept()
    const again = await keep.add(root, { kind: 'folder', encrypted: false, bytes: 600_005, files: 3, online: false }, async (sink) => { await importTree(files(), sink) })
    expect(again.kind).toBe('folder')
    expect((await keep.list()).filter((m) => m.cid === root)).toHaveLength(1)
  })
})

describe('openBackend', () => {
  it('uses the private file system when it takes a write, and IndexedDB, and memory, in that order', async () => {
    const dir = fakeDirectory()
    expect((await openBackend({ storage: { getDirectory: async () => dir } as unknown as StorageManager, indexedDB: undefined as unknown as IDBFactory })).kind).toBe('opfs')
    const refusing = { getDirectory: async () => { throw new Error('no') } } as unknown as StorageManager
    ;(globalThis as any).IDBKeyRange = { bound: (lower: unknown[], upper: unknown[]) => ({ lower, upper }) }
    expect((await openBackend({ storage: refusing, indexedDB: fakeIndexedDB() as unknown as IDBFactory })).kind).toBe('idb')
    expect((await openBackend({ storage: refusing })).kind).toBe('memory')
    expect((await openBackend({})).durable).toBe(false)
  })
})
