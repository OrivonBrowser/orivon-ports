import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settings = new Map<string, unknown>()
vi.mock('../page/src/store.js', () => ({
  getSetting: async (name: string, fallback: unknown) => settings.has(name) ? settings.get(name) : fallback,
  setSetting: async (name: string, value: unknown) => { settings.set(name, value) }
}))

const { FREE, HOSTED_ONLY, describe: describeTarget, pin, recordName } = await import('../page/src/publish/targets.js')

const RELAY = 'https://telemetry.orivonstack.com/decentrawiki'
const NODE = 'http://127.0.0.1:5180'
const PAGE_PEER = '12D3KooWR2vUA19onp2TihxmaJyuKqm8oxMSmboKNdeT96PTnKLJ'
const ORIVON_PEER = '12D3KooWBFpVc6cRWcWt72deRUy5SG2Ezcb4w3XqJF9pxp9WE7ne'
const CID = 'bafybeiaguadwjnfdrtua35mmcvtq5ll2dqpknsmbftbgqjopxxml3zp4sm'
const KEPT = '2026-11-22T12:00:00.000Z'

const files = [{ path: 'index.html', bytes: new Uint8Array([1, 2, 3]) }]
const site = { cid: CID, car: () => new Uint8Array([9]) }
const upload = { rootName: 'wiki', name: 'Wiki (DecentraWiki)', files, site }

let urls: string[]
let starts: number

beforeEach(() => {
  settings.clear()
  urls = []
  starts = 0
  vi.stubGlobal('window', { orivon: { net: { connect () {} } }, process: {} })
  vi.stubGlobal('decentrawikiNode', { start: async () => { starts++; return { base: NODE, peer: PAGE_PEER, port: 5180 } } })
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input)
    urls.push(`${init.method ?? 'GET'} ${url.split('?')[0]}`)
    if (url.startsWith(`${NODE}/blocks`)) return Response.json({ roots: [CID], blocks: 3 })
    if (url.endsWith('/api/v0/node')) return Response.json({ peer: 'x', addrs: [`/ip4/203.0.113.5/tcp/4001/p2p/${ORIVON_PEER}`] })
    if (url.endsWith('/dial')) return Response.json({ peer: 'x' })
    if (url.includes('/api/v0/pin-from')) return Response.json({ Name: 'wiki', Hash: CID, KeptUntil: KEPT })
    return new Response(`{"Name":"wiki","Hash":"${CID}","Size":"3","KeptUntil":"${KEPT}"}\n`)
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('free pinning, by whether the page\'s node hosts', () => {
  it('uploads to Orivon\'s server, and starts no node, when hosting is off', async () => {
    const result = await pin(FREE, { ...upload, fromNode: false })
    expect(result).toEqual({ cid: CID, keptUntil: Date.parse(KEPT) })
    expect(urls).toEqual([`POST ${RELAY}/api/v0/add`])
    expect(starts).toBe(0)
  })

  it('uploads when nothing says to use the node', async () => {
    await pin(FREE, upload)
    expect(urls).toEqual([`POST ${RELAY}/api/v0/add`])
    expect(starts).toBe(0)
  })

  it('publishes from the page\'s node when hosting is on', async () => {
    const result = await pin(FREE, { ...upload, fromNode: true })
    expect(result).toEqual({ cid: CID, keptUntil: Date.parse(KEPT) })
    expect(starts).toBe(1)
    expect(urls).toEqual([
      `POST ${NODE}/blocks`,
      `POST ${RELAY}/api/v0/node`,
      `POST ${NODE}/dial`,
      `POST ${RELAY}/api/v0/pin-from`
    ])
  })

  it('uploads where the page can run no node, whatever Settings holds', async () => {
    vi.stubGlobal('window', {})
    await pin(FREE, { ...upload, fromNode: true })
    expect(urls).toEqual([`POST ${RELAY}/api/v0/add`])
    expect(starts).toBe(0)
  })

  it('uploads when the site was not addressed here, so there is nothing to hand a node', async () => {
    await pin(FREE, { rootName: 'wiki', name: 'Wiki', files, fromNode: true })
    expect(urls).toEqual([`POST ${RELAY}/api/v0/add`])
    expect(starts).toBe(0)
  })

  it('leaves the services of the person\'s own to their own route', async () => {
    const kubo = { id: 'k', kind: 'kubo' as const, values: { endpoint: 'http://127.0.0.1:5001' } }
    const result = await pin(kubo, { ...upload, fromNode: true })
    expect(result).toEqual({ cid: CID, keptUntil: null })
    expect(urls).toEqual(['POST http://127.0.0.1:5001/api/v0/add'])
    expect(starts).toBe(0)
  })
})

describe('what a person reads for free pinning', () => {
  it('names the node when hosting is on, and Orivon\'s free pinning when it is off', () => {
    expect(describeTarget(FREE, true)).toBe('Your IPFS node, in this page')
    expect(describeTarget(FREE, false)).toBe('Free pinning by Orivon')
    expect(describeTarget(FREE)).toBe('Free pinning by Orivon')
  })

  it('records the publication under the route it took', () => {
    const until = Date.parse(KEPT)
    expect(recordName(FREE, until, true)).toMatch(/^Your IPFS node, kept by Orivon until /)
    expect(recordName(FREE, until, false)).toMatch(/^Free pinning by Orivon, until /)
    expect(recordName(FREE, until)).toMatch(/^Free pinning by Orivon, until /)
    expect(recordName(FREE, null, true)).toBe('Your IPFS node, in this page')
    expect(recordName(FREE, null, false)).toBe('Free pinning by Orivon')
  })

  it('records a publication only this computer hosts under its own name', () => {
    expect(HOSTED_ONLY).toBe('This computer, while the editor is open')
  })

  it('reads a service of the person\'s the same whichever route free pinning takes', () => {
    const rpc = { id: 'r', kind: 'rpc' as const, values: { endpoint: 'https://ipfs.example.org' } }
    expect(describeTarget(rpc, true)).toBe(describeTarget(rpc, false))
    expect(recordName(rpc, Date.parse(KEPT), true)).toBe(recordName(rpc, Date.parse(KEPT), false))
  })
})
