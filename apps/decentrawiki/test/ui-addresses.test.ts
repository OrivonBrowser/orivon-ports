import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeElement, installFakeDom, removeFakeDom, show } from './fake-dom.ts'

beforeAll(installFakeDom)
afterAll(removeFakeDom)

const mem = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  wikis: new Map<string, Record<string, unknown>>(),
  dialogs: [] as Array<{ title: string, body: unknown[], actions: Array<{ label: string, onClick?: () => unknown }>, busy: boolean, closed: boolean }>,
  confirmed: [] as Array<Record<string, unknown>>
}))

vi.mock('../page/src/store.js', () => ({
  getSetting: async (key: string, fallback: unknown) => mem.settings.has(key) ? structuredClone(mem.settings.get(key)) : fallback,
  setSetting: async (key: string, value: unknown) => { mem.settings.set(key, structuredClone(value)) },
  updateSetting: async (key: string, fallback: unknown, change: (current: unknown) => unknown) => {
    const next = change(mem.settings.has(key) ? structuredClone(mem.settings.get(key)) : fallback)
    mem.settings.set(key, structuredClone(next))
    return next
  },
  listWikis: async () => [...mem.wikis.values()].map((wiki) => structuredClone(wiki)),
  getWiki: async (id: string) => structuredClone(mem.wikis.get(id)),
  updateWiki: async (id: string, change: (wiki: Record<string, unknown>) => Record<string, unknown>) => {
    const current = mem.wikis.get(id)
    if (current === undefined) return undefined
    const next = change(structuredClone(current))
    mem.wikis.set(id, next)
    return structuredClone(next)
  }
}))

// The dialog is the browser's: here it only keeps what it was given, and a test presses its buttons.
vi.mock('../page/src/ui/dialog.js', () => ({
  openDialog: (options: { title: string, body?: unknown[], actions?: Array<{ label: string }> }) => {
    const state = { title: options.title, body: options.body ?? [], actions: options.actions ?? [], busy: false, closed: false } as (typeof mem.dialogs)[number]
    mem.dialogs.push(state)
    return {
      close () { state.closed = true },
      setBody (...nodes: unknown[]) { state.body = nodes },
      setActions (list: typeof state.actions) { state.actions = list },
      setBusy (busy: boolean) { state.busy = busy }
    }
  },
  toast: () => {},
  copyText: async () => {},
  downloadFile: () => {},
  confirmDialog: async () => true
}))

vi.mock('../page/src/version-fetch.js', async (original) => ({
  ...await original<typeof import('../page/src/version-fetch.js')>(),
  fetchVersion: async () => ({ tiddlers: [], prepared: { title: 'Fetched title', tiddlers: [], lineage: null }, gateway: 'https://ipfs.orbitor.dev' })
}))

vi.mock('../page/src/ui/confirm-import.js', async (original) => ({
  ...await original<typeof import('../page/src/ui/confirm-import.js')>(),
  confirmImport: async (input: Record<string, unknown>) => { mem.confirmed.push(input); return 'taken-in' }
}))

const CID = 'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am'

const names = await import('../page/src/names.js')
const { addressesPanel } = await import('../page/src/views/addresses.js')
const { openPublications } = await import('../page/src/ui/publications.js')
const { takeKey } = await import('../page/src/ui/import-key.js')
const { keyFileText } = await import('../page/src/name-files.js')

describe('the addresses in Settings, and the publications of a wiki', () => {
  const NOW = Date.now()
  const DAY = 86_400_000
  let sent: number

  beforeEach(() => {
    mem.settings.clear()
    mem.wikis.clear()
    mem.dialogs.length = 0
    sent = 0
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent++
      const { parseRecord } = await import('../page/src/ipfs/ipns.js')
      const record = parseRecord(init.body as Uint8Array)
      return Response.json({ Name: 'x', Value: record.value, Sequence: record.sequence, KeptUntil: new Date(NOW + 30 * DAY).toISOString() })
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  /** An address with a record signed now, taken by Orivon's node until `until` when given. */
  async function addressKeptUntil (label: string, until: number | null) {
    const entry = await names.makeName(label)
    const { sequence } = await names.signVersion(entry.name, { cid: CID, title: `${label} title`, now: NOW })
    if (until !== null) await names.markKept(entry.name, sequence, until)
    return entry
  }

  it('says what each address shows and what Orivon\'s node is doing for it', async () => {
    await names.makeName('Fresh')
    await addressKeptUntil('Kept', NOW + 20 * DAY)
    await addressKeptUntil('Lapsed', NOW - DAY)
    await addressKeptUntil('Pending', null)
    const panel = (await addressesPanel(() => {})) as unknown as FakeElement
    const text = panel.textContent
    expect(text).toContain('Not published yet')
    expect(text).toContain('Orivon keeps it up until')
    expect(text).toContain('Orivon stopped keeping it on')
    expect(text).toContain('Orivon\'s node has not taken the newest record yet')
    expect(text).toContain('shows “Kept title”')
    expect(text).toContain('shows “Fresh”')
    expect(panel.find('Publish the address again')).toHaveLength(2)
    expect(panel.find('Download the public record')).toHaveLength(3)
    expect(panel.find('Download the key')).toHaveLength(4)
    expect(panel.find('Import a key')).toHaveLength(1)
    expect(text).toContain('not the keys')
  })

  it('sends the saved record again and shows the day it is kept until', async () => {
    const pending = await addressKeptUntil('Pending', null)
    let refreshed = 0
    const panel = (await addressesPanel(() => { refreshed++ })) as unknown as FakeElement
    panel.find('Publish the address again')[0]?.fire('click')
    await vi.waitFor(async () => expect((await names.getName(pending.name))?.accepted).toBe(true))
    expect(sent).toBe(1)
    await vi.waitFor(() => expect(refreshed).toBe(1))
    expect((await names.getName(pending.name))?.keptUntil).toBe(NOW + 30 * DAY)
  })

  it('removes an address and the link wikis had to it', async () => {
    const gone = await addressKeptUntil('Gone', NOW + DAY)
    mem.wikis.set('w', { id: 'w', title: 'W', name: gone.name, publications: [] })
    let refreshed = 0
    const panel = (await addressesPanel(() => { refreshed++ })) as unknown as FakeElement
    const remove = panel.all('button').find((button) => button.attrs['aria-label']?.startsWith('Remove')) as FakeElement
    remove.fire('click')
    await vi.waitFor(() => expect(refreshed).toBe(1))
    expect(await names.loadNames()).toEqual([])
    expect(mem.wikis.get('w')?.['name']).toBeNull()
  })

  const wikiWith = (name: string | null, publications: unknown[]) => ({ id: 'w', title: 'Wiki w', subtitle: '', name, publications }) as never
  const shown = () => show((mem.dialogs.at(-1) as (typeof mem.dialogs)[number]).body)

  it('lists the versions with the address and sequence each went under, and the address on top', async () => {
    const entry = await addressKeptUntil('Wiki w', null)
    const publications = [
      { cid: CID, at: NOW - DAY, target: 'Downloaded as a CAR file', size: 10 },
      { cid: CID, at: NOW, target: 'Free pinning', size: 20, name: entry.name, sequence: 77 }
    ]
    await openPublications(wikiWith(entry.name, publications))
    const view = shown()
    expect(view.textContent).toContain(`ipns://${entry.name}/`)
    expect(view.textContent).toContain(`address ${entry.name.slice(0, 10)}…${entry.name.slice(-6)}, sequence 77`)
    expect(view.find('Download the key')).toHaveLength(1)
    expect(view.find('Download the public record')).toHaveLength(1)
    expect(view.find('Publish the address again')).toHaveLength(1)
    expect(view.all('li')).toHaveLength(2)
  })

  it('offers no way to publish the address again once Orivon\'s node took it, and says when the key is not held', async () => {
    const entry = await addressKeptUntil('Wiki w', NOW + DAY)
    await openPublications(wikiWith(entry.name, []))
    expect(shown().find('Publish the address again')).toHaveLength(0)
    await openPublications(wikiWith('k51qzi5uqu5dgh3vf75s4r3b1tmvxytqag9c97dmnqy75fs1vlne9ovykd6tuy', []))
    expect(shown().textContent).toContain('This browser does not hold its key')
    expect(shown().find('Download the key')).toHaveLength(0)
    await openPublications(wikiWith(null, []))
    expect(shown().textContent).toContain('Not published from this browser yet.')
  })
})

describe('importing the key of an address', () => {
  const NOW = Date.now()
  const handle = () => {
    const dialog = mem.dialogs.at(-1) as (typeof mem.dialogs)[number]
    return {
      close () { dialog.closed = true },
      setBody (...nodes: unknown[]) { dialog.body = nodes },
      setActions (list: typeof dialog.actions) { dialog.actions = list },
      setBusy (busy: boolean) { dialog.busy = busy }
    }
  }
  let dialog: ReturnType<typeof handle>
  /** The key file of an address published in "another browser", whose record Orivon's node holds. */
  let keyFile: Uint8Array
  let record: Uint8Array
  let name: string

  beforeEach(async () => {
    mem.settings.clear()
    mem.wikis.clear()
    mem.dialogs.length = 0
    mem.confirmed.length = 0
    const entry = await names.makeName('Other browser')
    await names.signVersion(entry.name, { cid: CID, title: 'Published title', now: NOW })
    const held = (await names.getName(entry.name)) as Awaited<ReturnType<typeof names.getName>> & object
    keyFile = new TextEncoder().encode(keyFileText(held))
    record = new Uint8Array(Buffer.from(held.record as string, 'base64'))
    name = entry.name
    await names.removeName(name)
    await openDialogFor()
  })
  afterEach(() => { vi.unstubAllGlobals() })

  async function openDialogFor () {
    const { openDialog } = await import('../page/src/ui/dialog.js')
    openDialog({ title: 'Import', body: [], actions: [] })
    dialog = handle()
  }
  const answers = (relay: Response | Error, gateway: () => Response | Error) => vi.stubGlobal('fetch', async (url: string) => {
    const answer = url.includes('/name/record') ? relay : gateway()
    if (answer instanceof Error) throw answer
    return answer.clone()
  })
  const text = () => show((mem.dialogs.at(-1) as (typeof mem.dialogs)[number]).body).textContent
  const labels = () => (mem.dialogs.at(-1) as (typeof mem.dialogs)[number]).actions.map((action) => action.label)

  it('keeps the address, finds what it shows, and edits it', async () => {
    answers(new Response(record as never), () => new Response('', { status: 404 }))
    const opened: Array<string | null> = []
    await takeKey({ bytes: keyFile, dialog: dialog as never, onOpen: (id) => { opened.push(id) } })
    expect((await names.loadNames()).map((entry) => entry.name)).toEqual([name])
    expect(text()).toContain('This address shows “Published title”, published just now.')
    expect(labels()).toEqual(['Close', 'Edit it'])
    expect((await names.getName(name))?.sequence).toBe(Math.floor(NOW / 1000))
    const edit = (mem.dialogs.at(-1) as (typeof mem.dialogs)[number]).actions.find((action) => action.label === 'Edit it')
    await edit?.onClick?.()
    expect(mem.confirmed).toHaveLength(1)
    expect(mem.confirmed[0]).toMatchObject({ name, source: { kind: 'ipfs', address: `ipfs://${CID}` } })
    expect(opened).toEqual(['taken-in'])
  })

  it('takes the version the address shows into its history when the key file is older than that version', async () => {
    const { createRecord, decodeKeyFile } = await import('../page/src/ipfs/ipns.js')
    const { seed } = await decodeKeyFile(new Uint8Array(Buffer.from(JSON.parse(new TextDecoder().decode(keyFile)).privateKey, 'base64')))
    const later = 'bafybeicwq4ldplx5a4qvmsx2lp6qp6md6fm6isikgwfz5ahyfjngzcrjta'
    const sequence = Math.floor(NOW / 1000) + 120
    const newer = await createRecord({ seed, value: `/ipfs/${later}`, sequence, validity: new Date(NOW + 3650 * 86_400_000), ttlMs: 300_000 })
    answers(new Response(newer as never), () => new Response('', { status: 404 }))
    await takeKey({ bytes: keyFile, dialog: dialog as never, onOpen: () => {} })
    expect(text()).toContain('This address shows “Fetched title”')
    const entry = await names.getName(name)
    expect(entry?.sequence).toBe(sequence)
    expect(entry?.history.at(-1)).toMatchObject({ cid: later, sequence, title: 'Fetched title', at: sequence * 1000 })
  })

  it('says nobody keeps the address up when no source has a record, and that Publish can use it', async () => {
    answers(new Response('', { status: 404 }), () => new Response('', { status: 404 }))
    await takeKey({ bytes: keyFile, dialog: dialog as never })
    expect(text()).toContain('Nobody keeps this address up now')
    expect(text()).toContain('Publish')
    expect((await names.loadNames())).toHaveLength(1)
  })

  it('says it could not look, and offers to look again, when no source answers', async () => {
    answers(new Error('offline'), () => new Error('offline'))
    await takeKey({ bytes: keyFile, dialog: dialog as never })
    expect(text()).toContain('Could not ask Orivon')
    expect(labels()).toEqual(['Close', 'Look again'])
    answers(new Response(record as never), () => new Response('', { status: 404 }))
    const again = (mem.dialogs.at(-1) as (typeof mem.dialogs)[number]).actions.find((action) => action.label === 'Look again')
    await again?.onClick?.()
    await vi.waitFor(() => expect(text()).toContain('This address shows'))
  })

  it('stops after keeping the address when it was asked not to look', async () => {
    answers(new Error('never asked'), () => new Error('never asked'))
    await takeKey({ bytes: keyFile, dialog: dialog as never, lookup: false })
    expect((mem.dialogs.at(-1) as (typeof mem.dialogs)[number]).closed).toBe(true)
    expect((await names.loadNames())).toHaveLength(1)
  })

  it('refuses a file that is no key, in words', async () => {
    await expect(takeKey({ bytes: new TextEncoder().encode('{"a":1}'), dialog: dialog as never })).rejects.toThrow('not a DecentraWiki address key')
    expect(await names.loadNames()).toEqual([])
  })
})
