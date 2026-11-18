// pkc-js keeps its caches (the name-resolution cache, the evm-contract challenge's wallet cache) in SQLite, one connection per
// cache name. These tests run pkc-js's own cache code, cut out of the chunk the Worker is built from, over Orivon's shim SQLite
// (the one the Worker uses) on an in-memory file layer: with every cache on one file the shim fails as the Worker did, and with
// the build's patch, a file for each cache name, it does not. They need the Orivon checkout the build takes the shim from
// (`ORIVON_MVP_ROOT`, else the one beside this repository) and are skipped when it is not there.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path, { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { mvpRootOf } from '../../../../src/build/esbuild-kit.mjs'
import { lruStorageFiles } from '../../build/gap-lru-storage.mjs'

const CHUNKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@pkcprotocol', 'pkc-js', 'dist', 'bundled', 'chunks')
const NAMES = 'pkcjs_lrustorage_nameResolutions'
const WALLETS = 'challenge_evm_contract_call_v1_wallet_last_timestamp'
const DATA = '/orivon/app/data'
const START = '//#region dist/node/runtime/node/sqlite-lru-cache.js'
const END = '//#region dist/node/publications/comment-moderation/comment-moderation.js'

const chunkName = readdirSync(CHUNKS).find((name) => /^node-[\w-]+\.js$/.test(name)) ?? ''
const chunkPath = join(CHUNKS, chunkName)

interface Cache { getItem: (key: string) => Promise<unknown>, setItem: (key: string, value: unknown) => Promise<unknown>, init: () => Promise<void>, destroy: () => Promise<void> }
type CacheClass = new (options: { cacheName: string, maxItems: number, pkc: { dataPath: string } }) => Cache
interface Database { prepare: (sql: string) => { pluck: () => { get: () => unknown } }, pragma: (sql: string) => unknown, close: () => void }
interface MemoryFs { install: () => void, uninstall: () => void, files: Map<string, unknown> }

/** pkc-js's cache classes as the chunk holds them (region sqlite-lru-cache and lru-storage), with the three helpers the chunk imports faked. */
function cacheClassOf (chunk: string, Database: unknown): CacheClass {
  const start = chunk.indexOf(START)
  const end = chunk.indexOf(END, start)
  if (start === -1 || end === -1) throw new Error('the cache regions are not in the chunk')
  const fakes = {
    // `cbor` and `debounce` are bundled in the chunk; a JSON body and a call that runs at once are all these tests need of them.
    require_cbor: () => ({ encode: (value: unknown) => Buffer.from(JSON.stringify(value)), decode: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()) }),
    require_debounce: () => (call: () => unknown) => call,
    __toESM: (module: unknown) => ({ default: module }),
    e: (value: unknown) => typeof value === 'object' && value !== null
  }
  const body = `${chunk.slice(start, end)}\nreturn LRUStorage`
  return new Function('Database', 'path', ...Object.keys(fakes), body)(Database, path, ...Object.values(fakes)) as CacheClass
}

const shimRoot = mvpRootOf()
const shimSource = join(shimRoot, 'src', 'shim', 'sqlite')
const available = existsSync(join(shimSource, 'better-sqlite3.ts')) && existsSync(join(shimSource, 'tests', 'support', 'memory-sync-fs.ts'))

describe('the LRU storage patch', () => {
  it('finds its one anchor in the installed chunk, and each cache name then has its own file', async () => {
    expect(lruStorageFiles.file.test(chunkPath)).toBe(true)
    const text = await readFile(chunkPath, 'utf8')
    const patched = lruStorageFiles.apply(text, chunkPath)
    expect(patched).not.toContain('path.join(this._opts.pkc.dataPath, "lru-storage")')
    expect(patched).toContain('"lru-storage-" + String(this._opts.cacheName)')
    expect(patched.length).toBeGreaterThan(text.length)
    expect(patched.split('"lru-storage-"').length).toBe(2)
  })

  it('applies to no other chunk of pkc-js, and the chunk it applies to is the only one named node-*', () => {
    expect(readdirSync(CHUNKS).filter((name) => lruStorageFiles.file.test(join(CHUNKS, name)))).toEqual([chunkName])
  })

  it('refuses a chunk with no anchor, and one with the anchor twice', () => {
    const anchor = 'path.join(this._opts.pkc.dataPath, "lru-storage")'
    expect(() => lruStorageFiles.apply('//#region elsewhere\n', chunkPath)).toThrow(/text not found/)
    expect(() => lruStorageFiles.apply(`${anchor}\n${anchor}`, chunkPath)).toThrow(/more than once/)
    expect(lruStorageFiles.apply(anchor, chunkPath)).toContain('"lru-storage-"')
  })
})

describe.skipIf(!available)('two caches over the shim\'s SQLite', () => {
  let Database: new (file: string, options?: object) => Database
  let createMemorySyncFs: () => MemoryFs
  let chunk: string

  beforeAll(async () => {
    const load = (file: string): Promise<Record<string, any>> => import(/* @vite-ignore */ pathToFileURL(join(shimSource, file)).href)
    const [engine, adapter, memory] = await Promise.all([load('engine.ts'), load('better-sqlite3.ts'), load('tests/support/memory-sync-fs.ts')])
    await engine['loadSqliteEngine']({ wasmBinary: readFileSync(createRequire(join(shimRoot, 'package.json')).resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm')) })
    Database = adapter['default']
    createMemorySyncFs = memory['createMemorySyncFs']
    chunk = await readFile(chunkPath, 'utf8')
  })

  /** What the Worker does: the name cache is used first, the wallet cache comes after it, and both stay open. Returns each failure. */
  async function useBoth (LRUStorage: CacheClass): Promise<{ failures: string[], reopened: Record<string, unknown>, files: string[] }> {
    const fs = createMemorySyncFs()
    fs.install()
    try {
      const pkc = { dataPath: DATA }
      const failures: string[] = []
      const attempt = async (what: string, call: () => Promise<unknown>): Promise<unknown> => {
        try { return await call() } catch (error) { failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`); return undefined }
      }
      const names = new LRUStorage({ cacheName: NAMES, maxItems: 5000, pkc })
      await names.init()
      for (let index = 0; index < 20; index++) await names.setItem(`name-${String(index)}`, { index, publicKey: 'k'.repeat(52) })
      const wallets = new LRUStorage({ cacheName: WALLETS, maxItems: Number.MAX_SAFE_INTEGER, pkc })
      await wallets.init()
      await wallets.setItem('eth0xabc', 1700000000)
      for (let index = 20; index < 40; index++) await attempt(`names set ${String(index)}`, () => names.setItem(`name-${String(index)}`, { index, publicKey: 'k'.repeat(52) }))
      await attempt('wallets set', () => wallets.setItem('eth0xdef', 1700000001))
      await attempt('names destroy', () => names.destroy())
      await attempt('wallets destroy', () => wallets.destroy())
      // The node starts again: both caches are opened whole, as the next run of the Worker does, and read.
      const reopened: Record<string, unknown> = {}
      const names2 = new LRUStorage({ cacheName: NAMES, maxItems: 5000, pkc })
      await names2.init()
      const wallets2 = new LRUStorage({ cacheName: WALLETS, maxItems: Number.MAX_SAFE_INTEGER, pkc })
      await wallets2.init()
      reopened['name-0'] = await attempt('names get 0', () => names2.getItem('name-0'))
      reopened['name-39'] = await attempt('names get 39', () => names2.getItem('name-39'))
      reopened['eth0xabc'] = await attempt('wallets get 1', () => wallets2.getItem('eth0xabc'))
      reopened['eth0xdef'] = await attempt('wallets get 2', () => wallets2.getItem('eth0xdef'))
      await names2.destroy()
      await wallets2.destroy()
      const files = [...fs.files.keys()].sort()
      for (const file of files.filter((one) => one.includes('lru-storage'))) {
        const db = new Database(`/orivon/app/${file}`)
        try { reopened[`integrity ${file.split('/').pop() ?? file}`] = db.pragma('integrity_check') } finally { db.close() }
      }
      return { failures, reopened, files }
    } finally {
      fs.uninstall()
    }
  }

  it('control: with both caches on one file the shim fails as the Worker did', async () => {
    // When this stops failing the shim holds a second connection to a file: delete build/gap-lru-storage.mjs and this file.
    const unpatched = await useBoth(cacheClassOf(chunk, Database))
    expect(unpatched.files).toContain('data/lru-storage')
    expect(unpatched.failures.length).toBeGreaterThan(0)
    expect(unpatched.failures.some((line) => /database disk image is malformed/.test(line))).toBe(true)
  })

  it('with a file for each cache name both write and read, and reopen whole', async () => {
    const patched = await useBoth(cacheClassOf(lruStorageFiles.apply(chunk, chunkPath), Database))
    expect(patched.failures).toEqual([])
    expect(patched.files.filter((file) => file.includes('lru-storage'))).toEqual([
      `data/lru-storage-${WALLETS}`,
      `data/lru-storage-${NAMES}`
    ].sort())
    expect(patched.reopened['name-0']).toEqual({ index: 0, publicKey: 'k'.repeat(52) })
    expect(patched.reopened['name-39']).toEqual({ index: 39, publicKey: 'k'.repeat(52) })
    expect(patched.reopened['eth0xabc']).toBe(1700000000)
    expect(patched.reopened['eth0xdef']).toBe(1700000001)
    for (const [key, value] of Object.entries(patched.reopened)) if (key.startsWith('integrity ')) expect(value).toEqual([{ integrity_check: 'ok' }])
    expect(Object.keys(patched.reopened).filter((key) => key.startsWith('integrity '))).toHaveLength(2)
  })

  it('an old lru-storage file is left alone and never opened', async () => {
    const fs = createMemorySyncFs()
    fs.install()
    try {
      const old = new Database(`${DATA}/lru-storage`)
      old.pragma('user_version = 9')
      old.close()
      const before = [...fs.files.entries()].map(([name, file]) => [name, (file as { length: number }).length])
      const LRUStorage = cacheClassOf(lruStorageFiles.apply(chunk, chunkPath), Database)
      const cache = new LRUStorage({ cacheName: NAMES, maxItems: 5000, pkc: { dataPath: DATA } })
      await cache.init()
      await cache.setItem('a', 1)
      expect(await cache.getItem('a')).toBe(1)
      await cache.destroy()
      const lengthOf = (name: string): number => (fs.files.get(name) as { length: number } | undefined)?.length ?? -1
      for (const [name, length] of before) expect(lengthOf(name as string)).toBe(length)
      expect([...fs.files.keys()]).toContain(`data/lru-storage-${NAMES}`)
    } finally {
      fs.uninstall()
    }
  })
})
