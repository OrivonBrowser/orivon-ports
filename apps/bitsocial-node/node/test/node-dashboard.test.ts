// The node dashboard module: the node's numbers as they were, a section only where the app names it and the node answers, the board
// manager's form (its patch, what it says beside a field, what it does with a refusal) and the refresh that keeps it current.
import vm from 'node:vm'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultsOf, fieldOfError, patchOf, valuesOf } from '../../page/dashboard/board-form.js'
import { agoOf, inOf, splitDuration, toSeconds } from '../../page/dashboard/format.js'
import { classesOf, mountNodeDashboard } from '../../page/node-dashboard.js'
import { FakeDocument, FakeElement } from './support/fake-dom.js'

const BUILT_IN = { perPage: 15, pages: 10, bumpLimit: 300, archivePurgeSeconds: 172_800 }
const ADDRESS = '12D3KooWBoardOne'
const SECOND = '12D3KooWBoardTwo'

afterEach(() => { vi.useRealTimers() })

/** What the Worker's `view` answers for a board, with what a test changes. */
function view (address: string, over: Record<string, unknown> = {}) {
  const config = (over['config'] ?? {}) as Record<string, number>
  const effective = { ...BUILT_IN, ...config }
  return { address, hosted: true, started: true, managed: false, enabled: false, state: 'off', failures: 0, restarts: 0, lastError: null, lastErrorAt: null, since: null, nextAttemptAt: null, archivedThreads: 0, config, effective, capacity: effective.perPage * effective.pages, ...over }
}

function refusal (status: number, message: string) { return Object.assign(new Error(message), { status }) }

/** A node's control channel in memory: each call answers from `boards`, and a test sets `failWith` to make the next call fail. */
function fakeNode (boards: Array<ReturnType<typeof view>>, over: { reachability?: string } = {}) {
  const state = { boards, set: {} as Record<string, number>, failWith: null as Error | null, stats: { peer: 'QmPeer', peers: 4, reachability: over.reachability ?? 'public', repoBytes: 5_400_000, storageMax: 10_000_000_000 } as Record<string, unknown> }
  const calls: Array<[string, Record<string, unknown> | undefined]> = []
  const find = (address: unknown) => {
    const one = state.boards.find((board) => board.address === address)
    if (one === undefined) throw refusal(404, `${String(address)} is not a board this node hosts`)
    return one
  }
  const change = (board: ReturnType<typeof view>, patch: Record<string, number | null>, over: Record<string, unknown> = {}) => {
    const config = { ...board.config } as Record<string, number>
    for (const [key, value] of Object.entries(patch)) { if (value === null) delete config[key]; else config[key] = value }
    const { effective: _effective, capacity: _capacity, ...rest } = board
    Object.assign(board, view(board.address, { ...rest, config, ...over }))
    return board
  }
  const manager = vi.fn(async (call: string, body: Record<string, unknown> = {}) => {
    calls.push([call, body])
    if (state.failWith !== null) { const error = state.failWith; state.failWith = null; throw error }
    switch (call) {
      case 'boards': return { boards: state.boards, defaults: { ...BUILT_IN, ...state.set } }
      case 'defaults': return { set: state.set, effective: { ...BUILT_IN, ...state.set } }
      case 'defaults/set': { for (const [key, value] of Object.entries(body['defaults'] as Record<string, number | null>)) { if (value === null) delete state.set[key]; else state.set[key] = value } return { set: state.set, effective: { ...BUILT_IN, ...state.set } } }
      case 'enable': return change(find(body['address']), (body['config'] ?? {}) as Record<string, number | null>, { managed: true, enabled: true, state: 'running' })
      case 'disable': return change(find(body['address']), {}, { enabled: false, state: 'off' })
      case 'config': return change(find(body['address']), body['config'] as Record<string, number | null>)
      default: throw refusal(403, `${call} is not a call a page may make`)
    }
  })
  const handle = { reused: false, ports: { rpc: 9138 }, gatewayUrl: 'http://localhost:6473', stats: vi.fn(async () => ({ ...state.stats })), manager }
  return { state, calls, handle, manager }
}

function mount (options: { handle: unknown, features?: string[], name?: string, node?: unknown, sections?: unknown, refreshMs?: number }) {
  const doc = new FakeDocument()
  const root = doc.createElement('div')
  const win: Record<string, unknown> = {}
  const node = options.node ?? { ready: Promise.resolve(options.handle), error: null }
  const dashboard = mountNodeDashboard({ root: root as never, node: node as never, app: { name: options.name ?? '5chan', features: options.features ?? ['board-manager'] }, document: doc as never, window: win, now: () => 1_700_000_100_000, ...(options.refreshMs === undefined ? {} : { refreshMs: options.refreshMs }), ...(options.sections === undefined ? {} : { sections: options.sections as never }) })
  const by = (selector: string) => root.querySelector(selector)
  const card = (address: string): FakeElement => root.querySelector(`[data-nd-board="${address}"]`) as FakeElement
  const field = (owner: string, name: string): FakeElement => root.querySelector(`[data-nd-field="${name}"][data-nd-owner="${owner}"]`) as FakeElement
  const input = (owner: string, name: string): FakeElement => field(owner, name).querySelector('[data-nd-input]') as FakeElement
  const form = (owner: string): FakeElement => root.querySelector(`[data-nd-form="${owner}"]`) as FakeElement
  return { doc, root, win, dashboard, by, card, field, input, form }
}

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('the bundle a page loads', () => {
  it('is one script that gives the page BitsocialNodeDashboard.mountNodeDashboard, and draws with nothing but a document', async () => {
    const built = await build({ entryPoints: [new URL('../../page/node-dashboard.js', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'BitsocialNodeDashboard', platform: 'browser', write: false, logLevel: 'silent' })
    const sandbox: Record<string, unknown> = {}
    vm.runInNewContext(`${built.outputFiles[0]!.text}; this.api = BitsocialNodeDashboard`, sandbox)
    const api = sandbox['api'] as { mountNodeDashboard: typeof mountNodeDashboard, SECTIONS: unknown[] }
    expect(typeof api.mountNodeDashboard).toBe('function')
    const doc = new FakeDocument()
    const root = doc.createElement('div')
    const dashboard = api.mountNodeDashboard({ root: root as never, node: { ready: Promise.resolve(null), error: 'no node' }, app: { name: '5chan', features: [] }, document: doc as never, window: {} })
    await dashboard.started
    expect(root.querySelector('#state')?.textContent).toBe('Not running')
  })
})

describe('format', () => {
  it('splits a length of time into the largest unit that holds it exactly, and joins it again', () => {
    expect(splitDuration(172_800)).toEqual({ value: '2', unit: 'days' })
    expect(splitDuration(3_600)).toEqual({ value: '1', unit: 'hours' })
    expect(splitDuration(5_400)).toEqual({ value: '90', unit: 'minutes' })
    expect(splitDuration(45)).toEqual({ value: '45', unit: 'seconds' })
    expect(toSeconds('2', 'days')).toBe(172_800)
    expect(toSeconds('90', 'minutes')).toBe(5_400)
  })

  it('says how long ago and how long until', () => {
    expect(agoOf(1_000, 3_000)).toBe('just now')
    expect(agoOf(0, 12_000)).toBe('12 s ago')
    expect(agoOf(0, 5 * 60_000)).toBe('5 min ago')
    expect(agoOf(0, 3 * 3_600_000)).toBe('3 h ago')
    expect(inOf(30_000, 0)).toBe('in 30 s')
    expect(inOf(0, 5_000)).toBe('now')
  })
})

describe('the settings form: what a person typed becomes a patch', () => {
  const none = valuesOf({}, BUILT_IN)

  it('shows an empty field for a setting the board does not make, and the value for one it does', () => {
    expect(none).toEqual({ capacity: '', bumpLimit: '', purge: '', purgeUnit: 'days' })
    expect(valuesOf({ perPage: 3, pages: 1, archivePurgeSeconds: 3_600 }, { ...BUILT_IN, perPage: 3, pages: 1, archivePurgeSeconds: 3_600 })).toEqual({ capacity: '3', bumpLimit: '', purge: '1', purgeUnit: 'hours' })
    expect(defaultsOf(BUILT_IN)).toEqual({ capacity: '150', bumpLimit: '300', purge: '2', purgeUnit: 'days' })
  })

  it('sends nothing for a form nobody changed, and only what changed otherwise', () => {
    expect(patchOf(none, none)).toEqual({ patch: {}, errors: {} })
    expect(patchOf({ ...none, bumpLimit: '50' }, none).patch).toEqual({ bumpLimit: 50 })
    expect(patchOf({ ...none, capacity: '3' }, none).patch).toEqual({ perPage: 3, pages: 1 })
    expect(patchOf({ ...none, purge: '90', purgeUnit: 'minutes' }, none).patch).toEqual({ archivePurgeSeconds: 5_400 })
  })

  it('sends null for a field that had a value and was cleared, and nothing for one that was empty and stays so', () => {
    const set = valuesOf({ perPage: 3, pages: 1, bumpLimit: 20, archivePurgeSeconds: 3_600 }, { ...BUILT_IN, perPage: 3, pages: 1, bumpLimit: 20, archivePurgeSeconds: 3_600 })
    expect(patchOf({ ...set, bumpLimit: '' }, set).patch).toEqual({ bumpLimit: null })
    expect(patchOf({ ...set, capacity: '', purge: '' }, set).patch).toEqual({ perPage: null, pages: null, archivePurgeSeconds: null })
    expect(patchOf({ ...none, bumpLimit: '' }, none).patch).toEqual({})
  })

  it('takes a changed unit as a change, and the same length in another unit as none', () => {
    const set = { capacity: '', bumpLimit: '', purge: '1', purgeUnit: 'hours' }
    expect(patchOf({ ...set, purgeUnit: 'days' }, set).patch).toEqual({ archivePurgeSeconds: 86_400 })
    expect(patchOf({ ...set }, set).patch).toEqual({})
  })

  it('names the field of each value that is not a whole number above zero, and sends no patch for it', () => {
    for (const text of ['0', '-3', '2.5', 'three', '1e3', ' ']) {
      const { patch, errors } = patchOf({ ...none, bumpLimit: text === ' ' ? 'x' : text }, none)
      expect(errors, text).toEqual({ bumpLimit: 'Enter a whole number above 0.' })
      expect(patch).toEqual({})
    }
    expect(patchOf({ ...none, capacity: '0', purge: 'x' }, none).errors).toEqual({ capacity: 'Enter a whole number above 0.', purge: 'Enter a whole number above 0.' })
  })

  it('finds the field a refusal is about from the setting it names', () => {
    expect(fieldOfError('bumpLimit must be a positive integer')).toBe('bumpLimit')
    expect(fieldOfError('perPage must be a positive integer')).toBe('capacity')
    expect(fieldOfError('pages must be a positive integer')).toBe('capacity')
    expect(fieldOfError('archivePurgeSeconds must be a positive integer')).toBe('purge')
    expect(fieldOfError('the request is too large')).toBeNull()
  })
})

describe('the dashboard, with the node\'s numbers', () => {
  it('draws the state, the peer, the peers, the reachability and the repository, and leaves its state where a test reads it', async () => {
    const node = fakeNode([])
    const page = mount({ handle: node.handle, features: [] })
    await page.dashboard.started
    expect(page.win['nodeDashboard']).toBe(page.dashboard.view)
    expect(page.dashboard.view.state).toBe('Running')
    expect(page.dashboard.view.stats).toMatchObject({ peer: 'QmPeer', peers: 4, reachability: 'public' })
    expect(page.by('#state')?.textContent).toBe('Running')
    expect(page.by('#peer')?.textContent).toBe('QmPeer')
    expect(page.by('#peers')?.textContent).toBe('4')
    expect(page.by('#reach')?.textContent).toBe('Reachable from the internet')
    expect(page.by('#repo')?.textContent).toBe('5.4 MB of 10.00 GB')
    expect(page.by('#rpc')?.textContent).toBe('ws://localhost:9138/<key>')
    expect(page.by('#gateway')?.textContent).toBe('http://localhost:6473')
  })

  it('names the app in the state of a node another tab started', async () => {
    const node = fakeNode([])
    node.handle.reused = true
    const page = mount({ handle: node.handle, features: [], name: 'seedit' })
    await page.dashboard.started
    expect(page.dashboard.view.state).toBe('Running (started by another tab of seedit)')
  })

  it('says why when the node did not start', async () => {
    const page = mount({ handle: null, node: { ready: Promise.resolve(null), error: 'the node did not start: no key' } })
    await page.dashboard.started
    expect(page.dashboard.view).toMatchObject({ state: 'Not running', detail: 'the node did not start: no key' })
    expect(page.by('#detail')?.textContent).toBe('the node did not start: no key')
    expect(page.by('[data-nd-section]')).toBeNull()
  })

  it('keeps a number the node did not answer this time, and takes the ones it did', async () => {
    vi.useFakeTimers()
    const node = fakeNode([])
    const page = mount({ handle: node.handle, features: [], refreshMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(page.by('#peers')?.textContent).toBe('4')
    node.state.stats = { peer: null, peers: null, reachability: 'unknown', repoBytes: 6_000_000, storageMax: null }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(page.dashboard.view.stats).toMatchObject({ peer: 'QmPeer', peers: 4, reachability: 'public', repoBytes: 6_000_000, storageMax: 10_000_000_000 })
    expect(page.by('#repo')?.textContent).toBe('6.0 MB of 10.00 GB')
    page.dashboard.stop()
  })
})

describe('sections shown or hidden by what the app names and the node answers', () => {
  it('shows no board section in an app that does not name the feature, and asks the node nothing for it', async () => {
    const node = fakeNode([view(ADDRESS)])
    const page = mount({ handle: node.handle, features: [], name: 'seedit' })
    await page.dashboard.started
    expect(page.by('[data-nd-section]')).toBeNull()
    expect(page.dashboard.view.sections).toEqual({})
    expect(node.manager).not.toHaveBeenCalled()
    expect(page.by('#state')?.textContent).toBe('Running')
  })

  it('shows the board section in an app that names the feature, with a card for each board the node lists', async () => {
    const node = fakeNode([view(ADDRESS), view(SECOND, { managed: true, enabled: true, state: 'running' })])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    const section = page.by('[data-nd-section="board-manager"]') as FakeElement
    expect(section.hidden).toBe(false)
    expect(page.dashboard.view.sections['board-manager']).toMatchObject({ shown: true, error: null })
    expect(page.root.querySelectorAll('[data-nd-board]').map((one) => one.getAttribute('data-nd-board'))).toEqual([ADDRESS, SECOND])
    expect(page.card(ADDRESS).querySelector('[data-nd-state]')?.textContent).toBe('Off')
    expect(page.card(SECOND).querySelector('[data-nd-state]')?.textContent).toBe('Running')
  })

  it('shows no board section when the handle has no control call', async () => {
    const node = fakeNode([view(ADDRESS)])
    const { manager: _manager, ...bare } = node.handle
    const page = mount({ handle: bare })
    await page.dashboard.started
    expect(page.by('[data-nd-section]')).toBeNull()
  })

  it('hides the board section for good when the node has no board manager (503), refuses the call (403) or does not know it (404)', async () => {
    for (const status of [503, 403, 404]) {
      const node = fakeNode([view(ADDRESS)])
      node.state.failWith = refusal(status, 'no board manager')
      const page = mount({ handle: node.handle })
      await page.dashboard.started
      expect((page.by('[data-nd-section]') as FakeElement).hidden, String(status)).toBe(true)
      expect(page.dashboard.view.sections['board-manager'].shown).toBe(false)
      expect(node.manager.mock.calls.map(([call]) => call), String(status)).toEqual(['boards'])
    }
  })

  it('shows the section with what went wrong when the node does not answer, and draws the boards at the next refresh', async () => {
    vi.useFakeTimers()
    const node = fakeNode([view(ADDRESS)])
    node.state.failWith = new TypeError('Failed to fetch')
    const page = mount({ handle: node.handle, refreshMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect((page.by('[data-nd-section]') as FakeElement).hidden).toBe(false)
    expect(page.by('[role="alert"]')?.textContent).toBe('The boards could not be read: The node did not answer: Failed to fetch')
    expect(page.dashboard.view.sections['board-manager'].error).toContain('did not answer')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(page.card(ADDRESS)).not.toBeNull()
    expect(page.dashboard.view.sections['board-manager'].error).toBeNull()
    page.dashboard.stop()
  })

  it('takes a section from the list it is given, so a later feature adds one without touching the dashboard', async () => {
    const mountOne = vi.fn((context: { doc: FakeDocument }) => { const element = context.doc.createElement('section'); element.setAttribute('data-nd-section', 'listing'); return { element, refresh: async () => {} } })
    const page = mount({ handle: fakeNode([]).handle, features: ['listing'], sections: [{ name: 'listing', feature: 'listing', mount: mountOne }] })
    await page.dashboard.started
    expect(page.by('[data-nd-section="listing"]')).not.toBeNull()
    expect(mountOne).toHaveBeenCalledOnce()
  })

  it('puts an app\'s own class beside the module\'s, for the roles the app names', () => {
    const classes = classesOf({ button: 'btn', input: 'field' })
    expect(classes['button']).toBe('nd-button btn')
    expect(classes['input']).toBe('nd-input field')
    expect(classes['label']).toBe('nd-label')
  })
})

describe('a board\'s card', () => {
  it('says the manager\'s state in words, with the archived count, the last error and how long ago it was', async () => {
    const node = fakeNode([
      view(ADDRESS, { managed: true, enabled: true, state: 'running', since: 1_700_000_100_000 - 90_000, archivedThreads: 2 }),
      view(SECOND, { managed: true, enabled: true, state: 'backoff', failures: 3, nextAttemptAt: 1_700_000_100_000 + 20_000, lastError: 'the board did not answer', lastErrorAt: 1_700_000_100_000 - 120_000 })
    ])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    const first = page.card(ADDRESS).textContent
    expect(first).toContain('Running (started 2 min ago)')
    expect(page.card(ADDRESS).querySelector('[data-nd-archived]')?.textContent).toBe('2')
    expect(page.card(ADDRESS).querySelector('[data-nd-action="toggle"]')?.textContent).toBe('Turn manager off')
    const second = page.card(SECOND).textContent
    expect(second).toContain('Trying again in 20 s, after 3 failed starts in a row')
    expect(second).toContain('the board did not answer (2 min ago)')
  })

  it('says what happens to a thread past the limit: archived, deleted at once on a board with no archive, or not known, and where a board owner sets it', async () => {
    const node = fakeNode([view(ADDRESS, { noArchive: false }), view(SECOND, { noArchive: true }), view('12D3KooWBoardThree', { noArchive: null })])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    const past = (address: string) => page.card(address).querySelector('[data-nd-past-limit]')?.textContent ?? ''
    expect(past(ADDRESS)).toContain('Archived, then deleted after the delay')
    expect(past(SECOND)).toContain('Deleted at once, because this board has no archive')
    expect(past('12D3KooWBoardThree')).toContain('Not known')
    for (const address of [ADDRESS, SECOND, '12D3KooWBoardThree']) expect(past(address)).toContain('Set in 5chan: open the board, Board Settings, and "noArchive" under "features".')
  })

  it('says a board with a config the node no longer hosts, and hides the last error line when there is none', async () => {
    const node = fakeNode([view(ADDRESS, { hosted: false, managed: true })])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    expect(page.card(ADDRESS).textContent).toContain('This node does not host this board any more')
    expect(page.card(ADDRESS).querySelectorAll('dt').find((term) => term.textContent === 'Last error')?.hidden).toBe(true)
  })

  it('says each field in the words of a board owner, with the effective value beside a field left at its default', async () => {
    const node = fakeNode([view(ADDRESS)])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    const labels = page.form(ADDRESS).querySelectorAll('label').map((one) => one.textContent)
    expect(labels).toEqual(['Archive the oldest thread when the board has more than', 'Stop a thread moving up the board after', 'Delete an archived thread after'])
    const hints = page.form(ADDRESS).querySelectorAll('.nd-hint').map((one) => one.textContent)
    expect(hints).toEqual(['Using the default: 150 threads (15 a page, 10 pages)', 'Using the default: 300 replies', 'Using the default: 2 days'])
    expect(page.input(ADDRESS, 'capacity').getAttribute('placeholder')).toBe('150')
  })

  it('shows what a board sets and no default beside it, and the node-wide defaults it falls back to', async () => {
    const node = fakeNode([view(ADDRESS, { config: { perPage: 3, pages: 1, bumpLimit: 40 } })])
    node.state.set = { archivePurgeSeconds: 3_600 }
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    expect(page.input(ADDRESS, 'capacity').value).toBe('3')
    expect(page.input(ADDRESS, 'bumpLimit').value).toBe('40')
    expect(page.input(ADDRESS, 'purge').value).toBe('')
    const hints = page.form(ADDRESS).querySelectorAll('.nd-hint').map((one) => one.textContent)
    expect(hints).toEqual(['', '', 'Using the default: 2 days'])
    expect(page.input('defaults', 'purge').value).toBe('1')
  })
})

describe('what a person does on a card', () => {
  it('saves a changed capacity as a patch of the card\'s board, and shows what the node answers', async () => {
    const node = fakeNode([view(ADDRESS, { managed: true, enabled: true, state: 'running' })])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    page.input(ADDRESS, 'capacity').type('3')
    expect(page.form(ADDRESS).dispatch('submit')).toBe(true)
    await settle()
    expect(node.calls.at(-1)).toEqual(['config', { address: ADDRESS, config: { perPage: 3, pages: 1 } }])
    expect(page.form(ADDRESS).querySelector('[role="status"]')?.textContent).toBe('Saved. The manager starts again with the new limits.')
    expect(page.input(ADDRESS, 'capacity').value).toBe('3')
    expect(page.dashboard.view.sections['board-manager'].boards[0].capacity).toBe(3)
  })

  it('sends null for a field that was set and is now empty', async () => {
    const node = fakeNode([view(ADDRESS, { config: { bumpLimit: 40, archivePurgeSeconds: 3_600 } })])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    page.input(ADDRESS, 'bumpLimit').type('')
    page.form(ADDRESS).dispatch('submit')
    await settle()
    expect(node.calls.at(-1)).toEqual(['config', { address: ADDRESS, config: { bumpLimit: null } }])
    expect(page.input(ADDRESS, 'bumpLimit').value).toBe('')
    expect(page.input(ADDRESS, 'purge').value).toBe('1')
    expect(page.form(ADDRESS).querySelectorAll('.nd-hint').map((one) => one.textContent)[1]).toBe('Using the default: 300 replies')
  })

  it('asks the node nothing when nothing changed, and says so', async () => {
    const node = fakeNode([view(ADDRESS)])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    const asked = node.manager.mock.calls.length
    page.form(ADDRESS).dispatch('submit')
    await settle()
    expect(node.manager.mock.calls.length).toBe(asked)
    expect(page.form(ADDRESS).querySelector('[role="status"]')?.textContent).toBe('Nothing to change.')
  })

  it('shows a value that is not a number next to its field, and asks the node nothing', async () => {
    const node = fakeNode([view(ADDRESS)])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    const asked = node.manager.mock.calls.length
    page.input(ADDRESS, 'bumpLimit').type('lots')
    page.form(ADDRESS).dispatch('submit')
    await settle()
    expect(page.field(ADDRESS, 'bumpLimit').querySelector('[role="alert"]')?.textContent).toBe('Enter a whole number above 0.')
    expect(page.field(ADDRESS, 'capacity').querySelector('[role="alert"]')?.textContent).toBe('')
    expect(node.manager.mock.calls.length).toBe(asked)
    page.input(ADDRESS, 'bumpLimit').type('30')
    expect(page.field(ADDRESS, 'bumpLimit').querySelector('[role="alert"]')?.textContent).toBe('')
  })

  it('shows a value the node refuses (400) next to the field it names, and keeps what was typed', async () => {
    const node = fakeNode([view(ADDRESS)])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    page.input(ADDRESS, 'bumpLimit').type('30')
    node.state.failWith = refusal(400, 'bumpLimit must be a positive integer')
    page.form(ADDRESS).dispatch('submit')
    await settle()
    expect(page.field(ADDRESS, 'bumpLimit').querySelector('[role="alert"]')?.textContent).toBe('Enter a whole number above 0.')
    expect(page.input(ADDRESS, 'bumpLimit').value).toBe('30')
  })

  it('says a refusal that names no field in the form\'s own message: a board the node does not host, and a node that does not answer', async () => {
    const node = fakeNode([view(ADDRESS)])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    page.input(ADDRESS, 'bumpLimit').type('30')
    node.state.failWith = refusal(404, `${ADDRESS} is not a board this node hosts`)
    page.form(ADDRESS).dispatch('submit')
    await settle()
    const message = page.form(ADDRESS).querySelector('[role="status"]') as FakeElement
    expect(message.textContent).toBe(`${ADDRESS} is not a board this node hosts`)
    expect(message.getAttribute('data-nd-failed')).toBe('true')
    node.state.failWith = new TypeError('Failed to fetch')
    page.form(ADDRESS).dispatch('submit')
    await settle()
    expect(message.textContent).toBe('The node did not answer: Failed to fetch')
  })

  it('turns the manager on with what is typed in the form, and off with a call of its own', async () => {
    const node = fakeNode([view(ADDRESS)])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    const toggle = page.card(ADDRESS).querySelector('[data-nd-action="toggle"]') as FakeElement
    expect(toggle.textContent).toBe('Turn manager on')
    page.input(ADDRESS, 'capacity').type('3')
    toggle.click()
    await settle()
    expect(node.calls.at(-1)).toEqual(['enable', { address: ADDRESS, config: { perPage: 3, pages: 1 } }])
    expect(toggle.textContent).toBe('Turn manager off')
    expect(page.card(ADDRESS).querySelector('[data-nd-state]')?.textContent).toBe('Running')
    toggle.click()
    await settle()
    expect(node.calls.at(-1)).toEqual(['disable', { address: ADDRESS }])
    expect(toggle.textContent).toBe('Turn manager on')
    expect(page.card(ADDRESS).querySelector('[data-nd-state]')?.textContent).toBe('Off')
  })

  it('does not turn the manager on while a field holds something that is not a number', async () => {
    const node = fakeNode([view(ADDRESS)])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    page.input(ADDRESS, 'purge').type('soon')
    ;(page.card(ADDRESS).querySelector('[data-nd-action="toggle"]') as FakeElement).click()
    await settle()
    expect(node.calls.some(([call]) => call === 'enable')).toBe(false)
    expect(page.field(ADDRESS, 'purge').querySelector('[role="alert"]')?.textContent).toBe('Enter a whole number above 0.')
  })

  it('holds the card\'s buttons while a call is out, so a second click is not a second call', async () => {
    const node = fakeNode([view(ADDRESS)])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    const toggle = page.card(ADDRESS).querySelector('[data-nd-action="toggle"]') as FakeElement
    toggle.click()
    expect(toggle.disabled).toBe(true)
    toggle.click()
    await settle()
    expect(node.calls.filter(([call]) => call === 'enable')).toHaveLength(1)
    expect(toggle.disabled).toBe(false)
  })
})

describe('the settings every board takes', () => {
  it('saves a patch of defaults, shows the answer, and reads the boards again so each shows the new default', async () => {
    const node = fakeNode([view(ADDRESS)])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    page.input('defaults', 'bumpLimit').type('100')
    page.form('defaults').dispatch('submit')
    await settle()
    expect(node.calls.find(([call]) => call === 'defaults/set')).toEqual(['defaults/set', { defaults: { bumpLimit: 100 } }])
    expect(page.form('defaults').querySelector('[role="status"]')?.textContent).toBe('Saved. Running managers start again with the new settings.')
    expect(node.calls.at(-2)![0]).toBe('boards')
    expect(page.dashboard.view.sections['board-manager'].defaults).toEqual({ set: { bumpLimit: 100 }, effective: { ...BUILT_IN, bumpLimit: 100 } })
  })

  it('shows a refused value next to its field', async () => {
    const node = fakeNode([])
    const page = mount({ handle: node.handle })
    await page.dashboard.started
    page.input('defaults', 'purge').type('5')
    node.state.failWith = refusal(400, 'archivePurgeSeconds must be a positive integer')
    page.form('defaults').dispatch('submit')
    await settle()
    expect(page.field('defaults', 'purge').querySelector('[role="alert"]')?.textContent).toBe('Enter a whole number above 0.')
  })
})

describe('refresh', () => {
  it('draws a change the node made (a thread archived), adds a board that appeared and drops one that is gone', async () => {
    vi.useFakeTimers()
    const node = fakeNode([view(ADDRESS, { managed: true, enabled: true, state: 'running' })])
    const page = mount({ handle: node.handle, refreshMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(page.card(ADDRESS).querySelector('[data-nd-archived]')?.textContent).toBe('0')
    node.state.boards[0]!.archivedThreads = 1
    node.state.boards.push(view(SECOND))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(page.card(ADDRESS).querySelector('[data-nd-archived]')?.textContent).toBe('1')
    expect(page.card(SECOND)).not.toBeNull()
    expect(page.dashboard.view.sections['board-manager'].boards).toHaveLength(2)
    node.state.boards.splice(0, 1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(page.card(ADDRESS)).toBeNull()
    expect(page.card(SECOND)).not.toBeNull()
    page.dashboard.stop()
  })

  it('leaves the form alone while a person has changed something in it, and shows the node\'s state beside it', async () => {
    vi.useFakeTimers()
    const node = fakeNode([view(ADDRESS, { config: { bumpLimit: 40 } })])
    const page = mount({ handle: node.handle, refreshMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(page.input(ADDRESS, 'bumpLimit').value).toBe('40')
    page.input(ADDRESS, 'capacity').type('7')
    node.state.boards[0] = view(ADDRESS, { config: { bumpLimit: 55 }, state: 'running', managed: true, enabled: true })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(page.input(ADDRESS, 'capacity').value).toBe('7')
    expect(page.input(ADDRESS, 'bumpLimit').value).toBe('40')
    expect(page.card(ADDRESS).querySelector('[data-nd-state]')?.textContent).toBe('Running')
    page.dashboard.stop()
  })

  it('refills a form nobody changed from what the node says', async () => {
    vi.useFakeTimers()
    const node = fakeNode([view(ADDRESS, { config: { bumpLimit: 40 } })])
    const page = mount({ handle: node.handle, refreshMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)
    node.state.boards[0] = view(ADDRESS, { config: { bumpLimit: 55 } })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(page.input(ADDRESS, 'bumpLimit').value).toBe('55')
    page.dashboard.stop()
  })

  it('stops refreshing when told to', async () => {
    vi.useFakeTimers()
    const node = fakeNode([view(ADDRESS)])
    const page = mount({ handle: node.handle, refreshMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)
    page.dashboard.stop()
    const asked = node.manager.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(node.manager.mock.calls.length).toBe(asked)
  })
})
