// A Chain over a table of names and a list of logs: the registry, the wrapper and the resolver proxy answer the six reads the
// resolver makes through one `aggregate3`, `getLogs` answers by address, topics and range (and refuses a range over the span the
// node allows, as the browser does), and the proxy's implementation slot holds one address. Every read the chain is asked is kept,
// so a test can say which block it was made at and how many log queries a lookup took.

import { decode, encode, selector, toChecksumAddress, ZERO_ADDRESS } from '../../site/sdk/abi.js'
import { fromHex, toHex } from '../../site/sdk/bytes.js'
import { ChainError, type Chain, type Log, type LogFilter } from '../../site/sdk/chain.js'
import { MULTICALL3 } from '../../site/sdk/read.js'
import { idTopic, nameLogsOf, type NameLogs } from '../../site/resolver/og-freshness.js'
import { keyOf } from '../../site/resolver/og-name.js'
import { IMPLEMENTATION, IMPLEMENTATION_SLOT, PROXY, REGISTRY, TOPICS, UPGRADES, WRAPPER } from '../../site/resolver/og-pins.js'
import type { Place, Vector } from './og-vectors.ts'

export interface NameState {
  registryOwner: string
  nameToId: string
  idToName: string
  ownerOf: string | null
  controller: string | null
  values: Record<string, string>
}
export interface WorldLog { address: string, blockNumber: number, logIndex: number, topics: string[] }
export interface World {
  head: number
  /** The node's safe block; null for a node that names none. */
  safe: number | null
  names: Record<string, NameState>
  logs: WorldLog[]
  implementation: string
}
export interface Faults {
  /** An error for a `getLogs` the node should fail, or undefined to answer it. */
  logs?: (filter: LogFilter) => ChainError | undefined
  /** What a node that trimmed the leading zeros of a storage value would answer. */
  trimSlot?: boolean
  /** A node that returns the logs of every address in the range, whatever address the query named. */
  anyAddress?: boolean
}

export const ADDRESS_OF: Record<Place, string> = { registry: REGISTRY, proxy: PROXY, wrapper: WRAPPER }
const ZERO_WORD = `0x${'0'.repeat(64)}`
const FREE: NameState = { registryOwner: ZERO_ADDRESS, nameToId: '0', idToName: ZERO_WORD, ownerOf: null, controller: ZERO_ADDRESS, values: {} }

const SELECTOR = (signature: string) => toHex(selector(signature))
const READS = {
  owner: SELECTOR('owner(bytes32)'),
  nameToId: SELECTOR('nameToId(bytes32)'),
  controller: SELECTOR('controller(bytes32)'),
  getTextRecord: SELECTOR('getTextRecord(bytes32,string)'),
  idToName: SELECTOR('idToName(uint256)'),
  ownerOf: SELECTOR('ownerOf(uint256)')
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

/** The first block of a world whose blocks were spread: after the resolver proxy's creation, so a census can be cut over it. */
export const FIRST_BLOCK = 16_000_000

/**
 * The world of one name at one block: the state and the logs of a vector. With `spread` its blocks are moved to `FIRST_BLOCK` and a
 * multiple of `spread` after it, in the same order: a live name's history is millions of blocks long, and what a test is after is the
 * order of its logs.
 */
export function worldOf (vector: Vector, options: { spread?: number, head?: number, safe?: number | null } = {}): World {
  const blocks = [...new Set(vector.logs.map((log) => log[1]))].sort((a, b) => a - b)
  const moved = (block: number) => options.spread === undefined ? block : FIRST_BLOCK + blocks.indexOf(block) * options.spread
  const logs = vector.logs.map(([place, blockNumber, logIndex, topics]) => ({ address: ADDRESS_OF[place], blockNumber: moved(blockNumber), logIndex, topics }))
  const head = options.head ?? Math.max(FIRST_BLOCK, ...logs.map((log) => log.blockNumber)) + 500
  return { head, safe: options.safe === undefined ? head : options.safe, names: { [vector.label]: { ...vector.state } }, logs, implementation: IMPLEMENTATION }
}

export function fakeChain (world: World, options: { maxSpan?: number, faults?: Faults } = {}) {
  const { maxSpan = 1024, faults = {} } = options
  const asked = {
    logs: [] as LogFilter[],
    calls: [] as { to: string, block: unknown }[],
    blocks: [] as unknown[],
    storage: [] as { address: string, block: unknown }[]
  }
  const byKey = () => new Map(Object.entries(world.names).map(([label, state]) => [keyOf(label), state]))
  const stateOf = (key: string) => byKey().get(key.toLowerCase()) ?? FREE
  const stateOfId = (id: bigint) => Object.values(world.names).find((state) => BigInt(state.nameToId) === id && id !== 0n)

  function answer (to: string, data: Uint8Array): Uint8Array | null {
    const sel = toHex(data.subarray(0, 4))
    const args = data.subarray(4)
    if (sel === READS.owner && same(to, REGISTRY)) return encode(['address'], [stateOf(`0x${toHex(args.subarray(0, 32))}`).registryOwner])
    if (sel === READS.nameToId && same(to, WRAPPER)) return encode(['uint256'], [stateOf(`0x${toHex(args.subarray(0, 32))}`).nameToId])
    if (sel === READS.controller && same(to, PROXY)) {
      const controller = stateOf(`0x${toHex(args.subarray(0, 32))}`).controller
      return controller === null ? null : encode(['address'], [controller])
    }
    if (sel === READS.getTextRecord && same(to, PROXY)) {
      const [key, name] = decode(['bytes32', 'string'], args) as [Uint8Array, string]
      return encode(['string'], [stateOf(`0x${toHex(key)}`).values[name] ?? ''])
    }
    if (sel === READS.idToName && same(to, WRAPPER)) return encode(['bytes32'], [stateOfId(decode(['uint256'], args)[0] as bigint)?.idToName ?? ZERO_WORD])
    if (sel === READS.ownerOf && same(to, WRAPPER)) {
      const holder = stateOfId(decode(['uint256'], args)[0] as bigint)?.ownerOf
      return holder === undefined || holder === null ? null : encode(['address'], [holder])
    }
    return null
  }

  const chain = {
    kind: 'orivon',
    chainId: async () => 1,
    blockNumber: async () => world.head,
    getBlock: async (ref: unknown) => {
      asked.blocks.push(ref)
      if (ref === 'safe' && world.safe === null) throw new ChainError('invalid', 'the node has no safe block')
      const number = ref === 'safe' ? world.safe as number : ref === 'latest' ? world.head : Number(ref)
      return { number, hash: `0x${number.toString(16).padStart(64, '0')}`, parentHash: ZERO_WORD, timestamp: 0, gasLimit: 0, gasUsed: 0, miner: ZERO_ADDRESS, transactions: [], baseFeePerGas: null }
    },
    call: async (tx: { to?: string, data?: Uint8Array }, block?: unknown) => {
      asked.calls.push({ to: tx.to ?? '', block })
      if (tx.to === undefined || tx.data === undefined) return { data: null, revert: new Uint8Array(0), offchainLookup: null }
      if (!same(tx.to, MULTICALL3)) {
        const direct = answer(tx.to, tx.data)
        return direct === null ? { data: null, revert: new Uint8Array(0), offchainLookup: null } : { data: direct, revert: null, offchainLookup: null }
      }
      const [calls] = decode(['(address,bool,bytes)[]'], tx.data.subarray(4)) as [[string, boolean, Uint8Array][]]
      const results = calls.map(([to, , data]) => {
        const out = answer(to, data)
        return [out !== null, out ?? new Uint8Array(0)] as [boolean, Uint8Array]
      })
      return { data: encode(['(bool,bytes)[]'], [results]), revert: null, offchainLookup: null }
    },
    getLogs: async (filter: LogFilter): Promise<Log[]> => {
      asked.logs.push(filter)
      const from = Number(filter.fromBlock)
      const to = Number(filter.toBlock)
      if (to - from + 1 > maxSpan) throw new ChainError('limit', 'the range is wider than the node allows')
      const failure = faults.logs?.(filter)
      if (failure !== undefined) throw failure
      const addresses = filter.address === undefined || faults.anyAddress === true ? [] : [filter.address].flat()
      return world.logs
        .filter((log) => log.blockNumber >= from && log.blockNumber <= to && (addresses.length === 0 || addresses.some((address) => same(address, log.address))))
        .filter((log) => (filter.topics ?? []).every((topic, index) => topic === null || same(topic, log.topics[index] ?? '')))
        .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
        .map((log) => ({ address: toChecksumAddress(log.address), topics: log.topics, data: new Uint8Array(0), blockNumber: log.blockNumber, transactionHash: `0x${log.blockNumber.toString(16).padStart(64, '0')}`, logIndex: log.logIndex, removed: false }))
    },
    getStorageAt: async (address: string, slot: string, block?: unknown) => {
      asked.storage.push({ address, block })
      if (!same(address, PROXY) || slot !== IMPLEMENTATION_SLOT) return new Uint8Array(0)
      const word = fromHex(world.implementation.slice(2).padStart(64, '0'))
      return faults.trimSlot === true ? word.subarray(word.findIndex((byte) => byte !== 0)) : word
    }
  } as unknown as Chain
  return { chain, asked, world }
}

/** A log of the resolver proxy that says the implementation changed, at a block. */
export const upgradedLog = (blockNumber: number, implementation = `0x${'ab'.repeat(20)}`, logIndex = 0): WorldLog => ({ address: PROXY, blockNumber, logIndex, topics: [TOPICS.upgraded, `0x${'0'.repeat(24)}${implementation.slice(2).toLowerCase()}`] })

/** The proxy's upgrades as the chain logged them (`UPGRADES`): what a world holds for a census to be cut over it. */
export const pinnedUpgradeLogs = (): WorldLog[] => UPGRADES.map((upgrade) => upgradedLog(upgrade.block, upgrade.implementation, upgrade.logIndex))

/** The logs of one name as the freshness rule reads them: the registry's and the resolver's that carry its key, and the wrapper's transfers of its token. */
export function nameLogs (world: World, label: string): NameLogs {
  const key = keyOf(label)
  const named = world.logs.filter((log) => (same(log.address, REGISTRY) || same(log.address, PROXY)) && same(log.topics[1] ?? '', key))
  const token = BigInt(world.names[label]?.nameToId ?? 0)
  const moved = token === 0n ? [] : world.logs.filter((log) => same(log.address, WRAPPER) && same(log.topics[3] ?? '', idTopic(token)))
  return nameLogsOf(named, moved)
}
