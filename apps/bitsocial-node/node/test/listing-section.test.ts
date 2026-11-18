// The listing section of the node dashboard, drawn into a stand-in for a document and talking to the Worker's real listing calls over
// a fake pkc-js: the directories read from GitHub, a card for each board the node hosts, what the board still misses of a directory
// in words, the request that is prepared and shown before anything is sent, the GitHub address it opens, and what seedit is offered.
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LISTS_RAW } from '../../page/dashboard/listing-links.js'
import { mountNodeDashboard } from '../../page/node-dashboard.js'
import { boardRecords } from '../worker/board-records.js'
import { LISTING_API_PATH, listingApi } from '../worker/listing-api.js'
import { verifyRequest } from '../worker/listing-request.js'
import { FakeDocument, FakeElement } from './support/fake-dom.js'

const KEY = 'listing-section-test-key-0123456789abc'
const NOW = 1_800_000_123_000
const DEFAULTS_5CHAN = { directories: {
  a: { title: '/a/ - Anime & Manga', features: { pseudonymityMode: 'per-reply', safeForWork: true }, rules: ['Stay on topic.'] },
  b: { title: '/b/ - Random', features: { requirePostLinkIsMedia: true } }
} }
const DEFAULTS_SEEDIT = { directories: { cats: { title: 'Cats' }, aww: { title: 'Aww' } } }
const GOOD = { features: { pseudonymityMode: 'per-reply', safeForWork: true }, challenges: [{ type: 'mod-queue', pendingApproval: true }], rules: ['Stay on topic.', 'Be kind.'] }

async function identity () {
  const key = await generateKeyPair('Ed25519')
  return { privateKey: Buffer.from(key.raw.subarray(0, 32)).toString('base64'), address: peerIdFromPrivateKey(key).toString() }
}

let ids: Awaited<ReturnType<typeof identity>>[]
beforeEach(async () => { ids = [await identity(), await identity(), await identity()]; vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) })
afterEach(() => { vi.useRealTimers() })

type Hosted = { address: string, name?: string, publicKey: string, record: Record<string, unknown> | null, held?: boolean }
const refusal = (status: number, message: string) => Object.assign(new Error(message), { status })

/** A node: the Worker's own listing API over a fake pkc-js hosting these boards, reached the way a page reaches it. */
function node (hosted: () => Hosted[], over: { failBoards?: () => Error | null } = {}) {
  const pkc = {
    get communities () { return hosted().map((one) => ({ address: one.address, name: one.name, publicKey: one.publicKey, started: true })) },
    async createCommunity ({ address }: { address: string }) {
      const one = hosted().find((board) => board.address === address)!
      return { address: one.address, name: one.name, publicKey: one.publicKey, updatedAt: one.record === null ? undefined : 1, ...(one.record ?? {}), signer: { privateKey: (one.held === false ? ids[2]! : ids.find((id) => id.address === one.publicKey) ?? ids[0]!).privateKey, address: one.publicKey } }
    }
  }
  const api = listingApi({ authKey: KEY, boards: boardRecords({ pkc: () => pkc }), now: () => NOW })
  const calls: Array<[string, Record<string, unknown>]> = []
  const listing = vi.fn(async (call: string, body: Record<string, unknown> = {}) => {
    calls.push([call, body])
    const failure = over.failBoards?.()
    if (failure) throw failure
    const answer = await api.handle(new Request(`http://127.0.0.1:6473${LISTING_API_PATH}${call}`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) }))
    const value = (await answer.json()) as { Message: string }
    if (!answer.ok) throw refusal(answer.status, value.Message)
    return value
  })
  return { calls, handle: { reused: false, ports: { rpc: 9138 }, gatewayUrl: 'http://localhost:6473', stats: async () => ({ peer: 'Qm', peers: 1, reachability: 'public', repoBytes: 1, storageMax: 2 }), listing } }
}

async function settle () { for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }

type Setup = { feature?: string, defaults?: unknown, fetch?: unknown, handle?: unknown }
function mount (hosted: Hosted[], setup: Setup = {}) {
  const live = { list: hosted }
  const { handle, calls } = node(() => live.list)
  const opened: string[] = []
  const copied: string[] = []
  const feature = setup.feature ?? 'listing'
  const fetched: string[] = []
  const fetcher = setup.fetch ?? vi.fn(async (url: string) => { fetched.push(url); return new Response(JSON.stringify(setup.defaults ?? (feature === 'listing' ? DEFAULTS_5CHAN : DEFAULTS_SEEDIT)), { status: 200 }) })
  const doc = new FakeDocument()
  const root = doc.createElement('div')
  const win: Record<string, unknown> = {}
  const time = { now: NOW }
  const dashboard = mountNodeDashboard({
    root: root as never, node: { ready: Promise.resolve(setup.handle ?? handle), error: null }, app: { name: feature === 'listing' ? '5chan' : 'seedit', features: [feature] },
    document: doc as never, window: win, now: () => time.now, fetch: fetcher as never, open: (url: string) => { opened.push(url) }, copy: async (text: string) => { copied.push(text) }, refreshMs: 1_000
  })
  const by = (selector: string) => root.querySelector(selector) as FakeElement
  /** One refresh of the dashboard, the way its timer makes it. */
  const refresh = async () => { vi.advanceTimersByTime(1_000); await settle() }
  const card = (address: string) => root.querySelector(`[data-nd-listing="${address}"]`) as FakeElement | null
  return { root, win, dashboard, live, calls, opened, copied, fetched, fetcher, time, by, refresh, card, section: () => root.querySelector('[data-nd-section]') as FakeElement | null }
}

const board = (index: number, over: Partial<Hosted> = {}): Hosted => ({ address: `board${String(index)}.bso`, name: `board${String(index)}.bso`, publicKey: ids[index]!.address, record: GOOD, ...over })
const text = (element: FakeElement | null) => element?.textContent ?? ''

async function ready (hosted: Hosted[], setup: Setup = {}) {
  const view = mount(hosted, setup)
  await view.dashboard.started
  await settle()
  return view
}

function choose (card: FakeElement, code: string) {
  const select = card.querySelector('[data-nd-input="directory"]')!
  select.value = code
  select.dispatch('change')
}

describe('what shows the section', () => {
  it('is the app naming the feature and the node answering the listing calls', async () => {
    const view = await ready([board(0)])
    expect(view.section()?.getAttribute('data-nd-section')).toBe('listing')
    expect(view.card('board0.bso')).not.toBeNull()
    const none = await ready([board(0)], { feature: 'board-manager' })
    expect(none.section()).toBeNull()
    expect(none.win['nodeDashboard']).toMatchObject({ sections: {} })
  })

  it('is hidden by a node that has no listing call, and by one that refuses the call as one with none', async () => {
    expect((await ready([board(0)], { handle: { reused: false, ports: { rpc: 1 }, gatewayUrl: 'x', stats: async () => ({}) } })).section()).toBeNull()
    for (const status of [403, 404, 503]) {
      const refusing = { reused: false, ports: { rpc: 1 }, gatewayUrl: 'x', stats: async () => ({}), listing: async () => { throw refusal(status, 'no') } }
      const view = await ready([board(0)], { handle: refusing })
      expect(view.section()?.hidden, String(status)).toBe(true)
      expect((view.win['nodeDashboard'] as { sections: Record<string, { shown: boolean }> }).sections['listing']!.shown).toBe(false)
    }
  })

  it('says the node did not answer when the call fails for another reason, and keeps the section', async () => {
    const failing = { reused: false, ports: { rpc: 1 }, gatewayUrl: 'x', stats: async () => ({}), listing: async () => { throw new Error('socket closed') } }
    const view = await ready([board(0)], { handle: failing })
    expect(view.section()?.hidden).toBe(false)
    expect(text(view.by('[role="alert"]'))).toContain('socket closed')
  })
})

describe('the directories', () => {
  it('are read once from the lists on GitHub and offered in a list for each board, each saying what the board would need', async () => {
    const view = await ready([board(0), board(1, { record: { features: {}, challenges: [], rules: [] } })])
    expect(view.fetched).toEqual([`${LISTS_RAW}5chan-directories/5chan-directories-defaults.json`])
    expect(view.card('board0.bso')).not.toBeNull()
    const options = (address: string) => view.card(address)!.querySelectorAll('option').map((one) => [one.getAttribute('value'), one.textContent])
    expect(options('board0.bso')).toEqual([['', 'Choose a directory'], ['a', '/a/ - Anime & Manga (this board meets the requirements)'], ['b', '/b/ - Random (this board misses 1 requirement)']])
    expect(options('board1.bso')[1]).toEqual(['a', '/a/ - Anime & Manga (this board misses 4 requirements)'])
    await view.dashboard.started
    expect(view.fetched).toHaveLength(1)
  })

  it('say they could not be read when GitHub does not answer, and are asked for again after a minute', async () => {
    let answer: Response | Error = new Response('no', { status: 503 })
    const fetcher = vi.fn(async () => { if (answer instanceof Error) throw answer; return answer })
    const view = mount([board(0)], { fetch: fetcher })
    await view.dashboard.started
    await settle()
    expect(text(view.by('[role="alert"]'))).toMatch(/The directories could not be read: .*503/)
    expect(fetcher).toHaveBeenCalledTimes(1)
    answer = new Response(JSON.stringify(DEFAULTS_5CHAN), { status: 200 })
    await view.refresh()
    expect(fetcher).toHaveBeenCalledTimes(1)
    view.time.now += 61_000
    await view.refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(view.card('board0.bso')!.querySelectorAll('option')).toHaveLength(3)
    expect(text(view.by('[role="alert"]'))).toBe('')
  })
})

describe('a board against a directory', () => {
  it('lists each requirement in words, ticked or not, and what to change for one the board misses', async () => {
    const view = await ready([board(0, { record: { features: { pseudonymityMode: 'per-post', safeForWork: true }, challenges: [], rules: ['Stay on topic.'] } })])
    const card = view.card('board0.bso')!
    choose(card, 'a')
    const items = card.querySelectorAll('[data-nd-requirement]')
    expect(items.map((one) => [one.getAttribute('data-nd-requirement'), one.getAttribute('data-nd-met')])).toEqual([['pseudonymityMode', 'false'], ['safeForWork', 'true'], ['noGallery', 'true'], ['pendingApproval', 'false'], ['rules', 'true']])
    expect(text(items[0]!)).toContain('No poster IDs: every reply comes from a new address')
    expect(text(items[0]!)).toContain('features.pseudonymityMode: per-reply')
    expect(text(items[3]!)).toContain('A new poster waits for a moderator')
    expect(text(items[1]!)).not.toContain('features.safeForWork')
    expect(text(card.querySelector('[data-nd-state]'))).toBe('Misses 2 of 5')
  })

  it('says the board meets every requirement, in its own words', async () => {
    const view = await ready([board(0)])
    const card = view.card('board0.bso')!
    choose(card, 'a')
    expect(text(card.querySelector('[data-nd-state]'))).toBe('Meets all 5')
    expect(card.querySelectorAll('[data-nd-met="false"]')).toHaveLength(0)
  })

  it('draws no check for a board that has published nothing, and offers no request until it has', async () => {
    const view = await ready([board(0, { record: null })])
    const card = view.card('board0.bso')!
    expect(text(card)).toContain('has not published its record yet')
    choose(card, 'a')
    expect(card.querySelectorAll('[data-nd-requirement]')).toHaveLength(0)
    expect(card.querySelector('[data-nd-action="prepare"]')!.disabled).toBe(true)
  })

  it('offers no request for a board whose key the node does not hold, and says why', async () => {
    const view = await ready([board(0, { held: false })])
    const card = view.card('board0.bso')!
    expect(text(card)).toContain("does not hold this board's key")
    expect(card.querySelector('[data-nd-action="prepare"]')).toBeNull()
  })
})

describe('the request', () => {
  it('is prepared on a press and shown as the issue it would open, with the signature the board\'s key made, and nothing is opened', async () => {
    const view = await ready([board(0)])
    const card = view.card('board0.bso')!
    expect(card.querySelector('[data-nd-action="prepare"]')!.disabled).toBe(true)
    choose(card, 'a')
    expect(card.querySelector('[data-nd-request]')!.hidden).toBe(true)
    card.querySelector('[data-nd-action="prepare"]')!.click()
    await settle()
    expect(view.calls.filter(([call]) => call === 'sign')).toEqual([['sign', { address: 'board0.bso', file: '5chan-directories/5chan-a-directory.json' }]])
    expect(card.querySelector('[data-nd-request]')!.hidden).toBe(false)
    const title = text(card.querySelector('[data-nd-preview="title"]'))
    const body = text(card.querySelector('[data-nd-preview="body"]'))
    expect(title).toBe('Add a board to /a/ - Anime & Manga: board0.bso')
    expect(body).toContain('Address: board0.bso')
    expect(body).toContain('meets all 5 requirements')
    const signature = /Signature \(base64\): (\S+)/.exec(body)![1]!
    const message = /```\n(bitsocial-listing-request-v1\n[^`]+)\n```/.exec(body)![1]!
    expect(await verifyRequest({ message, signature, publicKey: ids[0]!.address })).toBe(true)
    expect(text(card.querySelector('[data-nd-signature]'))).toBe(signature)
    expect(message).toContain(`"addedAt":${String(NOW / 1000)}`)
    expect(view.opened).toEqual([])
  })

  it('opens GitHub on a press of Open, with the title and the body that were shown, and only then', async () => {
    const view = await ready([board(0)])
    const card = view.card('board0.bso')!
    choose(card, 'a')
    card.querySelector('[data-nd-action="prepare"]')!.click()
    await settle()
    card.querySelector('[data-nd-action="open"]')!.click()
    expect(view.opened).toHaveLength(1)
    const url = new URL(view.opened[0]!)
    expect(url.origin + url.pathname).toBe('https://github.com/bitsocialnet/lists/issues/new')
    expect(url.searchParams.get('title')).toBe(text(card.querySelector('[data-nd-preview="title"]')))
    expect(url.searchParams.get('body')).toBe(text(card.querySelector('[data-nd-preview="body"]')))
  })

  it('copies the body on a press of Copy', async () => {
    const view = await ready([board(0)])
    const card = view.card('board0.bso')!
    choose(card, 'b')
    card.querySelector('[data-nd-action="prepare"]')!.click()
    await settle()
    card.querySelector('[data-nd-action="copy"]')!.click()
    await settle()
    expect(view.copied).toEqual([text(card.querySelector('[data-nd-preview="body"]'))])
    expect(text(card.querySelector('[data-nd-message]'))).toContain('Copied')
  })

  it('carries the owner a person names, and takes the Worker\'s refusal of one that is no name to the field', async () => {
    const view = await ready([board(0)])
    const card = view.card('board0.bso')!
    choose(card, 'a')
    const owner = card.querySelector('[data-nd-input="owner"]')!
    owner.type('nobody')
    card.querySelector('[data-nd-action="prepare"]')!.click()
    await settle()
    expect(text(card.querySelector('[data-nd-error="owner"]'))).toContain('owner must be a name that ends .bso or .eth')
    expect(card.querySelector('[data-nd-request]')!.hidden).toBe(true)
    owner.type('me.bso')
    card.querySelector('[data-nd-action="prepare"]')!.click()
    await settle()
    expect(text(card.querySelector('[data-nd-error="owner"]'))).toBe('')
    expect(text(card.querySelector('[data-nd-preview="body"]'))).toContain('"owner": "me.bso"')
  })

  it('is taken back when the directory or the owner changes, because it no longer says what the person asked for', async () => {
    const view = await ready([board(0)])
    const card = view.card('board0.bso')!
    choose(card, 'a')
    card.querySelector('[data-nd-action="prepare"]')!.click()
    await settle()
    choose(card, 'b')
    expect(card.querySelector('[data-nd-request]')!.hidden).toBe(true)
    card.querySelector('[data-nd-action="prepare"]')!.click()
    await settle()
    card.querySelector('[data-nd-input="owner"]')!.type('me.bso')
    expect(card.querySelector('[data-nd-request]')!.hidden).toBe(true)
  })

  it('is taken back when the board\'s record changes what the board meets, and kept when it changes nothing of the sort', async () => {
    const view = await ready([board(0, { record: { features: { pseudonymityMode: 'per-post', safeForWork: true }, challenges: [], rules: ['Stay on topic.'] } })])
    const card = view.card('board0.bso')!
    choose(card, 'a')
    card.querySelector('[data-nd-action="prepare"]')!.click()
    await settle()
    expect(card.querySelector('[data-nd-request]')!.hidden).toBe(false)
    expect(text(card.querySelector('[data-nd-preview="body"]'))).toContain('misses 2 of 5 requirements')
    view.live.list = [board(0, { record: { features: { pseudonymityMode: 'per-post', safeForWork: true, noDownvotes: true }, challenges: [], rules: ['Stay on topic.'] } })]
    view.time.now += 31_000
    await view.refresh()
    expect(card.querySelector('[data-nd-request]')!.hidden).toBe(false)
    view.live.list = [board(0)]
    view.time.now += 31_000
    await view.refresh()
    expect(card.querySelector('[data-nd-request]')!.hidden).toBe(true)
    expect(text(card.querySelector('[data-nd-message]'))).toContain('changed since this request was made')
    expect(text(card.querySelector('[data-nd-state]'))).toBe('Meets all 5')
    card.querySelector('[data-nd-action="prepare"]')!.click()
    await settle()
    expect(text(card.querySelector('[data-nd-preview="body"]'))).toContain('meets all 5 requirements')
  })

  it('says what the Worker refused it with, in the card', async () => {
    const view = await ready([board(0)])
    const card = view.card('board0.bso')!
    choose(card, 'a')
    view.live.list = []
    card.querySelector('[data-nd-action="prepare"]')!.click()
    await settle()
    expect(text(card.querySelector('[role="status"]'))).toContain('not a board this node hosts')
  })
})

describe('refreshing', () => {
  it('keeps the directory a person chose, adds a board that appears and drops one that goes', async () => {
    const view = await ready([board(0)])
    choose(view.card('board0.bso')!, 'b')
    view.live.list = [board(0), board(1)]
    await view.refresh()
    expect(view.card('board1.bso')).not.toBeNull()
    expect(view.card('board0.bso')!.querySelector('[data-nd-input="directory"]')!.value).toBe('b')
    view.live.list = [board(1)]
    await view.refresh()
    expect(view.card('board0.bso')).toBeNull()
  })

  it('reads a board that had published nothing again, and a board that was read a while ago', async () => {
    const view = await ready([board(0, { record: null })])
    const reads = () => view.calls.filter(([call]) => call === 'board').length
    expect(reads()).toBe(1)
    view.live.list = [board(0)]
    await view.refresh()
    expect(reads()).toBe(2)
    expect(text(view.card('board0.bso'))).not.toContain('has not published its record yet')
    await view.refresh()
    expect(reads()).toBe(2)
    view.time.now += 31_000
    await view.refresh()
    expect(reads()).toBe(3)
  })
})

describe('what seedit is offered', () => {
  it('is the signed request alone, for a route, with a note that seedit\'s own link opens the issue, and nothing it checks', async () => {
    const view = await ready([board(0)], { feature: 'listing-signature' })
    expect(view.section()?.getAttribute('data-nd-section')).toBe('listing-signature')
    expect(view.fetched).toEqual([`${LISTS_RAW}seedit-directories/seedit-directories-defaults.json`])
    const card = view.card('board0.bso')!
    expect(text(view.section())).toContain("seedit's own")
    expect(card.querySelectorAll('option').map((one) => [one.getAttribute('value'), one.textContent])).toEqual([['', 'Choose a route'], ['aww', 's/aww - Aww'], ['cats', 's/cats - Cats']])
    choose(card, 'cats')
    expect(card.querySelectorAll('[data-nd-requirement]')).toHaveLength(0)
    expect(card.querySelector('[data-nd-input="owner"]')).toBeNull()
    expect(card.querySelector('[data-nd-action="open"]')).toBeNull()
    card.querySelector('[data-nd-action="prepare"]')!.click()
    await settle()
    expect(view.calls.filter(([call]) => call === 'sign')).toEqual([['sign', { address: 'board0.bso', file: 'seedit-directories/seedit-cats-directory.json' }]])
    const body = text(card.querySelector('[data-nd-preview="body"]'))
    expect(text(card.querySelector('[data-nd-preview="title"]'))).toBe('Propose a community for s/cats: board0.bso')
    expect(body).toContain('add it to `communities`')
    card.querySelector('[data-nd-action="copy"]')!.click()
    await settle()
    expect(view.copied).toEqual([body])
    expect(view.opened).toEqual([])
  })
})
