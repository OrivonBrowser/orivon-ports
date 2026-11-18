// The dashboard's challenges section, drawn into a small stand-in for a document over a node's calls in memory: what a board's challenges
// say in words, adding, changing, removing and ordering them from the installed list, the excludes, the host a challenge reaches before it is
// added, what changes before an apply, and the apply itself (a refusal, a list that changed meanwhile, a refresh that must not undo an edit).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountNodeDashboard } from '../../page/node-dashboard.js'
import { describeChallenges, registerChallenges } from '../worker/challenges.js'
import { FakeDocument, FakeElement } from './support/fake-dom.js'

afterEach(() => { vi.useRealTimers() })

const BOARD = '12D3KooWBoardOne'
const SECOND = 'second.bso'
const WORD = { name: '@bitsocial/wordfilter-challenge', options: { 'wordfilter/v1/rules': '[{"src":"cloud","dst":"butt"}]' }, publicOptions: ['wordfilter/v1/rules'], exclude: [{ roles: ['moderator', 'admin'] }] }
const B64 = { name: '@bitsocial/base64-challenge' }
const PAGES = { posts: [{ name: 'active' }] }

const registry: Record<string, unknown> = { 'text-math': () => ({ description: 'Ask a math question.', type: 'text/plain', optionInputs: [{ option: 'difficulty', label: 'Difficulty', default: 'easy' }] }) }
registerChallenges(registry)
const LIST = describeChallenges(registry, { filesDir: '/files' })

function refusal (status: number, message: string, extra: Record<string, unknown> = {}) { return Object.assign(new Error(message), { status, ...extra }) }

/** A node's challenge calls in memory, answering as the Worker does: an apply replaces `challenges` and keeps every other setting. */
function fakeNode (settings: Record<string, Record<string, unknown>> = { [BOARD]: { challenges: [WORD], pages: PAGES, fetchThumbnailUrls: true } }) {
  const state = { settings, failWith: null as Error | null, boardsFail: null as Error | null, ethereum: undefined as Record<string, unknown> | undefined }
  const applied: Array<Record<string, unknown>> = []
  const challenges = vi.fn(async (call: string, body: Record<string, any> = {}) => {
    if (call === 'boards' && state.boardsFail !== null) throw state.boardsFail
    if (call === 'list') return structuredClone(LIST)
    if (call === 'boards') return { boards: Object.keys(state.settings).map((address) => ({ address, publicKey: address, started: true })), ...(state.ethereum === undefined ? {} : { ethereum: structuredClone(state.ethereum) }) }
    const current = state.settings[body['address']]
    if (current === undefined) throw refusal(404, `${String(body['address'])} is not a board this node hosts`)
    const view = () => ({ address: body['address'], challenges: structuredClone(current['challenges'] ?? []), otherSettings: Object.keys(current).filter((key) => key !== 'challenges').sort() })
    if (call === 'board') return view()
    if (state.failWith !== null) { const error = state.failWith; state.failWith = null; throw error }
    if (body['expect'] !== undefined && JSON.stringify(body['expect']) !== JSON.stringify(current['challenges'] ?? [])) throw refusal(409, 'The challenges changed since you read them.')
    applied.push(structuredClone(body))
    current['challenges'] = structuredClone(body['challenges'])
    return view()
  })
  const handle = { reused: false, ports: { rpc: 9138 }, gatewayUrl: 'http://localhost:6473', stats: vi.fn(async () => ({ peer: 'QmPeer', peers: 1, reachability: 'public', repoBytes: 1, storageMax: 2 })), challenges }
  return { state, applied, challenges, handle }
}

function mount (options: { handle: unknown, term?: string, name?: string, features?: string[], refreshMs?: number }) {
  const doc = new FakeDocument()
  const root = doc.createElement('div')
  const dashboard = mountNodeDashboard({ root: root as never, node: { ready: Promise.resolve(options.handle), error: null } as never, app: { name: options.name ?? '5chan', ...(options.term === undefined ? { term: 'board' } : { term: options.term }), features: options.features ?? ['challenges'] } as never, document: doc as never, window: {}, now: () => 1_700_000_100_000, ...(options.refreshMs === undefined ? {} : { refreshMs: options.refreshMs }) })
  const by = (selector: string) => root.querySelector(selector)
  const card = (address = BOARD): FakeElement => root.querySelector(`[data-nd-challenge-board="${address}"]`) as FakeElement
  const rows = (address = BOARD): FakeElement[] => card(address).querySelectorAll('[data-nd-challenge-row]')
  const part = (parent: FakeElement, name: string): FakeElement | null => parent.querySelector(`[data-nd-part="${name}"]`)
  const act = async (parent: FakeElement, action: string) => { (parent.querySelector(`[data-nd-action="${action}"]`) as FakeElement).click(); await flush() }
  const field = (row: FakeElement, option: string): FakeElement => row.querySelector(`[data-nd-field="${option}"]`) as FakeElement
  const input = (row: FakeElement, option: string, kind = 'value'): FakeElement => field(row, option).querySelector(`[data-nd-input="${kind}"]`) as FakeElement
  const changes = (address = BOARD) => (part(card(address), 'changes')?.querySelectorAll('li') ?? []).map((one) => one.textContent)
  const add = async (name: string, address = BOARD) => {
    const picker = card(address).querySelector('[data-nd-input="add"]') as FakeElement
    picker.value = name
    picker.dispatch('change')
    await act(card(address), 'add')
  }
  return { doc, root, dashboard, by, card, rows, part, act, field, input, changes, add }
}

const flush = async () => { for (let i = 0; i < 5; i++) await (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((resolve) => setTimeout(resolve, 0))) }
const ready = async (node = fakeNode(), options: Partial<Parameters<typeof mount>[0]> = {}) => { const page = mount({ handle: node.handle, ...options }); await page.dashboard.started; await flush(); return { node, page } }

describe('which boards the section shows, and when', () => {
  it('shows nothing in an app that does not name it, and asks the node nothing for it', async () => {
    const node = fakeNode()
    const page = mount({ handle: node.handle, features: [], name: 'seedit' })
    await page.dashboard.started
    expect(page.by('[data-nd-section="challenges"]')).toBeNull()
    expect(node.challenges).not.toHaveBeenCalled()
  })

  it('shows nothing when the handle has no challenge call, and hides for good when the node answers 503, 403 or 404 to the boards', async () => {
    const { challenges: _challenges, ...bare } = fakeNode().handle
    const none = mount({ handle: bare })
    await none.dashboard.started
    expect(none.by('[data-nd-section="challenges"]')).toBeNull()
    for (const status of [503, 403, 404]) {
      const node = fakeNode()
      node.state.boardsFail = refusal(status, 'no challenges')
      const { page } = await ready(node)
      expect((page.by('[data-nd-section="challenges"]') as FakeElement).hidden, String(status)).toBe(true)
      expect(node.challenges.mock.calls.filter(([call]) => call === 'board')).toEqual([])
    }
  })

  it('draws a card for each board the node hosts, and says so when it hosts none, in the app\'s own word', async () => {
    const { page } = await ready(fakeNode({ [BOARD]: { challenges: [] }, [SECOND]: {} }))
    expect(page.root.querySelectorAll('[data-nd-challenge-board]').map((one) => one.getAttribute('data-nd-challenge-board'))).toEqual([BOARD, SECOND])
    const empty = await ready(fakeNode({}), { name: 'seedit', term: 'community' })
    expect(empty.page.by('[data-nd-section="challenges"]')?.textContent).toContain('This node hosts no communities yet.')
    const board = await ready(fakeNode({}))
    expect(board.page.by('[data-nd-section="challenges"]')?.textContent).toContain('This node hosts no boards yet.')
  })

  it('says "community" and never "board" in an app that calls it that, in the headings and the sentences alike', async () => {
    const { page } = await ready(fakeNode(), { name: 'seedit', term: 'community' })
    const text = page.by('[data-nd-section="challenges"]')?.textContent ?? ''
    expect(text).toMatch(/community/i)
    expect(text).not.toMatch(/\bboards?\b/i)
    const five = await ready(fakeNode())
    const fiveText = five.page.by('[data-nd-section="challenges"]')?.textContent ?? ''
    expect(fiveText).toMatch(/\bboard\b/i)
    expect(fiveText).not.toMatch(/communit/i)
  })
})

describe('a board\'s current challenges, in words', () => {
  it('names each with what it asks of a poster, and who it does not ask, from the board\'s own settings', async () => {
    const { page } = await ready(fakeNode({ [BOARD]: { challenges: [WORD, { ...B64, description: 'No pasted pictures', pendingApproval: true }, { name: 'text-math', options: { difficulty: 'hard' }, exclude: [{ postScore: 5 }, { publicKeys: ['12D3KooWFriend'] }] }] } }))
    const [word, base, math] = page.rows()
    expect(page.part(word!, 'title')?.textContent).toContain('wordfilter')
    expect(page.part(word!, 'asks')?.textContent).toMatch(/nothing/i)
    expect(page.part(word!, 'excludes')?.textContent).toBe('Not asked of: a moderator or an admin.')
    expect(page.part(base!, 'title')?.textContent).toContain('base64')
    expect(page.part(base!, 'description')?.textContent).toContain('No pasted pictures')
    expect(page.part(base!, 'pending')?.textContent).toMatch(/moderator.*approve/i)
    expect(page.part(math!, 'asks')?.textContent).toBe('Ask a math question.')
    expect(page.part(math!, 'excludes')?.textContent).toBe('Not asked of: an author with a post score of at least 5; or the author with the key 12D3KooWFriend.')
  })

  it('says a board with no challenges asks none, and shows the challenge of a package this node does not have, kept and marked', async () => {
    const empty = await ready(fakeNode({ [BOARD]: { challenges: [] } }))
    expect(empty.page.card().textContent).toContain('This board asks nothing of a poster: anyone can post.')
    const { page } = await ready(fakeNode({ [BOARD]: { challenges: [{ name: '@bitsocial/mintpass-challenge', options: { a: 'b' } }, { path: '/home/x/mine.js' }] } }))
    const [mint, file] = page.rows()
    expect(page.part(mint!, 'asks')?.textContent).toMatch(/not available on this node/i)
    expect(page.part(file!, 'asks')?.textContent).toMatch(/file on the computer|from a file/i)
    expect(page.part(mint!, 'title')?.textContent).toContain('mintpass')
    expect(mint!.querySelector('[data-nd-action="edit"]')).toBeNull()
    expect(mint!.querySelector('[data-nd-action="remove"]')).not.toBeNull()
  })

  it('says which other settings of the board an apply keeps as they are', async () => {
    const { page } = await ready()
    expect(page.part(page.card(), 'kept')?.textContent).toBe('Everything else about this board stays as it is: fetchThumbnailUrls, pages.')
  })

  it('says a board could not be read when the node refuses it, and still draws the others', async () => {
    const node = fakeNode({ [BOARD]: { challenges: [WORD] }, [SECOND]: { challenges: [] } })
    const original = node.challenges.getMockImplementation()!
    node.challenges.mockImplementation(async (call, body) => { if (call === 'board' && body?.['address'] === SECOND) throw refusal(500, 'the board is not answering'); return original(call, body) })
    const { page } = await ready(node)
    expect(page.rows()).toHaveLength(1)
    expect(page.card(SECOND).textContent).toContain('The challenges could not be read: the board is not answering')
  })
})

describe('adding a challenge', () => {
  it('lists what is installed, built in and bundled, and the ones left out with their reason, which cannot be chosen', async () => {
    const { page } = await ready()
    const picker = page.card().querySelector('[data-nd-input="add"]') as FakeElement
    const options = picker.querySelectorAll('option')
    const names = options.map((one) => one.getAttribute('value'))
    expect(names).toEqual(expect.arrayContaining(['@bitsocial/wordfilter-challenge', '@bitsocial/base64-challenge', 'text-math', '@bitsocial/captcha-canvas-challenge']))
    const mint = options.find((one) => one.getAttribute('value') === '@bitsocial/mintpass-challenge')!
    expect(mint.disabled).toBe(true)
    expect(mint.textContent).toMatch(/mintpass.*native module/)
  })

  it('names the host a challenge reaches, in one line, before it is added, and none for one that reaches none', async () => {
    const { page } = await ready()
    const picker = page.card().querySelector('[data-nd-input="add"]') as FakeElement
    picker.value = '@bitsocial/spam-blocker-challenge'
    picker.dispatch('change')
    expect(page.part(page.card(), 'add-host')?.textContent).toBe('Connects to spamblocker.bitsocial.net: an ordinary web server, which counts as a Level 1 (Web2) connection for the Web3 Score.')
    picker.value = '@bitsocial/base64-challenge'
    picker.dispatch('change')
    expect(page.part(page.card(), 'add-host')?.textContent).toBe('')
    expect(page.part(page.card(), 'add-asks')?.textContent).toMatch(/base64/i)
  })

  it('puts the new challenge last, with the options marked required filled with their defaults, and says what that changes', async () => {
    const { page } = await ready()
    await page.add('@bitsocial/r9k-challenge')
    const rows = page.rows()
    expect(rows).toHaveLength(2)
    expect(page.input(rows[1]!, 'statePath').value).toBe('/files/challenges/r9k-state.json')
    expect(page.input(rows[1]!, 'minimumOriginalContentLength').value).toBe('16')
    expect(page.input(rows[1]!, 'maxPenaltySeconds').value).toBe('')
    expect(page.changes()).toEqual(['Added r9k as number 2.'])
  })

  it('names the host of a challenge again on its row once it is added', async () => {
    const { page } = await ready()
    await page.add('@bitsocial/flags-challenge')
    expect(page.part(page.rows()[1]!, 'hosts')?.textContent).toContain('Connects to flags.5chan.app')
  })

  it('asks nothing of the node and writes nothing until the apply', async () => {
    const { node, page } = await ready()
    await page.add('@bitsocial/base64-challenge')
    expect(node.applied).toEqual([])
    expect(node.state.settings[BOARD]!['challenges']).toEqual([WORD])
  })
})

describe('the "Require an Orivon ID" preset', () => {
  const ID = '@orivon/id-challenge'
  const picker = (page: ReturnType<typeof mount>) => page.card().querySelector('[data-nd-input="add"]') as FakeElement
  const groups = (page: ReturnType<typeof mount>) => picker(page).querySelectorAll('optgroup')

  it('is offered first, in a group of presets, in the words a board owner knows it by, before the installed challenges', async () => {
    const { page } = await ready()
    const [presets, installed] = groups(page)
    expect(groups(page).map((one) => one.getAttribute('label'))).toEqual(['Presets', 'Installed challenges'])
    expect(presets!.querySelectorAll('option').map((one) => [one.getAttribute('value'), one.textContent])).toEqual([[ID, 'Require an Orivon ID']])
    expect(installed!.querySelectorAll('option').map((one) => one.getAttribute('value'))).not.toContain(ID)
    expect(installed!.querySelectorAll('option').map((one) => one.getAttribute('value'))).toEqual(expect.arrayContaining(['@bitsocial/wordfilter-challenge', 'text-math']))
    expect(picker(page).querySelectorAll('option')[0]!.getAttribute('value')).toBe('')
  })

  it('is not offered by a node that does not have the challenge, and the installed ones are then listed as they were', async () => {
    const node = fakeNode()
    const original = node.challenges.getMockImplementation()!
    node.challenges.mockImplementation(async (call, body) => {
      const answer = await original(call, body)
      return call === 'list' ? { ...answer, challenges: (answer as typeof LIST).challenges.filter((one) => one.name !== ID) } : answer
    })
    const { page } = await ready(node)
    expect(groups(page).map((one) => one.getAttribute('label'))).toEqual(['Installed challenges'])
    expect(picker(page).querySelectorAll('option').map((one) => one.getAttribute('value'))).not.toContain(ID)
  })

  it('says before it is added what it asks, that a board with nobody holding an ID refuses every post, and the Ethereum providers it reads through', async () => {
    const { page } = await ready()
    picker(page).value = ID
    picker(page).dispatch('change')
    const asks = page.part(page.card(), 'add-asks')!.textContent
    expect(asks).toMatch(/author name must be an Orivon ID/)
    expect(asks).toContain('id.orivonstack.eth')
    expect(asks).toMatch(/if that site has not opened yet, no author has one and this board refuses every post/i)
    expect(page.part(page.card(), 'add-host')?.textContent).toMatch(/^Connects to ethereum-rpc\.publicnode\.com, eth\.drpc\.org, .*, 1rpc\.io and eth-pokt\.nodies\.app: an ordinary web server, which counts as a Level 1 \(Web2\) connection for the Web3 Score\.$/)
    expect(page.card().textContent).toContain('refuses every post. Connects to ethereum-rpc.publicnode.com')
  })

  it('says "community" for the board in an app that calls it that', async () => {
    const { page } = await ready(fakeNode(), { name: 'seedit', term: 'community' })
    picker(page).value = ID
    picker(page).dispatch('change')
    expect(page.part(page.card(), 'add-asks')?.textContent).toMatch(/this community refuses every post/)
    expect(page.part(page.card(), 'add-asks')?.textContent).not.toMatch(/\bboard\b/i)
  })

  it('adds the challenge with its defaults: no option, nothing published, nobody let through, and says so', async () => {
    const { node, page } = await ready()
    await page.add(ID)
    const row = page.rows()[1]!
    expect(page.part(row, 'title')?.textContent).toBe('2. Orivon ID')
    expect(page.changes()).toEqual(['Added Orivon ID as number 2.'])
    expect(page.part(row, 'excludes')?.textContent).toBe('')
    expect(page.part(row, 'hosts')?.textContent).toContain('Connects to ethereum-rpc.publicnode.com')
    expect(page.input(row, 'error').value).toBe('')
    expect(node.applied).toEqual([])
    await page.act(page.card(), 'apply')
    expect(node.applied).toEqual([{ address: BOARD, challenges: [WORD, { name: ID }], expect: [WORD] }])
    expect(node.state.settings[BOARD]).toEqual({ challenges: [WORD, { name: ID }], pages: PAGES, fetchThumbnailUrls: true })
  })

  it('shows the message a refused poster is told as the option\'s default, and writes the owner\'s own message when they type one', async () => {
    const { node, page } = await ready(fakeNode({ [BOARD]: { challenges: [], pages: PAGES } }))
    await page.add(ID)
    const row = page.rows()[0]!
    expect(page.field(row, 'error').textContent).toContain('Posting here needs an Orivon ID')
    page.input(row, 'error').type('IDs only: https://id.orivonstack.eth')
    await page.act(page.card(), 'apply')
    expect(node.state.settings[BOARD]!['challenges']).toEqual([{ name: ID, options: { error: 'IDs only: https://id.orivonstack.eth' } }])
  })

  it('removes the preset again, and the board is as it was before', async () => {
    const node = fakeNode()
    const { page } = await ready(node)
    await page.add(ID)
    await page.act(page.card(), 'apply')
    expect(page.rows()).toHaveLength(2)
    await page.act(page.rows()[1]!, 'remove')
    expect(page.changes()).toEqual(['Removed Orivon ID (it was number 2).'])
    await page.act(page.card(), 'apply')
    expect(node.state.settings[BOARD]).toEqual({ challenges: [WORD], pages: PAGES, fetchThumbnailUrls: true })
    expect(page.rows()).toHaveLength(1)
  })

  it('is never on a board by itself: a board that names no challenge still asks nothing', async () => {
    const { node, page } = await ready(fakeNode({ [BOARD]: { challenges: [] } }))
    expect(page.rows()).toEqual([])
    expect(page.card().textContent).toContain('This board asks nothing of a poster: anyone can post.')
    expect(node.applied).toEqual([])
  })
})

describe('applying', () => {
  it('has nothing to apply on a board nobody changed, and shows what an apply changes as soon as something is', async () => {
    const { page } = await ready()
    expect((page.card().querySelector('[data-nd-action="apply"]') as FakeElement).disabled).toBe(true)
    expect(page.changes()).toEqual([])
    await page.add('@bitsocial/base64-challenge')
    expect((page.card().querySelector('[data-nd-action="apply"]') as FakeElement).disabled).toBe(false)
    expect(page.changes()).toEqual(['Added base64 as number 2.'])
  })

  it('adds wordfilter with a word and base64, and the board then holds both in order with every other setting as it was', async () => {
    const { node, page } = await ready(fakeNode({ [BOARD]: { challenges: [], pages: PAGES, fetchThumbnailUrls: true, maxPendingApprovalCount: 3 } }))
    await page.add('@bitsocial/wordfilter-challenge')
    const word = page.rows()[0]!
    expect(page.input(word, 'wordfilter/v1/rules').value).toBe('[]')
    expect((page.input(word, 'wordfilter/v1/rules', 'publish')).checked).toBe(true)
    page.input(word, 'wordfilter/v1/rules').type('[{"src":"cloud","dst":"butt"}]')
    await page.add('@bitsocial/base64-challenge')
    expect(page.changes()).toEqual(['Added wordfilter as number 1.', 'Added base64 as number 2.'])
    await page.act(page.card(), 'apply')
    expect(node.applied).toEqual([{ address: BOARD, challenges: [{ name: '@bitsocial/wordfilter-challenge', options: { 'wordfilter/v1/rules': '[{"src":"cloud","dst":"butt"}]' }, publicOptions: ['wordfilter/v1/rules'] }, { name: '@bitsocial/base64-challenge' }], expect: [] }])
    expect(node.state.settings[BOARD]).toEqual({ challenges: [{ name: '@bitsocial/wordfilter-challenge', options: { 'wordfilter/v1/rules': '[{"src":"cloud","dst":"butt"}]' }, publicOptions: ['wordfilter/v1/rules'] }, { name: '@bitsocial/base64-challenge' }], pages: PAGES, fetchThumbnailUrls: true, maxPendingApprovalCount: 3 })
    expect(page.part(page.card(), 'message')?.textContent).toBe('Applied. The board now asks these challenges, in this order.')
    expect(page.changes()).toEqual([])
    expect((page.card().querySelector('[data-nd-action="apply"]') as FakeElement).disabled).toBe(true)
  })

  it('removes one, and the board has the others; the list the page read is what the node is told to expect', async () => {
    const node = fakeNode({ [BOARD]: { challenges: [WORD, B64], pages: PAGES } })
    const { page } = await ready(node)
    await page.act(page.rows()[0]!, 'remove')
    expect(page.rows()).toHaveLength(1)
    expect(page.changes()).toEqual(['Removed wordfilter (it was number 1).'])
    await page.act(page.card(), 'apply')
    expect(node.applied[0]).toEqual({ address: BOARD, challenges: [B64], expect: [WORD, B64] })
    expect(node.state.settings[BOARD]).toEqual({ challenges: [B64], pages: PAGES })
  })

  it('moves a challenge up or down, never past an end, and applies the new order', async () => {
    const node = fakeNode({ [BOARD]: { challenges: [WORD, B64, { name: 'text-math' }] } })
    const { page } = await ready(node)
    await page.act(page.rows()[2]!, 'up')
    await page.act(page.rows()[0]!, 'up')
    expect(page.rows().map((one) => page.part(one, 'title')?.textContent)).toEqual([expect.stringContaining('wordfilter'), expect.stringContaining('text-math'), expect.stringContaining('base64')])
    await page.act(page.rows()[2]!, 'down')
    expect(page.changes()).toEqual(['Moved text-math from number 3 to number 2.'])
    await page.act(page.card(), 'apply')
    expect((node.state.settings[BOARD]!['challenges'] as Array<{ name: string }>).map((one) => one.name)).toEqual([WORD.name, 'text-math', B64.name])
  })

  it('changes one option and writes that entry alone, leaving the other entries as the board had them', async () => {
    const node = fakeNode({ [BOARD]: { challenges: [WORD, { name: '@bitsocial/base64-challenge', options: { maxLength: '100' } }] } })
    const { page } = await ready(node)
    await page.act(page.rows()[1]!, 'edit')
    page.input(page.rows()[1]!, 'maxLength').type('200')
    expect(page.changes()).toEqual(['Changed base64: the options maxLength.'])
    await page.act(page.card(), 'apply')
    expect(node.state.settings[BOARD]!['challenges']).toEqual([WORD, { name: '@bitsocial/base64-challenge', options: { maxLength: '200' } }])
  })

  it('discards what was changed, and the board is as it was read', async () => {
    const { node, page } = await ready()
    await page.add('@bitsocial/base64-challenge')
    await page.act(page.card(), 'discard')
    expect(page.rows()).toHaveLength(1)
    expect(page.changes()).toEqual([])
    expect(node.applied).toEqual([])
  })
})

describe('what is not accepted', () => {
  it('asks for a required option that has no value, next to its field, and applies nothing', async () => {
    const { node, page } = await ready()
    await page.add('@bitsocial/evm-contract-challenge')
    await page.act(page.card(), 'apply')
    const evm = page.rows()[1]!
    expect(page.field(evm, 'address').querySelector('[data-nd-error]')?.textContent).toMatch(/required/i)
    expect(page.field(evm, 'abi').querySelector('[data-nd-error]')?.textContent).toMatch(/required/i)
    expect(page.field(evm, 'chainTicker').querySelector('[data-nd-error]')?.textContent).toBe('')
    expect(node.applied).toEqual([])
    expect(page.part(page.card(), 'message')?.textContent).toMatch(/fix the fields/i)
    page.input(evm, 'address').type('0x0000000000000000000000000000000000000001')
    expect(page.field(evm, 'address').querySelector('[data-nd-error]')?.textContent).toBe('')
  })

  it('shows the node\'s refusal on the challenge it is about, keeps what was typed, and applies nothing', async () => {
    const node = fakeNode()
    const { page } = await ready(node)
    await page.add('@bitsocial/voucher-challenge')
    page.input(page.rows()[1]!, 'vouchers').type('A1,B2')
    node.state.failWith = refusal(400, 'Challenge 2 (voucher): the option vouchers is not one this challenge has.', { failures: [{ index: 1, name: '@bitsocial/voucher-challenge', option: 'vouchers', message: 'the option vouchers is not one this challenge has' }] })
    await page.act(page.card(), 'apply')
    expect(page.rows()[1]!.textContent).toContain('the option vouchers is not one this challenge has')
    expect(page.field(page.rows()[1]!, 'vouchers').querySelector('[data-nd-error]')?.textContent).toContain('not one this challenge has')
    expect(page.input(page.rows()[1]!, 'vouchers').value).toBe('A1,B2')
    expect(page.part(page.card(), 'message')?.textContent).toContain('Challenge 2 (voucher)')
    expect(node.state.settings[BOARD]!['challenges']).toEqual([WORD])
  })

  it('says the board changed meanwhile, writes nothing, and offers to read it again', async () => {
    const node = fakeNode()
    const { page } = await ready(node)
    await page.add('@bitsocial/base64-challenge')
    node.state.settings[BOARD]!['challenges'] = [WORD, { name: 'text-math' }]
    await page.act(page.card(), 'apply')
    expect(page.part(page.card(), 'message')?.textContent).toMatch(/changed since/i)
    expect(node.applied).toEqual([])
    await page.act(page.card(), 'reload')
    expect(page.rows()).toHaveLength(2)
    expect(page.changes()).toEqual([])
  })

  it('says the node did not answer when it does not, and keeps the draft', async () => {
    const node = fakeNode()
    const { page } = await ready(node)
    await page.add('@bitsocial/base64-challenge')
    node.state.failWith = new TypeError('Failed to fetch')
    await page.act(page.card(), 'apply')
    expect(page.part(page.card(), 'message')?.textContent).toBe('The node did not answer: Failed to fetch')
    expect(page.rows()).toHaveLength(2)
  })
})

describe('excludes', () => {
  it('adds a rule for the moderators and admins, in the shape 0.0.132 names, and applies it', async () => {
    const node = fakeNode({ [BOARD]: { challenges: [B64] } })
    const { page } = await ready(node)
    await page.act(page.rows()[0]!, 'edit')
    await page.act(page.rows()[0]!, 'add-rule')
    const rule = page.rows()[0]!.querySelector('[data-nd-rule="0"]') as FakeElement
    for (const role of ['moderator', 'admin']) {
      const box = rule.querySelector(`[data-nd-field="roles"] [data-nd-value="${role}"]`) as FakeElement
      box.checked = true
      box.dispatch('change')
    }
    expect(page.changes()).toEqual(['Changed base64: who it lets through.'])
    await page.act(page.card(), 'apply')
    expect(node.state.settings[BOARD]!['challenges']).toEqual([{ name: '@bitsocial/base64-challenge', exclude: [{ roles: ['moderator', 'admin'] }] }])
    expect(page.part(page.rows()[0]!, 'excludes')?.textContent).toBe('Not asked of: a moderator or an admin.')
  })

  it('takes keys and names into their own fields, and refuses a name where a key goes, next to the field', async () => {
    const node = fakeNode({ [BOARD]: { challenges: [B64] } })
    const { page } = await ready(node)
    await page.act(page.rows()[0]!, 'edit')
    await page.act(page.rows()[0]!, 'add-rule')
    const rule = page.rows()[0]!.querySelector('[data-nd-rule="0"]') as FakeElement
    ;(rule.querySelector('[data-nd-field="publicKeys"] [data-nd-input="value"]') as FakeElement).type('alice.eth')
    await page.act(page.card(), 'apply')
    expect(rule.querySelector('[data-nd-field="publicKeys"] [data-nd-error]')?.textContent).toMatch(/key/i)
    expect(node.applied).toEqual([])
    ;(rule.querySelector('[data-nd-field="publicKeys"] [data-nd-input="value"]') as FakeElement).type('12D3KooWAuthor')
    ;(rule.querySelector('[data-nd-field="names"] [data-nd-input="value"]') as FakeElement).type('alice.eth')
    await page.act(page.card(), 'apply')
    expect(node.state.settings[BOARD]!['challenges']).toEqual([{ name: '@bitsocial/base64-challenge', exclude: [{ publicKeys: ['12D3KooWAuthor'], names: ['alice.eth'] }] }])
  })

  it('refuses a rule with no condition, and removes a rule', async () => {
    const node = fakeNode({ [BOARD]: { challenges: [{ ...B64, exclude: [{ roles: ['owner'] }] }] } })
    const { page } = await ready(node)
    await page.act(page.rows()[0]!, 'edit')
    await page.act(page.rows()[0]!, 'add-rule')
    await page.act(page.card(), 'apply')
    expect(page.rows()[0]!.querySelector('[data-nd-rule="1"]')?.textContent).toMatch(/at least one condition/i)
    expect(node.applied).toEqual([])
    await page.act(page.rows()[0]!.querySelector('[data-nd-rule="1"]') as FakeElement, 'remove-rule')
    expect(page.changes()).toEqual([])
  })

  it('moves a rule that names another challenge with it, when the order changes', async () => {
    const node = fakeNode({ [BOARD]: { challenges: [WORD, { ...B64, exclude: [{ challenges: [0] }] }] } })
    const { page } = await ready(node)
    await page.act(page.rows()[1]!, 'up')
    await page.act(page.card(), 'apply')
    expect(node.state.settings[BOARD]!['challenges']).toEqual([{ ...B64, exclude: [{ challenges: [1] }] }, WORD])
  })
})

describe('where a challenge that reads Ethereum says it reads', () => {
  const EVM = '@bitsocial/evm-contract-challenge'
  const LIGHT = { path: 'light-client', lightClient: 1, public: 0 }
  const LIGHT_WORDS = 'Connects to your browser\'s light client for Ethereum by default (name RPC URLs to choose others): it checks each answer, and a public server is asked only for what it cannot answer.'
  const VIEM_WORDS = 'Connects to ethereum.reth.rs by default (name RPC URLs to choose others): an ordinary web server, which counts as a Level 1 (Web2) connection for the Web3 Score.'
  const pick = (page: ReturnType<typeof mount>) => {
    const picker = page.card().querySelector('[data-nd-input="add"]') as FakeElement
    picker.value = EVM
    picker.dispatch('change')
    return page.part(page.card(), 'add-host')?.textContent
  }

  it('names the browser\'s light client, before the challenge is added and on its row, when the node reads Ethereum through it', async () => {
    const node = fakeNode()
    node.state.ethereum = LIGHT
    const { page } = await ready(node)
    expect(pick(page)).toBe(LIGHT_WORDS)
    await page.add(EVM)
    expect(page.part(page.rows()[1]!, 'hosts')?.textContent).toBe(LIGHT_WORDS)
    expect(page.dashboard.view.sections['challenges'].ethereum).toEqual(LIGHT)
  })

  it('names the server the challenge\'s own library uses on a browser with no light client for apps, and on a node that says nothing of it', async () => {
    const unsupported = fakeNode()
    unsupported.state.ethereum = { path: 'public', why: 'unsupported' }
    const first = await ready(unsupported)
    expect(pick(first.page)).toBe(VIEM_WORDS)
    await first.page.add(EVM)
    expect(first.page.part(first.page.rows()[1]!, 'hosts')?.textContent).toBe(VIEM_WORDS)
    const silent = await ready(fakeNode())
    expect(pick(silent.page)).toBe(VIEM_WORDS)
    expect(silent.page.dashboard.view.sections['challenges'].ethereum ?? null).toBeNull()
  })

  it('follows the node: the lines change at the next refresh when the path does, on a row already drawn and in the picker, and a typed server wins', async () => {
    vi.useFakeTimers()
    const node = fakeNode()
    node.state.ethereum = { path: 'asking', lightClient: 0, public: 0 }
    const page = mount({ handle: node.handle, refreshMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)
    await page.add(EVM)
    await vi.advanceTimersByTimeAsync(0)
    const row = page.rows()[1]!
    expect(page.part(row, 'hosts')?.textContent).toMatch(/^Connects to public Ethereum servers by default until you answer your browser's question about its light client/)
    pick(page)
    node.state.ethereum = LIGHT
    await vi.advanceTimersByTimeAsync(1_000)
    expect(page.part(page.rows()[1]!, 'hosts')?.textContent).toBe(LIGHT_WORDS)
    expect(page.part(page.card(), 'add-host')?.textContent).toBe(LIGHT_WORDS)
    node.state.ethereum = { path: 'public', why: 'denied', lightClient: 0, public: 1 }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(page.part(page.rows()[1]!, 'hosts')?.textContent).toMatch(/^Connects to public Ethereum servers by default, because your browser's light client is off/)
    await page.act(page.rows()[1]!, 'edit')
    page.input(page.rows()[1]!, 'rpcUrls').type('https://rpc.example.org')
    expect(page.part(page.rows()[1]!, 'hosts')?.textContent).toMatch(/^Connects to rpc\.example\.org: /)
    page.dashboard.stop()
  })

  it('leaves a challenge that reads no chain as it was, whatever the node says', async () => {
    const node = fakeNode()
    node.state.ethereum = LIGHT
    const { page } = await ready(node)
    await page.add('@bitsocial/flags-challenge')
    expect(page.part(page.rows()[1]!, 'hosts')?.textContent).toContain('Connects to flags.5chan.app')
  })
})

describe('a refresh', () => {
  it('draws a board that appeared and removes one that went, and does not undo an edit or read a board that has not changed again', async () => {
    vi.useFakeTimers()
    const node = fakeNode()
    const page = mount({ handle: node.handle, refreshMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)
    await page.add('@bitsocial/base64-challenge')
    await vi.advanceTimersByTimeAsync(0)
    expect(page.changes()).toEqual(['Added base64 as number 2.'])
    const reads = node.challenges.mock.calls.filter(([call]) => call === 'board').length
    node.state.settings[SECOND] = { challenges: [] }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(page.card(SECOND)).not.toBeNull()
    expect(page.rows()).toHaveLength(2)
    expect(page.changes()).toEqual(['Added base64 as number 2.'])
    expect(node.challenges.mock.calls.filter(([call]) => call === 'board').length).toBe(reads + 1)
    delete node.state.settings[SECOND]
    await vi.advanceTimersByTimeAsync(1_000)
    expect(page.root.querySelector(`[data-nd-challenge-board="${SECOND}"]`)).toBeNull()
    page.dashboard.stop()
  })

  it('leaves its state where a test reads it: whether it is shown, the boards and the error', async () => {
    const { page } = await ready()
    expect(page.dashboard.view.sections['challenges']).toMatchObject({ shown: true, error: null, boards: [expect.objectContaining({ address: BOARD })] })
  })
})
