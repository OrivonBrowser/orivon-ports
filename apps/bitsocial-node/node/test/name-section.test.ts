// The name section of the node dashboard, drawn into a stand-in for a document and talking to the Worker's real name calls over a fake pkc-js
// and a stub of Ethereum: a card for each board the node hosts, the record the board's name must hold, the check of whether the name points
// at the board, and the transaction that sets the record, offered only to a page that has a wallet and sent only when the person asks it to.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountNodeDashboard } from '../../page/node-dashboard.js'
import { boardRecords } from '../worker/board-records.js'
import { NAME_API_PATH, nameApi } from '../worker/name-api.js'
import { nameClaims } from '../worker/name-claim.js'
import { FakeDocument, FakeElement } from './support/fake-dom.js'

const AUTH = 'name-section-test-key-0123456789abc'
const KEYS = ['12D3KooWJoFVU6rBeqCTZoPszCaWyENY5ahrTUsNpHqhfrpmwkZD', '12D3KooWGuT5qwpG6eAiavrAoTiXKyb2UL12NvoWAEVT9CLBZoLN', '12D3KooWKxen9sLMZgBL6egvZGtPQeie16KJ1w67YraKYaAvUjt9']
const RESOLVER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63'
const ACCOUNT = '0x1111111111111111111111111111111111111111'
const HASH = `0x${'ab'.repeat(32)}`

beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) })
afterEach(() => { vi.useRealTimers() })

type Hosted = { address: string, name?: string, publicKey: string }
const refusal = (status: number, message: string) => Object.assign(new Error(message), { status })

interface Setup { noResolvers?: boolean, feature?: string, handle?: unknown, addressSetting?: string, record?: () => unknown, resolver?: string, read?: () => unknown, ethereum?: unknown, reads?: () => Record<string, unknown> }

/** A node: the Worker's own name API over a fake pkc-js hosting these boards and holding one name resolver, reached the way a page reaches it. */
function node (hosted: () => Hosted[], setup: Setup) {
  const pkc = {
    get communities () { return hosted().map((one) => ({ ...one, started: true })) },
    nameResolvers: setup.noResolvers === true ? [] : [{ key: 'one', provider: 'https://one.test', canResolve: () => true, resolve: async () => setup.record?.() as { publicKey: string } | undefined }]
  }
  const createClient = () => ({ readContract: async () => { const value = setup.read?.(); if (value !== undefined) return value as string; return setup.resolver ?? RESOLVER } })
  const door = nameApi({ authKey: AUTH, boards: boardRecords({ pkc: () => pkc }), claims: nameClaims({ pkc: () => pkc, createClient: createClient as never }), ...(setup.reads === undefined ? {} : { ethereum: setup.reads }) })
  const calls: Array<[string, Record<string, unknown>]> = []
  const names = vi.fn(async (call: string, body: Record<string, unknown> = {}) => {
    calls.push([call, body])
    const answer = await door.handle(new Request(`http://127.0.0.1:6473${NAME_API_PATH}${call}`, { method: 'POST', headers: { Authorization: `Bearer ${AUTH}` }, body: JSON.stringify(body) }))
    const value = (await answer.json()) as { Message: string }
    if (!answer.ok) throw refusal(answer.status, value.Message)
    return value
  })
  return { calls, handle: { reused: false, ports: { rpc: 9138 }, gatewayUrl: 'http://localhost:6473', stats: async () => ({ peer: 'Qm', peers: 1, reachability: 'public', repoBytes: 1, storageMax: 2 }), names } }
}

async function settle () { for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }

function mount (hosted: Hosted[], setup: Setup = {}) {
  const live = { list: hosted }
  const { handle, calls } = node(() => live.list, setup)
  const copied: string[] = []
  const doc = new FakeDocument()
  const root = doc.createElement('div')
  const win: Record<string, unknown> = setup.ethereum === undefined ? {} : { ethereum: setup.ethereum }
  const feature = setup.feature ?? 'name'
  const dashboard = mountNodeDashboard({
    root: root as never, node: { ready: Promise.resolve(setup.handle ?? handle), error: null },
    app: { name: 'seedit', features: [feature], ...(setup.addressSetting === undefined ? {} : { addressSetting: setup.addressSetting }) },
    document: doc as never, window: win, now: () => 1_800_000_000_000, copy: async (text: string) => { copied.push(text) }, refreshMs: 1_000
  })
  const by = (selector: string) => root.querySelector(selector) as FakeElement
  const refresh = async () => { vi.advanceTimersByTime(1_000); await settle() }
  const card = (address: string) => root.querySelector(`[data-nd-name-board="${address}"]`) as FakeElement | null
  return { root, win, dashboard, live, calls, copied, by, refresh, card, section: () => root.querySelector('[data-nd-section]') as FakeElement | null }
}

const board = (index: number, over: Partial<Hosted> = {}): Hosted => ({ address: KEYS[index]!, publicKey: KEYS[index]!, ...over })
const text = (element: FakeElement | null) => element?.textContent ?? ''

async function ready (hosted: Hosted[], setup: Setup = {}) {
  const view = mount(hosted, setup)
  await view.dashboard.started
  await settle()
  return view
}

const field = (card: FakeElement, selector: string) => card.querySelector(selector)!
async function typeName (card: FakeElement, name: string) { field(card, '[data-nd-input="name"]').type(name); await settle() }
async function press (card: FakeElement, action: string) { field(card, `[data-nd-action="${action}"]`).click(); await settle() }
async function showRecord (card: FakeElement, name = 'yourname.bso') { await typeName(card, name); await press(card, 'show') }

/** A wallet as `window.ethereum` is: `request` answers by method, and every call is kept. */
function wallet (over: Partial<Record<string, (params: unknown) => unknown>> = {}) {
  const requests: Array<{ method: string, params?: unknown }> = []
  const answers: Record<string, (params: unknown) => unknown> = { eth_requestAccounts: () => [ACCOUNT], eth_chainId: () => '0x1', eth_sendTransaction: () => HASH, ...over }
  const provider = { request: async (args: { method: string, params?: unknown }) => { requests.push(args); const answer = answers[args.method]; if (answer === undefined) throw Object.assign(new Error('unsupported'), { code: -32601 }); return answer(args.params) } }
  return { provider, requests }
}

describe('what shows the section', () => {
  it('is the app naming the feature and the node answering the name calls, with a card for each board', async () => {
    const view = await ready([board(0), board(1, { name: 'music.bso' })])
    expect(view.section()?.getAttribute('data-nd-section')).toBe('name')
    expect(view.card(KEYS[0]!)).not.toBeNull()
    expect(view.card(KEYS[1]!)).not.toBeNull()
    expect((view.win['nodeDashboard'] as { sections: Record<string, { shown: boolean, boards: Array<{ address: string }> }> }).sections['name']).toMatchObject({ shown: true, boards: [{ address: KEYS[0] }, { address: KEYS[1] }] })
    expect((await ready([board(0)], { feature: 'board-manager' })).section()).toBeNull()
  })

  it('is hidden by a node that has no name call, and by one that refuses the call as one with none', async () => {
    expect((await ready([board(0)], { handle: { reused: false, ports: { rpc: 1 }, gatewayUrl: 'x', stats: async () => ({}) } })).section()).toBeNull()
    for (const status of [403, 404, 503]) {
      const refusing = { reused: false, ports: { rpc: 1 }, gatewayUrl: 'x', stats: async () => ({}), names: async () => { throw refusal(status, 'no') } }
      expect((await ready([board(0)], { handle: refusing })).section()?.hidden, String(status)).toBe(true)
    }
  })

  it('says the node did not answer when the call fails for another reason, and keeps the section', async () => {
    const failing = { reused: false, ports: { rpc: 1 }, gatewayUrl: 'x', stats: async () => ({}), names: async () => { throw new Error('socket closed') } }
    const view = await ready([board(0)], { handle: failing })
    expect(view.section()?.hidden).toBe(false)
    expect(text(view.by('[role="alert"]'))).toContain('socket closed')
  })

  it('says a board has a name when it has, puts it in the field, and says the board has none when it has none', async () => {
    const view = await ready([board(0), board(1, { name: 'music.bso' })])
    expect(text(view.card(KEYS[0]!)!.querySelector('.nd-badge'))).toBe('No name yet')
    expect(field(view.card(KEYS[0]!)!, '[data-nd-input="name"]').value).toBe('')
    expect(text(view.card(KEYS[1]!)!.querySelector('.nd-badge'))).toBe('Named music.bso')
    expect(field(view.card(KEYS[1]!)!, '[data-nd-input="name"]').value).toBe('music.bso')
  })

  it('follows the node: a board that takes a name says so, and what a person typed is left as it is', async () => {
    const view = await ready([board(0)])
    await typeName(view.card(KEYS[0]!)!, 'mine.bso')
    view.live.list = [board(0, { name: 'other.bso' })]
    await view.refresh()
    const card = view.card(KEYS[0]!)!
    expect(text(card.querySelector('.nd-badge'))).toBe('Named other.bso')
    expect(field(card, '[data-nd-input="name"]').value).toBe('mine.bso')
  })
})

describe('the record', () => {
  it('is shown exactly: the name as ENS spells it, the record key and the board\'s public key, each with a copy button that copies it', async () => {
    const view = await ready([board(0)])
    const card = view.card(KEYS[0]!)!
    expect(field(card, '[data-nd-record]').hidden).toBe(true)
    await showRecord(card)
    expect(field(card, '[data-nd-record]').hidden).toBe(false)
    expect(text(field(card, '[data-nd-fact="name"]'))).toBe('yourname.eth')
    expect(text(field(card, '[data-nd-fact="key"]'))).toBe('bitsocial')
    expect(text(field(card, '[data-nd-fact="value"]'))).toBe(KEYS[0])
    for (const [action, expected] of [['copy-name', 'yourname.eth'], ['copy-key', 'bitsocial'], ['copy-value', KEYS[0]!]] as const) {
      await press(card, action)
      expect(view.copied.at(-1), action).toBe(expected)
    }
    expect(view.calls.filter(([call]) => call === 'record')).toEqual([['record', { address: KEYS[0], name: 'yourname.bso' }]])
  })

  it('does not keep saying "Copied." under a check made after it', async () => {
    const view = await ready([board(0)])
    const card = view.card(KEYS[0]!)!
    await showRecord(card)
    await press(card, 'copy-value')
    expect(text(field(card, '[data-nd-message]'))).toBe('Copied.')
    await press(card, 'check')
    expect(text(field(card, '[data-nd-message]'))).toBe('')
  })

  it('says a .bso name is the .eth name of the same label, so the record is set on that name', async () => {
    const view = await ready([board(0)])
    const card = view.card(KEYS[0]!)!
    await showRecord(card, 'yourname.bso')
    expect(text(card)).toContain('yourname.bso is the same name as yourname.eth')
    await showRecord(card, 'yourname.eth')
    expect(text(card)).not.toContain('is the same name as')
  })

  it('is shown with no wallet at all, and never calls anything but the node', async () => {
    const view = await ready([board(0)])
    await showRecord(view.card(KEYS[0]!)!)
    expect(view.calls.map(([call]) => call)).toEqual(['boards', 'record'])
  })

  it('is refused with the node\'s words next to the field for a name that cannot be one, and nothing is shown', async () => {
    const view = await ready([board(0)])
    const card = view.card(KEYS[0]!)!
    await showRecord(card, 'Yourname.bso')
    expect(text(field(card, '[data-nd-error="name"]'))).toMatch(/capital letter/)
    expect(field(card, '[data-nd-record]').hidden).toBe(true)
    await showRecord(card, 'yourname.com')
    expect(text(field(card, '[data-nd-error="name"]'))).toMatch(/^The name must end \.bso or \.eth/)
  })

  it('asks the node nothing for an empty field, and says what to type', async () => {
    const view = await ready([board(0)])
    const card = view.card(KEYS[0]!)!
    await press(card, 'show')
    expect(text(field(card, '[data-nd-error="name"]'))).toMatch(/Type the name/)
    expect(view.calls.map(([call]) => call)).toEqual(['boards'])
  })

  it('is taken back when the name in the field changes, since it was made for another name', async () => {
    const view = await ready([board(0)])
    const card = view.card(KEYS[0]!)!
    await showRecord(card, 'one.bso')
    await typeName(card, 'two.bso')
    expect(field(card, '[data-nd-record]').hidden).toBe(true)
  })
})

describe('the check', () => {
  const checkOn = async (record: () => unknown, setup: Setup = {}, name = 'yourname.bso', hosted: Hosted[] = [board(0)]) => {
    const view = await ready(hosted, { record, ...setup })
    const card = view.card(hosted[0]!.address)!
    await typeName(card, name)
    await press(card, 'check')
    return { view, card, line: field(card, '[data-nd-check]') }
  }

  it('says the name points at this board, and where to set the board\'s address, in the app\'s words', async () => {
    const { line, view } = await checkOn(() => ({ publicKey: KEYS[0] }), { addressSetting: 'Community settings, the Address box' })
    expect(line.getAttribute('data-nd-check')).toBe('here')
    expect(text(line)).toBe('yourname.bso points at this board. The last step is the board\'s address: set it to yourname.bso in Community settings, the Address box.')
    expect(view.calls.filter(([call]) => call === 'check')).toEqual([['check', { address: KEYS[0], name: 'yourname.bso' }]])
  })

  it('points to the app\'s own settings in general words when the app names none, and offers no change of the address itself', async () => {
    const { line, card } = await checkOn(() => ({ publicKey: KEYS[0] }))
    expect(text(line)).toContain("in the app's own settings for this board")
    expect(card.querySelectorAll('button').map((one) => one.getAttribute('data-nd-action'))).not.toContain('switch')
  })

  it('says the board\'s address already is the name, when it is', async () => {
    const { line } = await checkOn(() => ({ publicKey: KEYS[0] }), {}, 'music.bso', [board(0, { name: 'music.bso' })])
    expect(text(line)).toBe("music.bso points at this board, and the board's address is already music.bso. Nothing more to do.")
  })

  it('says the name points at another board, and which', async () => {
    const { line } = await checkOn(() => ({ publicKey: KEYS[1] }))
    expect(line.getAttribute('data-nd-check')).toBe('elsewhere')
    expect(text(line)).toContain(`yourname.bso points at another board (${KEYS[1]})`)
    expect(text(line)).toContain('Set the record above')
  })

  it('says the name has no record', async () => {
    const { line } = await checkOn(() => undefined)
    expect(line.getAttribute('data-nd-check')).toBe('none')
    expect(text(line)).toBe('yourname.bso has no bitsocial record yet. Set the record above, wait until the transaction is in a block, then check again.')
  })

  it('says the record is not a board key, when the resolvers refuse it as one', async () => {
    const { line } = await checkOn(() => { throw new Error('Invalid bitsocial TXT record: expected a valid IPNS public key as the first segment.') })
    expect(line.getAttribute('data-nd-check')).toBe('invalid')
    expect(text(line)).toMatch(/yourname\.bso has a bitsocial record that is not a board's key: Invalid bitsocial TXT record/)
  })

  it('says it could not find out when no resolver answered, with the first reason', async () => {
    const { line } = await checkOn(() => { throw new Error('503 Service Unavailable') })
    expect(line.getAttribute('data-nd-check')).toBe('unreachable')
    expect(text(line)).toBe("The node could not read Ethereum, so it cannot say where yourname.bso points (503 Service Unavailable). Try again in a minute.")
  })

  it('says the node reads no names when it has no resolver, as a run with no internet has none', async () => {
    const { line } = await checkOn(() => undefined, { noResolvers: true })
    expect(line.getAttribute('data-nd-check')).toBe('no-resolver')
    expect(text(line)).toBe('This node reads no names (it runs without the internet).')
  })

  it('asks the node nothing for an empty field, and nothing more while the dashboard refreshes by itself', async () => {
    const view = await ready([board(0)], { record: () => ({ publicKey: KEYS[0] }) })
    const card = view.card(KEYS[0]!)!
    await press(card, 'check')
    expect(text(field(card, '[data-nd-error="name"]'))).toMatch(/Type the name/)
    await typeName(card, 'yourname.bso')
    await press(card, 'check')
    await view.refresh()
    await view.refresh()
    expect(view.calls.filter(([call]) => call === 'check')).toHaveLength(1)
  })

  it('says again that the answer is out of date when the name in the field changes after it', async () => {
    const { line, card } = await checkOn(() => ({ publicKey: KEYS[0] }))
    await typeName(card, 'other.bso')
    expect(text(line)).toBe('')
    expect(line.getAttribute('data-nd-check')).toBe('')
  })
})

describe('the transaction', () => {
  const withWallet = async (over: Partial<Record<string, (params: unknown) => unknown>> = {}, setup: Setup = {}) => {
    const w = wallet(over)
    const view = await ready([board(0)], { ethereum: w.provider, ...setup })
    const card = view.card(KEYS[0]!)!
    await showRecord(card, 'foo.bso')
    return { ...w, view, card }
  }

  it('is not offered to a page with no wallet, which is told in one line how a wallet would help', async () => {
    const view = await ready([board(0)])
    const card = view.card(KEYS[0]!)!
    await showRecord(card, 'foo.bso')
    expect(card.querySelectorAll('button').map((one) => one.getAttribute('data-nd-action')).filter((action) => ['prepare', 'send'].includes(String(action)))).toEqual([])
    expect(text(field(card, '[data-nd-wallet-note]'))).toMatch(/No wallet is available in this browser/)
    expect(view.calls.map(([call]) => call)).not.toContain('transaction')
  })

  it('is not offered when window.ethereum is not a wallet that can be asked', async () => {
    const view = await ready([board(0)], { ethereum: { isMetaMask: true } })
    expect(view.card(KEYS[0]!)!.querySelectorAll('[data-nd-action="prepare"]')).toHaveLength(0)
  })

  it('is offered when a wallet appears after the page was drawn', async () => {
    const view = await ready([board(0)])
    const card = view.card(KEYS[0]!)!
    await showRecord(card, 'foo.bso')
    expect(card.querySelector('[data-nd-action="prepare"]')).toBeNull()
    view.win['ethereum'] = wallet().provider
    await view.refresh()
    expect(card.querySelector('[data-nd-action="prepare"]')).not.toBeNull()
  })

  it('is prepared, and said in plain words, before the wallet is asked anything', async () => {
    const { card, requests, calls } = await withWallet().then((w) => ({ ...w, calls: w.view.calls }))
    expect(card.querySelector('[data-nd-action="send"]')).toBeNull()
    expect(field(card, '[data-nd-preview="calldata"]').hidden).toBe(true)
    await press(card, 'prepare')
    expect(field(card, '[data-nd-preview="calldata"]').hidden).toBe(false)
    const summary = text(field(card, '[data-nd-summary]'))
    expect(summary).toContain('one transaction on Ethereum mainnet')
    expect(summary).toContain(RESOLVER)
    expect(summary).toContain('text record "bitsocial" of foo.eth')
    expect(summary).toContain(KEYS[0])
    expect(summary).toMatch(/sends no money/)
    expect(summary).toMatch(/network fee/)
    expect(summary).toMatch(/Only an account that manages foo\.eth/)
    expect(summary).toMatch(/wallet shows the transaction and asks you to confirm/)
    expect(text(field(card, '[data-nd-preview="calldata"]'))).toMatch(/^0x10f13a8c/)
    expect(requests).toEqual([])
    expect(calls.filter(([call]) => call === 'transaction')).toEqual([['transaction', { address: KEYS[0], name: 'foo.bso' }]])
    expect(card.querySelector('[data-nd-action="send"]')).not.toBeNull()
    const order = card.descendants()
    expect(order.indexOf(field(card, '[data-nd-summary]'))).toBeLessThan(order.indexOf(field(card, '[data-nd-action="send"]')))
  })

  it('is sent only when the person presses the button: the wallet is asked for an account and the network, then to send exactly what was shown', async () => {
    const { card, requests } = await withWallet()
    await press(card, 'prepare')
    expect(requests).toEqual([])
    const data = text(field(card, '[data-nd-preview="calldata"]'))
    await press(card, 'send')
    expect(requests.map((one) => one.method)).toEqual(['eth_requestAccounts', 'eth_chainId', 'eth_sendTransaction'])
    expect(requests[2]!.params).toEqual([{ from: ACCOUNT, to: RESOLVER, data, value: '0x0' }])
    expect(text(field(card, '[data-nd-tx]'))).toBe(`Sent: ${HASH}. It takes a minute to be in a block; then press "Check the name".`)
  })

  it('says it was declined, and that nothing was sent, when the person declines in the wallet', async () => {
    const { card, requests } = await withWallet({ eth_sendTransaction: () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }) } })
    await press(card, 'prepare')
    await press(card, 'send')
    expect(text(field(card, '[data-nd-tx]'))).toBe('You declined it in your wallet. Nothing was sent.')
    expect(field(card, '[data-nd-tx]').getAttribute('data-nd-failed')).toBe('false')
    expect(requests.map((one) => one.method)).toContain('eth_sendTransaction')
  })

  it('says what the wallet said when it refuses for another reason', async () => {
    const { card } = await withWallet({ eth_sendTransaction: () => { throw Object.assign(new Error('insufficient funds for gas'), { code: -32000 }) } })
    await press(card, 'prepare')
    await press(card, 'send')
    expect(text(field(card, '[data-nd-tx]'))).toBe('The wallet did not send it: insufficient funds for gas')
    expect(field(card, '[data-nd-tx]').getAttribute('data-nd-failed')).toBe('true')
  })

  it('does not send on another network than mainnet, and says to switch', async () => {
    const { card, requests } = await withWallet({ eth_chainId: () => '0xaa36a7' })
    await press(card, 'prepare')
    await press(card, 'send')
    expect(requests.map((one) => one.method)).not.toContain('eth_sendTransaction')
    expect(text(field(card, '[data-nd-tx]'))).toBe('Your wallet is on another network (chain 0xaa36a7). Switch it to Ethereum mainnet and press the button again.')
  })

  it('does not send when the wallet gives no account', async () => {
    const { card, requests } = await withWallet({ eth_requestAccounts: () => [] })
    await press(card, 'prepare')
    await press(card, 'send')
    expect(requests.map((one) => one.method)).toEqual(['eth_requestAccounts'])
    expect(text(field(card, '[data-nd-tx]'))).toBe('The wallet gave no account.')
  })

  it('says why it cannot be prepared, from the node, and asks the wallet nothing: a name with no resolver', async () => {
    const { card, requests } = await withWallet({}, { resolver: '0x0000000000000000000000000000000000000000' })
    await press(card, 'prepare')
    expect(text(field(card, '[data-nd-tx]'))).toMatch(/foo\.eth has no resolver set/)
    expect(card.querySelector('[data-nd-action="send"]')).toBeNull()
    expect(requests).toEqual([])
  })

  it('is taken back when the name changes, so a transaction prepared for one name is never sent for another', async () => {
    const { card, requests } = await withWallet()
    await press(card, 'prepare')
    await typeName(card, 'other.bso')
    expect(card.querySelector('[data-nd-action="send"]')).toBeNull()
    expect(field(card, '[data-nd-summary]').hidden).toBe(true)
    expect(field(card, '[data-nd-preview="calldata"]').hidden).toBe(true)
    expect(requests).toEqual([])
  })

  it('is sent once for one press, and a second press while it waits for the wallet does nothing', async () => {
    let release: (hash: string) => void = () => {}
    const { card, requests } = await withWallet({ eth_sendTransaction: () => new Promise((resolve) => { release = resolve }) })
    await press(card, 'prepare')
    field(card, '[data-nd-action="send"]').click()
    await settle()
    field(card, '[data-nd-action="send"]').click()
    await settle()
    expect(requests.filter((one) => one.method === 'eth_sendTransaction')).toHaveLength(1)
    release(HASH)
    await settle()
    expect(text(field(card, '[data-nd-tx]'))).toContain(HASH)
  })
})

describe('which path reads Ethereum', () => {
  const line = (view: Awaited<ReturnType<typeof ready>>) => view.by('[data-nd-ethereum]')

  it('is said in one line of the section, in the words of the path the node reports, and kept for a test to read', async () => {
    const light = await ready([board(0)], { reads: () => ({ path: 'light-client', lightClient: 3, public: 0 }) })
    expect(line(light).getAttribute('data-nd-ethereum')).toBe('light-client')
    expect(text(line(light))).toBe('Ethereum is read through your browser\'s light client, which checks each answer.')
    expect(light.dashboard.view.sections['name'].ethereum).toEqual({ path: 'light-client', lightClient: 3, public: 0 })

    const asking = await ready([board(0)], { reads: () => ({ path: 'asking', lightClient: 0, public: 0 }) })
    expect(text(line(asking))).toBe('Your browser is asking whether this app may read Ethereum through its light client. Until you answer, public servers are used.')
  })

  it('says why a public server reads Ethereum: the browser has no light client for apps, the person did not allow it or it is off, or it did not answer', async () => {
    const unsupported = await ready([board(0)], { reads: () => ({ path: 'public', why: 'unsupported' }) })
    expect(line(unsupported).getAttribute('data-nd-ethereum')).toBe('public')
    expect(text(line(unsupported))).toBe('Ethereum is read from public servers: this browser has no light client for apps, so their answers are not checked.')
    for (const why of ['no-handle', 'denied', 'closed']) {
      const off = await ready([board(0)], { reads: () => ({ path: 'public', why, lightClient: 0, public: 2 }) })
      expect(text(line(off)), why).toBe('Ethereum is read from public servers: your browser\'s light client is off or was not allowed for this app, so their answers are not checked.')
    }
    for (const why of ['unavailable', 'timeout', 'limit', 'not-asked', 'something-new']) {
      const failing = await ready([board(0)], { reads: () => ({ path: 'public', why, lightClient: 1, public: 4 }) })
      expect(text(line(failing)), why).toBe('Ethereum is read from public servers: your browser\'s light client did not answer, so their answers are not checked.')
    }
  })

  it('says a node with no internet reads no Ethereum, and draws no line for a node that does not say (a build from before it did)', async () => {
    const none = await ready([board(0)], { reads: () => ({ path: 'none' }) })
    expect(text(line(none))).toBe('This node reads no Ethereum (it runs without the internet).')
    const older = await ready([board(0)])
    expect(older.root.querySelector('[data-nd-ethereum]')).toBeNull()
    expect(older.dashboard.view.sections['name'].ethereum ?? null).toBeNull()
  })

  it('follows the node: the line changes at the next refresh when the path does', async () => {
    let answer: Record<string, unknown> = { path: 'asking', lightClient: 0, public: 0 }
    const view = await ready([board(0)], { reads: () => answer })
    expect(line(view).getAttribute('data-nd-ethereum')).toBe('asking')
    answer = { path: 'light-client', lightClient: 0, public: 0 }
    await view.refresh()
    expect(line(view).getAttribute('data-nd-ethereum')).toBe('light-client')
  })

  it('is said for seedit and for 5chan alike, and never in the other app\'s word', async () => {
    const view = await ready([board(0)], { reads: () => ({ path: 'public', why: 'no-handle' }) })
    expect(text(line(view))).not.toMatch(/\b[Bb]oards?\b/)
    expect(text(line(view))).not.toMatch(/\b[Cc]ommunit/)
  })
})
