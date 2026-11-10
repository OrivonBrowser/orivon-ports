// A stand-in for the page's `orivon` for a browser that is not Orivon: the shape rules of fake-orivon.ts over a
// chain made of tables (fake-market.ts), so the whole page can be driven headless from a screenshot script or a test.
// It holds a registration clock that moves with real time at a rate the script sets, a wallet that signs through the
// two functions it is given, and a fetch that answers the private relay. Never served; the script injects it.

import { fromHex, toHex, utf8 } from '../../site/sdk/bytes.js'
import { ChainError } from '../../site/sdk/chain.js'
import { decode, selector, toChecksumAddress } from '../../site/sdk/abi.js'
import { keccak256 } from '../../site/sdk/keccak.js'
import { commitTx, makeCommitment } from '../../site/register-tx.js'
import { fakeMarket } from './fake-market.ts'
import { fakeOrivon } from './fake-orivon.ts'
import { type Event, fakeRegistry } from './fake-registry.ts'

export interface Scenario {
  /** Whole DAI in the wallet (default 100) and what the registrar may already take (default 0). */
  dai?: number
  allowance?: number
  /** IDs the wallet holds with their records set; the first uses the wallet's own resolver, so its records can be edited. */
  names?: string[]
  /** IDs the wallet holds but whose address record is empty. */
  unsetNames?: string[]
  /** IDs the wallet holds on a resolver the factory does not vouch for, so it cannot write their records. */
  notHeld?: string[]
  /** IDs held by somebody else. */
  taken?: string[]
  texts?: Record<string, Record<string, string>>
  contenthash?: Record<string, string>
  /** The registrar's sales status, a failure of the node, a refused permission, a refused signature. */
  salesClosed?: boolean
  relayRefuses?: boolean
  grantRefused?: boolean
  /** The person said no to reading Ethereum: `orivon.use` answers null for it. */
  readRefused?: boolean
  /** The node cannot answer the question of whether the registrar sells, until a script sets `fake.failSales` false. */
  salesReadFails?: boolean
  /** A commitment already made and mined for this wallet, as a reload in the middle of the registration finds it. */
  committed?: { label: string, secret: string }
  /** The wallet waits for `fake.release()` from the first signature on. */
  holdWallet?: boolean
  /** Seconds of block time that pass per real second (default 1; 0 stops the chain's clock). */
  rate?: number
  /** Blocks the head the page sees is ahead of the chain's own, so what the scenario registered lies beyond a light client's window of logs. */
  farHead?: number
  /** The node cannot give any log, as one that is no archive cannot give an old range. */
  logsRefused?: boolean
}

export interface Services {
  account: string
  /** EIP-191 signature of the message, 65 bytes with v 27 or 28. */
  sign: (message: Uint8Array) => Promise<Uint8Array>
  /** What the ecrecover precompile answers to its 128 bytes. */
  recover: (input: Uint8Array) => Promise<Uint8Array>
}

const OTHER = toChecksumAddress('0x' + '0b'.repeat(20))
const ECRECOVER = '0x0000000000000000000000000000000000000001'
const SET_TEXT = toHex(selector('setText(bytes,string,string)'))
const GET_OWNER = toHex(selector('getOwner(uint256)'))
const DAI_ABOVE_FLOOR = toHex(selector('daiAboveFloor()'))
const REGISTER = toHex(selector('register(string,address,address,bytes32)'))
const hex = (bytes: Uint8Array) => '0x' + toHex(bytes)
const synthetic = (seed: string) => toChecksumAddress('0x' + toHex(keccak256(utf8(`resolver:${seed}`))).slice(0, 40))
const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: 'invalid' }) }
const invalidUnavailable = (message: string): never => { throw Object.assign(new Error(message), { code: 'unavailable' }) }

export function installFakeOrivon (scenario: Scenario, services: Services, scope: any = globalThis) {
  const { account } = services
  const market = fakeMarket({
    account, dai: BigInt(scenario.dai ?? 100) * 10n ** 18n, allowance: BigInt(scenario.allowance ?? 0) * 10n ** 18n,
    resolver: (scenario.names?.length ?? 0) > 0 ? 'ours' : 'none',
    world: { names: {}, resolvers: {}, registrar: scenario.salesClosed === true ? { daiAboveFloor: false } : {} }
  })
  const { world, predicted } = market
  const events: Event[] = []
  const held = [
    ...(scenario.names ?? []).map((label) => ({ label, set: true, foreign: false })),
    ...(scenario.unsetNames ?? []).map((label) => ({ label, set: false, foreign: false })),
    ...(scenario.notHeld ?? []).map((label) => ({ label, set: true, foreign: true }))
  ]
  held.forEach(({ label, set, foreign }, index) => {
    const resolver = set && index === 0 && !foreign ? predicted : synthetic(label)
    world.names[label] = { owner: account, resolver }
    world.resolvers[resolver] = {
      extended: true, addr: set ? account : null, texts: scenario.texts?.[label] ?? {}, ...(foreign ? { foreign: true } : {}),
      ...(scenario.contenthash?.[label] === undefined ? {} : { contenthash: scenario.contenthash[label] })
    }
    events.push({ block: 26_357_200 + index, kind: 'registered', label, owner: account })
  })
  for (const label of scenario.taken ?? []) {
    const resolver = synthetic(label)
    world.names[label] = { owner: OTHER, resolver }
    world.resolvers[resolver] = { extended: true, addr: OTHER, texts: {} }
    events.push({ block: 26_357_250, kind: 'registered', label, owner: OTHER })
  }

  const registry = fakeRegistry(world, events)
  const chain = market.chain
  const signed = new Map<string, { from: string, to: string, data: Uint8Array }>()
  const fake: Record<string, any> = { market, scenario, events, rate: scenario.rate ?? 1, signed, relayCalls: 0, ownerReads: 0, calls: 0, holdOn: -1, failSales: scenario.salesReadFails === true, granted: false, gate: null as Promise<void> | null, open: null as (() => void) | null, decline: false }
  const tick = setInterval(() => { if (fake['rate'] > 0) market.advance(fake['rate']) }, 1000)

  /** A signature or a transaction waits here while a script holds the wallet, and is refused when it declines. */
  async function wallet() {
    if (fake['calls']++ === fake['holdOn']) fake['hold']()
    if (fake['gate'] !== null) await fake['gate']
    if (fake['decline'] === true) { fake['decline'] = false; throw Object.assign(new Error('the person declined'), { code: 'denied' }) }
  }

  /** Mines a transaction as a node would, and notes a registration so the registry lists it. */
  async function broadcast(tx: { from: string, to: string, data: Uint8Array }, hash: string) {
    market.broadcast(tx, hash)
    const head = toHex(tx.data.subarray(0, 4))
    if (head === REGISTER && market.sent.at(-1)?.ok === true) {
      const [label, owner] = decode(['string', 'address', 'address', 'bytes32'], tx.data.subarray(4)) as [string, string, string, Uint8Array]
      events.push({ block: await chain.blockNumber(), kind: 'registered', label, owner })
    } else if (head === SET_TEXT && market.sent.at(-1)?.ok === true) {
      const [, key, value] = decode(['bytes', 'string', 'string'], tx.data.subarray(4)) as [Uint8Array, string, string]
      const state = world.resolvers[Object.keys(world.resolvers).find((address) => address.toLowerCase() === tx.to.toLowerCase()) ?? '']
      if (state !== undefined) state.texts = { ...state.texts, [key]: value }
    }
  }

  const number = (value: string) => Number(BigInt(value))
  const answers: Record<string, (...args: any[]) => unknown> = {
    chainId: () => 1,
    blockNumber: async () => (await chain.blockNumber()) + (scenario.farHead ?? 0),
    getBlock: async () => {
      const block = (await chain.getBlock('latest'))!
      return { ...block, baseFeePerGas: '0x1', miner: block.miner }
    },
    call: async (tx: { to: string, data: Uint8Array }) => {
      if (toHex(tx.data.subarray(0, 4)) === GET_OWNER) fake['ownerReads']++
      if (fake['failSales'] === true && toHex(tx.data.subarray(0, 4)) === DAI_ABOVE_FLOOR) invalidUnavailable('the node did not answer')
      if (tx.to.toLowerCase() === ECRECOVER) {
        const out = await services.recover(tx.data)
        return { data: out, revert: null, offchainLookup: null }
      }
      return await chain.call(tx as never)
    },
    getLogs: async (filter: { fromBlock: string, toBlock: string, topics?: (string | null)[] }) => {
      if (scenario.logsRefused === true) invalidUnavailable('no provider can answer this call now')
      return await registry.chain.getLogs({ fromBlock: number(filter.fromBlock), toBlock: number(filter.toBlock), topics: filter.topics ?? [] } as never)
    },
    getCode: (address: string) => chain.getCode(address),
    getTransactionCount: (address: string) => chain.getTransactionCount(address),
    estimateGas: async (tx: { from?: string, to: string, data?: Uint8Array }) => {
      try {
        return await chain.estimateGas(tx as never)
      } catch (error) {
        if (error instanceof ChainError && error.reason === 'reverted') invalid(error.message)
        throw error
      }
    },
    gasPrice: () => '0x1',
    maxPriorityFeePerGas: () => '0x1',
    getTransactionReceipt: async (hash: string) => {
      const receipt = await chain.getTransactionReceipt(hash)
      return receipt === null ? null : { ...receipt, effectiveGasPrice: '0x1', logs: [] }
    },
    getAddresses: () => [account],
    signMessage: async (message: Uint8Array) => {
      await wallet()
      return await services.sign(message)
    },
    signTransaction: async (tx: { from: string, to: string, data: Uint8Array }) => {
      await wallet()
      const raw = utf8(JSON.stringify({ from: tx.from, to: tx.to, data: hex(tx.data), n: signed.size }))
      signed.set(hex(raw), { from: tx.from, to: tx.to, data: tx.data })
      return raw
    },
    sendRawTransaction: async (raw: Uint8Array) => {
      const tx = signed.get(hex(raw))
      if (tx === undefined) invalid('unknown transaction')
      const hash = hex(keccak256(raw))
      await broadcast(tx!, hash)
      return hash
    }
  }

  const { orivon } = fakeOrivon(answers, scenario.readRefused === true ? ['ETH_NET_0_1_READONLY'] : [])
  Object.assign(orivon, {
    app: {
      grants: async () => fake['granted'] === true ? [{ capability: 'https.connect', patterns: ['rpc.flashbots.net:443'] }] : [],
      requestGrant: async () => { if (scenario.grantRefused === true) return false; fake['granted'] = true; return true }
    }
  })

  // The private relay: the page posts the signed bytes with its own fetch.
  const realFetch = scope.fetch?.bind(scope)
  scope.fetch = async (url: unknown, init?: { body?: string }) => {
    if (String(url) !== 'https://rpc.flashbots.net') return await realFetch(url, init)
    fake['relayCalls']++
    const body = JSON.parse(init?.body ?? '{}')
    const reply = (payload: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(payload as object) }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (scenario.relayRefuses === true) return reply({ error: { message: 'rejected by the relay' } })
    const raw = fromHex(body.params[0])
    const tx = signed.get(hex(raw))
    if (tx === undefined) return reply({ error: { message: 'unknown transaction' } })
    const hash = hex(keccak256(raw))
    await broadcast(tx, hash)
    return reply({ result: hash })
  }

  Object.assign(fake, {
    orivon,
    /** Moves the chain's clock on by `seconds` at once. */
    advance: (seconds: number) => market.advance(seconds),
    setRate: (rate: number) => { fake['rate'] = rate },
    /** Holds the wallet: the next signature waits for `release`, or the one at index `holdOn` of all it is asked for. */
    hold: () => { fake['gate'] = new Promise<void>((resolve) => { fake['open'] = resolve }) },
    release: () => { fake['open']?.(); fake['gate'] = null },
    stop: () => clearInterval(tick)
  })
  if (scenario.committed !== undefined) {
    const { label, secret } = scenario.committed
    const commit = commitTx(makeCommitment(label, account, predicted, secret))
    market.broadcast({ from: account, to: commit.to, data: commit.data }, '0x' + '01'.repeat(32))
  }
  if (scenario.holdWallet === true) fake['hold']()
  scope.orivon = orivon
  scope.__fake = fake
  return fake
}
