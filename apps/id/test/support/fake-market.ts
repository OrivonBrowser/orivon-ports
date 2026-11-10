// A Chain that behaves like the registrar, DAI, the resolver factory and one account's resolver, with a block clock
// that moves when the code under test sleeps. It runs the registrar's checks in its own order, so a flow test sees
// the revert strings the contract gives. R1 and the resolver's records are served by fakeRegistry. A real node is the
// fork tests' job.

import { decode, encode, encodeCall, selector, toChecksumAddress, ZERO_ADDRESS } from '../../site/sdk/abi.js'
import { fromHex, toHex, utf8 } from '../../site/sdk/bytes.js'
import { type Chain, ChainError, pollReceipt, type Receipt } from '../../site/sdk/chain.js'
import { keccak256 } from '../../site/sdk/keccak.js'
import { labelhash } from '../../site/sdk/ens.js'
import { ADDRESSES, isValidLabel, price } from '../../site/sdk/orivonid.js'
import { makeCommitment, RECORD_ROLES, RESOLVER_ROLES as ALL_RESOLVER } from '../../site/register-tx.js'
import { fakeRegistry, type World } from './fake-registry.ts'

const sel = (signature: string) => toHex(selector(signature))
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
const BLOCK_SECONDS = 12

export type Code = 'none' | 'accepting' | 'rejecting' | 'delegating'

export interface MarketOptions {
  account: string
  dai?: bigint
  allowance?: bigint
  accountCode?: Code
  resolver?: 'none' | 'ours' | 'foreign' | 'noRoles'
  world?: Partial<World>
}

export interface Sent { step: string, hash: string, from: string, to: string, data: Uint8Array, ts: number, ok: boolean }

export function fakeMarket (options: MarketOptions) {
  const { account } = options
  const world: World = { names: {}, resolvers: {}, registrar: {}, ...options.world }
  const registry = fakeRegistry(world)
  const state = { ts: 1_800_000_000, number: 26_357_300, nowMs: 1_000_000, counter: 0, reads: 0 }
  const commitments = new Map<string, number>()
  const balances = new Map<string, bigint>([[account.toLowerCase(), options.dai ?? 100n * 10n ** 18n]])
  const allowances = new Map<string, bigint>([[account.toLowerCase(), options.allowance ?? 0n]])
  const codes = new Map<string, Uint8Array>()
  const roles = new Map<string, bigint>()
  const receipts = new Map<string, Receipt>()
  const sent: Sent[] = []
  const hooks = { revertMined: null as string | null, drop: false, onRegister: null as (() => void) | null }
  const dropped: { tx: { from: string, to: string, data: Uint8Array }, hash: string }[] = []

  const predicted = toChecksumAddress('0x' + toHex(keccak256(encode(['address', 'string'], [account, 'resolver'])).slice(12)))
  if (options.resolver !== undefined && options.resolver !== 'none') {
    codes.set(predicted.toLowerCase(), new Uint8Array([0x60, 0x80]))
    world.resolvers[predicted] = { extended: true, addr: null, texts: {} }
    roles.set(predicted.toLowerCase(), options.resolver === 'noRoles' ? 0n : ALL_RESOLVER)
  }
  const foreign = options.resolver === 'foreign'
  const accountCode = options.accountCode ?? 'none'
  if (accountCode === 'delegating') codes.set(account.toLowerCase(), fromHex('0xef0100' + '11'.repeat(20)))
  else if (accountCode !== 'none') codes.set(account.toLowerCase(), new Uint8Array([0x60, 0x80]))

  const labelOfId = (id: bigint) => Object.keys(world.names).find((label) => BigInt(labelhash(label)) === id)
  const word = (value: bigint) => encode(['uint256'], [value])
  const answer = (data: Uint8Array) => ({ data, revert: null, offchainLookup: null })
  const reverted = (reason: string) => ({ data: null, revert: reason === '' ? new Uint8Array(0) : fromHex('0x08c379a0' + toHex(encode(['string'], [reason]))), offchainLookup: null })
  const balance = (holder: string) => balances.get(holder.toLowerCase()) ?? 0n
  const allowance = (holder: string) => allowances.get(holder.toLowerCase()) ?? 0n

  function call(tx: { from?: string, to?: string, data?: Uint8Array }) {
    state.reads++
    const to = tx.to ?? ''
    const data = tx.data ?? new Uint8Array(0)
    const head = toHex(data.subarray(0, 4))
    const args = data.subarray(4)
    if (same(to, ADDRESSES.registrar) && head === sel('commitmentAt(bytes32)')) return answer(word(BigInt(commitments.get(toHex(args)) ?? 0)))
    if (same(to, ADDRESSES.dai) && head === sel('balanceOf(address)')) return answer(word(balance(decode(['address'], args)[0] as string)))
    if (same(to, ADDRESSES.dai) && head === sel('allowance(address,address)')) return answer(word(allowance(decode(['address', 'address'], args)[0] as string)))
    if (same(to, ADDRESSES.verifiableFactory) && head === sel('predictProxyAddress(address,uint256)')) {
      return answer(encode(['address'], [same(decode(['address', 'uint256'], args)[0] as string, account) ? predicted : toChecksumAddress('0x' + '99'.repeat(20))]))
    }
    if (same(to, ADDRESSES.verifiableFactory) && head === sel('verifyContract(address)')) {
      const proxy = decode(['address'], args)[0] as string
      const vouched = Object.entries(world.resolvers).find(([address]) => same(address, proxy))?.[1]?.foreign !== true
      return foreign || !vouched ? reverted('') : answer(encode(['address'], [ADDRESSES.resolverImplementation]))
    }
    if (same(to, predicted) && head === sel('hasRootRoles(uint256,address)')) {
      const [bitmap] = decode(['uint256', 'address'], args) as [bigint, string]
      return answer(encode(['bool'], [((roles.get(predicted.toLowerCase()) ?? 0n) & bitmap) === bitmap]))
    }
    if (head === sel('onERC1155Received(address,address,uint256,uint256,bytes)') && codes.has(to.toLowerCase())) {
      return accountCode === 'accepting' ? answer(fromHex('0xf23a6e61' + '00'.repeat(28))) : accountCode === 'rejecting' ? reverted('') : answer(new Uint8Array(0))
    }
    return registry.chain.call({ to, data } as never) as unknown as ReturnType<typeof answer>
  }

  function refusal(tx: { from: string, to: string, data: Uint8Array }, at: number): string | null {
    const to = tx.to.toLowerCase()
    const head = toHex(tx.data.subarray(0, 4))
    const args = tx.data.subarray(4)
    if (to === ADDRESSES.registrar.toLowerCase() && head === sel('register(string,address,address,bytes32)')) {
      const [label, owner, resolver, secret] = decode(['string', 'address', 'address', 'bytes32'], args) as [string, string, string, Uint8Array]
      if (!isValidLabel(label)) return 'invalid label'
      if (!same(resolver, ZERO_ADDRESS) && !same(owner, tx.from)) return 'resolver only for your own name'
      const started = commitments.get(toHex(fromHex(makeCommitment(label, owner, resolver, secret)))) ?? 0
      if (at < started + 60) return 'commitment too new'
      if (at >= started + 86400) return 'commitment too old'
      if (world.ethToR0 !== undefined || world.r0ToR1 !== undefined) return 'v1 unreachable'
      if (world.registrar.daiAboveFloor === false) return 'DAI below $0.80'
      if (world.registrar.beneficiary === 'revert') return 'no beneficiary'
      if (balance(tx.from) < price(label)) return 'Dai/insufficient-balance'
      if (allowance(tx.from) < price(label)) return 'Dai/insufficient-allowance'
      if (world.names[label] !== undefined) return ''
      if (accountCode === 'rejecting' || accountCode === 'delegating') return ''
    }
    if (to === ADDRESSES.r1.toLowerCase() && head === sel('setResolver(uint256,address)')) {
      const label = labelOfId(decode(['uint256', 'address'], args)[0] as bigint)
      if (label === undefined || !same(world.names[label]?.owner ?? '', tx.from)) return 'EACUnauthorizedAccountRoles'
    }
    if (to === ADDRESSES.verifiableFactory.toLowerCase() && head === sel('deployProxy(address,uint256,bytes)') && codes.has(predicted.toLowerCase())) return 'create2 failed'
    if (to === predicted.toLowerCase() && head === sel('multicall(bytes[])') && ((roles.get(to) ?? 0n) & RECORD_ROLES) !== RECORD_ROLES) return 'EACUnauthorizedAccountRoles'
    return null
  }

  function apply(tx: { from: string, to: string, data: Uint8Array }, at: number) {
    const to = tx.to.toLowerCase()
    const head = toHex(tx.data.subarray(0, 4))
    const args = tx.data.subarray(4)
    if (to === ADDRESSES.registrar.toLowerCase() && head === sel('commit(bytes32)')) {
      const key = toHex(args)
      if ((commitments.get(key) ?? 0) + 86400 <= at) commitments.set(key, at)
    } else if (to === ADDRESSES.dai.toLowerCase() && head === sel('approve(address,uint256)')) {
      allowances.set(tx.from.toLowerCase(), decode(['address', 'uint256'], args)[1] as bigint)
    } else if (to === ADDRESSES.verifiableFactory.toLowerCase() && head === sel('deployProxy(address,uint256,bytes)')) {
      codes.set(predicted.toLowerCase(), new Uint8Array([0x60, 0x80]))
      roles.set(predicted.toLowerCase(), ALL_RESOLVER)
      world.resolvers[predicted] = { extended: true, addr: null, texts: {} }
    } else if (to === ADDRESSES.registrar.toLowerCase() && head === sel('register(string,address,address,bytes32)')) {
      const [label, owner, resolver, secret] = decode(['string', 'address', 'address', 'bytes32'], args) as [string, string, string, Uint8Array]
      commitments.delete(toHex(fromHex(makeCommitment(label, owner, resolver, secret))))
      balances.set(tx.from.toLowerCase(), balance(tx.from) - price(label))
      world.names[label] = { owner, resolver }
      hooks.onRegister?.()
    } else if (to === ADDRESSES.r1.toLowerCase() && head === sel('setResolver(uint256,address)')) {
      const [id, resolver] = decode(['uint256', 'address'], args) as [bigint, string]
      const label = labelOfId(id)
      if (label !== undefined) world.names[label] = { ...world.names[label]!, resolver }
    } else if (to === predicted.toLowerCase() && head === sel('multicall(bytes[])')) {
      const [calls] = decode(['bytes[]'], args) as [Uint8Array[]]
      const record = world.resolvers[predicted] ?? { extended: true }
      for (const inner of calls) {
        const innerArgs = inner.subarray(4)
        if (toHex(inner.subarray(0, 4)) === sel('setAddress(bytes,uint256,bytes)')) record.addr = toChecksumAddress('0x' + toHex((decode(['bytes', 'uint256', 'bytes'], innerArgs) as [Uint8Array, bigint, Uint8Array])[2]))
        else if (toHex(inner.subarray(0, 4)) === sel('setContenthash(bytes,bytes)')) record.contenthash = '0x' + toHex((decode(['bytes', 'bytes'], innerArgs) as [Uint8Array, Uint8Array])[1])
        else if (toHex(inner.subarray(0, 4)) === sel('setText(bytes,string,string)')) {
          const [, key, value] = decode(['bytes', 'string', 'string'], innerArgs) as [Uint8Array, string, string]
          record.texts = { ...record.texts, [key]: value }
        }
      }
      world.resolvers[predicted] = record
    }
  }

  const hashOf = () => '0x' + toHex(keccak256(utf8(`tx:${++state.counter}`)))

  function mine(tx: { from: string, to: string, data: Uint8Array }, hash: string): void {
    const step = stepOf(tx)
    const at = state.ts + BLOCK_SECONDS
    state.ts = at
    state.number += 1
    const ok = hooks.revertMined !== step && refusal(tx, at) === null
    if (ok) apply(tx, at)
    sent.push({ step, hash, from: tx.from, to: tx.to, data: tx.data, ts: at, ok })
    receipts.set(hash, {
      transactionHash: hash, blockHash: '0x' + '00'.repeat(32), blockNumber: state.number, status: ok ? 1 : 0, gasUsed: 100_000,
      effectiveGasPrice: 1n, contractAddress: null, logs: []
    })
  }

  function stepOf(tx: { to: string, data: Uint8Array }): string {
    const head = toHex(tx.data.subarray(0, 4))
    const names: Record<string, string> = {
      [sel('commit(bytes32)')]: 'commit', [sel('approve(address,uint256)')]: 'approve', [sel('deployProxy(address,uint256,bytes)')]: 'deploy',
      [sel('register(string,address,address,bytes32)')]: 'register', [sel('multicall(bytes[])')]: 'records', [sel('setResolver(uint256,address)')]: 'resolver'
    }
    return names[head] ?? 'other'
  }

  const chain: Chain = {
    kind: 'orivon',
    chainId: async () => 1,
    blockNumber: async () => state.number,
    getBlock: async () => ({ number: state.number, hash: '0x' + '00'.repeat(32), parentHash: '0x' + '00'.repeat(32), timestamp: state.ts, gasLimit: 30_000_000, gasUsed: 0, baseFeePerGas: 1n, miner: ZERO_ADDRESS, transactions: [] }),
    call: async (tx) => call(tx) as never,
    getLogs: async () => [],
    getCode: async (address) => codes.get(address.toLowerCase()) ?? new Uint8Array(0),
    getTransactionCount: async () => state.counter,
    estimateGas: async (tx) => {
      const why = refusal({ from: tx.from ?? account, to: tx.to ?? '', data: tx.data ?? new Uint8Array(0) }, state.ts + BLOCK_SECONDS)
      if (why !== null) throw new ChainError('reverted', why === '' ? 'execution reverted' : `execution reverted: ${why}`)
      return 100_000
    },
    gasPrice: async () => 1n,
    maxPriorityFeePerGas: async () => 1n,
    getTransactionReceipt: async (hash) => receipts.get(hash) ?? null,
    addresses: async () => [account],
    signMessage: async () => new Uint8Array(65),
    sendTransaction: async () => { throw new Error('the flow sends through its broadcaster') },
    waitForReceipt: async (hash, wait) => await pollReceipt(chain, hash, wait)
  }

  return {
    chain, world, sent, hooks, predicted, account,
    advance (seconds: number) { state.ts += seconds; state.number += Math.max(1, Math.ceil(seconds / BLOCK_SECONDS)) },
    clock: {
      now: () => state.nowMs,
      sleep: async (ms: number) => { state.nowMs += ms; state.ts += Math.ceil(ms / 1000); state.number += 1 }
    },
    time: () => state.ts,
    reads: () => state.reads,
    balanceOf: balance,
    allowanceOf: allowance,
    commitment: (key: string) => commitments.get(key),
    /** Broadcasts the way a node does: mined at once, or accepted and never mined when `hooks.drop` is set. */
    broadcast (tx: { from: string, to: string, data: Uint8Array }, hash: string): void {
      if (hooks.drop) { hooks.drop = false; dropped.push({ tx, hash }); return }
      mine(tx, hash)
    },
    /** Mines what was accepted and never included, as a slow node would later. */
    includeDropped (): void { for (const { tx, hash } of dropped.splice(0)) mine(tx, hash) },
    nextHash: hashOf
  }
}

export type Market = ReturnType<typeof fakeMarket>
