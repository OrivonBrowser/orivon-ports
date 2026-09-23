// The pickle key: apps/web/src/BasePlatform.ts and utils/tokens/pickling.ts,
// reproduced so upstream's own sw.js -- which this port never edits and
// never forks -- can decrypt the access token it stores in the SAME
// IndexedDB database. ../README.md's "Differs from Element Desktop" section
// is the design note this file backs: the key sits in the app's own
// IndexedDB, as it does for Element Web, not in an OS keyring.
import { describe, expect, it } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import { fakeIndexedDb } from './test-helpers.ts'

const source = await bridgeSourceFor('element')

interface Pickling {
  getPickleKey: (userId: string, deviceId: string) => Promise<string | null>
  createPickleKey: (userId: string, deviceId: string) => Promise<string | null>
  destroyPickleKey: (userId: string, deviceId: string) => Promise<void>
  pickleAdditionalData: (userId: string, deviceId: string) => Uint8Array
}

interface FakeIDBRequest { result: unknown, onsuccess: (() => void) | null }
interface FakeIDBFactory { open: (name: string, version: number) => FakeIDBRequest }
interface FakeDatabase { transaction: (names: readonly string[]) => { objectStore: (name: string) => { get: (key: unknown) => FakeIDBRequest } } }

function load (extra: Record<string, unknown> = {}): { pickling: Pickling } {
  const { internals } = runBridge(source, { globals: { crypto: globalThis.crypto, btoa: globalThis.btoa, indexedDB: fakeIndexedDb(), ...extra } })
  return { pickling: internals.app['pickling'] as Pickling }
}

async function openDb (idb: FakeIDBFactory): Promise<FakeDatabase> {
  return await new Promise((resolve) => {
    const request = idb.open('matrix-react-sdk', 1)
    request.onsuccess = () => resolve(request.result as FakeDatabase)
  })
}

// `crypto.subtle`'s own type (from @types/node's webcrypto, since this
// project's lib carries no DOM) is what actually types the `decrypt` call
// below -- this alias just names the shape a stored record carries.
type StoredCryptoKey = Parameters<typeof crypto.subtle.decrypt>[1]

async function rawRecord (idb: FakeIDBFactory, store: string, key: readonly [string, string]): Promise<{ encrypted: ArrayBuffer, iv: Uint8Array, cryptoKey: StoredCryptoKey }> {
  const db = await openDb(idb)
  return await new Promise((resolve) => {
    const request = db.transaction([store]).objectStore(store).get(key)
    request.onsuccess = () => resolve(request.result as { encrypted: ArrayBuffer, iv: Uint8Array, cryptoKey: StoredCryptoKey })
  })
}

const USER = '@alice:example.org'
const DEVICE = 'DEVICE1'

describe('pickle key', () => {
  it('creates a 32-byte key as unpadded base64', async () => {
    const { pickling } = load()
    const key = await pickling.createPickleKey(USER, DEVICE)
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}$/)
  })

  it('get after create returns the same key', async () => {
    const { pickling } = load()
    const created = await pickling.createPickleKey(USER, DEVICE)
    await expect(pickling.getPickleKey(USER, DEVICE)).resolves.toBe(created)
  })

  it('is readable by apps/web/src/utils/tokens/pickling.ts\'s own decrypt steps -- the same ones upstream\'s sw.js runs on the access token', async () => {
    const idb = fakeIndexedDb()
    const { pickling } = load({ indexedDB: idb })
    const created = await pickling.createPickleKey(USER, DEVICE)

    const record = await rawRecord(idb, 'pickleKey', [USER, DEVICE])
    const additionalData = pickling.pickleAdditionalData(USER, DEVICE)
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData }, record.cryptoKey, record.encrypted)
    const replayed = Buffer.from(decrypted).toString('base64').replace(/=+$/, '')
    expect(replayed).toBe(created)
  })

  it('returns null for a key nobody created, and for the wrong device', async () => {
    const { pickling } = load()
    await expect(pickling.getPickleKey(USER, DEVICE)).resolves.toBeNull()
    await pickling.createPickleKey(USER, DEVICE)
    await expect(pickling.getPickleKey(USER, 'OTHER-DEVICE')).resolves.toBeNull()
  })

  it('destroy removes the key: a get afterwards is null, and destroying twice does not throw', async () => {
    const { pickling } = load()
    await pickling.createPickleKey(USER, DEVICE)
    await pickling.destroyPickleKey(USER, DEVICE)
    await expect(pickling.getPickleKey(USER, DEVICE)).resolves.toBeNull()
    await expect(pickling.destroyPickleKey(USER, DEVICE)).resolves.toBeUndefined()
  })

  it('creates both the pickleKey and account object stores, as StorageAccess.ts does', async () => {
    const idb = fakeIndexedDb()
    const { pickling } = load({ indexedDB: idb })
    await pickling.createPickleKey(USER, DEVICE)
    const db = await openDb(idb)
    expect(() => db.transaction(['account']).objectStore('account')).not.toThrow()
  })

  it('returns null, never throws, with no IndexedDB available', async () => {
    const { internals } = runBridge(source, { globals: { crypto: globalThis.crypto } })
    const pickling = internals.app['pickling'] as Pickling
    await expect(pickling.createPickleKey(USER, DEVICE)).resolves.toBeNull()
    await expect(pickling.getPickleKey(USER, DEVICE)).resolves.toBeNull()
  })

  it('returns null, never throws, with no crypto.subtle available', async () => {
    const { internals } = runBridge(source, { globals: { indexedDB: fakeIndexedDb(), crypto: {} } })
    const pickling = internals.app['pickling'] as Pickling
    await expect(pickling.createPickleKey(USER, DEVICE)).resolves.toBeNull()
  })
})
