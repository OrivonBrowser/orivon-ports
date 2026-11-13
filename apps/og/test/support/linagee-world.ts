// The three Linagee contracts as a table that mines transactions, behind the answers `fakeOrivon` gives a page: what a registration
// reads, signs and sends goes through the real Chain adapter (chain-orivon.js) and sender (register-send.js). Each rule is the
// contract's own as its source says it, including the ones that do nothing
// without saying so: `reserve` of a held name and `transfer` by a non-owner succeed and change nothing.

import { decode, encode, selector, toChecksumAddress, ZERO_ADDRESS } from '../../site/sdk/abi.js'
import { fromHex, toHex, utf8 } from '../../site/sdk/bytes.js'
import { keccak256 } from '../../site/sdk/keccak.js'
import { labelhash, namehash } from '../../site/sdk/ens.js'
import { ADDRESSES, SUFFIX as ID_SUFFIX } from '../../site/sdk/orivonid.js'
import { MULTICALL3 } from '../../site/sdk/read.js'
import { addressTopic, hashOf, idTopic } from '../../site/resolver/og-freshness.js'
import { keyOf } from '../../site/resolver/og-name.js'
import { IMPLEMENTATION, IMPLEMENTATION_SLOT, PROXY, REGISTRY, TOPICS, WRAPPER } from '../../site/resolver/og-pins.js'
import { UNIVERSAL_RESOLVER } from '../../site/register-tip.js'
import { fakeOrivon } from './fake-orivon.ts'

export interface State {
  owner: Record<string, string>
  controller: Record<string, string>
  texts: Record<string, Record<string, string>>
  waitForWrap: Record<string, string>
  nameToId: Record<string, bigint>
  idToName: Record<string, string>
  tokenOwner: Record<string, string>
  nextId: bigint
  wrapEnabled: boolean
  nonces: Record<string, number>
  balances: Record<string, bigint>
  /** The resolver's primary name of each account (lower-case address), as a registry key. */
  primary: Record<string, string>
  /** The address each name resolves to, as `setPrimary` sets it. */
  resolveAddress: Record<string, string>
  /** What the registry's `name(address)` lists for an account. */
  registryName: Record<string, string>
  /** Orivon ID usernames: label to holder. Each is held, resolves to its holder and gives the holder every role. */
  ids: Record<string, string>
}
export interface WorldLog { address: string, blockNumber: number, logIndex: number, topics: string[] }
export interface MinedTx { hash: string, from: string, to: string, status: 0 | 1, gasUsed: number, block: number, label: string }

export const ACCOUNT = toChecksumAddress(`0x${'a1'.repeat(20)}`)
export const RIVAL = toChecksumAddress(`0x${'b2'.repeat(20)}`)
export const TIP_ADDRESS = toChecksumAddress(`0x${'c3'.repeat(20)}`)
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
const ZERO_KEY = `0x${'0'.repeat(64)}`
/** The resolver every Orivon ID in the world names. */
const ID_RESOLVER = toChecksumAddress(`0x${'1d'.repeat(20)}`)
/** The token ids an account holds, in the order the wrapper's enumeration lists them. */
const tokensOf = (at: State, holder: string): bigint[] => Object.entries(at.tokenOwner).filter(([, owner]) => same(owner, holder)).map(([id]) => BigInt(id)).sort((left, right) => left < right ? -1 : 1)
const SEL = (signature: string) => toHex(selector(signature))
/** The gas each call used on a mainnet fork, as measured by tools/fork-series.mjs, and what a call that did nothing or reverted used (round numbers for the manager's calls). */
const GAS: Record<string, [number, number]> = {
  reserve: [45_149, 23_749], setController: [58_506, 37_581], createWrapper: [51_606, 29_367], transfer: [28_489, 24_188], wrap: [202_295, 29_395], setTextRecord: [125_329, 41_989], tip: [21_000, 21_000],
  unwrap: [69_513, 30_000], unsetController: [36_264, 25_000], unsetTextRecord: [50_324, 25_000], setPrimary: [87_226, 25_000], unsetPrimary: [34_556, 25_000], sendToken: [89_228, 25_000]
}

const clone = (state: State): State => ({
  ...state, owner: { ...state.owner }, controller: { ...state.controller }, texts: Object.fromEntries(Object.entries(state.texts).map(([key, value]) => [key, { ...value }])),
  waitForWrap: { ...state.waitForWrap }, nameToId: { ...state.nameToId }, idToName: { ...state.idToName }, tokenOwner: { ...state.tokenOwner }, nonces: { ...state.nonces }, balances: { ...state.balances },
  primary: { ...state.primary }, resolveAddress: { ...state.resolveAddress }, registryName: { ...state.registryName }, ids: { ...state.ids }
})

export interface WorldOptions {
  /** What `orivonstack.eth` resolves to: an address, or null for a lookup that fails. */
  tip?: string | null
  /** Whether the wallet signs a series (`signTransactions`). */
  plan?: boolean
  /** The wallet says no to the nth signature (0 is the first: the series, or the first transaction). */
  declineSignature?: number
  /** The page's own account. */
  account?: string
  /** Codes the person refuses when the page asks for them. */
  decline?: string[]
  /** The number of the block the world starts at: after a census cut at 26,401,211, so a resolver reads from it. */
  base?: number
  /** The address the tip goes to holds code: it takes a plain transfer only with at least `gas` to run, or never (`reverts`). */
  tipContract?: { gas: number } | { reverts: true }
}

/** The first block of a world. */
export const BASE_BLOCK = 26_401_300

/** One world: its table, the blocks it has mined, a hook run before each transaction is mined, and the page's `orivon`. */
export function linageeWorld (initial: Partial<State> = {}, options: WorldOptions = {}) {
  const account = options.account ?? ACCOUNT
  const base = options.base ?? BASE_BLOCK
  const chainLogs: WorldLog[] = []
  let state: State = {
    owner: {}, controller: {}, texts: {}, waitForWrap: {}, nameToId: {}, idToName: {}, tokenOwner: {}, nextId: 70_078n, wrapEnabled: true, nonces: {}, balances: {}, primary: {}, resolveAddress: {}, registryName: {}, ids: {}, ...initial
  }
  const blocks: State[] = [clone(state)]
  const head = () => base + blocks.length - 1
  const stateAt = (block: unknown): State => blocks[Math.max(0, Math.min(blocks.length - 1, (typeof block === 'string' && block.startsWith('0x') ? Number(BigInt(block)) : head()) - base))] as State
  const mined = new Map<string, { mined: MinedTx, logs: unknown[] }>()
  const log: MinedTx[] = []
  const world = {
    get state () { return state },
    log,
    /** Run before the nth transaction (0-based, counting every mined one) is executed: another account acting, or a switch flipped. */
    before: new Map<number, (state: State) => void>(),
    /** Another account acting between two of the page's calls: applies `change` and mines a block with it. */
    change (change: (state: State) => void) { change(state); blocks.push(clone(state)) },
    signatures: 0,
    signed: [] as { from: string, to: string, data: string, value: string }[],
    sent: [] as string[],
    relayed: [] as string[]
  }

  const toTipContract = (to: string) => options.tipContract !== undefined && options.tip !== undefined && options.tip !== null && same(to, options.tip)

  /** `limit`: the gas the transaction was signed with, which a contract's receive function may need more than. */
  function execute (target: State, from: string, to: string, data: Uint8Array, value: bigint, events: { address: string, topics: string[] }[] = [], limit?: number): { ok: boolean, kind: string } {
    const sel = toHex(data.subarray(0, 4))
    const args = data.subarray(4)
    const word = (index: number) => `0x${toHex(args.subarray(index * 32, index * 32 + 32))}`
    if (same(to, REGISTRY)) {
      if (sel === SEL('reserve(bytes32)')) {
        const owned = (target.owner[word(0)] ?? ZERO_ADDRESS) !== ZERO_ADDRESS
        if (!owned) { target.owner[word(0)] = from; events.push({ address: REGISTRY, topics: [TOPICS.changed, word(0)] }) }
        return { ok: true, kind: owned ? 'reserve:none' : 'reserve' }
      }
      if (sel === SEL('transfer(bytes32,address)')) {
        const key = word(0)
        const owns = same(target.owner[key] ?? ZERO_ADDRESS, from)
        if (owns) { target.owner[key] = decode(['address'], args.subarray(32))[0] as string; events.push({ address: REGISTRY, topics: [TOPICS.changed, key] }) }
        return { ok: true, kind: owns ? 'transfer' : 'transfer:none' }
      }
    }
    if (same(to, PROXY)) {
      const key = word(0)
      const holds = same(target.owner[key] ?? ZERO_ADDRESS, from)
      const allowed = holds || same(target.controller[key] ?? ZERO_ADDRESS, from)
      // `setController` and `unsetController` need the registry's owner, as the contract says: a controller cannot name its successor.
      if (sel === SEL('setController(bytes32,address)') || sel === SEL('unsetController(bytes32)')) {
        if (!holds) return { ok: false, kind: 'setController' }
        target.controller[key] = sel === SEL('unsetController(bytes32)') ? ZERO_ADDRESS : decode(['address'], args.subarray(32))[0] as string
        events.push({ address: PROXY, topics: [TOPICS.newController, key, addressTopic(target.controller[key] as string)] })
        return { ok: true, kind: sel === SEL('unsetController(bytes32)') ? 'unsetController' : 'setController' }
      }
      if (sel === SEL('setTextRecord(bytes32,string,string)')) {
        if (!allowed) return { ok: false, kind: 'setTextRecord' }
        const [, textKey, value] = decode(['bytes32', 'string', 'string'], args) as [Uint8Array, string, string]
        target.texts[key] = { ...(target.texts[key] ?? {}), [textKey]: value }
        events.push({ address: PROXY, topics: [TOPICS.setTextRecord, key, hashOf(textKey), hashOf(value)] })
        return { ok: true, kind: 'setTextRecord' }
      }
      if (sel === SEL('unsetTextRecord(bytes32,string)')) {
        if (!allowed) return { ok: false, kind: 'unsetTextRecord' }
        const [, textKey] = decode(['bytes32', 'string'], args) as [Uint8Array, string]
        const rest = { ...(target.texts[key] ?? {}) }
        delete rest[textKey]
        target.texts[key] = rest
        events.push({ address: PROXY, topics: [TOPICS.setTextRecord, key, hashOf(''), hashOf('')] })
        return { ok: true, kind: 'unsetTextRecord' }
      }
      if (sel === SEL('setPrimary(bytes32)')) {
        if (!allowed) return { ok: false, kind: 'setPrimary' }
        const mine = from.toLowerCase()
        delete target.resolveAddress[target.primary[mine] ?? '']
        delete target.primary[(target.resolveAddress[key] ?? '').toLowerCase()]
        target.primary[mine] = key
        target.resolveAddress[key] = from
        return { ok: true, kind: 'setPrimary' }
      }
    }
    if (same(to, PROXY) && sel === SEL('unsetPrimary()')) {
      const mine = from.toLowerCase()
      delete target.resolveAddress[target.primary[mine] ?? '']
      delete target.primary[mine]
      return { ok: true, kind: 'unsetPrimary' }
    }
    if (same(to, WRAPPER)) {
      const key = word(0)
      if (sel === SEL('createWrapper(bytes32)')) {
        if (!same(target.owner[key] ?? ZERO_ADDRESS, from) || !target.wrapEnabled) return { ok: false, kind: 'createWrapper' }
        target.waitForWrap[key] = from
        return { ok: true, kind: 'createWrapper' }
      }
      if (sel === SEL('wrap(bytes32)')) {
        if (!same(target.owner[key] ?? ZERO_ADDRESS, WRAPPER) || !same(target.waitForWrap[key] ?? ZERO_ADDRESS, from) || !target.wrapEnabled) return { ok: false, kind: 'wrap' }
        const id = target.nextId++
        target.tokenOwner[String(id)] = from
        target.idToName[String(id)] = key
        target.nameToId[key] = id
        delete target.waitForWrap[key]
        events.push({ address: WRAPPER, topics: [TOPICS.transfer, addressTopic(ZERO_ADDRESS), addressTopic(from), idTopic(id)] })
        return { ok: true, kind: 'wrap' }
      }
      if (sel === SEL('unwrap(uint256)')) {
        const id = BigInt(word(0))
        if (!same(target.tokenOwner[String(id)] ?? ZERO_ADDRESS, from)) return { ok: false, kind: 'unwrap' }
        const named = target.idToName[String(id)] as string
        target.owner[named] = from
        events.push({ address: REGISTRY, topics: [TOPICS.changed, named] })
        delete target.idToName[String(id)]
        delete target.nameToId[named]
        delete target.tokenOwner[String(id)]
        events.push({ address: WRAPPER, topics: [TOPICS.transfer, addressTopic(from), addressTopic(ZERO_ADDRESS), idTopic(id)] })
        return { ok: true, kind: 'unwrap' }
      }
      if (sel === SEL('safeTransferFrom(address,address,uint256)')) {
        const [sender, receiver, id] = decode(['address', 'address', 'uint256'], args) as [string, string, bigint]
        if (!same(sender, from) || !same(target.tokenOwner[String(id)] ?? ZERO_ADDRESS, from) || same(receiver, ZERO_ADDRESS)) return { ok: false, kind: 'sendToken' }
        target.tokenOwner[String(id)] = receiver
        events.push({ address: WRAPPER, topics: [TOPICS.transfer, addressTopic(from), addressTopic(receiver), idTopic(id)] })
        return { ok: true, kind: 'sendToken' }
      }
    }
    if (data.length === 0 && value > 0n) {
      const contract = toTipContract(to) ? options.tipContract : undefined
      if (contract !== undefined && ('reverts' in contract || (limit !== undefined && limit < contract.gas))) return { ok: false, kind: 'tip' }
      target.balances[to.toLowerCase()] = (target.balances[to.toLowerCase()] ?? 0n) + value
      return { ok: true, kind: 'tip' }
    }
    return { ok: false, kind: 'unknown' }
  }

  /** The Orivon ID registry's side, as much of it as the badge reads: a username is held, resolves to its holder, and its holder has every role. */
  function answerId (at: State, to: string, sel: string, args: Uint8Array): Uint8Array | null | undefined {
    const labelOf = (id: bigint) => Object.keys(at.ids).find((label) => BigInt(labelhash(label)) === id)
    if (same(to, ADDRESSES.r1)) {
      if (sel === SEL('getOwner(uint256)')) { const label = labelOf(BigInt(`0x${toHex(args.subarray(0, 32))}`)); return encode(['address'], [label === undefined ? ZERO_ADDRESS : at.ids[label] as string]) }
      if (sel === SEL('roleCount(uint256)')) return encode(['uint256'], [1n])
      if (sel === SEL('roles(uint256,address)')) {
        const [id, holder] = decode(['uint256', 'address'], args) as [bigint, string]
        const label = labelOf(id)
        return encode(['uint256'], [label !== undefined && same(at.ids[label] as string, holder) ? 1n : 0n])
      }
      if (sel === SEL('getResolver(string)')) { const [label] = decode(['string'], args) as [string]; return encode(['address'], [at.ids[label] === undefined ? ZERO_ADDRESS : ID_RESOLVER]) }
    }
    if (same(to, ID_RESOLVER)) {
      if (sel === SEL('addr(bytes32)')) {
        const node = `0x${toHex(args.subarray(0, 32))}`
        const label = Object.keys(at.ids).find((one) => namehash(`${one}.${ID_SUFFIX}`) === node)
        return encode(['address'], [label === undefined ? ZERO_ADDRESS : at.ids[label] as string])
      }
      if (sel === SEL('hasRoles(uint256,uint256,address)')) return encode(['bool'], [true])
      if (sel === SEL('supportsInterface(bytes4)')) return null
    }
    if (same(to, ADDRESSES.verifiableFactory) && sel === SEL('verifyContract(address)')) return encode(['address'], [ADDRESSES.resolverImplementation])
    return undefined
  }

  function answerCall (at: State, to: string, data: Uint8Array): Uint8Array | null {
    const sel = toHex(data.subarray(0, 4))
    const args = data.subarray(4)
    const word = (index: number) => `0x${toHex(args.subarray(index * 32, index * 32 + 32))}`
    if (same(to, MULTICALL3)) {
      const [calls] = decode(['(address,bool,bytes)[]'], args) as [[string, boolean, Uint8Array][]]
      return encode(['(bool,bytes)[]'], [calls.map(([target, , inner]) => { const out = answerCall(at, target, inner); return [out !== null, out ?? new Uint8Array(0)] })])
    }
    if (same(to, REGISTRY) && sel === SEL('owner(bytes32)')) return encode(['address'], [at.owner[word(0)] ?? ZERO_ADDRESS])
    if (same(to, REGISTRY) && sel === SEL('name(address)')) return encode(['bytes32'], [at.registryName[(decode(['address'], args)[0] as string).toLowerCase()] ?? ZERO_KEY])
    if (same(to, WRAPPER)) {
      if (sel === SEL('balanceOf(address)')) return encode(['uint256'], [BigInt(tokensOf(at, decode(['address'], args)[0] as string).length)])
      if (sel === SEL('tokenOfOwnerByIndex(address,uint256)')) {
        const [holder, index] = decode(['address', 'uint256'], args) as [string, bigint]
        const id = tokensOf(at, holder)[Number(index)]
        return id === undefined ? null : encode(['uint256'], [id])
      }
      if (sel === SEL('nameToId(bytes32)')) return encode(['uint256'], [at.nameToId[word(0)] ?? 0n])
      if (sel === SEL('waitForWrap(bytes32)')) return encode(['address'], [at.waitForWrap[word(0)] ?? ZERO_ADDRESS])
      if (sel === SEL('idToName(uint256)')) return encode(['bytes32'], [at.idToName[String(BigInt(word(0)))] ?? `0x${'0'.repeat(64)}`])
      if (sel === SEL('ownerOf(uint256)')) {
        const holder = at.tokenOwner[String(BigInt(word(0)))]
        return holder === undefined ? null : encode(['address'], [holder])
      }
    }
    if (same(to, PROXY)) {
      if (sel === SEL('primary(address)')) return encode(['bytes32'], [at.primary[(decode(['address'], args)[0] as string).toLowerCase()] ?? ZERO_KEY])
      if (sel === SEL('resolveAddress(bytes32)')) return encode(['address'], [at.resolveAddress[word(0)] ?? ZERO_ADDRESS])
      if (sel === SEL('controller(bytes32)')) return encode(['address'], [at.controller[word(0)] ?? ZERO_ADDRESS])
      if (sel === SEL('getTextRecord(bytes32,string)')) {
        const [key, textKey] = decode(['bytes32', 'string'], args) as [Uint8Array, string]
        return encode(['string'], [at.texts[`0x${toHex(key)}`]?.[textKey] ?? ''])
      }
    }
    const idAnswer = answerId(at, to, sel, args)
    if (idAnswer !== undefined) return idAnswer
    if (same(to, UNIVERSAL_RESOLVER) && sel === SEL('resolve(bytes,bytes)')) {
      if (options.tip === undefined || options.tip === null) return null
      return encode(['bytes', 'address'], [encode(['address'], [options.tip]), `0x${'dd'.repeat(20)}`])
    }
    return null
  }

  const quantity = (value: number | bigint) => `0x${BigInt(value).toString(16)}`
  const rawOf = (tx: Record<string, unknown>, nonce: number) => utf8(JSON.stringify({ from: tx['from'] ?? account, to: tx['to'], data: toHex((tx['data'] as Uint8Array | undefined) ?? new Uint8Array(0)), value: tx['value'] ?? '0x0', gas: tx['gas'], nonce }))

  async function signing () {
    if (options.declineSignature === world.signatures++) throw Object.assign(new Error('the person declined'), { code: 'denied' })
  }

  const answers: Record<string, (...args: any[]) => unknown> = {
    chainId: () => 1,
    blockNumber: () => head(),
    getBlock: () => ({ number: head(), hash: `0x${head().toString(16).padStart(64, '0')}`, parentHash: `0x${'0'.repeat(64)}`, timestamp: 1, gasLimit: 30_000_000, gasUsed: 0, baseFeePerGas: '0x3b9aca00', miner: ZERO_ADDRESS, transactions: [] }),
    call: (tx: { to: string, data: Uint8Array }, block?: string) => {
      const out = answerCall(stateAt(block), tx.to, tx.data)
      return out === null ? { data: null, revert: new Uint8Array(0), offchainLookup: null } : { data: out, revert: null, offchainLookup: null }
    },
    getLogs: (filter: { fromBlock: string, toBlock: string, address?: string[], topics?: (string | null)[] }) => {
      const at = (value: string) => value === 'latest' || value === 'safe' || value === 'finalized' ? head() : Number(BigInt(value))
      const from = at(filter.fromBlock)
      const to = at(filter.toBlock)
      return chainLogs
        .filter((log) => log.blockNumber >= from && log.blockNumber <= to && (filter.address === undefined || filter.address.some((address) => same(address, log.address))))
        .filter((log) => (filter.topics ?? []).every((topic, index) => topic === null || same(topic, log.topics[index] ?? '')))
        .map((log) => ({ ...log, data: new Uint8Array(0), transactionHash: `0x${log.blockNumber.toString(16).padStart(64, '0')}`, removed: false }))
    },
    getCode: (address: string) => toTipContract(address) ? Uint8Array.of(0x60, 0x80, 0x60, 0x40) : new Uint8Array(0),
    getStorageAt: (address: string, slot: string, block?: string) => {
      if (same(address, PROXY) && slot === IMPLEMENTATION_SLOT) return fromHex(IMPLEMENTATION.slice(2).toLowerCase().padStart(64, '0'))
      if (!same(address, WRAPPER)) return new Uint8Array(32)
      const at = stateAt(block)
      return fromHex(`${'0'.repeat(20)}${REGISTRY.slice(2).toLowerCase()}${at.wrapEnabled ? '01' : '00'}00`)
    },
    getTransactionCount: (address: string, block?: string) => stateAt(block).nonces[address.toLowerCase()] ?? 0,
    estimateGas: (tx: { from?: string, to: string, data?: Uint8Array, value?: string }) => {
      const probe = clone(state)
      const done = execute(probe, tx.from ?? account, tx.to, tx.data ?? new Uint8Array(0), tx.value === undefined ? 0n : BigInt(tx.value))
      if (!done.ok) throw Object.assign(new Error('execution reverted'), { code: 'invalid' })
      const contract = toTipContract(tx.to) ? options.tipContract : undefined
      if (contract !== undefined && 'gas' in contract) return contract.gas
      return GAS[done.kind.split(':')[0] as string]?.[0] ?? 50_000
    },
    gasPrice: () => '0x3b9aca00',
    maxPriorityFeePerGas: () => '0x59682f00',
    getTransactionReceipt: (hash: string) => {
      const found = mined.get(hash.toLowerCase())
      if (found === undefined) return null
      const { mined: one } = found
      return { transactionHash: one.hash, blockHash: `0x${one.block.toString(16).padStart(64, '0')}`, blockNumber: one.block, status: one.status, gasUsed: one.gasUsed, effectiveGasPrice: '0x3b9aca00', contractAddress: null, logs: [] }
    },
    getAddresses: () => [account],
    signTransaction: async (tx: Record<string, unknown>) => {
      await signing()
      const from = String(tx['from'] ?? account)
      world.signed.push({ from, to: String(tx['to']), data: toHex((tx['data'] as Uint8Array | undefined) ?? new Uint8Array(0)), value: String(tx['value'] ?? '0x0') })
      return rawOf(tx, Number(tx['nonce']))
    },
    signTransactions: async (txs: Record<string, unknown>[]) => {
      await signing()
      const first = state.nonces[account.toLowerCase()] ?? 0
      return txs.map((tx, index) => {
        world.signed.push({ from: account, to: String(tx['to']), data: toHex((tx['data'] as Uint8Array | undefined) ?? new Uint8Array(0)), value: String(tx['value'] ?? '0x0') })
        return rawOf(tx, first + index)
      })
    },
    sendRawTransaction: async (raw: Uint8Array) => {
      world.sent.push(`0x${toHex(keccak256(raw))}`)
      return mine(raw)
    }
  }

  /** Mines a signed transaction in the next block, as the node would; used by the page's node and by the relay stand-in. */
  function mine (raw: Uint8Array): string {
    const tx = JSON.parse(new TextDecoder().decode(raw)) as { from: string, to: string, data: string, value: string, gas: number, nonce: number }
    const hash = `0x${toHex(keccak256(raw))}`
    const next = state.nonces[tx.from.toLowerCase()] ?? 0
    if (tx.nonce !== next) throw Object.assign(new Error(`nonce too ${tx.nonce < next ? 'low' : 'high'}`), { code: 'invalid' })
    world.before.get(log.length)?.(state)
    const data = fromHex(tx.data)
    const probe = clone(state)
    const events: { address: string, topics: string[] }[] = []
    const done = execute(probe, tx.from, tx.to, data, BigInt(tx.value), events, tx.gas)
    if (done.ok) state = probe
    state.nonces[tx.from.toLowerCase()] = next + 1
    const [base, idle] = GAS[done.kind.split(':')[0] as string] ?? [21_000, 21_000]
    const contract = toTipContract(tx.to) ? options.tipContract : undefined
    const full = contract !== undefined && 'gas' in contract && done.kind === 'tip' ? contract.gas : base
    const gasUsed = !done.ok ? idle : done.kind.endsWith(':none') ? idle : full
    blocks.push(clone(state))
    if (done.ok) events.forEach((event, logIndex) => chainLogs.push({ ...event, blockNumber: head(), logIndex }))
    const one: MinedTx = { hash, from: tx.from, to: tx.to, status: done.ok ? 1 : 0, gasUsed, block: head(), label: done.kind }
    mined.set(hash, { mined: one, logs: [] })
    log.push(one)
    return hash
  }

  const fake = fakeOrivon(answers, options.decline ?? [], { plan: options.plan === true })
  return { world, chainLogs, orivon: fake.orivon, uses: fake.uses, calls: fake.calls, account, mine, quantity, keyOf }
}
