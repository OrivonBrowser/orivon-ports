import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chain } from '../site/sdk/chain.js'
import { CENSUS_FORMAT, type Census } from '../site/resolver/og-census.js'
import { hashOf } from '../site/resolver/og-freshness.js'
import { answerOf, textAddress, web3Target } from '../site/resolver/og-answer.js'
import { inspectOg, resolveOg } from '../site/resolver/og-names.js'
import { CONTRACT_KEY, IMPLEMENTATION, SOURCE, TEXT_KEYS, UPGRADES } from '../site/resolver/og-pins.js'
import { createSession } from '../site/resolver/og-tail.js'
import { ANSWERED_KEYS, recordRows } from '../site/search-model.js'
import { cutCensus } from '../tools/cut-census.mjs'
import { fakeOrivon } from './support/fake-orivon.ts'
import { fakeChain, FIRST_BLOCK, pinnedUpgradeLogs, worldOf } from './support/og-world.ts'
import { VECTORS, type Vector, type VectorLog } from './support/og-vectors.ts'

const SPREAD = 300
const CUT_BLOCK = 26_401_000
const ADDRESS = '0x4F53Eae17346d6c0f96215Af157c7F8e093E17F1'
const LOWER = ADDRESS.toLowerCase()
const OPENED = `web3://${LOWER}`
const CID = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

/** The record types NAMES_0_1 and NAMES_0_2 list for a record of a name, transcribed from the two official modules: `web3` is only in the second. */
const TYPES_0_1 = ['contentHash', 'ipfs', 'bzz', 'arw', 'magnet', 'ethfs', 'https', 'http', 'ddoc']
const TYPES_0_2 = ['contentHash', 'ipfs', 'bzz', 'arw', 'magnet', 'ethfs', 'web3', 'https', 'http', 'ddoc']

const vector = (id: string): Vector => VECTORS.find((one) => one.id === id)!
const MINTED = 'unwrapped-passes-mainnet'
const ECDN = 'sellers-leftover-and-disowned-mainnet'

/** A census cut before the first log of any name: nothing is known, so the tail is the name's whole history. */
const before = (): Census => ({ format: CENSUS_FORMAT, block: FIRST_BLOCK - 1_000, blockHash: `0x${'00'.repeat(32)}`, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names: {} })

/** The vector with `contentcontract` holding `value`, written by the same log as before: the log carries the hash of the new value. */
function withContract (id: string, value: string): Vector {
  const base = vector(id)
  const logs = base.logs.map((log): VectorLog => log[0] === 'proxy' && log[3][2] === hashOf(CONTRACT_KEY) ? [log[0], log[1], log[2], [log[3][0]!, log[3][1]!, log[3][2]!, hashOf(value)]] : log)
  return { ...base, state: { ...base.state, values: { ...base.state.values, [CONTRACT_KEY]: value } }, logs }
}

async function answerFor (one: Vector, options: { web3?: boolean } = {}) {
  const world = worldOf(one, { spread: SPREAD })
  return await resolveOg(fakeChain(world).chain, `${one.label}.og`, { session: createSession(), census: before() }, options)
}

describe('web3Target: the contract a contentcontract value names', () => {
  it.each([
    ['a checksummed address, as every .og record is written', ADDRESS],
    ['the address in lower case', LOWER],
    ['the address in upper case', `0x${LOWER.slice(2).toUpperCase()}`],
    ['the address without 0x', ADDRESS.slice(2)],
    ['web3://<address>', `web3://${ADDRESS}`],
    ['web3://<address> without 0x', `web3://${ADDRESS.slice(2)}`],
    ['<address>:1', `${ADDRESS}:1`],
    ['web3://<address>:1', `web3://${ADDRESS}:1`]
  ])('reads %s as web3://<address> in lower case', (_what, value) => {
    expect(web3Target(value)).toEqual({ ok: true, address: OPENED })
    expect(textAddress('web3', value)).toBe(OPENED)
  })

  it.each([
    ['another chain, after the address', `${ADDRESS}:10`, 'web3-other-chain'],
    ['another chain, in the web3:// form', `web3://${ADDRESS}:8453`, 'web3-other-chain'],
    ['a chain written by its short name', `web3://${ADDRESS}:eth`, 'web3-other-chain'],
    ['a chain written before the address', `eth:${ADDRESS}`, 'web3-other-chain'],
    ['a chain id with a leading zero', `${ADDRESS}:01`, 'web3-other-chain'],
    ['a name where the address belongs', 'vitalik.eth', 'web3-a-name'],
    ['a name in the web3:// form', 'web3://vitalik.eth', 'web3-a-name'],
    ['a name that is a .og name', 'chaosroadsmint.og', 'web3-a-name'],
    ['plain words', 'not an address', 'web3-not-an-address'],
    ['a short address', 'web3://0x1234', 'web3-not-an-address'],
    ['an address one digit too long', `${ADDRESS}0`, 'web3-not-an-address'],
    ['an address with a path', `web3://${ADDRESS}/index.html`, 'web3-not-an-address'],
    ['an address with a query', `web3://${ADDRESS}?x=1`, 'web3-not-an-address'],
    ['an address with spaces around it', ` ${ADDRESS} `, 'web3-not-an-address'],
    ['another scheme', `ipfs://${CID}`, 'web3-not-an-address'],
    ['an empty value', '', 'web3-not-an-address'],
    ['a value over the standard\'s bound', `web3://${ADDRESS}${'0'.repeat(3000)}`, 'web3-not-an-address']
  ])('refuses %s, and says why', (_what, value, reason) => {
    expect(web3Target(value)).toEqual({ ok: false, reason })
    expect(textAddress('web3', value)).toBeNull()
  })
})

describe('answerOf with the contract', () => {
  const counted = { 'content.https': 'https://example.com/', [CONTRACT_KEY]: ADDRESS, 'content.ipfs': CID }

  it('lists the web3 record after the content records, in the order of the keys, with no owner default', () => {
    expect(answerOf(counted, 26_000_000, { web3: true })).toEqual({
      ownerDefault: null,
      records: [{ type: 'ipfs', value: CID }, { type: 'https', value: 'https://example.com/' }, { type: 'web3', value: OPENED }],
      provenance: { by: SOURCE, proven: false, block: 26_000_000 }
    })
  })

  it('never lists it for an answer that did not ask for it, even when the contract counted', () => {
    for (const options of [undefined, {}, { web3: false }]) expect(answerOf(counted, 1, options).records.map((record) => record.type), JSON.stringify(options)).toEqual(['ipfs', 'https'])
    expect(answerOf({ [CONTRACT_KEY]: ADDRESS }).records).toEqual([])
  })

  it('leaves the record out when the value is not a contract of Ethereum, and keeps the others', () => {
    expect(answerOf({ 'content.ipfs': CID, [CONTRACT_KEY]: `${ADDRESS}:10` }, 1, { web3: true }).records).toEqual([{ type: 'ipfs', value: CID }])
    expect(answerOf({ [CONTRACT_KEY]: 'vitalik.eth' }, 1, { web3: true }).records).toEqual([])
  })
})

describe('resolveOg: the contract of a live name', () => {
  it('answers chaosroadsmint as the web3:// site of its contract under the version that lists web3, and with nothing new under the one that does not', async () => {
    const minted = vector(MINTED)
    expect(await answerFor(minted, { web3: true })).toMatchObject({ ownerDefault: null, records: [{ type: 'web3', value: OPENED }], provenance: { by: SOURCE, proven: false } })
    expect((await answerFor(minted, { web3: true })).records).toEqual([{ type: 'web3', value: 'web3://0x4f53eae17346d6c0f96215af157c7f8e093e17f1' }])
    expect((await answerFor(minted)).records).toEqual([])
    expect((await answerFor(minted, { web3: false })).records).toEqual([])
  })

  it('answers nothing for ecdn under either version: its record was written before the name last changed hands', async () => {
    const ecdn = vector(ECDN)
    expect((await answerFor(ecdn, { web3: true })).records).toEqual([])
    expect((await answerFor(ecdn)).records).toEqual([])
    const inspected = await inspectOg(fakeChain(worldOf(ecdn, { spread: SPREAD })).chain, ecdn.label, { session: createSession(), census: before() }, { keys: [CONTRACT_KEY] })
    expect(inspected.verdict?.keys[CONTRACT_KEY]).toMatchObject({ counts: false, reason: 'set-before-the-last-holder-change' })
  })

  it('answers chaosroadsmint the same when every log of the name is in the bundle and none is read from the node', async () => {
    const world = worldOf(vector(MINTED), { spread: SPREAD, head: CUT_BLOCK })
    world.logs.push(...pinnedUpgradeLogs())
    const census = await cutCensus(fakeChain(world, { maxSpan: Infinity }).chain, { block: world.head }) as Census
    const { chain, asked } = fakeChain(world)
    const answer = await resolveOg(chain, 'chaosroadsmint.og', { session: createSession(), census }, { web3: true })
    expect(answer.records).toEqual([{ type: 'web3', value: OPENED }])
    expect(asked.logs).toEqual([])
  })

  it.each(VECTORS.map((one) => [one.id, one] as const))('%s: the contract answers when its value has no reason against it, after the content records', async (_id, one) => {
    const value = one.state.values[CONTRACT_KEY] ?? ''
    const content = TEXT_KEYS.filter(([key]) => one.records.includes(key)).map(([key, type]) => ({ type, value: one.state.values[key] }))
    const contract = value !== '' && one.reasons[CONTRACT_KEY] === undefined ? [{ type: 'web3', value: OPENED }] : []
    expect((await answerFor(one, { web3: true })).records).toEqual([...content, ...contract])
    expect((await answerFor(one)).records).toEqual(content)
  })

  it('has a name with both kinds of record, which is the one case that shows the order', () => {
    const both = VECTORS.filter((one) => one.records.includes('content.ipfs') && one.state.values[CONTRACT_KEY] !== undefined && one.reasons[CONTRACT_KEY] === undefined)
    expect(both.map((one) => one.id)).toEqual(['wrapped-passes'])
  })
})

describe('resolveOg: what the value of the contract is', () => {
  it.each([
    [ADDRESS, OPENED],
    [LOWER, OPENED],
    [ADDRESS.slice(2), OPENED],
    [`web3://${ADDRESS}`, OPENED],
    [`${ADDRESS}:1`, OPENED],
    [`web3://${ADDRESS}:1`, OPENED],
    [`${ADDRESS}:10`, null],
    [`web3://${ADDRESS}:8453`, null],
    ['vitalik.eth', null],
    ['not an address', null],
    [`web3://${ADDRESS}/index.html`, null]
  ])('answers %s as %s', async (value, opened) => {
    const one = withContract(MINTED, value)
    expect((await answerFor(one, { web3: true })).records).toEqual(opened === null ? [] : [{ type: 'web3', value: opened }])
    expect((await answerFor(one)).records).toEqual([])
  })

  it('still applies the freshness rule to a value that is well formed: a contract written by a previous holder does not answer', async () => {
    const stale = withContract(ECDN, ADDRESS)
    expect((await answerFor(stale, { web3: true })).records).toEqual([])
  })
})

describe('the Search page: why the contract counts or does not', () => {
  async function rowsOf (one: Vector) {
    const inspection = await inspectOg(fakeChain(worldOf(one, { spread: SPREAD })).chain, one.label, { session: createSession(), census: before() }, { latest: true, keys: ANSWERED_KEYS })
    return recordRows(inspection, ANSWERED_KEYS).filter((row) => row.key === CONTRACT_KEY)
  }

  it('reads the contract key, so a name that has one shows it', () => {
    expect(ANSWERED_KEYS).toContain(CONTRACT_KEY)
  })

  it('says chaosroadsmint counts, and that Orivon opens it as a web3:// site', async () => {
    const [row] = await rowsOf(vector(MINTED))
    expect(row).toMatchObject({ key: CONTRACT_KEY, label: 'web3:// contract', value: ADDRESS, counts: true, reason: 'passes' })
    expect(row?.words).toMatch(/^Counts: it was written after the name last changed hands/)
    expect(row?.words).toMatch(/Orivon opens it as the web3:\/\/ site of that contract/)
    expect(row).not.toHaveProperty('opened')
  })

  it('says ecdn does not count because it was written before the name last changed hands', async () => {
    const [row] = await rowsOf(vector(ECDN))
    expect(row).toMatchObject({ counts: false, reason: 'set-before-the-last-holder-change' })
    expect(row?.words).toMatch(/^Does not count: it was written before the name last changed hands/)
  })

  it.each([
    [`${ADDRESS}:10`, 'web3-other-chain', /other than Ethereum/],
    ['eth:' + ADDRESS, 'web3-other-chain', /other than Ethereum/],
    ['vitalik.eth', 'web3-a-name', /it is a name, and Orivon needs the address/],
    ['not an address', 'web3-not-an-address', /not the address of a contract/]
  ])('says %s does not count even when it was written in time: %s', async (value, reason, words) => {
    const [row] = await rowsOf(withContract(MINTED, value))
    expect(row).toMatchObject({ counts: false, reason })
    expect(row?.words).toMatch(words)
    expect(row?.words).toMatch(/^Does not count: /)
  })
})

describe('the page: each code answers by its own list of record types', () => {
  type Implementation = Record<string, (context: unknown, ...args: any[]) => Promise<any>>
  const provided: Record<string, Implementation> = {}

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

  /** The page started over a bundle that carries the whole history of the vector's name, as a release does. */
  async function start (one: Vector) {
    const world = worldOf(one, { spread: SPREAD, head: CUT_BLOCK })
    world.logs.push(...pinnedUpgradeLogs())
    const census = await cutCensus(fakeChain(world, { maxSpan: Infinity }).chain, { block: world.head }) as Census
    vi.resetModules()
    for (const key of Object.keys(provided)) delete provided[key]
    const provide = vi.fn((code: string, implementation: Implementation) => { provided[code] = implementation })
    ;(globalThis as any).window = { orivonIntegration: { version: 0, provide, use: async () => { throw new Error('no read-ahead here') } } }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(census)))
    await import('../site/resolver/resolver.js')
    const orivon = fakeOrivon(reads(fakeChain(world).chain))
    const context = { depth: 1, deadlineAt: Date.now() + 30_000, signal: new AbortController().signal, use: orivon.orivon.use, progress: vi.fn() }
    return { context, orivon }
  }

  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => {
    delete (globalThis as any).window
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('answers chaosroadsmint with the web3 record under NAMES_0_2 and without it under NAMES_0_1, each in the record types its standard lists', async () => {
    const { context, orivon } = await start(vector(MINTED))
    const second = await provided['NAMES_0_2']!.resolve!(context, 'chaosroadsmint.og')
    const first = await provided['NAMES_0_1']!.resolve!(context, 'chaosroadsmint.og')
    expect(second.records).toEqual([{ type: 'web3', value: OPENED }])
    expect(first.records).toEqual([])
    for (const record of second.records) expect(TYPES_0_2).toContain(record.type)
    for (const record of first.records) expect(TYPES_0_1).toContain(record.type)
    expect(second).toMatchObject({ ownerDefault: null, provenance: { by: SOURCE, proven: false } })
    expect(orivon.uses.flatMap((use) => use.codes)).toEqual(expect.arrayContaining(['ETH_NET_0_1_READONLY']))
  })

  it('answers ecdn with nothing under either code', async () => {
    const { context } = await start(vector(ECDN))
    expect((await provided['NAMES_0_2']!.resolve!(context, 'ecdn.og')).records).toEqual([])
    expect((await provided['NAMES_0_1']!.resolve!(context, 'ecdn.og')).records).toEqual([])
  })
})
