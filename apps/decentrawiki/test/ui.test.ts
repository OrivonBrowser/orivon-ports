import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Just enough of a document for dom.js: elements with attributes, children, listeners and a few properties.
class FakeNode {}
class FakeText extends FakeNode {
  constructor (public data: string) { super() }
}
class FakeElement extends FakeNode {
  children: FakeNode[] = []
  attrs: Record<string, string> = {}
  listeners: Record<string, Array<(event: unknown) => void>> = {}
  private chosen: string | undefined
  checkedNow: boolean | undefined
  constructor (public tag: string) { super() }
  setAttribute (name: string, value: string): void { this.attrs[name] = value }
  getAttribute (name: string): string | null { return this.attrs[name] ?? null }
  hasAttribute (name: string): boolean { return name in this.attrs }
  removeAttribute (name: string): void { delete this.attrs[name] }
  addEventListener (type: string, listener: (event: unknown) => void): void { (this.listeners[type] ??= []).push(listener) }
  fire (type: string): void { for (const listener of this.listeners[type] ?? []) listener({ target: this, preventDefault () {} }) }
  append (...nodes: Array<FakeNode | string>): void { this.children.push(...nodes.map((node) => typeof node === 'string' ? new FakeText(node) : node)) }
  replaceChildren (...nodes: Array<FakeNode | string>): void { this.children = []; this.append(...nodes) }
  get className (): string { return this.attrs['class'] ?? '' }
  set className (value: string) { this.attrs['class'] = value }
  get classList () { return { add: () => {}, remove: () => {}, toggle: () => {} } }
  get dataset (): Record<string, string> { return {} }
  get textContent (): string { return this.children.map((child) => child instanceof FakeText ? child.data : (child as FakeElement).textContent).join('') }
  set textContent (value: string) { this.children = [new FakeText(value)] }
  get checked (): boolean { return this.checkedNow ?? this.hasAttribute('checked') }
  set checked (value: boolean) { this.checkedNow = value }
  get value (): string {
    if (this.chosen !== undefined) return this.chosen
    return this.tag === 'select' ? (this.all('option')[0]?.attrs['value'] ?? '') : this.attrs['value'] ?? ''
  }
  set value (value: string) { this.chosen = value }
  all (tag: string): FakeElement[] {
    const found: FakeElement[] = []
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue
      if (child.tag === tag) found.push(child)
      found.push(...child.all(tag))
    }
    return found
  }
  find (text: string): FakeElement[] {
    return this.all('button').concat(this.all('a')).filter((el) => el.textContent.includes(text))
  }
}

const globals = globalThis as Record<string, unknown>
beforeAll(() => {
  globals['Node'] = FakeNode
  globals['window'] = {}
  globals['document'] = { createElement: (tag: string) => new FakeElement(tag), createElementNS: (_ns: string, tag: string) => new FakeElement(tag) }
})
afterAll(() => {
  delete globals['Node']
  delete globals['window']
  delete globals['document']
})

const mem = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  wikis: new Map<string, Record<string, unknown>>(),
  dialogs: [] as Array<{ title: string, body: unknown[], actions: Array<{ label: string, onClick?: () => unknown }>, busy: boolean, closed: boolean }>,
  downloads: [] as string[],
  confirmed: [] as Array<Record<string, unknown>>,
  /** What the Publish dialog asked pinSite for, and the progress list it showed at that moment. */
  pinned: [] as Array<{ fromNode?: boolean, steps: unknown[] }>,
  pinFailure: '',
  buildFailures: 0
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
  downloadFile: (_data: unknown, name: string) => { mem.downloads.push(name) },
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
      return { keptUntil: Date.parse('2026-11-25T00:00:00Z') }
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
const { addressesPanel } = await import('../page/src/views/addresses.js')
const { renderSettings } = await import('../page/src/views/settings.js')
const { openPublications } = await import('../page/src/ui/publications.js')
const { takeKey } = await import('../page/src/ui/import-key.js')
const { keyFileText } = await import('../page/src/name-files.js')

type Wiki = Parameters<typeof addressFieldset>[0]['wiki']
const wiki = (name: string | null): Wiki => ({ name } as unknown as Wiki)
const show = (nodes: unknown[]): FakeElement => {
  const root = new FakeElement('div')
  root.append(...(nodes.flat(Infinity).filter((node) => node !== null && node !== undefined) as FakeNode[]))
  return root
}

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
    mem.buildFailures = 0
    published.length = 0
    kept = []
    answer = ok
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
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

  describe('free pinning, by the route chosen in Settings', () => {
    const inOrivon = () => vi.stubGlobal('window', { orivon: { net: { connect () {} } } })
    const stepsShown = () => show(mem.pinned[0]?.steps ?? []).textContent
    const publications = (id: string) => mem.wikis.get(id)?.['publications'] as Array<Record<string, unknown>>

    it('publishes from the page\'s IPFS node in Orivon until Settings says otherwise', async () => {
      inOrivon()
      makeWiki('a', null)
      const dialog = await open('a')
      expect(root(dialog).textContent).toContain('Your IPFS node, in this page')
      expect(root(dialog).textContent).toContain('This page runs an IPFS node')
      press(dialog, 'Publish')
      await finished(dialog)
      expect(mem.pinned).toHaveLength(1)
      expect(mem.pinned[0]?.fromNode).toBe(true)
      expect(stepsShown()).toContain('Publishing it from your IPFS node')
      expect(publications('a')[0]?.['target']).toMatch(/^Your IPFS node, kept by Orivon until /)
      expect(root(dialog).textContent).toContain('Your IPFS node published it, and Orivon\'s node keeps this version pinned until')
    })

    it('uploads instead when Settings chose the upload, and says so in the label, the step, the record and the result', async () => {
      inOrivon()
      mem.settings.set('publishFromNode', false)
      makeWiki('a', null)
      const dialog = await open('a')
      expect(root(dialog).textContent).toContain('Free pinning by Orivon')
      expect(root(dialog).textContent).not.toContain('Your IPFS node, in this page')
      expect(root(dialog).textContent).toContain('the wiki goes to Orivon\'s server')
      press(dialog, 'Publish')
      await finished(dialog)
      expect(mem.pinned[0]?.fromNode).toBe(false)
      expect(stepsShown()).toContain('Pinning it with Free pinning by Orivon')
      expect(stepsShown()).not.toContain('from your IPFS node')
      expect(publications('a')[0]?.['target']).toMatch(/^Free pinning by Orivon, until /)
      expect(root(dialog).textContent).toContain('Orivon keeps this version pinned until')
      expect(root(dialog).textContent).not.toContain('Your IPFS node')
    })

    it('uploads where the page can run no node, whatever Settings holds', async () => {
      mem.settings.set('publishFromNode', true)
      makeWiki('a', null)
      const dialog = await open('a')
      expect(root(dialog).textContent).toContain('Free pinning by Orivon')
      press(dialog, 'Publish')
      await finished(dialog)
      expect(mem.pinned[0]?.fromNode).toBe(false)
    })

    it('writes one error line naming the step and the route when a publish fails, for the bug report', async () => {
      inOrivon()
      makeWiki('a', null)
      mem.pinFailure = 'Your IPFS node could not connect to Orivon\'s node. Check your connection and try again.'
      const dialog = await open('a')
      press(dialog, 'Publish')
      await vi.waitFor(() => expect(dialog.actions.map((a) => a.label)).toContain('Try again'))
      expect(errors).toHaveBeenCalledTimes(1)
      expect(errors).toHaveBeenCalledWith(`[decentrawiki] publish failed at the pin step, free pinning from the page's IPFS node: ${mem.pinFailure}`)
      mem.settings.set('publishFromNode', false)
      const again = await open('a')
      press(again, 'Publish')
      await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2))
      expect(errors).toHaveBeenLastCalledWith(`[decentrawiki] publish failed at the pin step, free pinning as an upload: ${mem.pinFailure}`)
    })
  })
})

describe('the publishing choice in Settings', () => {
  const orivon = { orivon: { net: { connect () {} } } }
  const settingsView = () => new FakeElement('div')
  const routes = (view: FakeElement) => view.all('input').filter((input) => input.attrs['name'] === 'free-route')
  const saved = () => mem.settings.get('publishFromNode')

  beforeEach(() => {
    mem.settings.clear()
    mem.wikis.clear()
    mem.dialogs.length = 0
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('is offered only where the page can run an IPFS node', async () => {
    const outside = settingsView()
    await renderSettings(outside as never)
    expect(routes(outside)).toHaveLength(0)
    expect(outside.textContent).not.toContain('How free pinning gets the wiki')
    expect(outside.textContent).toContain('Free pinning by Orivon: what it keeps')

    vi.stubGlobal('window', orivon)
    const inside = settingsView()
    await renderSettings(inside as never)
    expect(inside.textContent).toContain('How free pinning gets the wiki')
    expect(routes(inside).map((input) => [input.attrs['value'], input.checked])).toEqual([['node', true], ['upload', false]])
    expect(inside.textContent).toContain('Your IPFS node, in this page: what it keeps')
    expect(inside.textContent).toContain('Publish uses your IPFS node, in this page')
  })

  it('stores the choice, speaks of the route chosen, and shows the saved choice after a reload', async () => {
    vi.stubGlobal('window', orivon)
    const view = settingsView()
    await renderSettings(view as never)
    const choose = (value: string) => {
      const radio = routes(view).find((input) => input.attrs['value'] === value) as FakeElement
      radio.checked = true
      radio.fire('change')
    }
    choose('upload')
    await vi.waitFor(() => expect(saved()).toBe(false))
    await vi.waitFor(() => expect(view.textContent).toContain('Free pinning by Orivon: what it keeps'))
    expect(routes(view).map((input) => input.checked)).toEqual([false, true])
    expect(view.textContent).toContain('Publish uses free pinning by Orivon')
    expect(view.textContent).toContain('which sees your IP address while it uploads')
    const reloaded = settingsView()
    await renderSettings(reloaded as never)
    expect(routes(reloaded).map((input) => input.checked)).toEqual([false, true])
    choose('node')
    await vi.waitFor(() => expect(saved()).toBe(true))
    await vi.waitFor(() => expect(view.textContent).toContain('Your IPFS node, in this page: what it keeps'))
  })
})

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
