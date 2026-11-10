import { describe, expect, it } from 'vitest'
import { toHex } from '../site/sdk/bytes.js'
import {
  blockParam, ChainError, checkLogSpan, MAX_LOG_SPAN, parseQuantity, pollReceipt, quantityHex, REASONS, suggestFees
} from '../site/sdk/chain.js'
import { detectChain } from '../site/sdk/chain-detect.js'
import { eip1193Chain, fromProviderError } from '../site/sdk/chain-eip1193.js'
import { fromOrivonError, orivonChain } from '../site/sdk/chain-orivon.js'
import { keccak256 } from '../site/sdk/keccak.js'
import { fakeOrivon } from './support/fake-orivon.ts'

const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const REGISTRAR = '0x27264C6AE4ec65fD14C0FB55C2Dc71eAa8956Cb4'
const HASH = '0x' + 'ab'.repeat(32)

async function reason (work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    if (error instanceof ChainError) return error.reason
    throw error
  }
  return 'resolved'
}

describe('shared helpers', () => {
  it('spell block references the way both nodes and the host accept', () => {
    expect(blockParam(undefined)).toBe('latest')
    expect(blockParam(0)).toBe('0x0')
    expect(blockParam(26357300)).toBe('0x1922e34')
    expect(blockParam(26357300n)).toBe('0x1922e34')
    expect(blockParam('0x0001')).toBe('0x1')
    expect(blockParam('safe')).toBe('safe')
    expect(() => blockParam('pending')).toThrow(ChainError)
    expect(() => blockParam(-1)).toThrow(ChainError)
    expect(() => blockParam(HASH)).toThrow('block hash')
    expect(blockParam(HASH.toUpperCase().replace('0X', '0x'), true)).toBe(HASH)
  })

  it('reads quantities strictly', () => {
    expect(parseQuantity('0x10')).toBe(16n)
    expect(() => parseQuantity('16')).toThrow(ChainError)
    expect(() => parseQuantity('0x')).toThrow(ChainError)
    expect(quantityHex(0n)).toBe('0x0')
  })

  it('refuses a log range of more than 1024 blocks, counting both ends', () => {
    expect(() => checkLogSpan({ fromBlock: 100, toBlock: 100 + MAX_LOG_SPAN - 1 })).not.toThrow()
    expect(() => checkLogSpan({ fromBlock: 100, toBlock: 100 + MAX_LOG_SPAN })).toThrow('1024')
    expect(() => checkLogSpan({ fromBlock: 100, toBlock: 'latest' })).not.toThrow()
  })

  it('names nine reasons and no more', () => {
    expect(REASONS).toHaveLength(9)
  })
})

describe('pollReceipt', () => {
  const receipt = { transactionHash: HASH }

  it('polls until the receipt appears, and keeps going through a node that is briefly unavailable', async () => {
    let calls = 0
    let clock = 0
    const chain = {
      getTransactionReceipt: async () => {
        calls++
        if (calls === 1) return null
        if (calls === 2) throw new ChainError('unavailable', 'down')
        return receipt as never
      }
    }
    const got = await pollReceipt(chain, HASH, { now: () => clock, sleep: async (ms) => { clock += ms } })
    expect(got).toBe(receipt)
    expect(calls).toBe(3)
  })

  it('times out with the hash, and does not hide a real failure', async () => {
    let clock = 0
    const never = { getTransactionReceipt: async () => null }
    const error = await pollReceipt(never, HASH, { timeoutMs: 5000, intervalMs: 2000, now: () => clock, sleep: async (ms) => { clock += ms } }).catch((e: ChainError) => e)
    expect(error).toMatchObject({ reason: 'timeout', hash: HASH })
    const broken = { getTransactionReceipt: async () => { throw new ChainError('badAnswer', 'x') } }
    expect(await reason(pollReceipt(broken, HASH))).toBe('badAnswer')
  })
})

describe('suggestFees', () => {
  it('doubles the base fee and adds the tip, or answers null when there is no base fee', async () => {
    const block = (baseFeePerGas: bigint | null) => async () => ({ baseFeePerGas }) as never
    expect(await suggestFees({ getBlock: block(10n), maxPriorityFeePerGas: async () => 3n })).toEqual({ maxFeePerGas: 23n, maxPriorityFeePerGas: 3n })
    expect(await suggestFees({ getBlock: block(null), maxPriorityFeePerGas: async () => 3n })).toBeNull()
  })
})

const BLOCK = { number: 100, hash: HASH, parentHash: HASH, timestamp: 1700000000, gasLimit: 30000000, gasUsed: 1, baseFeePerGas: '0xa', miner: ALICE, transactions: [HASH] }

describe('orivonChain', () => {
  it('asks for nothing until a call needs it, then once, with the read profile only', async () => {
    const fake = fakeOrivon({ blockNumber: 7 })
    const chain = orivonChain(fake.orivon as never)
    expect(fake.uses).toEqual([])
    expect(await Promise.all([chain.blockNumber(), chain.blockNumber()])).toEqual([7, 7])
    await chain.blockNumber()
    expect(fake.uses).toEqual([{ codes: ['ETH_NET_0_1_READONLY'], groups: undefined }])
  })

  it('answers declined when the person refuses the reads, and when a group was not granted', async () => {
    const refused = orivonChain(fakeOrivon({ blockNumber: 7 }, ['ETH_NET_0_1_READONLY']).orivon as never)
    expect(await reason(refused.blockNumber())).toBe('declined')
    const noSign = orivonChain({ use: async () => [Object.freeze({ code: 'ETH_0_1', getAddresses: async () => [ALICE] })] } as never)
    expect(await noSign.addresses()).toEqual([ALICE])
    expect(await reason(noSign.signMessage(new Uint8Array(1)))).toBe('declined')
  })

  it('sends a call in the shape the host checks: no undefined field, hex quantities, data in its own buffer', async () => {
    const fake = fakeOrivon({ call: { data: new Uint8Array([1, 2]), revert: null, offchainLookup: null } })
    const chain = orivonChain(fake.orivon as never)
    const big = new Uint8Array(100)
    const result = await chain.call({ to: REGISTRAR, data: big.subarray(10, 14), value: 255n, from: undefined } as never)
    expect(result.data).toEqual(new Uint8Array([1, 2]))
    const sent = fake.calls[0]?.args as [Record<string, unknown>, string]
    expect(Object.keys(sent[0]).sort()).toEqual(['data', 'to', 'value'])
    expect(sent[0]['value']).toBe('0xff')
    expect((sent[0]['data'] as Uint8Array).buffer.byteLength).toBe(4)
    expect(sent[1]).toBe('latest')
  })

  it('passes ccipRead false through and a block as a hex number', async () => {
    const fake = fakeOrivon({ call: { data: new Uint8Array(0), revert: null, offchainLookup: null } })
    await orivonChain(fake.orivon as never).call({ to: REGISTRAR }, 26357300, { ccipRead: false })
    expect(fake.calls[0]?.args).toEqual([{ to: REGISTRAR }, '0x1922e34', { ccipRead: false }])
  })

  it('gets logs for one address as a list, and refuses a wide range before asking', async () => {
    const log = { address: REGISTRAR, topics: [HASH], data: new Uint8Array(0), blockNumber: 5, transactionHash: HASH, logIndex: 0, removed: false }
    const fake = fakeOrivon({ getLogs: [log] })
    const chain = orivonChain(fake.orivon as never)
    expect(await chain.getLogs({ fromBlock: 10, toBlock: 10 + 1023, address: REGISTRAR, topics: [HASH, null] })).toEqual([log])
    expect(fake.calls[0]?.args).toEqual([{ fromBlock: '0xa', toBlock: '0x409', address: [REGISTRAR], topics: [HASH, null] }])
    expect(await reason(chain.getLogs({ fromBlock: 10, toBlock: 10 + 1024 }))).toBe('limit')
    expect(fake.calls).toHaveLength(1)
  })

  it('reads a block with its base fee as a bigint, by number or by hash', async () => {
    const fake = fakeOrivon({ getBlock: BLOCK })
    const chain = orivonChain(fake.orivon as never)
    expect(await chain.getBlock(100)).toMatchObject({ number: 100, baseFeePerGas: 10n, transactions: [HASH] })
    await chain.getBlock(HASH)
    expect(fake.calls.map((call) => call.args)).toEqual([['0x64'], [HASH]])
  })

  it('maps a gas estimate the host refuses to reverted, and the other codes to their reasons', async () => {
    const refusing = (code: string) => orivonChain(fakeOrivon({ estimateGas: () => { throw Object.assign(new Error(code), { code }) } }).orivon as never)
    expect(await reason(refusing('invalid').estimateGas({ to: REGISTRAR }))).toBe('reverted')
    for (const [code, expected] of [['denied', 'declined'], ['revoked', 'declined'], ['closed', 'declined'], ['timeout', 'timeout'], ['limit', 'limit'], ['unavailable', 'unavailable'], ['internal', 'unavailable'], ['reset', 'unavailable']]) {
      expect(fromOrivonError(Object.assign(new Error('x'), { code })).reason, code).toBe(expected)
    }
  })

  it('asks for the address alone, then for the signature and the broadcast only when an action needs them', async () => {
    const fake = fakeOrivon({ getAddresses: [ALICE], signMessage: new Uint8Array(65) })
    const chain = orivonChain(fake.orivon as never)
    expect(await chain.addresses()).toEqual([ALICE])
    expect(fake.uses).toEqual([{ codes: ['ETH_0_1'], groups: ['addresses'] }])
    expect(await chain.signMessage(new Uint8Array([1]))).toHaveLength(65)
    expect(fake.uses.at(-1)).toEqual({ codes: ['ETH_0_1'], groups: ['addresses', 'sign'] })
    expect(fake.uses.some((use) => use.codes.includes('ETH_NET_0_1'))).toBe(false)
  })
})

describe('orivonChain.sendTransaction', () => {
  const SIGNED = new Uint8Array([2, 0xc0, 0xff, 0xee])
  const SIGNED_HASH = '0x' + toHex(keccak256(SIGNED))
  const scripted = (extra: Record<string, unknown> = {}) => fakeOrivon({
    getAddresses: [ALICE], 'ETH_0_1.chainId': 1, getTransactionCount: 7, estimateGas: 100000, getBlock: BLOCK, maxPriorityFeePerGas: '0x3',
    signTransaction: SIGNED, sendRawTransaction: SIGNED_HASH, ...extra
  })

  it('fills the nonce, gas and fees, signs, broadcasts and answers the hash of the signed bytes', async () => {
    const fake = scripted()
    const hash = await orivonChain(fake.orivon as never).sendTransaction({ to: REGISTRAR, data: new Uint8Array([9]), value: 0n })
    expect(hash).toBe(SIGNED_HASH)
    expect(fake.uses).toEqual([{ codes: ['ETH_0_1', 'ETH_NET_0_1'], groups: ['addresses', 'sign', 'broadcast'] }, { codes: ['ETH_NET_0_1_READONLY'], groups: undefined }])
    const signed = fake.calls.find((call) => call.fn.endsWith('signTransaction'))?.args[0]
    expect(signed).toEqual({ from: ALICE, to: REGISTRAR, data: new Uint8Array([9]), value: '0x0', nonce: 7, gas: 120000, chainId: 1, maxFeePerGas: '0x17', maxPriorityFeePerGas: '0x3' })
    expect(fake.calls.at(-1)).toMatchObject({ fn: 'ETH_NET_0_1.sendRawTransaction', args: [SIGNED] })
  })

  it('keeps a gas limit, nonce and fees the caller chose', async () => {
    const fake = scripted()
    await orivonChain(fake.orivon as never).sendTransaction({ to: REGISTRAR, gas: 50000, nonce: 1, gasPrice: 9n })
    expect(fake.calls.find((call) => call.fn.endsWith('signTransaction'))?.args[0]).toMatchObject({ gas: 50000, nonce: 1, gasPrice: '0x9' })
    expect(fake.calls.some((call) => call.fn.endsWith('estimateGas') || call.fn.endsWith('getTransactionCount'))).toBe(false)
  })

  it('sends a gasPrice on a network without a base fee', async () => {
    const fake = scripted({ getBlock: { ...BLOCK, baseFeePerGas: null }, gasPrice: '0x5' })
    await orivonChain(fake.orivon as never).sendTransaction({ to: REGISTRAR })
    expect(fake.calls.find((call) => call.fn.endsWith('signTransaction'))?.args[0]).toMatchObject({ gasPrice: '0x5' })
  })

  it('says the outcome is unknown, with the hash, when the broadcast times out', async () => {
    const fake = scripted({ sendRawTransaction: () => { throw Object.assign(new Error('slow'), { code: 'timeout' }) } })
    const error = await orivonChain(fake.orivon as never).sendTransaction({ to: REGISTRAR }).catch((e: ChainError) => e)
    expect(error).toMatchObject({ reason: 'unknownOutcome', hash: SIGNED_HASH })
  })

  it('does not call a send that failed to start unknown, nor take another hash for its own', async () => {
    const down = scripted({ sendRawTransaction: () => { throw Object.assign(new Error('gone'), { code: 'unavailable' }) } })
    expect(await reason(orivonChain(down.orivon as never).sendTransaction({ to: REGISTRAR }))).toBe('unavailable')
    const wrong = scripted({ sendRawTransaction: HASH })
    expect(await reason(orivonChain(wrong.orivon as never).sendTransaction({ to: REGISTRAR }))).toBe('badAnswer')
    const refused = scripted({ sendRawTransaction: () => { throw Object.assign(new Error('nonce too low'), { code: 'invalid' }) } })
    expect(await reason(orivonChain(refused.orivon as never).sendTransaction({ to: REGISTRAR }))).toBe('invalid')
  })

  it('is declined, and reads nothing, when the person refuses the wallet', async () => {
    const fake = fakeOrivon({}, ['ETH_0_1', 'ETH_NET_0_1'])
    expect(await reason(orivonChain(fake.orivon as never).sendTransaction({ to: REGISTRAR }))).toBe('declined')
    expect(fake.calls).toEqual([])
  })
})

type Request = { method: string, params?: unknown[] }

function provider (answers: Record<string, unknown>) {
  const requests: Request[] = []
  return {
    requests,
    request: async (request: Request) => {
      requests.push(request)
      const answer = answers[request.method]
      if (answer instanceof Error) throw answer
      if (typeof answer === 'function') return (answer as (r: Request) => unknown)(request)
      if (answer === undefined) throw Object.assign(new Error('method not found'), { code: -32601 })
      return answer
    }
  }
}

const rpcError = (code: number, message: string, data?: unknown) => Object.assign(new Error(message), { code, data })

describe('eip1193Chain', () => {
  it('reads with the standard methods and parses their hex answers', async () => {
    const wallet = provider({
      eth_blockNumber: '0x1922e34', eth_chainId: '0x1', eth_getCode: '0x6080', eth_getTransactionCount: '0x7', eth_estimateGas: '0x5208',
      eth_gasPrice: '0x3b9aca00', eth_maxPriorityFeePerGas: '0x1', eth_getBlockByNumber: { ...BLOCK, number: '0x64', timestamp: '0x1', gasLimit: '0x2', gasUsed: '0x3', baseFeePerGas: '0xa' }
    })
    const chain = eip1193Chain(wallet)
    expect(await chain.blockNumber()).toBe(26357300)
    expect(await chain.chainId()).toBe(1)
    expect(await chain.getCode(REGISTRAR)).toEqual(new Uint8Array([0x60, 0x80]))
    expect(await chain.getTransactionCount(ALICE, 'latest')).toBe(7)
    expect(await chain.estimateGas({ to: REGISTRAR, value: 1n })).toBe(21000)
    expect(await chain.gasPrice()).toBe(1000000000n)
    expect(await chain.getBlock(100)).toMatchObject({ number: 100, baseFeePerGas: 10n })
    expect(wallet.requests.find((r) => r.method === 'eth_estimateGas')?.params).toEqual([{ to: REGISTRAR, value: '0x1' }, 'latest'])
    expect(wallet.requests.find((r) => r.method === 'eth_getBlockByNumber')?.params).toEqual(['0x64', false])
  })

  it('asks for a block by hash with the hash method', async () => {
    const wallet = provider({ eth_getBlockByHash: null })
    expect(await eip1193Chain(wallet).getBlock(HASH)).toBeNull()
    expect(wallet.requests[0]).toEqual({ method: 'eth_getBlockByHash', params: [HASH, false] })
  })

  it('answers a revert as an answer, and an off-chain lookup as one too', async () => {
    const revert = '0x08c379a0' + '00'.repeat(31) + '20' + '00'.repeat(31) + '02' + '6e6f' + '00'.repeat(30)
    const reverts = eip1193Chain(provider({ eth_call: () => { throw rpcError(3, 'execution reverted: no', revert) } }))
    expect((await reverts.call({ to: REGISTRAR })).revert?.length).toBe(100)
    const lookup = eip1193Chain(provider({ eth_call: () => { throw rpcError(3, 'execution reverted', '0x556f1830aabb') } }))
    expect(await lookup.call({ to: REGISTRAR })).toEqual({ data: null, revert: null, offchainLookup: new Uint8Array([0x55, 0x6f, 0x18, 0x30, 0xaa, 0xbb]) })
    const returns = eip1193Chain(provider({ eth_call: '0x01' }))
    expect(await returns.call({ to: REGISTRAR })).toEqual({ data: new Uint8Array([1]), revert: null, offchainLookup: null })
    const down = eip1193Chain(provider({ eth_call: () => { throw rpcError(-32603, 'internal') } }))
    expect(await reason(down.call({ to: REGISTRAR }))).toBe('unavailable')
  })

  it('reads logs with the same 1024-block rule as the Orivon chain', async () => {
    const wallet = provider({ eth_getLogs: [{ address: REGISTRAR, topics: [HASH], data: '0x', blockNumber: '0x5', transactionHash: HASH, logIndex: '0x0' }] })
    const chain = eip1193Chain(wallet)
    expect(await chain.getLogs({ fromBlock: 1, toBlock: 1024, address: [REGISTRAR] })).toHaveLength(1)
    expect(wallet.requests[0]?.params).toEqual([{ fromBlock: '0x1', toBlock: '0x400', address: [REGISTRAR] }])
    expect(await reason(chain.getLogs({ fromBlock: 1, toBlock: 1025 }))).toBe('limit')
  })

  it('maps a failed estimate to reverted and wallet codes to their reasons', async () => {
    const chain = eip1193Chain(provider({ eth_estimateGas: () => { throw rpcError(3, 'execution reverted: invalid label') } }))
    expect(await reason(chain.estimateGas({ to: REGISTRAR }))).toBe('reverted')
    for (const [code, expected] of [[4001, 'declined'], [4100, 'declined'], [4900, 'unavailable'], [-32005, 'limit'], [4200, 'invalid'], [-32000, 'invalid'], [-32603, 'unavailable']] as const) {
      expect(fromProviderError(rpcError(code, 'x')).reason, String(code)).toBe(expected)
    }
  })

  it('signs a message with personal_sign and answers v as 27 or 28', async () => {
    const signature = '0x' + '11'.repeat(64) + '01'
    const wallet = provider({ eth_requestAccounts: [ALICE], personal_sign: signature })
    const signed = await eip1193Chain(wallet).signMessage(new Uint8Array([0x68, 0x69]))
    expect(signed[64]).toBe(28)
    expect(wallet.requests.at(-1)).toEqual({ method: 'personal_sign', params: ['0x6869', ALICE] })
    const short = provider({ eth_requestAccounts: [ALICE], personal_sign: '0x1234' })
    expect(await reason(eip1193Chain(short).signMessage(new Uint8Array(1)))).toBe('badAnswer')
  })

  it('falls back to eth_accounts when eth_requestAccounts does not exist', async () => {
    const wallet = provider({ eth_accounts: [ALICE] })
    expect(await eip1193Chain(wallet).addresses()).toEqual([ALICE])
  })

  it('sends a transaction in one request and answers its hash, or declined', async () => {
    const wallet = provider({ eth_requestAccounts: [ALICE], eth_sendTransaction: HASH.toUpperCase().replace('0X', '0x') })
    const hash = await eip1193Chain(wallet).sendTransaction({ to: REGISTRAR, data: new Uint8Array([1, 2]), value: 16n })
    expect(hash).toBe(HASH)
    expect(wallet.requests.at(-1)).toEqual({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: REGISTRAR, data: '0x0102', value: '0x10' }] })
    const refusing = provider({ eth_requestAccounts: [ALICE], eth_sendTransaction: () => { throw rpcError(4001, 'User rejected') } })
    expect(await reason(eip1193Chain(refusing).sendTransaction({ to: REGISTRAR }))).toBe('declined')
  })

  it('reads a receipt, its status and logs', async () => {
    const wallet = provider({ eth_getTransactionReceipt: { transactionHash: HASH, blockHash: HASH, blockNumber: '0x5', status: '0x1', gasUsed: '0x10', effectiveGasPrice: '0x2', contractAddress: null, logs: [] } })
    expect(await eip1193Chain(wallet).getTransactionReceipt(HASH)).toMatchObject({ blockNumber: 5, status: 1, gasUsed: 16, effectiveGasPrice: 2n, contractAddress: null })
  })
})

describe('detectChain', () => {
  it('prefers orivon.use over the window.ethereum shim Orivon also installs, and says when there is neither', () => {
    expect(detectChain({ orivon: { use: async () => [] }, ethereum: { request: async () => null } }).kind).toBe('orivon')
    expect(detectChain({ ethereum: { request: async () => null } }).kind).toBe('eip1193')
    expect(() => detectChain({})).toThrow(ChainError)
    try {
      detectChain({})
    } catch (error) {
      expect((error as ChainError).reason).toBe('noWallet')
    }
  })
})
