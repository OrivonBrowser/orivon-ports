import { describe, expect, it } from 'vitest'
import { createStore, MAX_REMEMBERED } from '../site/store.js'
import { ACCOUNT, RIVAL } from './support/linagee-world.ts'

function memory () {
  const data = new Map<string, string>()
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}

describe('the names this device remembers', () => {
  it('keeps the names of each account apart, in the order they were added, each once', () => {
    const store = createStore(memory())
    store.remember(ACCOUNT, 'harbor')
    store.remember(ACCOUNT, 'lantern')
    store.remember(ACCOUNT, 'harbor')
    store.remember(RIVAL, 'other')
    expect(store.names(ACCOUNT)).toEqual(['harbor', 'lantern'])
    expect(store.names(RIVAL)).toEqual(['other'])
    expect(store.names(ACCOUNT.toLowerCase())).toEqual(['harbor', 'lantern'])
  })

  it('forgets a name, and survives a new store over the same storage', () => {
    const storage = memory()
    const first = createStore(storage)
    first.remember(ACCOUNT, 'harbor')
    first.remember(ACCOUNT, 'lantern')
    first.forget(ACCOUNT, 'harbor')
    expect(createStore(storage).names(ACCOUNT)).toEqual(['lantern'])
  })

  it('keeps only names the name rule accepts, and nothing for an address that is not one', () => {
    const store = createStore(memory())
    store.remember(ACCOUNT, 'Harbor')
    store.remember(ACCOUNT, 'a.b')
    store.remember(ACCOUNT, '')
    store.remember('not an address', 'harbor')
    expect(store.names(ACCOUNT)).toEqual([])
    expect(store.names('not an address')).toEqual([])
  })

  it('ignores what the storage holds when it is not a list of names', () => {
    const storage = memory()
    storage.data.set(`og-names:${ACCOUNT.toLowerCase()}`, '{"x":1}')
    expect(createStore(storage).names(ACCOUNT)).toEqual([])
    storage.data.set(`og-names:${ACCOUNT.toLowerCase()}`, 'not json')
    expect(createStore(storage).names(ACCOUNT)).toEqual([])
    storage.data.set(`og-names:${ACCOUNT.toLowerCase()}`, JSON.stringify(['harbor', 5, 'Bad', 'harbor']))
    expect(createStore(storage).names(ACCOUNT)).toEqual(['harbor'])
  })

  it('keeps no more than it is limited to, the newest', () => {
    const store = createStore(memory())
    for (let index = 0; index < MAX_REMEMBERED + 5; index++) store.remember(ACCOUNT, `n${index}`)
    const names = store.names(ACCOUNT)
    expect(names).toHaveLength(MAX_REMEMBERED)
    expect(names.at(-1)).toBe(`n${MAX_REMEMBERED + 4}`)
  })

  it('works for the page\'s life when the storage is blocked or absent', () => {
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    for (const store of [createStore(blocked), createStore(null)]) {
      store.remember(ACCOUNT, 'harbor')
      expect(store.names(ACCOUNT)).toEqual(['harbor'])
      store.rememberId('alice')
      expect(store.idNames()).toEqual(['alice'])
    }
  })

  it('remembers Orivon ID usernames the ID rules accept', () => {
    const store = createStore(memory())
    store.rememberId('alice')
    store.rememberId('Alice')
    store.rememberId('a')
    store.rememberId('alice')
    store.rememberId('bob-1')
    expect(store.idNames()).toEqual(['alice', 'bob-1'])
  })
})
