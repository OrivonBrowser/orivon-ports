import { readFile, readdir, stat } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { toChecksumAddress } from '../site/sdk/abi.js'
import { fakeOrivon } from './support/fake-orivon.ts'
import { fakeOrv } from './support/fake-orv.ts'

const manifest = JSON.parse(await readFile(new URL('../orivon.json', import.meta.url), 'utf8'))
const SITE = new URL('../site/', import.meta.url)
const RESOLVER = new URL('resolver/', SITE)
const sources = async () => await Promise.all((await readdir(RESOLVER)).filter((name) => name.endsWith('.js')).map(async (name) => [name, await readFile(new URL(name, RESOLVER), 'utf8')] as const))

const ENTRY = {
  type: 'name-resolution',
  id: 'orv-names',
  name: 'ID names (.orv)',
  namespaces: ['.orv'],
  hosting: 'page',
  entry: 'resolver/index.html',
  onTheFly: true,
  icon: 'resolver/orv-names.svg',
  uses: [{ code: 'ETH_NET_0_1_READONLY', why: expect.stringMatching(/^.{10,160}$/) }]
}

describe('the manifest entry', () => {
  it('declares the .orv resolver as a page that reads Ethereum read-only, and nothing else', () => {
    expect(manifest.integrations).toEqual([ENTRY])
  })

  // Orivon's loader (src/loader/manifest/integrations.ts, integration-types.ts, integration-values.ts) refuses or skips an
  // entry that breaks these; they are copied here so this repository's check does not depend on that checkout.
  it('keeps the rules Orivon\'s loader reads an integration entry by', () => {
    const [entry] = manifest.integrations
    const allowed = ['id', 'name', 'hosting', 'entry', 'module', 'hash', 'export', 'onTheFly', 'background', 'uses', 'panel', 'icon', 'type', 'namespaces']
    expect(Object.keys(entry).filter((key) => !allowed.includes(key))).toEqual([])
    expect(entry.id).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(entry.id.length).toBeLessThanOrEqual(40)
    expect(entry.name.length).toBeLessThanOrEqual(60)
    for (const namespace of entry.namespaces) expect(namespace).toMatch(/^\.[a-z0-9-]{1,63}$/)
    for (const use of entry.uses) {
      expect(Object.keys(use).filter((key) => !['code', 'optional', 'why'].includes(key))).toEqual([])
      expect(use.code).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*_\d{1,3}_\d{1,3}(?:_[A-Z0-9]+)?$/)
      expect(use.why.length).toBeLessThanOrEqual(160)
    }
    expect(new Set(entry.uses.map((use: { code: string }) => use.code)).size).toBe(entry.uses.length)
    expect(manifest.integrations.length).toBeLessThanOrEqual(16)
  })

  it('names files that are in the bundle, as relative paths inside it', async () => {
    const [entry] = manifest.integrations
    for (const path of [entry.entry, entry.icon]) {
      expect(path).not.toMatch(/^\/|^[a-z]+:|\.\.|\\/)
      expect((await stat(new URL(path, SITE))).isFile(), path).toBe(true)
    }
  })

  it('claims a namespace that is a name no reserved list and no browser route holds', () => {
    // The names Orivon's install refuses (src/protocols/reserved-names.ts): special-use names, home-network suffixes, its own.
    const reserved = ['alt', 'arpa', 'example', 'invalid', 'localhost', 'mail', 'onion', 'orivon', 'test', 'local', 'localdomain', 'lan', 'internal', 'home', 'corp', 'intranet', 'private']
    const [entry] = manifest.integrations
    for (const namespace of entry.namespaces as string[]) {
      const label = namespace.slice(1)
      expect(reserved).not.toContain(label)
      // A namespace Orivon can route: it starts with a letter, holds letters, digits and hyphens, does not end in a hyphen.
      expect(label).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(label.endsWith('-')).toBe(false)
      // ICANN delegates no .orv: the IANA root zone list, version 2026110600, has no ORV. `isReservedNamespace('.orv')` is false there.
    }
    expect(entry.namespaces).toEqual(['.orv'])
  })
})

describe('the page', () => {
  it('is one document with one module script and nothing inline', async () => {
    const html = await readFile(new URL('index.html', RESOLVER), 'utf8')
    expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script type="module" src="resolver.js">'])
    expect(html).toMatch(/<script type="module" src="resolver.js"><\/script>/)
    expect(html).not.toMatch(/\son[a-z]+\s*=|javascript:|<style|<link|<iframe|<img|<form|https?:/i)
  })

  it('has an icon that is a small SVG with nothing active in it and no reference to anything else', async () => {
    const svg = await readFile(new URL('orv-names.svg', RESOLVER), 'utf8')
    expect(Buffer.byteLength(svg)).toBeLessThanOrEqual(65536)
    expect(svg).toMatch(/^<svg\b/)
    expect(svg).not.toMatch(/<script|<foreignObject|<image|<use\b|<style|<a\b|\shref\s*=|xlink|url\s*\(|\son[a-z]+\s*=|javascript:|data:|@import/i)
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:/i)
  })

  it('is made of files that call no NAMES_0_1 and no Ethereum code but the read-only one', async () => {
    const files = await sources()
    expect(files.map(([name]) => name).sort()).toEqual(['orv-answer.js', 'orv-contenthash.js', 'orv-names.js', 'orv-records.js', 'resolver.js'])
    for (const [name, source] of files) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code.match(/NAMES_0_1/g) ?? [], name).toEqual(name === 'resolver.js' ? ['NAMES_0_1'] : [])
      expect(code, name).not.toMatch(/\bETH_0_1\b|ETH_NET_0_1(?!_READONLY)|orivon\.use|window\.orivon\b/)
    }
  })
})

// Transcribed from the result of `resolve` in Orivon's NAMES_0_1 module (names-0-1.json): what the browser checks before the asker sees it.
const RECORD_TYPES = ['contentHash', 'ipfs', 'bzz', 'arw', 'magnet', 'https', 'http', 'ddoc']
function checkResult (result: any): void {
  expect(Object.keys(result).sort()).toEqual(['ownerDefault', 'provenance', 'records'])
  if (result.ownerDefault !== null) {
    expect(Object.keys(result.ownerDefault).sort()).toEqual(['type', 'value'])
    expect(result.ownerDefault.type.length).toBeLessThanOrEqual(32)
    expect(result.ownerDefault.value.length).toBeLessThanOrEqual(2048)
  }
  expect(result.records.length).toBeLessThanOrEqual(16)
  for (const record of result.records) {
    expect(Object.keys(record).sort()).toEqual(['type', 'value'])
    expect(RECORD_TYPES).toContain(record.type)
    expect(record.value.length).toBeLessThanOrEqual(2048)
  }
  const { by, proven, block, ...extra } = result.provenance
  expect(extra).toEqual({})
  expect(typeof by === 'string' && by.length <= 80).toBe(true)
  expect(typeof proven).toBe('boolean')
  if (block !== undefined) expect(Number.isSafeInteger(block) && block >= 0).toBe(true)
}

describe('what the page provides', () => {
  const provide = vi.fn()
  const address = (n: number) => toChecksumAddress('0x' + n.toString(16).padStart(40, '0'))
  const ALICE = address(0xa11ce)
  const RES = address(0x7e51)
  const world = () => fakeOrv({
    names: { alice: { owner: ALICE, resolver: RES } },
    resolvers: { [RES]: { contenthash: '0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f', texts: { 'content.https': 'https://example.com/' } } },
    registrar: {}
  })
  const context = (use: unknown, signal = new AbortController().signal) => ({ depth: 1, deadlineAt: Date.now() + 30_000, signal, use })
  type Implementation = Record<string, (context: unknown, ...args: unknown[]) => Promise<any>>
  let implementation: Implementation

  beforeAll(async () => {
    ;(globalThis as any).window = { orivonIntegration: { version: 0, provide, use: async () => { throw new Error('the integration\'s own use is not for a call it serves') } } }
    await import('../site/resolver/resolver.js')
    implementation = provide.mock.calls[0]![1]
  })
  afterAll(() => { delete (globalThis as any).window })

  it('is called once, for NAMES_0_1, with exactly the functions the standard defines (resolve)', () => {
    expect(provide).toHaveBeenCalledTimes(1)
    expect(provide.mock.calls[0]![0]).toBe('NAMES_0_1')
    expect(Object.keys(implementation)).toEqual(['resolve'])
  })

  it('answers a .orv name through the use of the call it serves, asking for ETH_NET_0_1_READONLY alone, in the standard\'s shape', async () => {
    const chain = world().chain
    const orivon = fakeOrivon({ blockNumber: 26357300, call: async (tx: { to: string, data: Uint8Array }) => await chain.call(tx) })
    const result = await implementation.resolve!(context(orivon.orivon.use), 'alice.orv')
    checkResult(result)
    expect(result.ownerDefault).toEqual({ type: 'ipfs', value: 'ipfs://bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4' })
    expect(result.records).toEqual([{ type: 'https', value: 'https://example.com/' }])
    expect(orivon.uses.flatMap((use) => use.codes)).toEqual(['ETH_NET_0_1_READONLY'])
    expect(new Set(orivon.calls.map((call) => call.fn))).toEqual(new Set(['ETH_NET_0_1_READONLY.blockNumber', 'ETH_NET_0_1_READONLY.call']))
  })

  it('answers a name that is not there in the standard\'s shape too', async () => {
    const chain = world().chain
    const orivon = fakeOrivon({ blockNumber: 26357300, call: async (tx: { to: string, data: Uint8Array }) => await chain.call(tx) })
    for (const name of ['nobody.orv', 'ab.orv']) {
      const result = await implementation.resolve!(context(orivon.orivon.use), name)
      checkResult(result)
      expect(result).toMatchObject({ ownerDefault: null, records: [] })
    }
  })

  it('fails, so the router goes on, when the person did not grant the read-only code, and for a name outside .orv', async () => {
    const declined = fakeOrivon({}, ['ETH_NET_0_1_READONLY'])
    await expect(implementation.resolve!(context(declined.orivon.use), 'alice.orv')).rejects.toMatchObject({ reason: 'declined' })
    await expect(implementation.resolve!(context(declined.orivon.use), 'alice.eth')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('stops waiting when the call is no longer wanted, even if the node never answers', async () => {
    const stuck = fakeOrivon({ blockNumber: () => new Promise(() => {}) })
    const controller = new AbortController()
    const pending = implementation.resolve!(context(stuck.orivon.use, controller.signal), 'alice.orv')
    controller.abort(new Error('the asker left'))
    await expect(pending).rejects.toThrow('the asker left')
  })
})
