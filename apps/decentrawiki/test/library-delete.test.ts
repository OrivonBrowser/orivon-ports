import { afterEach, describe, expect, it, vi } from 'vitest'

// The library with everything it draws and stores stubbed, so that what is under test is what a confirmed delete waits for.
const seen = vi.hoisted(() => ({
  order: [] as string[],
  clicks: [] as Array<() => void>,
  items: [] as Array<{ label: string, onSelect: () => Promise<void> }>,
  toasts: [] as string[],
  listed: 0,
  forget: undefined as undefined | ((wikiId: string, version?: string) => Promise<void>)
}))
vi.mock('../page/src/dom.js', () => ({
  h: () => ({ addEventListener: (type: string, listener: () => void) => { if (type === 'click') seen.clicks.push(listener) } }),
  icon: () => ({}),
  logo: () => ({}),
  replace: () => {}
}))
vi.mock('../page/src/format.js', () => ({ displayAddress: (a: string) => a, fileNameFor: (t: string) => t, formatAgo: () => 'now', shortCid: (c: string) => c }))
vi.mock('../page/src/ui/dialog.js', () => ({ confirmDialog: async () => true, downloadFile: () => {}, toast: (text: string) => { seen.toasts.push(text) } }))
vi.mock('../page/src/ui/menu.js', () => ({ openMenu: (_anchor: unknown, items: typeof seen.items) => { seen.items = items } }))
vi.mock('../page/src/wikis.js', () => ({ backup: async () => '' }))
vi.mock('../page/src/store.js', () => ({
  listWikis: async () => { seen.listed++; return [{ id: 'w', title: 'W', publications: [{ cid: 'bafy', at: 1 }], source: { kind: 'new' }, updatedAt: 1 }] },
  deleteWiki: async () => { seen.order.push('deleteWiki') }
}))
vi.mock('../page/src/publish/hosting.js', () => ({
  hosting: {
    hostedVersion: async () => { seen.order.push('hostedVersion'); return 'bafy' },
    forget: (wikiId: string, version?: string) => { seen.order.push(`forget ${wikiId} ${version}`); return seen.forget!(wikiId, version) }
  }
}))

const { renderLibrary } = await import('../page/src/views/library.js')

afterEach(() => { seen.order.length = 0; seen.toasts.length = 0; seen.clicks.length = 0; seen.listed = 0 })

describe('deleting a wiki from the library', () => {
  it('deletes it and says so without waiting for the node, which can be a minute from answering', async () => {
    seen.forget = () => new Promise<void>(() => {})
    await renderLibrary({} as never, {} as never)
    seen.clicks[0]!()
    const remove = seen.items.find((item) => item.label === 'Delete')!
    const outcome = await Promise.race([remove.onSelect().then(() => 'done'), new Promise((resolve) => setTimeout(() => resolve('stuck'), 100))])
    expect(outcome).toBe('done')
    expect(seen.order).toEqual(['hostedVersion', 'deleteWiki', 'forget w bafy'])
    expect(seen.toasts).toEqual(['“W” was deleted'])
    expect(seen.listed).toBe(2)
  })
})
