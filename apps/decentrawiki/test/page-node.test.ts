import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settings = new Map<string, unknown>()
const hosted = new Map<string, unknown>()
vi.mock('../page/src/store.js', () => ({
  getSetting: async (name: string, fallback: unknown) => settings.has(name) ? settings.get(name) : fallback,
  setSetting: async (name: string, value: unknown) => { settings.set(name, value) },
  getHosted: async (wiki: string) => hosted.get(wiki),
  putHosted: async (row: { wiki: string }) => { hosted.set(row.wiki, row) },
  deleteHosted: async (wiki: string) => { hosted.delete(wiki) },
  listHosted: async () => [...hosted.values()]
}))

const { FREE_PINNING_DEFAULT, freePinningOn, hostingOn: isHosting, pageNodeAvailable, publishFromPageNode, setFreePinning, setHosting } = await import('../page/src/publish/page-node.js')

const NODE = 'http://127.0.0.1:5180'
const RELAY = 'https://pin.example/decentrawiki'
const PAGE_PEER = '12D3KooWR2vUA19onp2TihxmaJyuKqm8oxMSmboKNdeT96PTnKLJ'
const ORIVON_PEER = '12D3KooWBFpVc6cRWcWt72deRUy5SG2Ezcb4w3XqJF9pxp9WE7ne'
const ORIVON = [`/ip4/203.0.113.5/tcp/4001/p2p/${ORIVON_PEER}`, `/ip6/2001:db8::5/tcp/4001/p2p/${ORIVON_PEER}`]
const CID = 'bafybeiaguadwjnfdrtua35mmcvtq5ll2dqpknsmbftbgqjopxxml3zp4sm'
const NEWER = 'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am'

type Call = { url: string, method: string, key: string | null, body: unknown }
let calls: Call[]
let answers: Map<string, (body: unknown) => Response | Promise<Response>>

let listens: boolean[]

beforeEach(() => {
  settings.clear()
  hosted.clear()
  listens = []
  calls = []
  answers = new Map([
    [`${NODE}/blocks`, () => Response.json({ roots: [CID], blocks: 3 })],
    [`${RELAY}/api/v0/node`, () => Response.json({ peer: '12D3KooWOrivon', addrs: ORIVON })],
    [`${NODE}/dial`, () => Response.json({ peer: '12D3KooWOrivon' })],
    [`${RELAY}/api/v0/pin-from`, () => Response.json({ Name: 'wiki', Hash: CID, KeptUntil: '2026-11-22T12:00:00.000Z' })]
  ])
  vi.stubGlobal('window', { orivon: { net: { connect () {} } }, process: {} })
  vi.stubGlobal('decentrawikiNode', { start: async ({ key, port, listen }: { key: string, port: number | null, listen?: boolean }) => { calls.push({ url: 'start', method: '', key, body: port }); listens.push(listen === true); return { base: NODE, peer: PAGE_PEER, port: 5183 } } })
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

  it('dials only addresses shaped as Orivon\'s node names them, eight at most', async () => {
    answers.set(`${RELAY}/api/v0/node`, () => Response.json({ peer: 'x', addrs: ['/dns4/evil.example/tcp/80/p2p/x', 42, ...ORIVON] }))
    await publishFromPageNode({ endpoint: RELAY, cid: CID, car: new Uint8Array(1) })
    expect(calls.filter((c) => c.url === `${NODE}/dial`).map((c) => JSON.parse(String(c.body)).addr)).toEqual([ORIVON[0]])
    answers.set(`${RELAY}/api/v0/node`, () => Response.json({ peer: 'x', addrs: 'not a list' }))
    await expect(publishFromPageNode({ endpoint: RELAY, cid: CID, car: new Uint8Array(1) })).rejects.toThrow(/could not connect to Orivon's node/)
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

  it('is offered only where the page has Orivon\'s sockets and the tab runs as the app', () => {
    expect(pageNodeAvailable()).toBe(true)
    vi.stubGlobal('window', { orivon: { net: { connect () {}, listen () {} } } })
    expect(pageNodeAvailable()).toBe(false)
    vi.stubGlobal('window', {})
    expect(pageNodeAvailable()).toBe(false)
  })
})

describe('publishing from the node that hosts the person\'s wikis', () => {
  const FEATURES = 'serve, listen, provide, relay'

  function hostingOn(nodeFeatures: string[] | null = FEATURES.split(', ')) {
    settings.set('hostWikis', true)
    vi.stubGlobal('window', { orivon: { net: { connect () {}, listen () {} } }, process: {} })
    answers.set('build.json', () => Response.json(nodeFeatures === null ? {} : { nodeFeatures }))
    answers.set(`${NODE}/health`, () => new Response('ok', { headers: { 'x-orivon-node-features': FEATURES } }))
    answers.set(`${NODE}/status`, () => Response.json({ relays: [], reachability: 'unknown', providing: [] }))
    answers.set(`${NODE}/provide`, () => Response.json({}, { status: 202 }))
  }

  async function fresh() {
    vi.resetModules()
    const node = await import('../page/src/publish/page-node.js')
    const { hosting } = await import('../page/src/publish/hosting.js')
    return { publishFromPageNode: node.publishFromPageNode, offerNodeToOrivon: node.offerNodeToOrivon, setHosting: node.setHosting, hostOrRevert: node.hostOrRevert, hosting }
  }

  const paths = () => calls.filter((c) => c.url.startsWith(NODE)).map((c) => `${c.method} ${c.url.slice(NODE.length)}`)

  it('starts the node that hosts, hands it the blocks once, and lets hosting announce the version without sending them again', async () => {
    hostingOn()
    const { publishFromPageNode, hosting } = await fresh()
    const car = new Uint8Array([1, 2, 3])
    await publishFromPageNode({ endpoint: RELAY, cid: CID, car })
    expect(listens).toEqual([true])
    expect(paths()).toEqual(['GET /health', 'GET /status', 'POST /blocks', 'POST /dial'])
    await publishFromPageNode({ endpoint: RELAY, cid: CID, car })
    expect(paths().filter((p) => p === 'POST /blocks')).toHaveLength(1)
    expect(listens).toEqual([true])
    expect(await hosting.host('wiki', CID, car)).toBe(true)
    expect(paths().filter((p) => p === 'POST /blocks')).toHaveLength(1)
    expect(paths().at(-1)).toBe('POST /provide')
    expect(hosted.get('wiki')).toMatchObject({ wiki: 'wiki', cid: CID })
    await hosting.stop()
  })

  it('publishes from a node that only answers the peer it dials when the node cannot host', async () => {
    hostingOn(null)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { publishFromPageNode } = await fresh()
      const result = await publishFromPageNode({ endpoint: RELAY, cid: CID, car: new Uint8Array(1) })
      expect(result.cid).toBe(CID)
      expect(listens).toEqual([false])
      expect(paths()).toEqual(['POST /blocks', 'POST /dial'])
      expect(error.mock.calls.map((call) => String(call[0]))).toEqual(['[decentrawiki] hosting is unavailable: the IPFS node this editor shipped has no listen, provide and relay features'])
    } finally {
      error.mockRestore()
    }
  })

  it('does not start a node that listens while hosting is off', async () => {
    hostingOn()
    settings.set('hostWikis', false)
    const { publishFromPageNode } = await fresh()
    await publishFromPageNode({ endpoint: RELAY, cid: CID, car: new Uint8Array(1) })
    expect(listens).toEqual([false])
    expect(paths()).toEqual(['POST /blocks', 'POST /dial'])
  })

  it('takes back every announcement when the switch is turned off, keeps the stored version, and hosts it again when the switch is turned on', async () => {
    hostingOn()
    answers.set(`${NODE}/provide/${CID}`, () => new Response('', { status: 200 }))
    const { publishFromPageNode, hosting, setHosting: save } = await fresh()
    const car = new Uint8Array([1, 2, 3])
    await publishFromPageNode({ endpoint: RELAY, cid: CID, car })
    expect(await hosting.host('wiki', CID, car)).toBe(true)
    await save(false)
    expect(settings.get('hostWikis')).toBe(false)
    expect(paths()).toContain(`DELETE /provide/${CID}`)
    expect(hosted.get('wiki')).toMatchObject({ cid: CID })
    await save(true)
    expect(settings.get('hostWikis')).toBe(true)
    await vi.waitFor(() => expect(paths().filter((p) => p === 'POST /provide')).toHaveLength(2))
    await hosting.stop()
  })

  it('waits for a turn-off to end the node before a turn-on that came meanwhile starts it again, so the node keeps hosting', async () => {
    hostingOn()
    let letGo = () => {}
    const gate = new Promise<void>((resolve) => { letGo = resolve })
    answers.set(`${NODE}/provide/${CID}`, async () => { await gate; return new Response('', { status: 200 }) })
    const { publishFromPageNode, hosting, setHosting: save } = await fresh()
    await publishFromPageNode({ endpoint: RELAY, cid: CID, car: new Uint8Array([1, 2, 3]) })
    expect(await hosting.host('wiki', CID, new Uint8Array([1, 2, 3]))).toBe(true)
    const off = save(false)
    await vi.waitFor(() => expect(paths()).toContain(`DELETE /provide/${CID}`))
    const on = save(true)
    expect(settings.get('hostWikis')).toBe(false)
    letGo()
    await Promise.all([off, on])
    expect(settings.get('hostWikis')).toBe(true)
    await vi.waitFor(() => expect(hosting.summary()).toMatchObject({ running: true, wikis: 1 }))
    expect(paths().filter((p) => p === 'POST /provide')).toHaveLength(2)
    await hosting.stop()
  })

  it('puts the wiki\'s kept version back, and announces it again, when the node does not take a version that only this computer hosts', async () => {
    hostingOn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    answers.set(`${NODE}/provide/${CID}`, () => new Response('', { status: 200 }))
    answers.set(`${NODE}/provide/${NEWER}`, () => new Response('', { status: 200 }))
    try {
      const { hostOrRevert, hosting } = await fresh()
      const car = new Uint8Array([1, 2, 3])
      expect(await hostOrRevert('wiki', CID, car)).toBe(true)
      expect(hosted.get('wiki')).toMatchObject({ cid: CID })
      answers.set(`${NODE}/blocks`, () => new Response('table full', { status: 507 }))
      expect(await hostOrRevert('wiki', NEWER, new Uint8Array([4, 5, 6]))).toBe(false)
      expect(hosted.get('wiki')).toMatchObject({ cid: CID })
      await vi.waitFor(() => expect(hosting.summary()).toMatchObject({ wikis: 1, unplaced: 0 }))
      expect(paths().filter((p) => p === 'POST /provide')).toHaveLength(2)
      expect(await hostOrRevert('other', NEWER, car)).toBe(false)
      expect(hosted.has('other')).toBe(false)
      await hosting.stop()
    } finally {
      error.mockRestore()
    }
  })

  it('takes back a version that only this computer hosts when the publish is cancelled while the node takes it', async () => {
    hostingOn()
    answers.set(`${NODE}/provide/${CID}`, () => new Response('', { status: 200 }))
    const { hostOrRevert, hosting } = await fresh()
    const cancel = new AbortController()
    cancel.abort()
    expect(await hostOrRevert('wiki', CID, new Uint8Array([1, 2, 3]), cancel.signal)).toBe(false)
    expect(hosted.has('wiki')).toBe(false)
    expect(paths()).toContain(`DELETE /provide/${CID}`)
    await hosting.stop()
  })

  it('connects the node to Orivon\'s node and answers its id, for keeping an address Orivon pins nothing of', async () => {
    hostingOn()
    const { offerNodeToOrivon, hosting } = await fresh()
    expect(await offerNodeToOrivon({ endpoint: `${RELAY}/` })).toBe(PAGE_PEER)
    expect(paths().filter((p) => p === 'POST /dial')).toHaveLength(1)
    answers.set(`${NODE}/dial`, () => new Response('timeout', { status: 504 }))
    expect(await offerNodeToOrivon({ endpoint: RELAY })).toBe(PAGE_PEER)
    await hosting.stop()
  })

  it('answers no id when hosting is off or the node cannot host', async () => {
    hostingOn()
    settings.set('hostWikis', false)
    expect(await (await fresh()).offerNodeToOrivon({ endpoint: RELAY })).toBeNull()
    hostingOn(null)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await (await fresh()).offerNodeToOrivon({ endpoint: RELAY })).toBeNull()
    } finally {
      error.mockRestore()
    }
  })
})

describe('the two switches Settings offers', () => {
  const listening = () => vi.stubGlobal('window', { orivon: { net: { connect () {}, listen () {} } }, process: {} })

  it('counts free pinning as on when absent, and keeps what Settings saves', async () => {
    expect(FREE_PINNING_DEFAULT).toBe(true)
    expect(await freePinningOn()).toBe(true)
    await setFreePinning(false)
    expect(settings.get('freePinning')).toBe(false)
    expect(await freePinningOn()).toBe(false)
    await setFreePinning(true)
    expect(settings.get('freePinning')).toBe(true)
    expect(await freePinningOn()).toBe(true)
  })

  it('counts hosting as on when absent in Orivon, and keeps what Settings saves', async () => {
    listening()
    expect(await isHosting()).toBe(true)
    await setHosting(false)
    expect(settings.get('hostWikis')).toBe(false)
    expect(await isHosting()).toBe(false)
    await setHosting(true)
    expect(settings.get('hostWikis')).toBe(true)
    expect(await isHosting()).toBe(true)
  })

  it('has hosting off where the page cannot run a node that listens, whatever was saved', async () => {
    expect(await isHosting()).toBe(false)
    vi.stubGlobal('window', {})
    await setHosting(true)
    expect(settings.get('hostWikis')).toBe(true)
    expect(await isHosting()).toBe(false)
  })
})
