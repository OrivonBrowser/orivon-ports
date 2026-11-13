import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { toChecksumAddress, ZERO_ADDRESS } from '../site/sdk/abi.js'
import { CENSUS_FORMAT, mergedLogs, readCensus, type Census, type NameEntry } from '../site/resolver/og-census.js'
import { addressTopic, hashOf } from '../site/resolver/og-freshness.js'
import { keyOf } from '../site/resolver/og-name.js'
import { resolveOg } from '../site/resolver/og-names.js'
import { IMPLEMENTATION, PROXY, REGISTRY, TOPICS, UPGRADES } from '../site/resolver/og-pins.js'
import { createSession } from '../site/resolver/og-tail.js'
import { labelOfKey } from '../tools/cut-census.mjs'
import { fakeChain, type NameState, type World, type WorldLog } from './support/og-world.ts'

const address = (n: number) => toChecksumAddress(`0x${n.toString(16).padStart(40, '0')}`)
const ALICE = address(0xa11ce)
const BOB = address(0xb0b)
const CHECKPOINT = 20_000_000
const HEAD = CHECKPOINT + 3_000
const KEY = keyOf('sitename')
const V1 = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const V2 = 'ipfs://bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4'
const ZERO_WORD = `0x${'0'.repeat(64)}`

const changed = (blockNumber: number, logIndex = 0): WorldLog => ({ address: REGISTRY, blockNumber, logIndex, topics: [TOPICS.changed, KEY] })
const written = (value: string, blockNumber: number, logIndex = 0): WorldLog => ({ address: PROXY, blockNumber, logIndex, topics: [TOPICS.setTextRecord, KEY, hashOf('content.ipfs'), hashOf(value)] })
const controlled = (controller: string, blockNumber: number, logIndex = 0): WorldLog => ({ address: PROXY, blockNumber, logIndex, topics: [TOPICS.newController, KEY, addressTopic(controller)] })

const entry = (overrides: Partial<NameEntry> = {}, value = V1, at = CHECKPOINT - 100): NameEntry => ({
  holder: ALICE, wrapped: false, id: null, holderChange: { block: CHECKPOINT - 500, logIndex: 0 }, newController: null,
  keys: { 'content.ipfs': { valueHash: hashOf(value), log: { block: at, logIndex: 0, valueHash: hashOf(value) }, counts: true, reason: 'passes' } },
  ...overrides
})
const census = (names: Record<string, NameEntry> = {}): Census => ({ format: CENSUS_FORMAT, block: CHECKPOINT, blockHash: ZERO_WORD, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names })

/** The name `sitename` as the chain has it now, with the logs after the checkpoint that the node would return. */
async function answer (options: { now?: Partial<NameState>, tail?: WorldLog[], census: Census }) {
  const state: NameState = { registryOwner: ALICE, nameToId: '0', idToName: ZERO_WORD, ownerOf: null, controller: ZERO_ADDRESS, values: { 'content.ipfs': V2 }, ...options.now }
  const world: World = { head: HEAD, safe: HEAD, names: { sitename: state }, logs: options.tail ?? [], implementation: IMPLEMENTATION }
  return (await resolveOg(fakeChain(world).chain, 'sitename.og', { session: createSession(), census: options.census })).records
}

describe('a name in the census, read with the history after the checkpoint', () => {
  it('keeps a record the bundle vouched for when nothing happened since', async () => {
    expect(await answer({ now: { values: { 'content.ipfs': V1 } }, census: census({ sitename: entry() }) })).toEqual([{ type: 'ipfs', value: V1 }])
  })

  it('keeps a value that changed after the checkpoint when its log is in the tail', async () => {
    expect(await answer({ tail: [written(V2, CHECKPOINT + 50)], census: census({ sitename: entry() }) })).toEqual([{ type: 'ipfs', value: V2 }])
  })

  it('fails closed on a value that changed with no log for it in the tail: the node left it out, or the value is not a write', async () => {
    expect(await answer({ census: census({ sitename: entry() }) })).toEqual([])
    expect(await answer({ tail: [written(V1, CHECKPOINT + 50)], census: census({ sitename: entry() }) })).toEqual([])
  })

  it('fails closed when the holder now is not the holder the census names and the tail shows no change of holder', async () => {
    expect(await answer({ now: { registryOwner: BOB, values: { 'content.ipfs': V1 } }, census: census({ sitename: entry() }) })).toEqual([])
    expect(await answer({ now: { registryOwner: BOB, values: { 'content.ipfs': V1 } }, tail: [written(V1, CHECKPOINT + 50)], census: census({ sitename: entry() }) })).toEqual([])
  })

  it('keeps a record the new holder wrote after a change of holder that the tail shows', async () => {
    const now = { registryOwner: BOB }
    expect(await answer({ now, tail: [changed(CHECKPOINT + 10), written(V2, CHECKPOINT + 20)], census: census({ sitename: entry() }) })).toEqual([{ type: 'ipfs', value: V2 }])
    expect(await answer({ now, tail: [written(V2, CHECKPOINT + 20), changed(CHECKPOINT + 30)], census: census({ sitename: entry() }) })).toEqual([])
  })

  it('drops a record the bundle vouched for when a change of the name in the registry comes after it in the tail', async () => {
    const now = { values: { 'content.ipfs': V1 } }
    expect(await answer({ now, tail: [changed(CHECKPOINT + 30)], census: census({ sitename: entry() }) })).toEqual([])
  })

  it('drops a record the bundle vouched for when a new controller is named after it, and takes it back when it is written again', async () => {
    const now = { values: { 'content.ipfs': V1 } }
    expect(await answer({ now, tail: [controlled(ALICE, CHECKPOINT + 30)], census: census({ sitename: entry() }) })).toEqual([])
    expect(await answer({ now, tail: [controlled(ALICE, CHECKPOINT + 30), written(V1, CHECKPOINT + 40)], census: census({ sitename: entry() }) })).toEqual([{ type: 'ipfs', value: V1 }])
  })

  it('fails closed when the census says the name was wrapped and the chain now says it is not', async () => {
    expect(await answer({ now: { values: { 'content.ipfs': V1 } }, census: census({ sitename: entry({ wrapped: true, id: '5' }) }) })).toEqual([])
  })

  it('keeps a record written after the checkpoint on a name the census does not list, since its holder changed before the checkpoint', async () => {
    expect(await answer({ tail: [written(V2, CHECKPOINT + 50)], census: census() })).toEqual([{ type: 'ipfs', value: V2 }])
    expect(await answer({ tail: [written(V2, CHECKPOINT + 50), changed(CHECKPOINT + 60)], census: census() })).toEqual([])
  })

  it('answers nothing for a value on a name the census does not list when no log in the tail wrote it', async () => {
    expect(await answer({ census: census() })).toEqual([])
  })

  it('treats a write and a change in the same block by the order of their logs in it', async () => {
    expect(await answer({ tail: [changed(CHECKPOINT + 5, 3), written(V2, CHECKPOINT + 5, 4)], census: census() })).toEqual([{ type: 'ipfs', value: V2 }])
    expect(await answer({ tail: [written(V2, CHECKPOINT + 5, 3), changed(CHECKPOINT + 5, 4)], census: census() })).toEqual([])
  })
})

describe('mergedLogs', () => {
  it('stands for the census holder\'s change only while that holder holds the name', () => {
    const reads = { registryOwner: BOB, nameToId: '0', idToName: null, ownerOf: null, controller: ZERO_ADDRESS, values: {} }
    const tail = { setText: [], newController: [], registryChanged: [], wrapperTransfers: [] }
    expect(mergedLogs({ key: KEY, reads, entry: entry(), checkpoint: CHECKPOINT, tail }).registryChanged).toEqual([])
    expect(mergedLogs({ key: KEY, reads: { ...reads, registryOwner: ALICE }, entry: entry(), checkpoint: CHECKPOINT, tail }).registryChanged).toHaveLength(1)
  })
})

describe('readCensus', () => {
  it('refuses what is not a census of this format, so a broken bundle fails every lookup', () => {
    for (const raw of [null, [], {}, { ...census(), format: 2 }, { ...census(), block: 'x' }, { ...census(), names: [] }, { ...census(), upgrades: {} }, { ...census(), implementation: 3 }]) {
      expect(() => readCensus(raw)).toThrow(/census/)
    }
  })
})

describe('the census this bundle carries', () => {
  it('is a census of the format, cut against the implementation the resolver is built for', async () => {
    const carried = readCensus(JSON.parse(await readFile(new URL('../site/resolver/census.json', import.meta.url), 'utf8')))
    expect(carried.implementation).toBe(IMPLEMENTATION)
    expect(carried.blockHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(carried.upgrades.at(-1)?.implementation.toLowerCase()).toBe(IMPLEMENTATION.toLowerCase())
    expect(carried.upgrades.map((upgrade) => ({ ...upgrade, implementation: upgrade.implementation.toLowerCase() }))).toEqual(UPGRADES.map((upgrade) => ({ ...upgrade, implementation: upgrade.implementation.toLowerCase() })))
    expect(carried.block).toBeGreaterThan(26_000_000)
  })

  it('lists names by a label this resolver answers, with the verdict the rule gave each key', async () => {
    const carried = readCensus(JSON.parse(await readFile(new URL('../site/resolver/census.json', import.meta.url), 'utf8')))
    for (const label of Object.keys(carried.names)) expect(labelOfKey(keyOf(label)), label).toBe(label)
    expect(carried.names['chaosroadsmint']?.keys['contentcontract']).toMatchObject({ counts: true, reason: 'passes' })
    expect(carried.names['ecdn']?.keys['contentcontract']).toMatchObject({ counts: false, reason: 'set-before-the-last-holder-change' })
  })
})
