// What the page tells the node it follows: the active account's subscriptions read from the app's own IndexedDB, sent when they change,
// and nothing where there is no account or no database (which is never created).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNTS_DATABASE, METADATA_DATABASE, readFollowed, startFollowSync } from '../../page/follow-sync.js'

/** An IndexedDB with these localforage databases: `{ name: { key: value } }`; a database that is not listed is created by opening it. */
function fakeIndexedDB (databases: Record<string, Record<string, unknown> | 'no-store'>) {
  type IDBFactory = Parameters<typeof readFollowed>[0] & object
  const created: string[] = []
  const factory = {
    open (name: string) {
      const request: Record<string, any> = { error: null, transaction: null }
      queueMicrotask(() => {
        const found = databases[name]
        if (found === undefined) {
          created.push(name)
          request.transaction = { abort () { request.error = { name: 'AbortError' }; queueMicrotask(() => request.onerror?.()) } }
          request.onupgradeneeded?.()
          return
        }
        request.result = {
          objectStoreNames: { contains: () => found !== 'no-store' },
          close () {},
          transaction: () => ({ objectStore: () => ({ get (key: string) { const asked: Record<string, any> = {}; queueMicrotask(() => { asked.result = found === 'no-store' ? undefined : found[key]; asked.onsuccess?.() }); return asked } }) })
        }
        request.onsuccess?.()
      })
      return request
    }
  }
  return { factory: factory as unknown as IDBFactory, created }
}

const account = (subscriptions: unknown) => fakeIndexedDB({ [METADATA_DATABASE]: { activeAccountId: 'acc-1' }, [ACCOUNTS_DATABASE]: { 'acc-1': { id: 'acc-1', subscriptions }, 'acc-2': { subscriptions: ['other.bso'] } } })

describe('reading what the active account follows', () => {
  it('is the subscriptions of the account the metadata names, and only the text in them', async () => {
    expect(await readFollowed(account(['a.bso', 'b.eth', 42, null]).factory)).toEqual(['a.bso', 'b.eth'])
    expect(await readFollowed(account([]).factory)).toEqual([])
  })

  it('is an empty list for an account that has no subscriptions field, and null for one that is not an account', async () => {
    expect(await readFollowed(account(undefined).factory)).toEqual([])
    expect(await readFollowed(fakeIndexedDB({ [METADATA_DATABASE]: { activeAccountId: 'gone' }, [ACCOUNTS_DATABASE]: {} }).factory)).toBeNull()
  })

  it('is null, and creates nothing, where the app has no account database yet', async () => {
    const none = fakeIndexedDB({})
    expect(await readFollowed(none.factory)).toBeNull()
    const noStore = fakeIndexedDB({ [METADATA_DATABASE]: 'no-store' })
    expect(await readFollowed(noStore.factory)).toBeNull()
    expect(await readFollowed(undefined)).toBeNull()
  })

  it('is null when the metadata names no account', async () => {
    expect(await readFollowed(fakeIndexedDB({ [METADATA_DATABASE]: { activeAccountId: 7 }, [ACCOUNTS_DATABASE]: {} }).factory)).toBeNull()
  })
})

describe('sending it to the node', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) })
  afterEach(() => { vi.useRealTimers() })
  const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }

  it('sends the list at once and again only when it changes, whatever its order', async () => {
    const sent: unknown[] = []
    let list: string[] | null = ['b.bso', 'a.bso']
    const stop = startFollowSync({ seeding: async (_call: string, body: Record<string, unknown>) => { sent.push(body['addresses']) } }, { read: async () => list, everyMs: 1_000 })
    await tick()
    vi.advanceTimersByTime(1_000)
    await tick()
    expect(sent).toEqual([['b.bso', 'a.bso']])
    list = ['a.bso', 'b.bso']
    vi.advanceTimersByTime(1_000)
    await tick()
    expect(sent).toHaveLength(1)
    list = ['a.bso', 'c.bso']
    vi.advanceTimersByTime(1_000)
    await tick()
    expect(sent).toEqual([['b.bso', 'a.bso'], ['a.bso', 'c.bso']])
    stop()
  })

  it('sends nothing for a list that could not be read, tries again when the node did not take it, and stops when told to', async () => {
    const sent: unknown[] = []
    let up = false
    let list: string[] | null = null
    const handle = { seeding: async (_call: string, body: Record<string, unknown>) => { if (!up) throw new Error('not yet'); sent.push(body['addresses']) } }
    const stop = startFollowSync(handle, { read: async () => list, everyMs: 1_000 })
    await tick()
    expect(sent).toEqual([])
    list = ['a.bso']
    vi.advanceTimersByTime(1_000)
    await tick()
    expect(sent).toEqual([])
    up = true
    vi.advanceTimersByTime(1_000)
    await tick()
    expect(sent).toEqual([['a.bso']])
    stop()
    list = ['z.bso']
    vi.advanceTimersByTime(5_000)
    await tick()
    expect(sent).toHaveLength(1)
  })

  it('does nothing for a handle that has no seeding calls', () => {
    const stop = startFollowSync({}, { read: async () => ['a.bso'] })
    expect(stop()).toBeUndefined()
  })
})
