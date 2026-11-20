import { describe, expect, it } from 'vitest'
import { callQueue, orivonChain } from '../site/sdk/chain-orivon.js'
import { eip1193Chain } from '../site/sdk/chain-eip1193.js'
import { fakeOrivon } from './support/fake-orivon.ts'

const HASH = `0x${'ab'.repeat(32)}`
const FROM = `0x${'11'.repeat(20)}`
const TO = `0x${'22'.repeat(20)}`

const wire = (overrides: Record<string, unknown> = {}) => ({
  hash: HASH, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: 26_409_829, from: FROM, to: TO, nonce: 3, value: '0x0', gas: 90_000, gasPrice: null,
  maxFeePerGas: null, maxPriorityFeePerGas: null, input: Uint8Array.of(0xc3, 0xd0, 0x14, 0xd6), type: 2, ...overrides
})

const orivonWith = (answer: unknown) => {
  const fake = fakeOrivon({ getTransaction: answer })
  return { chain: orivonChain(fake.orivon as never, { queue: callQueue({ burst: 1e6, perSecond: 1e6 }) }), fake }
}

describe('getTransaction over orivon.use', () => {
  it('asks ETH_NET_0_1_READONLY for the hash and keeps what the resolver reads: the hash, the block, the sender, the recipient and the input', async () => {
    const { chain, fake } = orivonWith(wire())
    expect(await chain.getTransaction(HASH)).toEqual({ hash: HASH, blockNumber: 26_409_829, from: FROM, to: TO, input: Uint8Array.of(0xc3, 0xd0, 0x14, 0xd6) })
    expect(fake.calls).toEqual([{ fn: 'ETH_NET_0_1_READONLY.getTransaction', args: [HASH] }])
  })

  it('answers null for a hash the node does not know, a creation with no recipient and a transaction not yet mined', async () => {
    expect(await orivonWith(null).chain.getTransaction(HASH)).toBeNull()
    expect(await orivonWith(wire({ to: null, blockNumber: null })).chain.getTransaction(HASH)).toMatchObject({ to: null, blockNumber: null })
  })

  it('does not read a transaction the node answers for another hash, or one whose input is not bytes', async () => {
    await expect(orivonWith(wire({ hash: `0x${'ef'.repeat(32)}` })).chain.getTransaction(HASH)).rejects.toMatchObject({ reason: 'badAnswer' })
    await expect(orivonWith(wire({ input: '0xc3d014d6' })).chain.getTransaction(HASH)).rejects.toMatchObject({ reason: 'badAnswer' })
  })

  it('takes a hash in either case', async () => {
    expect(await orivonWith(wire({ hash: HASH.toUpperCase().replace('0X', '0x') })).chain.getTransaction(HASH)).not.toBeNull()
  })
})

describe('getTransaction over an EIP-1193 provider', () => {
  const providerWith = (answer: unknown) => {
    const seen: { method: string, params?: unknown[] }[] = []
    const chain = eip1193Chain({ request: async (args) => { seen.push(args); return answer } })
    return { chain, seen }
  }

  it('asks eth_getTransactionByHash and reads the quantities and the input as the page does', async () => {
    const { chain, seen } = providerWith({ hash: HASH, blockNumber: '0x19331e5', from: FROM, to: TO, input: '0xc3d014d6' })
    expect(await chain.getTransaction(HASH)).toEqual({ hash: HASH, blockNumber: 26_423_781, from: FROM, to: TO, input: Uint8Array.of(0xc3, 0xd0, 0x14, 0xd6) })
    expect(seen).toEqual([{ method: 'eth_getTransactionByHash', params: [HASH] }])
  })

  it('answers null for a hash the node does not know, a creation and a pending transaction', async () => {
    expect(await providerWith(null).chain.getTransaction(HASH)).toBeNull()
    expect(await providerWith({ hash: HASH, blockNumber: null, from: FROM, to: null, input: '0x' }).chain.getTransaction(HASH)).toMatchObject({ blockNumber: null, to: null, input: new Uint8Array(0) })
  })

  it('does not read a transaction the node answers for another hash, or an input that is not hexadecimal', async () => {
    await expect(providerWith({ hash: `0x${'ef'.repeat(32)}`, blockNumber: '0x1', from: FROM, to: TO, input: '0x' }).chain.getTransaction(HASH)).rejects.toMatchObject({ reason: 'badAnswer' })
    await expect(providerWith({ hash: HASH, blockNumber: '0x1', from: FROM, to: TO, input: 'c3d0' }).chain.getTransaction(HASH)).rejects.toMatchObject({ reason: 'badAnswer' })
  })
})
