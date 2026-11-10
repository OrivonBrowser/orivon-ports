// A Chain whose contracts are a table: R1, the registrar, the two registries above it, and per-name resolvers. It
// answers the calls the site makes by decoding their calldata, and serves R1's logs from a list, so the site's
// reads are tested without a network. A real node is the fork tests' job.

import { decode, encode, selector, ZERO_ADDRESS } from '../../site/sdk/abi.js'
import { fromHex, toHex } from '../../site/sdk/bytes.js'
import { labelhash } from '../../site/sdk/ens.js'
import { ADDRESSES, LABEL_REGISTERED, TRANSFER_BATCH, TRANSFER_SINGLE } from '../../site/sdk/orivonid.js'
import { MULTICALL3 } from '../../site/sdk/read.js'
import type { Chain, Log } from '../../site/sdk/chain.js'

export interface Name { owner: string, resolver?: string | undefined, roleCount?: bigint, roles?: Record<string, bigint> }
/**
 * `roles` are the root roles per account (lower-case); an account not listed holds none. `resourceRoles` are roles on one
 * resource (`PermissionedResolverLib.resource(...)`, as a decimal string), added to the root ones as the contract does.
 * Absent `roles`, every account holds every role. `foreign` makes the factory refuse to vouch for the resolver.
 */
export interface ResolverState {
  extended?: boolean, addr?: string | null, texts?: Record<string, string>, contenthash?: string, reverts?: boolean
  /**
   * Whether the resolver takes `multicall(bytes[])`: through `resolve` for an extended one, which answers each call's revert
   * data in its place as the PermissionedResolver does, and directly for the others, which revert as a whole when any call
   * does, as ENS's Multicallable does. Absent, it takes none.
   */
  multicall?: boolean
  /** Text keys the resolver reverts on, the other records being fine. */
  badTexts?: string[]
  roles?: Record<string, bigint>, resourceRoles?: Record<string, Record<string, bigint>>, foreign?: boolean, rolesRevert?: boolean
}
export interface World {
  names: Record<string, Name>
  resolvers: Record<string, ResolverState>
  registrar: { daiAboveFloor?: boolean | 'revert', beneficiary?: string | 'revert' }
  ethToR0?: string
  r0ToR1?: string
  /** Whether Multicall3 has code on the chain. Absent, it has none. */
  multicall3?: boolean
}

/** What the registrar gives a buyer on R1: set subregistry, set resolver (each with its admin role) and transfer admin. */
export const OWNER_ROLES = (1n << 20n) | (1n << 24n) | (1n << 148n) | (1n << 152n) | (1n << 156n)

const hex = (signature: string) => toHex(selector(signature))
const SEL = {
  getOwner: hex('getOwner(uint256)'), roleCount: hex('roleCount(uint256)'), roles: hex('roles(uint256,address)'),
  getResolver: hex('getResolver(string)'), getSubregistry: hex('getSubregistry(string)'),
  daiAboveFloor: hex('daiAboveFloor()'), beneficiary: hex('beneficiary()'),
  supportsInterface: hex('supportsInterface(bytes4)'), resolve: hex('resolve(bytes,bytes)'),
  addr: hex('addr(bytes32)'), text: hex('text(bytes32,string)'), contenthash: hex('contenthash(bytes32)'),
  hasRoles: hex('hasRoles(uint256,uint256,address)'), verifyContract: hex('verifyContract(address)'),
  multicall: hex('multicall(bytes[])'), aggregate3: hex('aggregate3((address,bool,bytes)[])')
}

const revertWith = (reason: string) => '08c379a0' + toHex(encode(['string'], [reason]))
const isAt = (to: string, address: string) => to.toLowerCase() === address.toLowerCase()

export function topicOf (address: string): string {
  return '0x' + address.slice(2).toLowerCase().padStart(64, '0')
}

export type Event =
  | { block: number, kind: 'registered', label: string, owner: string, sender?: string }
  | { block: number, kind: 'single', to: string, label: string }
  | { block: number, kind: 'batch', to: string, labels: string[] }

const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0')

function logOf (event: Event, index: number): Log {
  const base = { address: ADDRESSES.r1, blockNumber: event.block, transactionHash: '0x' + '11'.repeat(32), logIndex: index, removed: false }
  const tokenId = (label: string) => BigInt(labelhash(label)) & ~0xffffffffn
  if (event.kind === 'registered') {
    const data = encode(['string', 'address', 'uint64'], [event.label, event.owner, 2n ** 64n - 1n])
    return { ...base, topics: [LABEL_REGISTERED.topic, word(tokenId(event.label)), labelhash(event.label), topicOf(event.sender ?? ADDRESSES.registrar)], data }
  }
  if (event.kind === 'single') {
    return { ...base, topics: [TRANSFER_SINGLE.topic, topicOf(ADDRESSES.safe), topicOf(ZERO_ADDRESS), topicOf(event.to)], data: encode(['uint256', 'uint256'], [tokenId(event.label), 1n]) }
  }
  const ids = event.labels.map(tokenId)
  return { ...base, topics: [TRANSFER_BATCH.topic, topicOf(ADDRESSES.safe), topicOf(ZERO_ADDRESS), topicOf(event.to)], data: encode(['uint256[]', 'uint256[]'], [ids, ids.map(() => 1n)]) }
}

interface CallResult { data: Uint8Array | null, revert: Uint8Array | null, offchainLookup: Uint8Array | null }

export interface FakeRegistry {
  chain: Chain
  world: World
  logQueries: { fromBlock: number, toBlock: number, topic0: string | null }[]
  callCount: () => number
  /** Every `eth_call` the site made, in order: the contract and the selector. Calls Multicall3 or a multicall makes inside are not listed. */
  callLog: { to: string, selector: string }[]
}

/** `head` is what blockNumber answers; `events` are R1's logs. */
export function fakeRegistry (world: World, events: Event[] = [], head = 26357300): FakeRegistry {
  const logQueries: FakeRegistry['logQueries'] = []
  let calls = 0
  const callLog: FakeRegistry['callLog'] = []
  const answer = (data: string) => ({ data: fromHex(data), revert: null, offchainLookup: null })
  const reverted = (reason: string) => ({ data: null, revert: fromHex(revertWith(reason)), offchainLookup: null })
  const labelOfId = (id: bigint) => Object.keys(world.names).find((label) => BigInt(labelhash(label)) === id)

  function r1 (sel: string, args: Uint8Array) {
    if (sel === SEL.getOwner || sel === SEL.roleCount || sel === SEL.roles) {
      const [id, holder] = decode(sel === SEL.roles ? ['uint256', 'address'] : ['uint256'], args) as [bigint, string | undefined]
      const name = world.names[labelOfId(id) ?? '']
      if (sel === SEL.getOwner) return answer(toHex(encode(['address'], [name?.owner ?? ZERO_ADDRESS])))
      if (sel === SEL.roleCount) return answer(toHex(encode(['uint256'], [name?.roleCount ?? (name === undefined ? 0n : OWNER_ROLES)])))
      const held = name?.roles?.[holder ?? ''] ?? (name !== undefined && isAt(holder ?? '', name.owner) ? OWNER_ROLES : 0n)
      return answer(toHex(encode(['uint256'], [held])))
    }
    if (sel === SEL.getResolver) {
      const [label] = decode(['string'], args) as [string]
      return answer(toHex(encode(['address'], [world.names[label]?.resolver ?? ZERO_ADDRESS])))
    }
    return reverted('r1: unknown call')
  }

  function resolverCall (state: ResolverState, name: Uint8Array | null, inner: Uint8Array): CallResult {
    if (state.reverts === true) return reverted('resolver reverts')
    const sel = toHex(inner.subarray(0, 4))
    if (sel === SEL.multicall) {
      if (state.multicall !== true) return reverted('resolver: unknown profile')
      const [items] = decode(['bytes[]'], inner.subarray(4)) as [Uint8Array[]]
      const results = items.map((item) => resolverCall(state, name, item))
      if (name === null && results.some((one) => one.data === null)) return reverted('multicall: a call reverted')
      return answer(toHex(encode(['bytes[]'], [results.map((one) => one.data ?? one.revert ?? new Uint8Array(0))])))
    }
    if (sel === SEL.addr) return answer(toHex(encode(['address'], [state.addr ?? ZERO_ADDRESS])))
    if (sel === SEL.text) {
      const [, key] = decode(['bytes32', 'string'], inner.subarray(4)) as [Uint8Array, string]
      if (state.badTexts?.includes(key) === true) return reverted(`resolver: no text ${key}`)
      return answer(toHex(encode(['string'], [state.texts?.[key] ?? ''])))
    }
    if (sel === SEL.contenthash) return answer(toHex(encode(['bytes'], [state.contenthash ?? '0x'])))
    return reverted(`resolver: unknown profile${name === null ? '' : ' for a name'}`)
  }

  function call (to: string, data: Uint8Array): CallResult {
    const sel = toHex(data.subarray(0, 4))
    const args = data.subarray(4)
    if (isAt(to, MULTICALL3)) {
      if (world.multicall3 !== true || sel !== SEL.aggregate3) return { data: new Uint8Array(0), revert: null, offchainLookup: null }
      const [batch] = decode(['(address,bool,bytes)[]'], args) as [[string, boolean, Uint8Array][]]
      const results = batch.map(([target, , inner]) => {
        const one = call(target, inner)
        return [one.data !== null, one.data ?? one.revert ?? new Uint8Array(0)]
      })
      return answer(toHex(encode(['(bool,bytes)[]'], [results])))
    }
    if (isAt(to, ADDRESSES.r1)) return r1(sel, args)
    if (isAt(to, ADDRESSES.registrar)) {
      const { daiAboveFloor = true, beneficiary = ADDRESSES.safe } = world.registrar
      if (sel === SEL.daiAboveFloor) return daiAboveFloor === 'revert' ? reverted('Uniswap: OLD') : answer(toHex(encode(['bool'], [daiAboveFloor])))
      if (sel === SEL.beneficiary) return beneficiary === 'revert' ? reverted('no beneficiary') : answer(toHex(encode(['address'], [beneficiary])))
    }
    if (sel === SEL.getSubregistry) {
      const [label] = decode(['string'], args) as [string]
      if (isAt(to, ADDRESSES.ethRegistry) && label === 'orivonid') return answer(toHex(encode(['address'], [world.ethToR0 ?? ADDRESSES.r0])))
      if (isAt(to, ADDRESSES.r0) && label === 'v1') return answer(toHex(encode(['address'], [world.r0ToR1 ?? ADDRESSES.r1])))
    }
    if (isAt(to, ADDRESSES.verifiableFactory) && sel === SEL.verifyContract) {
      const [proxy] = decode(['address'], args) as [string]
      const known = Object.entries(world.resolvers).find(([address]) => isAt(proxy, address))?.[1]
      return known === undefined || known.foreign === true ? { data: null, revert: new Uint8Array(0), offchainLookup: null } : answer(toHex(encode(['address'], [ADDRESSES.resolverImplementation])))
    }
    const state = Object.entries(world.resolvers).find(([address]) => isAt(to, address))?.[1]
    if (state === undefined) return { data: new Uint8Array(0), revert: null, offchainLookup: null }
    if (sel === SEL.hasRoles) {
      if (state.rolesRevert === true) return reverted('roles revert')
      const [resource, bitmap, holder] = decode(['uint256', 'uint256', 'address'], args) as [bigint, bigint, string]
      if (state.roles === undefined) return answer(toHex(encode(['bool'], [true])))
      const root = state.roles[holder.toLowerCase()] ?? 0n
      const own = state.resourceRoles?.[resource.toString()]?.[holder.toLowerCase()] ?? 0n
      return answer(toHex(encode(['bool'], [((root | own) & bitmap) === bitmap])))
    }
    if (sel === SEL.supportsInterface) return answer(toHex(encode(['bool'], [state.extended !== false])))
    if (sel === SEL.resolve) {
      const [name, inner] = decode(['bytes', 'bytes'], args) as [Uint8Array, Uint8Array]
      if (state.extended === false) return reverted('not extended')
      const result = resolverCall(state, name, inner)
      return result.data === null ? result : answer(toHex(encode(['bytes'], [result.data])))
    }
    return state.extended === false ? resolverCall(state, null, data) : reverted('plain call on an extended resolver')
  }

  const chain = {
    kind: 'orivon',
    blockNumber: async () => head,
    call: async (tx: { to?: string, data?: Uint8Array }) => {
      const data = tx.data ?? new Uint8Array(0)
      calls++
      callLog.push({ to: tx.to ?? '', selector: toHex(data.subarray(0, 4)) })
      return call(tx.to ?? '', data)
    },
    getLogs: async (filter: { fromBlock: number, toBlock: number, topics?: (string | null)[] }) => {
      logQueries.push({ fromBlock: filter.fromBlock, toBlock: filter.toBlock, topic0: filter.topics?.[0] ?? null })
      return events
        .map((event, index) => logOf(event, index))
        .filter((log) => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock)
        .filter((log) => (filter.topics ?? []).every((topic, position) => topic === null || log.topics[position] === topic))
    }
  } as unknown as Chain
  return { chain, world, logQueries, callCount: () => calls, callLog }
}
