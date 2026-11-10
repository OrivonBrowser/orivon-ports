import { afterAll, describe, expect, it, vi } from 'vitest'
import { encode, encodeCall, decodeRevert } from '../site/sdk/abi.js'
import { concat, toHex, utf8 } from '../site/sdk/bytes.js'
import { eip1193Chain } from '../site/sdk/chain-eip1193.js'
import { keccak256 } from '../site/sdk/keccak.js'
import { ADDRESSES, FIRST_BLOCK } from '../site/sdk/orivonid.js'
import { anvilRpc, FORK_BLOCK, startFork } from './support/anvil.ts'
import { rpcProvider } from './support/rpc-provider.ts'
import { freshAccount } from './support/sale.ts'

// The wallet-extension adapter against a real node: what a browser outside Orivon would do with window.ethereum.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 })
const fork = await startFork()
const reason = 'skip' in fork ? fork.skip : null
if (reason !== null) console.warn(`[fork tests skipped] ${reason}`)
afterAll(async () => { if (!('skip' in fork)) await fork.stop() })

const PRECOMPILE_ECRECOVER = '0x0000000000000000000000000000000000000001'

/** The EIP-191 digest a wallet signs for a message. */
function personalDigest (message: Uint8Array): Uint8Array {
  return keccak256(concat(utf8(`\x19Ethereum Signed Message:\n${message.length}`), message))
}

describe.skipIf(reason !== null)('the EIP-1193 adapter against a fork', () => {
  const url = 'skip' in fork ? '' : fork.url
  const chain = eip1193Chain(rpcProvider(url))
  const sender = freshAccount('chain-sender')
  const receiver = freshAccount('chain-receiver')

  it('reads the chain id, the head and the blocks by number, tag and hash', async () => {
    expect(await chain.chainId()).toBe(1)
    expect(await chain.blockNumber()).toBe(FORK_BLOCK)
    const byNumber = await chain.getBlock(FORK_BLOCK)
    expect(byNumber?.number).toBe(FORK_BLOCK)
    expect(typeof byNumber?.baseFeePerGas).toBe('bigint')
    expect(byNumber?.transactions.every((hash) => /^0x[0-9a-f]{64}$/.test(hash))).toBe(true)
    expect((await chain.getBlock(byNumber?.hash as string))?.number).toBe(FORK_BLOCK)
    expect((await chain.getBlock('latest'))?.number).toBe(FORK_BLOCK)
    expect(await chain.getBlock(FORK_BLOCK + 1000)).toBeNull()
  })

  it('reads code, and the nonce of an address that never sent', async () => {
    expect((await chain.getCode(ADDRESSES.r1)).length).toBeGreaterThan(0)
    expect((await chain.getCode(receiver)).length).toBe(0)
    expect(await chain.getTransactionCount(receiver)).toBe(0)
    expect(await chain.getTransactionReceipt('0x' + '11'.repeat(32))).toBeNull()
  })

  it('refuses a log range wider than 1024 blocks before asking the node, and answers one at the limit', async () => {
    await expect(chain.getLogs({ fromBlock: FIRST_BLOCK, toBlock: FIRST_BLOCK + 1024 })).rejects.toMatchObject({ reason: 'limit' })
    const logs = await chain.getLogs({ fromBlock: FIRST_BLOCK, toBlock: FIRST_BLOCK + 1023, address: ADDRESSES.r1 })
    expect(logs.length).toBeGreaterThan(0)
    expect(logs[0]?.data).toBeInstanceOf(Uint8Array)
    expect(logs.every((log) => log.blockNumber >= FIRST_BLOCK && log.blockNumber <= FIRST_BLOCK + 1023)).toBe(true)
  })

  it('answers the accounts, signs a message that recovers to the account, and gives v as 27 or 28', async () => {
    const accounts = await chain.addresses()
    expect(accounts.length).toBeGreaterThan(0)
    const message = utf8('Sign in to Orivon ID\nNonce: 7')
    const signature = await chain.signMessage(message)
    expect(signature).toHaveLength(65)
    expect([27, 28]).toContain(signature[64])
    const input = concat(personalDigest(message), new Uint8Array(31), Uint8Array.of(signature[64] as number), signature.subarray(0, 64))
    const recovered = await chain.call({ to: PRECOMPILE_ECRECOVER, data: input })
    expect('0x' + toHex((recovered.data as Uint8Array).subarray(12)).toLowerCase()).toBe((accounts[0] as string).toLowerCase())
  })

  it('sends a transaction, waits for the receipt, and the transfer arrives', async () => {
    await anvilRpc(url, 'anvil_impersonateAccount', [sender])
    await anvilRpc(url, 'anvil_setBalance', [sender, '0x' + (10n ** 18n).toString(16)])
    expect(await chain.estimateGas({ from: sender, to: receiver, value: 1n })).toBe(21_000)
    expect(typeof await chain.gasPrice()).toBe('bigint')
    expect(typeof await chain.maxPriorityFeePerGas()).toBe('bigint')
    const hash = await chain.sendTransaction({ from: sender, to: receiver, value: 12_345n })
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
    const receipt = await chain.waitForReceipt(hash, { intervalMs: 50 })
    expect(receipt.status).toBe(1)
    expect(receipt.gasUsed).toBe(21_000)
    expect(await anvilRpc(url, 'eth_getBalance', [receiver, 'latest'])).toBe('0x' + (12_345).toString(16))
    expect(await chain.getTransactionCount(sender)).toBe(1)
  })

  it('answers a revert as data from call, as `reverted` from estimateGas, and as a failed receipt when sent anyway', async () => {
    const data = encodeCall('register(string,address,address,bytes32)', ['Not A Label', sender, sender, new Uint8Array(32)])
    const result = await chain.call({ from: sender, to: ADDRESSES.registrar, data })
    expect(result.data).toBeNull()
    expect(result.revert).not.toBeNull()
    expect(decodeRevert(result.revert as Uint8Array).kind).not.toBe('empty')
    await expect(chain.estimateGas({ from: sender, to: ADDRESSES.registrar, data })).rejects.toMatchObject({ reason: 'reverted' })
    const hash = await chain.sendTransaction({ from: sender, to: ADDRESSES.registrar, data, gas: 300_000 })
    expect((await chain.waitForReceipt(hash, { intervalMs: 50 })).status).toBe(0)
  })

  it('answers a normal call as data, with the arguments the registrar expects', async () => {
    const data = encodeCall('isValidLabel(string)', ['alice'])
    const result = await chain.call({ to: ADDRESSES.registrar, data })
    expect(result.revert).toBeNull()
    expect(toHex(result.data as Uint8Array)).toBe(toHex(encode(['bool'], [true])))
  })
})
