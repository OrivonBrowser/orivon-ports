import { afterEach, describe, expect, it, vi } from 'vitest'

// main.js with everything it draws and stores stubbed, so that what is under test is when it asks hosting to resume.
const seen = vi.hoisted(() => ({
  resume: 0,
  rendered: 0,
  actions: undefined as undefined | { importWiki: () => void },
  importOptions: [] as Array<{ onOpen: (id: string | null) => void }>
}))
vi.mock('../page/src/dom.js', () => ({ h: () => ({}), icon: () => ({}), logo: () => ({}), replace: () => {} }))
vi.mock('../page/src/format.js', () => ({ displayAddress: (address: string) => address }))
vi.mock('../page/src/import.js', () => ({ ImportError: class extends Error {}, normaliseFields: () => null, prepareImport: () => ({}) }))
vi.mock('../page/src/publish/hosting.js', () => ({ hosting: { resume: async () => { seen.resume++ } } }))
vi.mock('../page/src/receive.js', () => ({ receive: async () => ({}) }))
vi.mock('../page/src/store.js', () => ({ getWiki: async () => undefined }))
vi.mock('../page/src/wikis.js', () => ({ createWiki: async () => ({}) }))
vi.mock('../page/src/workspace.js', () => ({ Workspace: class {} }))
vi.mock('../page/src/ui/dialog.js', () => ({ openDialog: () => ({}), toast: () => {} }))
vi.mock('../page/src/ui/confirm-import.js', () => ({ confirmImport: async () => null }))
vi.mock('../page/src/ui/import-dialog.js', () => ({ openImportDialog: (options: { onOpen: (id: string | null) => void }) => { seen.importOptions.push(options) } }))
vi.mock('../page/src/ui/publish-dialog.js', () => ({ openPublishDialog: async () => {} }))
vi.mock('../page/src/ui/publications.js', () => ({ openPublications: () => {} }))
vi.mock('../page/src/views/library.js', () => ({ renderLibrary: async (_view: unknown, actions: { importWiki: () => void }) => { seen.actions = actions; seen.rendered++ } }))
vi.mock('../page/src/views/settings.js', () => ({ renderSettings: async () => {} }))

afterEach(() => { vi.unstubAllGlobals() })

describe('when the editor asks hosting to hand the stored wikis to the node again', () => {
  it('does so once, when the page loads, and not each time the page it is on is opened again', async () => {
    vi.stubGlobal('document', { getElementById: () => ({}), title: '' })
    vi.stubGlobal('window', { addEventListener: () => {} })
    vi.stubGlobal('location', { hash: '#/' })
    await import('../page/src/main.js')
    await vi.waitFor(() => { expect(seen.resume).toBe(1) })
    expect(seen.rendered).toBe(1)

    seen.actions!.importWiki()
    seen.importOptions[0]!.onOpen(null)
    await vi.waitFor(() => { expect(seen.rendered).toBe(2) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen.resume).toBe(1)
  })
})
