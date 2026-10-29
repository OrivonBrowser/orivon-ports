import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeElement, installFakeDom, removeFakeDom, show } from './fake-dom.ts'

beforeAll(installFakeDom)
afterAll(removeFakeDom)

const mem = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  wikis: new Map<string, Record<string, unknown>>(),
  dialogs: [] as Array<{ title: string, body: unknown[], actions: Array<{ label: string, onClick?: () => unknown }>, busy: boolean, closed: boolean }>,
  downloads: [] as string[],
  /** What the Publish dialog asked pinSite for, and the progress list it showed at that moment. */
  pinned: [] as Array<{ fromNode?: boolean, steps: unknown[] }>,
  pinFailure: '',
  /** When the mocked free pinning says it keeps a version until; null, as a service of the person's does. */
  keptUntil: Date.parse('2026-11-25T00:00:00Z') as number | null,
  buildFailures: 0,
  /** What the mocked hosting was asked to host, and whether it can. */
  hosted: [] as Array<{ wiki: string, cid: string }>,
  hostResult: true,
  /** The version kept to host for each wiki, which the real hosting writes before it asks the node, and what it was told to stop announcing. */
  rows: new Map<string, { wiki: string, cid: string }>(),
  forgotten: [] as Array<{ wiki: string, cid: string }>,
  peer: '12D3KooWR2vUA19onp2TihxmaJyuKqm8oxMSmboKNdeT96PTnKLJ'
}))

vi.mock('../page/src/publish/hosting.js', () => {
  const listening = () => typeof (globalThis as { window?: { orivon?: { net?: { listen?: unknown } } } }).window?.orivon?.net?.listen === 'function'
  return {
    hostingAvailable: listening,
    hosting: {
      enabled: async () => listening() && mem.settings.get('hostWikis') !== false,
      host: async (wiki: string, cid: string) => { mem.hosted.push({ wiki, cid }); mem.rows.set(wiki, { wiki, cid }); return mem.hostResult },
      forget: async (wiki: string, cid: string) => { mem.forgotten.push({ wiki, cid }) },
      node: async () => mem.hostResult ? { base: 'http://127.0.0.1:5180', key: 'k', peer: mem.peer, port: 5180 } : null,
      poll: async () => true,
      resume: async () => {},
      stop: async () => {},
      summary: () => ({ running: false, wikis: 0, announced: 0, state: 'off', reachability: 'unknown', relays: 0 })
    }
  }
})

vi.mock('../page/src/store.js', () => ({
  listHosted: async () => [],
  getHosted: async (wiki: string) => mem.rows.get(wiki),
  putHosted: async (row: { wiki: string, cid: string }) => { mem.rows.set(row.wiki, row) },
  deleteHosted: async (wiki: string) => { mem.rows.delete(wiki) },
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
  downloadFile: (_data: unknown, name: string) => { mem.downloads.push(name) },
  confirmDialog: async () => true
}))

vi.mock('../page/src/publish/publish.js', async (original) => {
  const real = await original<typeof import('../page/src/publish/publish.js')>()
  return {
    ...real,
    renderSite: async () => {
      if (mem.buildFailures > 0) {
        mem.buildFailures--
        throw new Error('The built page does not load the TiddlyWiki core this editor publishes with.')
      }
      return [{ path: 'index.html', bytes: new Uint8Array([1]) }]
    },
    addressSite: async (files: unknown) => ({ files, cid: 'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am', blocks: new Map(), size: 123 }),
    pinSite: async (_wiki: unknown, _target: unknown, _site: unknown, options: { fromNode?: boolean }) => {
      mem.pinned.push({ ...options, steps: [...(mem.dialogs.at(-1)?.body ?? [])] })
      if (mem.pinFailure !== '') throw new Error(mem.pinFailure)
      return { keptUntil: mem.keptUntil }
    },
    carOf: () => new Uint8Array([1, 2, 3])
  }
})

const NAME_A = 'k51qzi5uqu5dgh3vf75s4r3b1tmvxytqag9c97dmnqy75fs1vlne9ovykd6tuy'
const NAME_B = 'k51qzi5uqu5dj62xvfnp4n0msn0c139y2i865g2uoyrfcpfdje725ljlg6y7i7'
const NAME_C = 'k51qzi5uqu5dgh3vf75s4r3b1tmvxytqag9c97dmnqy75fs1vlne9ovykd6tuz'
const CID = 'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am'
const held = (name: string, title: string, at?: number) => ({
  name, seed: '00'.repeat(32), label: title, createdAt: 0, sequence: 1, record: null, accepted: false, keptUntil: null,
  history: at === undefined ? [] : [{ cid: CID, at, sequence: 1, title }]
})

const { addressFieldset } = await import('../page/src/ui/address-choice.js')
const { resultView, carDoneView } = await import('../page/src/ui/publish-result.js')
const { openPublishDialog } = await import('../page/src/ui/publish-dialog.js')
const names = await import('../page/src/names.js')

type Wiki = Parameters<typeof addressFieldset>[0]['wiki']
const wiki = (name: string | null): Wiki => ({ name } as unknown as Wiki)

describe('the address choices in the Publish dialog', () => {
  const radios = (el: FakeElement) => el.all('input').map((input) => ({ value: input.attrs['value'], checked: input.checked, disabled: input.hasAttribute('disabled') }))

  it('offers the wiki\'s own address first when this browser holds its key', () => {
    const { el, get } = addressFieldset({ wiki: wiki(NAME_A), held: [held(NAME_A, 'Bisq', Date.now()), held(NAME_B, 'Other')] as never, onImportKey () {} })
    const field = el as unknown as FakeElement
    expect(radios(field)).toEqual([
      { value: 'update', checked: true, disabled: false }, { value: 'new', checked: false, disabled: false },
      { value: 'other', checked: false, disabled: false }, { value: 'none', checked: false, disabled: false }
    ])
    expect(field.textContent).toContain('Update its address')
    expect(field.textContent).toContain('Another address you hold')
    expect(field.textContent).toContain(' · Other')
    expect(get()).toEqual({ kind: 'update', name: NAME_A })
  })

  it('offers a new address first to a wiki with none, and an address held only when there is one', () => {
    const alone = addressFieldset({ wiki: wiki(null), held: [], onImportKey () {} })
    expect(radios(alone.el as unknown as FakeElement).map((radio) => radio.value)).toEqual(['new', 'none'])
    expect(alone.get()).toEqual({ kind: 'new' })
    const some = addressFieldset({ wiki: wiki(null), held: [held(NAME_B, 'Other')] as never, onImportKey () {} })
    const field = some.el as unknown as FakeElement
    expect(field.textContent).toContain('An address you hold')
    expect(some.get()).toEqual({ kind: 'new' })
    const chooser = field.all('select')[0] as FakeElement
    chooser.value = NAME_B
    chooser.fire('change')
    expect(some.get()).toEqual({ kind: 'other', name: NAME_B })
    expect(field.textContent).toContain('Readers of that address will see this wiki instead of “Other”.')
  })

  it('shows an address whose key is missing as disabled, with a way to import it, and defaults to a new one', () => {
    let asked = 0
    const { el, get } = addressFieldset({ wiki: wiki(NAME_C), held: [held(NAME_B, 'Other')] as never, onImportKey () { asked++ } })
    const field = el as unknown as FakeElement
    expect(radios(field)[0]).toEqual({ value: 'update', checked: false, disabled: true })
    expect(field.textContent).toContain('This browser does not hold its key.')
    field.find('Import the key')[0]?.fire('click')
    expect(asked).toBe(1)
    expect(get()).toEqual({ kind: 'new' })
    expect(field.textContent).toContain('Another address you hold')
  })

  it('answers none when no address is chosen', () => {
    const { el, get } = addressFieldset({ wiki: wiki(null), held: [], onImportKey () {} })
    const none = (el as unknown as FakeElement).all('input').find((input) => input.attrs['value'] === 'none') as FakeElement
    none.fire('change')
    expect(get()).toEqual({ kind: 'none' })
  })
})

describe('the result of a publish', () => {
  const view = (options: Parameters<typeof resultView>[0]) => show(resultView(options))

  it('shows the wiki\'s address first with the version\'s under it, and offers the key to the address it just made', () => {
    const root = view({ cid: CID, title: 'Bisq', keptUntil: Date.parse('2026-11-25T00:00:00Z'), name: NAME_A, made: true, point: { keptUntil: Date.parse('2026-11-25T00:00:00Z'), problem: null }, retry: async () => ({ keptUntil: null, problem: null }) })
    const text = root.textContent
    expect(text).toContain(`ipns://${NAME_A}/`)
    expect(text).toContain(`This version:ipfs://${CID}/`)
    expect(text).toContain('Keep this address\'s key')
    expect(root.find('Download the key')).toHaveLength(1)
    expect(root.find('Download the public record')).toHaveLength(1)
    expect(text).toContain('keeps the address up until')
    expect(root.all('a').map((link) => link.attrs['href'])).toEqual([`ipns://${NAME_A}/`, `https://${NAME_A}.ipns.dweb.link/`])
    expect(text).toContain('Content Hash')
    expect(text).toContain(`ipns://${NAME_A}`)
  })

  it('offers only the record on a later publish', () => {
    const root = view({ cid: CID, title: 'Bisq', keptUntil: null, name: NAME_A, point: { keptUntil: 1, problem: null }, retry: async () => ({ keptUntil: null, problem: null }) })
    expect(root.textContent).not.toContain('Keep this address\'s key')
    expect(root.find('Download the public record')).toHaveLength(1)
    expect(root.find('Download the key')).toHaveLength(0)
  })

  it('keeps the publish a success when Orivon\'s node said no, with its words and a way to try again', async () => {
    let tried = 0
    const root = view({ cid: CID, title: 'Bisq', keptUntil: null, name: NAME_A, point: { keptUntil: null, problem: 'Orivon\'s node could not read that version from IPFS.' }, retry: async () => { tried++; return { keptUntil: Date.parse('2026-12-01T00:00:00Z'), problem: null } } })
    expect(root.textContent).toContain('The wiki is published, but its address is not kept up yet.')
    expect(root.textContent).toContain('Orivon\'s node could not read that version from IPFS.')
    const again = root.find('Try again')[0] as FakeElement
    again.fire('click')
    await vi.waitFor(() => expect(tried).toBe(1))
    await vi.waitFor(() => expect(root.textContent).toContain('keeps the address up until'))
    expect(root.textContent).not.toContain('is not kept up yet')
  })

  it('is what it was for a version published with no address', () => {
    const root = view({ cid: CID, title: 'Bisq', keptUntil: null, name: null })
    expect(root.textContent).toContain(`ipfs://${CID}/`)
    expect(root.textContent).not.toContain('ipns://')
    expect(root.all('a').map((link) => link.attrs['href'])).toEqual([`ipfs://${CID}/`, `https://${CID}.ipfs.dweb.link/`])
    expect(root.find('Download')).toHaveLength(0)
  })

  it('tells what the address needs once a CAR file is saved', () => {
    const root = show(carDoneView({ cid: CID, name: NAME_A, made: true }))
    expect(root.textContent).toContain(`ipfs routing put /ipns/${NAME_A} ${NAME_A}.ipns-record`)
    expect(root.find('Download the key')).toHaveLength(1)
    expect(show(carDoneView({ cid: CID, name: null })).textContent).toContain(`ipfs://${CID}/`)
  })
})

describe('the Publish dialog, from pressing Publish to the result', () => {
  const RELAY_KEEP = 'https://telemetry.orivonstack.com/decentrawiki/api/v0/name/keep'
  let kept: Array<{ url: string, body: Uint8Array }>
  let answer: () => Response
  let errors: ReturnType<typeof vi.spyOn>
  const published: unknown[] = []

  const makeWiki = (id: string, name: string | null) => {
    const record = { id, title: `Wiki ${id}`, subtitle: '', createdAt: 1, updatedAt: 1, source: { kind: 'new', at: 1 }, lineage: id, previous: null, name, publications: [] }
    mem.wikis.set(id, record)
    return record
  }
  const ok = () => Response.json({ Name: 'x', Value: `/ipfs/${CID}`, Sequence: 1, KeptUntil: '2026-11-25T00:00:00.000Z' })

  beforeEach(() => {
    mem.settings.clear()
    mem.wikis.clear()
    mem.dialogs.length = 0
    mem.downloads.length = 0
    mem.pinned.length = 0
    mem.pinFailure = ''
    mem.keptUntil = Date.parse('2026-11-25T00:00:00Z')
    mem.hosted.length = 0
    mem.rows.clear()
    mem.forgotten.length = 0
    mem.hostResult = true
    mem.buildFailures = 0
    published.length = 0
    kept = []
    answer = ok
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/v0/node')) return Response.json({ addrs: [] })
      kept.push({ url, body: init.body as Uint8Array })
      const response = answer()
      // The relay echoes the record it was sent.
      if (response.ok) {
        const { parseRecord } = await import('../page/src/ipfs/ipns.js')
        const record = parseRecord(init.body as Uint8Array)
        return Response.json({ Name: url.split('arg=')[1], Value: record.value, Sequence: record.sequence, KeptUntil: '2026-11-25T00:00:00.000Z' })
      }
      return response
    })
  })
  afterEach(() => { vi.unstubAllGlobals(); errors.mockRestore() })

  const open = async (id: string) => {
    await openPublishDialog({ wiki: mem.wikis.get(id) as never, workspace: {} as never, onSettings () {}, onPublished: (wiki) => { published.push(wiki) } })
    return mem.dialogs.at(-1) as (typeof mem.dialogs)[number]
  }
  const root = (dialog: { body: unknown[] }) => show(dialog.body)
  const press = (dialog: { actions: Array<{ label: string, onClick?: () => unknown }> }, label: string) => {
    const action = dialog.actions.find((candidate) => candidate.label === label)
    if (action === undefined) throw new Error(`no ${label} button among ${dialog.actions.map((a) => a.label).join(', ')}`)
    void action.onClick?.()
  }
  const choose = (dialog: { body: unknown[] }, group: string, value: string) => {
    const radio = root(dialog).all('input').find((input) => input.attrs['name'] === group && input.attrs['value'] === value) as FakeElement
    radio.checked = true
    radio.fire('change')
  }
  const finished = async (dialog: { actions: Array<{ label: string }> }) => { await vi.waitFor(() => expect(dialog.actions.map((a) => a.label)).toContain('Done'), { timeout: 3000 }) }

  it('makes an address for a new wiki, points it at the version, keeps it, and offers the key', async () => {
    makeWiki('a', null)
    const dialog = await open('a')
    expect(root(dialog).textContent).toContain('A new address')
    press(dialog, 'Publish')
    await finished(dialog)
    const entry = (await names.loadNames())[0] as Awaited<ReturnType<typeof names.loadNames>>[number]
    expect(entry.accepted).toBe(true)
    expect(entry.keptUntil).toBe(Date.parse('2026-11-25T00:00:00Z'))
    expect(mem.wikis.get('a')?.['name']).toBe(entry.name)
    expect((mem.wikis.get('a')?.['publications'] as Array<Record<string, unknown>>)[0]).toMatchObject({ cid: CID, name: entry.name, sequence: entry.sequence })
    expect(kept).toHaveLength(1)
    expect(kept[0]?.url).toBe(`${RELAY_KEEP}?arg=${entry.name}`)
    const text = root(dialog).textContent
    expect(text).toContain(`ipns://${entry.name}/`)
    expect(text).toContain('Keep this address\'s key')
    expect(published.length).toBeGreaterThan(0)
  })

  it('offers to update the address the second time, and makes no key panel', async () => {
    makeWiki('a', null)
    const first = await open('a')
    press(first, 'Publish')
    await finished(first)
    const entry = (await names.loadNames())[0] as Awaited<ReturnType<typeof names.loadNames>>[number]
    const second = await open('a')
    const text = root(second).textContent
    expect(text).toContain('Update its address')
    expect(text).toContain('last published')
    press(second, 'Publish')
    await finished(second)
    expect(await names.loadNames()).toHaveLength(1)
    expect(root(second).textContent).not.toContain('Keep this address\'s key')
    expect(root(second).textContent).toContain(`ipns://${entry.name}/`)
    // The same version again is the same record: it is sent again and costs nothing.
    expect(kept).toHaveLength(2)
    expect(kept[1]?.body).toEqual(kept[0]?.body)
    expect(mem.wikis.get('a')?.['publications']).toHaveLength(2)
  })

  it('keeps the publish standing when Orivon\'s node refuses, and sends the same record on Try again', async () => {
    makeWiki('a', null)
    answer = () => Response.json({ Message: 'Orivon\'s node could not read that version from IPFS.' }, { status: 502 })
    const dialog = await open('a')
    press(dialog, 'Publish')
    await finished(dialog)
    const text = root(dialog).textContent
    expect(text).toContain('The wiki is published, but its address is not kept up yet.')
    expect(text).toContain('Orivon\'s node could not read that version from IPFS.')
    expect(mem.wikis.get('a')?.['publications']).toHaveLength(1)
    const entry = (await names.loadNames())[0] as Awaited<ReturnType<typeof names.loadNames>>[number]
    expect(entry.accepted).toBe(false)
    answer = ok
    root(dialog).find('Try again')[0]?.fire('click')
    await vi.waitFor(async () => expect((await names.loadNames())[0]?.accepted).toBe(true))
    expect(kept).toHaveLength(2)
    expect(kept[1]?.body).toEqual(kept[0]?.body)
    await vi.waitFor(() => expect(root(dialog).textContent).toContain('keeps the address up until'))
  })

  it('reuses the address it made when a later step failed', async () => {
    makeWiki('a', null)
    mem.buildFailures = 1
    const dialog = await open('a')
    press(dialog, 'Publish')
    await vi.waitFor(() => expect(dialog.actions.map((a) => a.label)).toContain('Try again'))
    expect(root(dialog).textContent).toContain('does not load the TiddlyWiki core')
    expect(await names.loadNames()).toHaveLength(1)
    expect(mem.wikis.get('a')?.['name']).not.toBeNull()
    press(dialog, 'Try again')
    await finished(dialog)
    expect(await names.loadNames()).toHaveLength(1)
    expect(root(dialog).textContent).toContain('Keep this address\'s key')
  })

  it('publishes with no address as it always did', async () => {
    makeWiki('a', null)
    const dialog = await open('a')
    choose(dialog, 'address', 'none')
    press(dialog, 'Publish')
    await finished(dialog)
    expect(kept).toHaveLength(0)
    expect(await names.loadNames()).toEqual([])
    expect(mem.wikis.get('a')?.['name']).toBeNull()
    expect((mem.wikis.get('a')?.['publications'] as Array<Record<string, unknown>>)[0]).not.toHaveProperty('name')
    expect(root(dialog).textContent).toContain(`ipfs://${CID}/`)
  })

  it('puts a second wiki under a held address, taking it from the first', async () => {
    makeWiki('a', null)
    const first = await open('a')
    press(first, 'Publish')
    await finished(first)
    const entry = (await names.loadNames())[0] as Awaited<ReturnType<typeof names.loadNames>>[number]
    makeWiki('b', null)
    const dialog = await open('b')
    expect(root(dialog).textContent).toContain('An address you hold')
    choose(dialog, 'address', 'other')
    const select = root(dialog).all('select')[0] as FakeElement
    select.value = entry.name
    select.fire('change')
    expect(root(dialog).textContent).toContain('Readers of that address will see this wiki instead of “Wiki a”.')
    press(dialog, 'Publish')
    await finished(dialog)
    expect(mem.wikis.get('b')?.['name']).toBe(entry.name)
    expect(mem.wikis.get('a')?.['name']).toBeNull()
    expect(await names.loadNames()).toHaveLength(1)
    expect(kept).toHaveLength(2)
  })

  it('refuses an address whose key was removed since the dialog opened', async () => {
    makeWiki('a', null)
    const first = await open('a')
    press(first, 'Publish')
    await finished(first)
    const second = await open('a')
    await names.removeName((await names.loadNames())[0]?.name as string)
    press(second, 'Publish')
    await vi.waitFor(() => expect(root(second).textContent).toContain('does not hold the key of that address any more'))
  })

  it('signs and offers the record beside the CAR file, without calling Orivon\'s node', async () => {
    makeWiki('a', null)
    const dialog = await open('a')
    choose(dialog, 'target', 'download')
    press(dialog, 'Publish')
    await vi.waitFor(() => expect(dialog.actions.map((a) => a.label)).toContain('Download the CAR file'))
    press(dialog, 'Download the CAR file')
    await finished(dialog)
    expect(mem.downloads).toHaveLength(1)
    expect(mem.downloads[0]).toMatch(/\.car$/)
    expect(kept).toHaveLength(0)
    const entry = (await names.loadNames())[0] as Awaited<ReturnType<typeof names.loadNames>>[number]
    expect(entry.record).not.toBeNull()
    expect(entry.accepted).toBe(false)
    expect((mem.wikis.get('a')?.['publications'] as Array<Record<string, unknown>>)[0]).toMatchObject({ name: entry.name, target: 'Downloaded as a CAR file' })
    expect(root(dialog).find('Download the key')).toHaveLength(1)
  })

  describe('publishing, by the two switches in Settings', () => {
    const inOrivon = () => vi.stubGlobal('window', { orivon: { net: { connect () {}, listen () {} } }, process: {} })
    const stepsShown = () => show(mem.pinned[0]?.steps ?? []).textContent
    const publications = (id: string) => mem.wikis.get(id)?.['publications'] as Array<Record<string, unknown>>
    const kubo = { id: 'k', kind: 'kubo', values: { endpoint: 'http://127.0.0.1:5001' } }
    const targetRadio = (dialog: { body: unknown[] }, value: string) => root(dialog).all('input').find((input) => input.attrs['name'] === 'target' && input.attrs['value'] === value)

    it('hosts from the page\'s IPFS node, has free pinning read from it, and names the node to Orivon when keeping the address, by default in Orivon', async () => {
      inOrivon()
      makeWiki('a', null)
      const dialog = await open('a')
      expect(root(dialog).textContent).toContain('Your IPFS node, in this page')
      expect(root(dialog).textContent).toContain('This page runs an IPFS node')
      expect(root(dialog).textContent).toContain('Hosting is on')
      expect(root(dialog).textContent).toContain('People who open it, and Orivon\'s relay, can see your IP address.')
      expect(root(dialog).textContent).toContain('Only this computer: online while the editor is open')
      expect(root(dialog).textContent).toContain('Free pinning keeps it for longer.')
      expect(targetRadio(dialog, 'free')?.checked).toBe(true)
      expect(targetRadio(dialog, 'hosted')?.checked).toBe(false)
      press(dialog, 'Publish')
      await finished(dialog)
      expect(mem.pinned).toHaveLength(1)
      expect(mem.pinned[0]?.fromNode).toBe(true)
      expect(stepsShown()).toContain('Publishing it from your IPFS node')
      expect(mem.hosted).toEqual([{ wiki: 'a', cid: CID }])
      expect(publications('a')[0]?.['target']).toMatch(/^Your IPFS node, kept by Orivon until /)
      expect(root(dialog).textContent).toContain('Your computer hosts this version while the editor is open.')
      expect(root(dialog).textContent).toContain('Your IPFS node published it, and Orivon\'s node keeps this version pinned until')
      const entry = (await names.loadNames())[0] as Awaited<ReturnType<typeof names.loadNames>>[number]
      expect(kept.map((call) => call.url)).toEqual([`${RELAY_KEEP}?arg=${entry.name}&peer=${mem.peer}`])
    })

    it('still offers "Only this computer" beside free pinning, so a wiki that free pinning refuses is published from this computer alone', async () => {
      inOrivon()
      makeWiki('a', null)
      mem.pinFailure = 'Free pinning refused it: the wiki is too large.'
      const failed = await open('a')
      press(failed, 'Publish')
      await vi.waitFor(() => expect(failed.actions.map((a) => a.label)).toContain('Try again'))
      expect(mem.hosted).toEqual([])
      expect(publications('a')).toEqual([])

      mem.pinned.length = 0
      const dialog = await open('a')
      expect(targetRadio(dialog, 'hosted')).toBeDefined()
      choose(dialog, 'target', 'hosted')
      press(dialog, 'Publish')
      await finished(dialog)
      expect(mem.pinned).toEqual([])
      expect(mem.hosted).toEqual([{ wiki: 'a', cid: CID }])
      expect(publications('a')[0]?.['target']).toBe('This computer, while the editor is open')
      expect(root(dialog).textContent).toContain('Nothing pins it, so it is online only while the editor is open.')
      expect(root(dialog).textContent).toContain('publish again with free pinning')
    })

    it('uploads, and hosts nothing, when hosting is off, and says so in the label, the step, the record and the result', async () => {
      inOrivon()
      mem.settings.set('hostWikis', false)
      makeWiki('a', null)
      const dialog = await open('a')
      expect(root(dialog).textContent).toContain('Free pinning by Orivon')
      expect(root(dialog).textContent).not.toContain('Your IPFS node, in this page')
      expect(root(dialog).textContent).not.toContain('Hosting is on')
      expect(root(dialog).textContent).toContain('the wiki goes to Orivon\'s server')
      press(dialog, 'Publish')
      await finished(dialog)
      expect(mem.pinned[0]?.fromNode).toBe(false)
      expect(stepsShown()).toContain('Pinning it with Free pinning by Orivon')
      expect(mem.hosted).toEqual([])
      expect(publications('a')[0]?.['target']).toMatch(/^Free pinning by Orivon, until /)
      expect(root(dialog).textContent).toContain('Orivon keeps this version pinned until')
      expect(root(dialog).textContent).not.toContain('Your computer hosts')
      expect(kept[0]?.url).not.toContain('peer=')
    })

    it('uploads where the page can run no node, whatever Settings holds', async () => {
      mem.settings.set('hostWikis', true)
      makeWiki('a', null)
      const dialog = await open('a')
      expect(root(dialog).textContent).toContain('Free pinning by Orivon')
      press(dialog, 'Publish')
      await finished(dialog)
      expect(mem.pinned[0]?.fromNode).toBe(false)
      expect(mem.hosted).toEqual([])
    })

    it('offers "Only this computer" first when hosting is on and free pinning is off, pins nothing, and keeps the address from the node', async () => {
      inOrivon()
      mem.settings.set('freePinning', false)
      makeWiki('a', null)
      const dialog = await open('a')
      expect(root(dialog).textContent).toContain('Only this computer: online while the editor is open')
      expect(root(dialog).textContent).toContain('and they can see your IP address.')
      expect(root(dialog).textContent).not.toContain('Free pinning by Orivon')
      expect(targetRadio(dialog, 'hosted')?.checked).toBe(true)
      press(dialog, 'Publish')
      await finished(dialog)
      expect(mem.pinned).toEqual([])
      expect(mem.hosted).toEqual([{ wiki: 'a', cid: CID }])
      expect(publications('a')[0]?.['target']).toBe('This computer, while the editor is open')
      expect(root(dialog).textContent).toContain('Your computer hosts this version while the editor is open.')
      expect(root(dialog).textContent).toContain('Nothing pins it, so it is online only while the editor is open.')
      expect(kept).toHaveLength(1)
      expect(kept[0]?.url).toContain(`&peer=${mem.peer}`)
      expect(published.length).toBeGreaterThan(0)
    })

    it('fails a publish only this computer hosts when the node cannot host it, and records nothing', async () => {
      inOrivon()
      mem.settings.set('freePinning', false)
      mem.hostResult = false
      makeWiki('a', null)
      const dialog = await open('a')
      press(dialog, 'Publish')
      await vi.waitFor(() => expect(dialog.actions.map((a) => a.label)).toContain('Try again'))
      expect(root(dialog).textContent).toContain('This computer could not host the wiki')
      expect(publications('a')).toEqual([])
      expect(errors).toHaveBeenCalledTimes(1)
      expect(String(errors.mock.calls[0]?.[0])).toMatch(/^\[decentrawiki\] publish failed at the pin step, hosted only: This computer could not host the wiki/)
    })

    it('leaves the wiki\'s kept version as it was when a publish only this computer hosts fails, so the editor announces nothing the person was told failed', async () => {
      inOrivon()
      mem.settings.set('freePinning', false)
      mem.hostResult = false
      makeWiki('a', null)
      makeWiki('b', null)
      mem.rows.set('b', { wiki: 'b', cid: 'bafyearlier' })
      const first = await open('a')
      press(first, 'Publish')
      await vi.waitFor(() => expect(first.actions.map((a) => a.label)).toContain('Try again'))
      expect(mem.hosted).toEqual([{ wiki: 'a', cid: CID }])
      expect(mem.rows.has('a')).toBe(false)
      expect(mem.forgotten).toEqual([{ wiki: 'a', cid: CID }])

      const second = await open('b')
      press(second, 'Publish')
      await vi.waitFor(() => expect(second.actions.map((a) => a.label)).toContain('Try again'))
      expect(mem.hosted).toEqual([{ wiki: 'a', cid: CID }, { wiki: 'b', cid: CID }])
      expect(mem.rows.get('b')).toEqual({ wiki: 'b', cid: 'bafyearlier' })
    })

    it('says the download is the one way not hosted, and hosts nothing when the files are downloaded', async () => {
      inOrivon()
      makeWiki('a', null)
      const dialog = await open('a')
      expect(root(dialog).textContent).toContain('unless you download the files, this computer also serves')
      expect(root(dialog).textContent).not.toContain('whichever way')
      choose(dialog, 'target', 'download')
      press(dialog, 'Publish')
      await vi.waitFor(() => expect(dialog.actions.map((a) => a.label)).toContain('Download the CAR file'))
      expect(mem.hosted).toEqual([])
      expect(mem.rows.size).toBe(0)
    })

    it('hosts a version pinned with a service of the person\'s too, and does not fail the publish when hosting fails', async () => {
      inOrivon()
      mem.settings.set('freePinning', false)
      mem.settings.set('targets', [kubo])
      mem.keptUntil = null
      makeWiki('a', null)
      const dialog = await open('a')
      expect(root(dialog).textContent).toContain('Only this computer: online while the editor is open')
      expect(targetRadio(dialog, 'k')?.checked).toBe(true)
      press(dialog, 'Publish')
      await finished(dialog)
      expect(mem.pinned[0]?.fromNode).toBe(true)
      expect(mem.hosted).toEqual([{ wiki: 'a', cid: CID }])
      expect(root(dialog).textContent).toContain('Your computer hosts this version while the editor is open.')
      expect(root(dialog).textContent).not.toContain('Nothing pins it')
      expect(kept[0]?.url).toContain(`&peer=${mem.peer}`)

      mem.hostResult = false
      mem.hosted.length = 0
      const again = await open('a')
      press(again, 'Publish')
      await finished(again)
      expect(root(again).textContent).not.toContain('Your computer hosts')
      expect(publications('a')).toHaveLength(2)
      expect(errors).not.toHaveBeenCalled()
    })

    it('offers the services of the person\'s and the download only when both switches are off', async () => {
      inOrivon()
      mem.settings.set('hostWikis', false)
      mem.settings.set('freePinning', false)
      makeWiki('a', null)
      const dialog = await open('a')
      const text = root(dialog).textContent
      expect(text).not.toContain('Free pinning by Orivon')
      expect(text).not.toContain('Only this computer')
      expect(text).toContain('Nobody: download the files')
      expect(targetRadio(dialog, 'download')?.checked).toBe(true)
      expect(targetRadio(dialog, 'free')).toBeUndefined()
    })

    it('writes one error line naming the step and the route when a publish fails, for the bug report, with no node key in it and at most 400 characters of the message', async () => {
      inOrivon()
      makeWiki('a', null)
      mem.pinFailure = 'Your IPFS node could not connect to Orivon\'s node. Check your connection and try again.'
      const dialog = await open('a')
      press(dialog, 'Publish')
      await vi.waitFor(() => expect(dialog.actions.map((a) => a.label)).toContain('Try again'))
      expect(errors).toHaveBeenCalledTimes(1)
      expect(errors).toHaveBeenCalledWith(`[decentrawiki] publish failed at the pin step, free pinning from the page's IPFS node: ${mem.pinFailure}`)
      mem.settings.set('hostWikis', false)
      const key = 'a1b2c3d4'.repeat(8)
      mem.pinFailure = `it ended (code 2): --api-key ${key} ${key.toUpperCase()} ${'x'.repeat(600)}`
      const again = await open('a')
      press(again, 'Publish')
      await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2))
      expect(errors).toHaveBeenLastCalledWith(`[decentrawiki] publish failed at the pin step, free pinning as an upload: it ended (code 2): --api-key <key> <key> ${'x'.repeat(359)}`)
    })
  })
})
