import { readFile, readdir, stat } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toChecksumAddress } from '../site/sdk/abi.js'
import type { Chain } from '../site/sdk/chain.js'
import { CENSUS_FORMAT, type Census } from '../site/resolver/og-census.js'
import { IMPLEMENTATION, UPGRADES } from '../site/resolver/og-pins.js'
import { fakeOrivon } from './support/fake-orivon.ts'
import { fakeChain, worldOf } from './support/og-world.ts'
import { VECTORS } from './support/og-vectors.ts'

const manifest = JSON.parse(await readFile(new URL('../orivon.json', import.meta.url), 'utf8'))
const recipe = JSON.parse(await readFile(new URL('../recipe.json', import.meta.url), 'utf8'))
const SITE = new URL('../site/', import.meta.url)
const RESOLVER = new URL('resolver/', SITE)
const sources = async () => await Promise.all((await readdir(RESOLVER)).filter((name) => name.endsWith('.js')).map(async (name) => [name, await readFile(new URL(name, RESOLVER), 'utf8')] as const))
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the manifest entry', () => {
  it('declares the .og resolver as a page that reads Ethereum, and writes only with the two codes a person confirms', () => {
    expect(manifest.integrations).toEqual([{
      type: 'name-resolution',
      id: 'og-names',
      name: 'OG names (.og)',
      namespaces: ['.og'],
      codes: ['NAMES_0_1', 'NAMES_0_2'],
      hosting: 'page',
      entry: 'resolver/index.html',
      onTheFly: true,
      icon: 'resolver/og-names.svg',
      uses: [
        { code: 'ETH_NET_0_1_READONLY', why: expect.stringMatching(/^.{10,160}$/) },
        { code: 'ETH_0_1', optional: true, why: expect.stringMatching(/^.{10,160}$/) },
        { code: 'ETH_NET_0_1', optional: true, why: expect.stringMatching(/^.{10,160}$/) }
      ]
    }])
  })

  it('names the site as the recipe does', () => {
    expect(recipe).toMatchObject({ id: 'og', site: 'site', manifest: 'orivon.json', eth: 'og.orivonstack.eth' })
    expect(manifest).toMatchObject({ domain: 'og.orivonstack.eth', entry: 'index.html', capabilities: {} })
  })

  it('keeps the rules Orivon\'s loader reads an integration entry by', () => {
    const [entry] = manifest.integrations
    const allowed = ['id', 'name', 'hosting', 'entry', 'module', 'hash', 'export', 'onTheFly', 'background', 'uses', 'panel', 'icon', 'type', 'namespaces', 'codes']
    expect(Object.keys(entry).filter((key) => !allowed.includes(key))).toEqual([])
    expect(entry.id).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(entry.name.length).toBeLessThanOrEqual(60)
    for (const namespace of entry.namespaces) expect(namespace).toMatch(/^\.[a-z0-9-]{1,63}$/)
    for (const use of entry.uses) {
      expect(Object.keys(use).filter((key) => !['code', 'optional', 'why'].includes(key))).toEqual([])
      expect(use.code).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*_\d{1,3}_\d{1,3}(?:_[A-Z0-9]+)?$/)
      expect(use.why.length).toBeLessThanOrEqual(160)
    }
    expect(new Set(entry.uses.map((use: { code: string }) => use.code)).size).toBe(entry.uses.length)
  })

  it('names files that are in the bundle, as relative paths inside it', async () => {
    const [entry] = manifest.integrations
    for (const path of [entry.entry, entry.icon, 'resolver/census.json', 'index.html']) {
      expect(path).not.toMatch(/^\/|^[a-z]+:|\.\.|\\/)
      expect((await stat(new URL(path, SITE))).isFile(), path).toBe(true)
    }
  })
})

describe('the page', () => {
  it('is one document with one module script and nothing inline', async () => {
    const html = await readFile(new URL('index.html', RESOLVER), 'utf8')
    expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script type="module" src="resolver.js">'])
    expect(html).not.toMatch(/\son[a-z]+\s*=|javascript:|<style|<link|<iframe|<img|<form|https?:/i)
  })

  it('has an icon that is a small SVG with nothing active in it and no reference to anything else', async () => {
    const svg = await readFile(new URL('og-names.svg', RESOLVER), 'utf8')
    expect(Buffer.byteLength(svg)).toBeLessThanOrEqual(65536)
    expect(svg).toMatch(/^<svg\b/)
    expect(svg).not.toMatch(/<script|<foreignObject|<image|<use\b|<style|<a\b|\shref\s*=|xlink|url\s*\(|\son[a-z]+\s*=|javascript:|data:|@import/i)
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:/i)
  })

  it('is made of files that name no standard code but in resolver.js, and ask for Ethereum only through the call it serves', async () => {
    const files = await sources()
    expect(files.map(([name]) => name).sort()).toEqual(['og-answer.js', 'og-census.js', 'og-freshness.js', 'og-guard.js', 'og-name.js', 'og-names.js', 'og-pins.js', 'og-set-record.js', 'og-state.js', 'og-tail.js', 'resolver.js'])
    for (const [name, source] of files) {
      const text = code(source)
      expect([...new Set(text.match(/NAMES_0_\d/g) ?? [])], name).toEqual(name === 'resolver.js' ? ['NAMES_0_1', 'NAMES_0_2'] : [])
      expect(text, name).not.toMatch(/\bETH_0_1\b|ETH_NET_0_1|orivon\.use|window\.orivon\b/)
    }
  })

  it('serves the vendored normalizer with its licence beside it', async () => {
    expect(await readFile(new URL('vendor/ens-normalize.LICENSE', RESOLVER), 'utf8')).toMatch(/MIT License[\s\S]*Permission is hereby granted/)
    expect((await stat(new URL('vendor/ens-normalize.js', RESOLVER))).isFile()).toBe(true)
  })
})

// Transcribed from the result of `resolve` in Orivon's NAMES_0_1 module: what the browser checks before the asker sees it.
const RECORD_TYPES = ['contentHash', 'ipfs', 'bzz', 'arw', 'magnet', 'https', 'http', 'ddoc']
function checkResult (result: any): void {
  expect(Object.keys(result).sort()).toEqual(['ownerDefault', 'provenance', 'records'])
  expect(result.ownerDefault).toBeNull()
  expect(result.records.length).toBeLessThanOrEqual(16)
  for (const record of result.records) {
    expect(Object.keys(record).sort()).toEqual(['type', 'value'])
    expect(RECORD_TYPES).toContain(record.type)
    expect(record.value.length).toBeLessThanOrEqual(2048)
  }
  const { by, proven, block, ...extra } = result.provenance
  expect(extra).toEqual({})
  expect(typeof by === 'string' && by.length <= 80).toBe(true)
  expect(proven).toBe(false)
  if (block !== undefined) expect(Number.isSafeInteger(block) && block >= 0).toBe(true)
}

const PASSES = VECTORS.find((vector) => vector.id === 'unwrapped-passes')!
const HOLDER = toChecksumAddress('0x8dc313a803D2Fe315eC4fd9180B1CE27431Ce279')
const world = () => worldOf(PASSES)
const CENSUS_BLOCK = 26_400_700

/** The census a page fetches: before the vector's logs, with the name listed so the page reads its history when it starts. */
const census = (): Census => ({
  format: CENSUS_FORMAT, block: CENSUS_BLOCK, blockHash: `0x${'00'.repeat(32)}`, implementation: IMPLEMENTATION, upgrades: [...UPGRADES],
  names: { [PASSES.label]: { holder: HOLDER, wrapped: false, id: null, holderChange: null, newController: null, keys: {} } }
})

/** What the browser's ETH_NET_0_1_READONLY handle answers, from a chain: the wire form of each argument turned back into the chain's. */
function reads (chain: Chain) {
  const ref = (param: string) => param === 'safe' || param === 'latest' ? param : parseInt(param, 16)
  return {
    blockNumber: async () => await chain.blockNumber(),
    getBlock: async (param: string) => await chain.getBlock(ref(param)),
    call: async (tx: { to: string, data: Uint8Array }, block: string) => await chain.call(tx, ref(block)),
    getLogs: async (filter: { fromBlock: string, toBlock: string, address?: string[], topics?: (string | null)[] }) => await chain.getLogs({ ...filter, fromBlock: ref(filter.fromBlock), toBlock: ref(filter.toBlock) }),
    getStorageAt: async (address: string, slot: string, block: string) => await chain.getStorageAt(address, slot, ref(block))
  }
}

describe('what the page provides', () => {
  type Implementation = Record<string, (context: unknown, ...args: any[]) => Promise<any>>
  const provided: Record<string, Implementation> = {}
  let fetched: string[]
  let censusReply: () => Response

  async function start (options: { use?: unknown } = {}) {
    vi.resetModules()
    for (const key of Object.keys(provided)) delete provided[key]
    const provide = vi.fn((codeName: string, implementation: Implementation) => { provided[codeName] = implementation })
    ;(globalThis as any).window = { orivonIntegration: { version: 0, provide, use: options.use ?? (async () => { throw new Error('no read-ahead here') }) } }
    await import('../site/resolver/resolver.js')
    return provide
  }
  const context = (use: unknown, signal = new AbortController().signal) => ({ depth: 1, deadlineAt: Date.now() + 30_000, signal, use, progress: vi.fn() })

  beforeEach(() => {
    fetched = []
    censusReply = () => new Response(JSON.stringify(census()))
    vi.stubGlobal('fetch', async (url: unknown) => { fetched.push(String(url)); return censusReply() })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    delete (globalThis as any).window
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('provides NAMES_0_1 with resolve, and NAMES_0_2 with resolve and setRecord, once each', async () => {
    const provide = await start()
    expect(provide.mock.calls.map((call) => call[0])).toEqual(['NAMES_0_1', 'NAMES_0_2'])
    expect(Object.keys(provided['NAMES_0_1']!)).toEqual(['resolve'])
    expect(Object.keys(provided['NAMES_0_2']!)).toEqual(['resolve', 'setRecord'])
  })

  it('answers a .og name through the use of the call it serves, asking for ETH_NET_0_1_READONLY alone, in the standard\'s shape', async () => {
    await start()
    const orivon = fakeOrivon(reads(fakeChain(world()).chain))
    const result = await provided['NAMES_0_1']!.resolve!(context(orivon.orivon.use), `${PASSES.label}.og`)
    checkResult(result)
    expect(result.records).toEqual([{ type: 'ipfs', value: PASSES.state.values['content.ipfs'] }])
    expect(orivon.uses.flatMap((use) => use.codes)).toEqual(['ETH_NET_0_1_READONLY'])
    expect(fetched).toHaveLength(1)
    expect(fetched[0]).toMatch(/\/resolver\/census\.json$/)
  })

  it('answers a name that is not there, and one it cannot judge, in the standard\'s shape too', async () => {
    await start()
    const orivon = fakeOrivon(reads(fakeChain(world()).chain))
    for (const name of ['nobody.og', 'Nobody.og', 'a.b.og']) {
      const result = await provided['NAMES_0_1']!.resolve!(context(orivon.orivon.use), name)
      checkResult(result)
      expect(result.records).toEqual([])
    }
  })

  it('fails with the code of the failure, so the router goes on: invalid for a name outside .og, declined when the read is not granted, unavailable for a node that is down', async () => {
    await start()
    const declined = fakeOrivon({}, ['ETH_NET_0_1_READONLY'])
    await expect(provided['NAMES_0_1']!.resolve!(context(declined.orivon.use), 'alice.eth')).rejects.toMatchObject({ code: 'invalid' })
    await expect(provided['NAMES_0_1']!.resolve!(context(declined.orivon.use), `${PASSES.label}.og`)).rejects.toMatchObject({ reason: 'declined' })
    const down = fakeOrivon({ getBlock: async () => { throw Object.assign(new Error('the light client is not synced'), { code: 'unavailable' }) } })
    await expect(provided['NAMES_0_1']!.resolve!(context(down.orivon.use), `${PASSES.label}.og`)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('says its words on the loading screen and in the console when it refuses to answer', async () => {
    await start()
    const made = fakeChain({ ...world(), implementation: `0x${'cd'.repeat(20)}` })
    const orivon = fakeOrivon(reads(made.chain))
    const call = context(orivon.orivon.use)
    await expect(provided['NAMES_0_1']!.resolve!(call, `${PASSES.label}.og`)).rejects.toMatchObject({ code: 'unavailable', name: 'OgRefusal' })
    expect(call.progress).toHaveBeenCalledWith(expect.stringMatching(/not built for/))
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[og-names\] .*not built for/))
  })

  it('fails every lookup that needs the census when the census cannot be read, and goes on providing', async () => {
    censusReply = () => new Response('', { status: 404 })
    await start()
    const orivon = fakeOrivon(reads(fakeChain(world()).chain))
    await expect(provided['NAMES_0_1']!.resolve!(context(orivon.orivon.use), `${PASSES.label}.og`)).rejects.toMatchObject({ code: 'unavailable', message: expect.stringMatching(/census/) })
  })

  it('stops waiting when the call is no longer wanted, even if the node never answers', async () => {
    await start()
    const stuck = fakeOrivon({ getBlock: () => new Promise(() => {}), blockNumber: () => new Promise(() => {}) })
    const controller = new AbortController()
    const pending = provided['NAMES_0_1']!.resolve!(context(stuck.orivon.use, controller.signal), `${PASSES.label}.og`)
    controller.abort(new Error('the asker left'))
    await expect(pending).rejects.toThrow('the asker left')
  })

  it('reads ahead with the integration\'s own use when it starts, so the first lookup finds its windows read', async () => {
    const warm = fakeOrivon(reads(fakeChain(world()).chain))
    await start({ use: warm.orivon.use })
    await vi.waitFor(() => { expect(warm.calls.filter((call) => call.fn.endsWith('getLogs')).length).toBeGreaterThanOrEqual(2) })
    const lookup = fakeOrivon(reads(fakeChain(world()).chain))
    const result = await provided['NAMES_0_1']!.resolve!(context(lookup.orivon.use), `${PASSES.label}.og`)
    expect(result.records).toHaveLength(1)
    expect(lookup.calls.filter((call) => call.fn.endsWith('getLogs'))).toEqual([])
  })

  it('answers setRecord with declined, and signs nothing, when the person does not grant ETH_0_1', async () => {
    await start()
    const orivon = fakeOrivon(reads(fakeChain(world()).chain), ['ETH_0_1', 'ETH_NET_0_1'])
    const result = await provided['NAMES_0_2']!.setRecord!(context(orivon.orivon.use), `${PASSES.label}.og`, 'contenthash', `ipfs://${'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'}`)
    expect(result).toEqual({ status: 'declined' })
  })

  it('answers setRecord with not-manager for an account that does not own the name, in the standard\'s shape', async () => {
    await start()
    const stranger = toChecksumAddress(`0x${'b0'.repeat(20)}`)
    const orivon = fakeOrivon({ ...reads(fakeChain(world()).chain), getAddresses: [stranger] })
    const call = context(orivon.orivon.use)
    const result = await provided['NAMES_0_2']!.setRecord!(call, `${PASSES.label}.og`, 'contenthash', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')
    expect(result).toEqual({ status: 'not-manager' })
    expect(call.progress).toHaveBeenCalledWith(expect.stringMatching(/owned by another account/))
    expect(orivon.calls.map((one) => one.fn)).not.toContain('ETH_0_1.signTransaction')
  })

  it('refuses a setRecord the standard does not define, as invalid', async () => {
    await start()
    const orivon = fakeOrivon({})
    await expect(provided['NAMES_0_2']!.setRecord!(context(orivon.orivon.use), `${PASSES.label}.og`, 'address', 'ipfs://x')).rejects.toMatchObject({ code: 'invalid' })
  })
})
