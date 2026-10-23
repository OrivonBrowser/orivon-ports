import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settings = new Map<string, unknown>()
vi.mock('../page/src/store.js', () => ({
  getSetting: async (name: string, fallback: unknown) => settings.has(name) ? settings.get(name) : fallback,
  setSetting: async (name: string, value: unknown) => { settings.set(name, value) }
}))

const { pageNodeAvailable, publishFromPageNode } = await import('../page/src/publish/page-node.js')

const NODE = 'http://127.0.0.1:5180'
const RELAY = 'https://pin.example/decentrawiki'
const PAGE_PEER = '12D3KooWPagePeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ORIVON = ['/ip4/203.0.113.5/tcp/4001/p2p/12D3KooWOrivonAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '/ip6/2001:db8::5/tcp/4001/p2p/12D3KooWOrivonAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']
const CID = 'bafybeiaguadwjnfdrtua35mmcvtq5ll2dqpknsmbftbgqjopxxml3zp4sm'

type Call = { url: string, method: string, key: string | null, body: unknown }
let calls: Call[]
let answers: Map<string, (body: unknown) => Response>

beforeEach(() => {
  settings.clear()
  calls = []
  answers = new Map([
    [`${NODE}/blocks`, () => Response.json({ roots: [CID], blocks: 3 })],
    [`${RELAY}/api/v0/node`, () => Response.json({ peer: '12D3KooWOrivon', addrs: ORIVON })],
    [`${NODE}/dial`, () => Response.json({ peer: '12D3KooWOrivon' })],
    [`${RELAY}/api/v0/pin-from`, () => Response.json({ Name: 'wiki', Hash: CID, KeptUntil: '2026-11-22T12:00:00.000Z' })]
  ])
  vi.stubGlobal('window', { orivon: { net: { connect () {} } } })
  vi.stubGlobal('decentrawikiNode', { start: async ({ key, port }: { key: string, port: number | null }) => { calls.push({ url: 'start', method: '', key, body: port }); return { base: NODE, peer: PAGE_PEER, port: 5183 } } })
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input)
    const headers = new Headers(init.headers)
    calls.push({ url, method: init.method ?? 'GET', key: headers.get('x-orivon-key'), body: init.body })
    const answer = answers.get(url.split('?')[0] ?? '')
    if (answer === undefined) throw new TypeError('fetch failed')
    return answer(init.body)
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('publishing from the page\'s own IPFS node', () => {
  it('starts the node, hands it the CAR, dials Orivon\'s node and has it read the wiki', async () => {
    const car = new Uint8Array([1, 2, 3])
    const steps: string[] = []
    const result = await publishFromPageNode({ endpoint: `${RELAY}/`, cid: CID, car, onStep: (s) => steps.push(s) })
    expect(result).toEqual({ cid: CID, keptUntil: Date.parse('2026-11-22T12:00:00.000Z') })
    const key = calls[0]?.key
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      ' start',
      `POST ${NODE}/blocks`,
      `POST ${RELAY}/api/v0/node`,
      `POST ${NODE}/dial`,
      `POST ${RELAY}/api/v0/pin-from?arg=${CID}&peer=${PAGE_PEER}`
    ])
    expect(calls[1]?.body).toBe(car)
    expect(calls.filter((c) => c.url.startsWith(NODE)).every((c) => c.key === key)).toBe(true)
    expect(calls.filter((c) => c.url.startsWith(RELAY)).every((c) => c.key === null)).toBe(true)
    expect(JSON.parse(String(calls[3]?.body))).toEqual({ addr: ORIVON[0] })
    expect(steps).toHaveLength(4)
  })

  it('keeps one key for every publish, and tries Orivon\'s next address when one does not connect', async () => {
    let dials = 0
    answers.set(`${NODE}/dial`, () => (++dials === 1 ? new Response('no route', { status: 502 }) : Response.json({ peer: 'x' })))
    await publishFromPageNode({ endpoint: RELAY, cid: CID, car: new Uint8Array(1) })
    await publishFromPageNode({ endpoint: RELAY, cid: CID, car: new Uint8Array(1) })
    const starts = calls.filter((c) => c.url === 'start')
    expect(new Set(starts.map((c) => c.key)).size).toBe(1)
    expect(starts.map((c) => c.body)).toEqual([null, 5183])
    expect(calls.filter((c) => c.url === `${NODE}/dial`).map((c) => JSON.parse(String(c.body)).addr).slice(0, 2)).toEqual(ORIVON)
  })

  it('says what free pinning and the node refused, in their words', async () => {
    answers.set(`${RELAY}/api/v0/pin-from`, () => Response.json({ Message: 'This version was already kept free for a month.', Code: 0, Type: 'error' }, { status: 409 }))
    await expect(publishFromPageNode({ endpoint: RELAY, cid: CID, car: new Uint8Array(1) })).rejects.toThrow('This version was already kept free for a month.')
    answers.set(`${NODE}/blocks`, () => new Response('a block does not match its CID', { status: 400 }))
    await expect(publishFromPageNode({ endpoint: RELAY, cid: CID, car: new Uint8Array(1) })).rejects.toThrow(/Your IPFS node refused it: a block does not match its CID/)
  })

  it('says so when no address of Orivon\'s node connects, and when the node will not start', async () => {
    answers.set(`${NODE}/dial`, () => new Response('timeout', { status: 504 }))
    await expect(publishFromPageNode({ endpoint: RELAY, cid: CID, car: new Uint8Array(1) })).rejects.toThrow(/could not connect to Orivon's node/)
    vi.stubGlobal('decentrawikiNode', { start: async () => { throw new Error('Your IPFS node could not start: no port was free.') } })
    await expect(publishFromPageNode({ endpoint: RELAY, cid: CID, car: new Uint8Array(1) })).rejects.toThrow('Your IPFS node could not start: no port was free.')
  })

  it('is offered only where the page has Orivon\'s sockets', () => {
    expect(pageNodeAvailable()).toBe(true)
    vi.stubGlobal('window', {})
    expect(pageNodeAvailable()).toBe(false)
  })
})
