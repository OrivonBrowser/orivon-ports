// The nonce of a new transaction. Orivon's ETH_NET_0_1 answers the count of mined transactions (`latest`) and
// refuses `pending`, so a transaction still waiting is known only from what this page broadcast itself.

import { describe, expect, it } from 'vitest'
import { toChecksumAddress } from '../site/sdk/abi.js'
import { toHex } from '../site/sdk/bytes.js'
import { ChainError } from '../site/sdk/chain.js'
import { orivonChain } from '../site/sdk/chain-orivon.js'
import { keccak256 } from '../site/sdk/keccak.js'
import { orivonBroadcaster } from '../site/register-send.js'
import { RelayError } from '../site/relay.js'

const ALICE = toChecksumAddress('0x' + 'a1'.repeat(20))
const BOB = toChecksumAddress('0x' + 'b0'.repeat(20))
const TX = { from: ALICE, to: ALICE, data: new Uint8Array(4), gas: 50_000 }
const PLAIN = { from: ALICE, to: ALICE, data: new Uint8Array(4), gas: 21_000 }
const hashOf = (raw: Uint8Array) => '0x' + toHex(keccak256(raw))

/** An Orivon whose node counts only what has been mined: `mined[address]` moves when a test says so. */
function world(options: { sendFails?: () => Error | null } = {}) {
  const asked: string[] = []
  const signed: { from: string, nonce: number }[] = []
  const mined: Record<string, number> = { [ALICE.toLowerCase()]: 5, [BOB.toLowerCase()]: 0 }
  const reads = {
    chainId: async () => 1,
    getTransactionCount: async (address: string, tag: string) => {
      asked.push(tag)
      return mined[address.toLowerCase()] ?? 0
    },
    getBlock: async () => ({ number: 1, hash: '0x' + '00'.repeat(32), parentHash: '0x' + '00'.repeat(32), timestamp: 1, gasLimit: 1, gasUsed: 0, miner: ALICE, transactions: [], baseFeePerGas: '0x1' }),
    maxPriorityFeePerGas: async () => '0x1',
    estimateGas: async () => 21_000
  }
  const eth = {
    chainId: async () => 1,
    getAddresses: async () => [ALICE],
    signTransaction: async (tx: { from: string, nonce: number }) => { signed.push({ from: tx.from, nonce: tx.nonce }); return Uint8Array.of(1, 2, 3, signed.length) }
  }
  const net = {
    sendRawTransaction: async (raw: Uint8Array) => {
      const failure = options.sendFails?.() ?? null
      if (failure !== null) throw failure
      return hashOf(raw)
    }
  }
  const orivon = { use: async (codes: string[]) => codes.map((code) => code === 'ETH_NET_0_1_READONLY' ? reads : code === 'ETH_0_1' ? eth : net) }
  const relay = { send: async (raw: Uint8Array) => hashOf(raw) }
  return { orivon: orivon as never, asked, mined, relay, nonces: () => signed.map((one) => one.nonce) }
}

describe('L2: the nonce of a second send while the first is pending', () => {
  it('goes one past the first when the node has not mined it, and follows the node once it has', async () => {
    const { orivon, asked, nonces, mined, relay } = world()
    const broadcaster = orivonBroadcaster({ orivon, chain: orivonChain(orivon), relay })
    await (await broadcaster.prepare(TX)).send({ private: false })
    await (await broadcaster.prepare(TX)).send({ private: false })
    await broadcaster.prepare(TX)
    expect(nonces()).toEqual([5, 6, 7])
    mined[ALICE.toLowerCase()] = 8
    await broadcaster.prepare(TX)
    expect(nonces()).toEqual([5, 6, 7, 8])
    expect(asked.every((tag) => tag === 'latest')).toBe(true)
  })

  it('does the same in the Chain\'s own sendTransaction', async () => {
    const { orivon, nonces } = world()
    const chain = orivonChain(orivon)
    await chain.sendTransaction(PLAIN)
    await chain.sendTransaction(PLAIN)
    expect(nonces()).toEqual([5, 6])
  })

  it('counts a send by either sender, since both are this page\'s', async () => {
    const { orivon, nonces, relay } = world()
    const chain = orivonChain(orivon)
    const broadcaster = orivonBroadcaster({ orivon, chain, relay })
    await (await broadcaster.prepare(TX)).send({ private: false })
    await chain.sendTransaction(PLAIN)
    await broadcaster.prepare(TX)
    expect(nonces()).toEqual([5, 6, 7])
  })

  it('follows the node when other transactions of the account were mined meanwhile', async () => {
    const { orivon, nonces, mined } = world()
    const chain = orivonChain(orivon)
    await chain.sendTransaction(PLAIN)
    mined[ALICE.toLowerCase()] = 9
    await chain.sendTransaction(PLAIN)
    expect(nonces()).toEqual([5, 9])
  })

  it('keeps each account\'s own count, whatever the case of its address', async () => {
    const { orivon, nonces } = world()
    const chain = orivonChain(orivon)
    await chain.sendTransaction(PLAIN)
    await chain.sendTransaction({ ...PLAIN, from: BOB })
    await chain.sendTransaction({ ...PLAIN, from: ALICE.toLowerCase() })
    expect(nonces()).toEqual([5, 0, 6])
  })

  it('counts a private reveal that reached the relay, or may have, and not one the relay refused', async () => {
    const { orivon, nonces, relay } = world()
    const chain = orivonChain(orivon)
    const refusing = { send: async () => { throw new RelayError('rejected', 'nonce too low') } }
    const unsure = { send: async () => { throw new RelayError('timeout', 'no answer', { maybeSent: true }) } }
    await (await orivonBroadcaster({ orivon, chain, relay: refusing }).prepare(TX)).send({ private: true }).catch(() => undefined)
    await orivonBroadcaster({ orivon, chain, relay }).prepare(TX)
    await (await orivonBroadcaster({ orivon, chain, relay: unsure }).prepare(TX)).send({ private: true }).catch(() => undefined)
    await orivonBroadcaster({ orivon, chain, relay }).prepare(TX)
    expect(nonces()).toEqual([5, 5, 5, 6])
  })

  it('does not count a transaction that was signed and never sent, or one the node refused', async () => {
    const failure: { now: Error | null } = { now: null }
    const { orivon, nonces, relay } = world({ sendFails: () => failure.now })
    const broadcaster = orivonBroadcaster({ orivon, chain: orivonChain(orivon), relay })
    await broadcaster.prepare(TX)
    failure.now = new ChainError('declined', 'refused')
    await expect((await broadcaster.prepare(TX)).send({ private: false })).rejects.toThrow('refused')
    await broadcaster.prepare(TX)
    expect(nonces()).toEqual([5, 5, 5])
  })

  it('counts a broadcast that timed out, which may have gone out', async () => {
    const failure: { now: Error | null } = { now: Object.assign(new Error('slow'), { code: 'timeout' }) }
    const { orivon, nonces, relay } = world({ sendFails: () => failure.now })
    const broadcaster = orivonBroadcaster({ orivon, chain: orivonChain(orivon), relay })
    await expect((await broadcaster.prepare(TX)).send({ private: false })).rejects.toMatchObject({ reason: 'unknownOutcome' })
    failure.now = null
    await broadcaster.prepare(TX)
    expect(nonces()).toEqual([5, 6])
  })

  it('starts from the node\'s count in a new page, which has an `orivon` of its own', async () => {
    const page = world()
    await orivonChain(page.orivon).sendTransaction(PLAIN)
    const reloaded = world()
    await orivonChain(reloaded.orivon).sendTransaction(PLAIN)
    expect([page.nonces(), reloaded.nonces()]).toEqual([[5], [5]])
  })

  it('never asks the node for `pending`, which ETH_NET_0_1 refuses', async () => {
    const { orivon, asked, relay } = world()
    const chain = orivonChain(orivon)
    await chain.sendTransaction(PLAIN)
    await orivonBroadcaster({ orivon, chain, relay }).prepare(TX)
    expect(asked).toEqual(['latest', 'latest'])
    await expect(chain.getTransactionCount(ALICE, 'pending')).rejects.toMatchObject({ reason: 'invalid' })
    expect(asked).toEqual(['latest', 'latest'])
  })
})
