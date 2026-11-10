import { afterAll, describe, expect, it, vi } from 'vitest'
import { toHex, utf8 } from '../site/sdk/bytes.js'
import { eip1193Chain } from '../site/sdk/chain-eip1193.js'
import { createRegistration } from '../site/register-flow.js'
import { REGISTER_GAS_LIMIT } from '../site/register-tx.js'
import { anvilRpc, FORK_BLOCK, startFork } from './support/anvil.ts'
import { memoryStore } from './support/flow-harness.ts'
import { rpcProvider } from './support/rpc-provider.ts'
import { freshAccount, fund, mineSeconds } from './support/sale.ts'

// The fixed gas limit of a private reveal, against the deployed registrar on a mainnet fork. A reveal is never
// simulated when it goes to the relay, so the limit must hold for the most it can cost: the longest label, a resolver
// that already exists, and a contract wallet's receiver hook. Needs anvil and a public node; skips otherwise.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 })
const fork = await startFork()
const reason = 'skip' in fork ? fork.skip : null
if (reason !== null) console.warn(`[fork tests skipped] ${reason}`)
afterAll(async () => { if (!('skip' in fork)) await fork.stop() })

const DAI = 10n ** 18n
/** A label of the longest length the registrar sells, 63 bytes, unlike any other this file buys. */
const longest = (tag: string) => tag + 'x'.repeat(63 - tag.length)
const HEADROOM = 1.25
const REVEAL = '787c7cf2'

describe.skipIf(reason !== null)(`the private reveal's gas limit on a mainnet fork at block ${FORK_BLOCK}`, () => {
  const url = 'skip' in fork ? '' : fork.url
  const chain = eip1193Chain(rpcProvider(url))

  /** Signs and sends as a wallet does, through the flow's private path, and records the limit the flow asked for the reveal. */
  function privateFlow() {
    const limits: number[] = []
    const estimated: string[] = []
    const watching = {
      ...chain,
      estimateGas: async (...args: Parameters<typeof chain.estimateGas>) => {
        estimated.push(toHex(args[0].data?.subarray(0, 4) ?? new Uint8Array(0)))
        return await chain.estimateGas(...args)
      }
    }
    const broadcaster = {
      async prepare(tx: { from: string, to: string, data: Uint8Array, gas: number }) {
        if (toHex(tx.data.subarray(0, 4)) === REVEAL) limits.push(tx.gas)
        return { hash: null, send: async () => await chain.sendTransaction(tx) }
      }
    }
    const flow = createRegistration({
      chain: watching, broadcaster, store: memoryStore(), pollMs: 30_000, pendingTimeoutMs: 120_000,
      clock: { now: () => Date.now(), sleep: async (ms) => { await mineSeconds(url, Math.ceil(ms / 1000)) } }
    })
    return { flow, limits, estimated }
  }

  async function revealed(account: string, label: string, name: string) {
    const { flow, limits, estimated } = privateFlow()
    const ready = await flow.check(label, account)
    expect(ready['phase'], name).toBe('ready')
    const done = await flow.start({ private: true })
    expect(done['phase'], `${name}: ${String(done['reason'])} ${String(done['detail'])}`).toBe('done')
    const receipt = await chain.getTransactionReceipt((done['hashes'] as Record<string, string>)['register'] as string)
    expect(receipt?.status, name).toBe(1)
    const gas = receipt?.gasUsed ?? 0
    console.log(`reveal gas on the fork, ${name}: ${gas} used, limit ${REGISTER_GAS_LIMIT}`)
    expect(limits, name).toEqual([REGISTER_GAS_LIMIT])
    expect(estimated, name).not.toContain(REVEAL)
    expect(gas * HEADROOM, name).toBeLessThanOrEqual(REGISTER_GAS_LIMIT)
    return { gas, ready }
  }

  it('holds for the longest label (63 bytes) with a resolver deployed for it', async () => {
    expect(utf8(longest('forkgas-a')).length).toBe(63)
    const buyer = freshAccount('fork-gas-longest')
    await fund(url, chain, buyer, 100n * DAI)
    expect((await revealed(buyer, longest('forkgas-a'), 'longest label, new resolver')).ready).toMatchObject({ resolverMode: 'deploy' })
  })

  it('holds for the longest label with a resolver the account already has', async () => {
    const buyer = freshAccount('fork-gas-reuse')
    await fund(url, chain, buyer, 100n * DAI)
    await revealed(buyer, 'forkgas-first', 'a first name')
    expect((await revealed(buyer, longest('forkgas-b'), 'longest label, reused resolver')).ready).toMatchObject({ resolverMode: 'reuse' })
  })

  it('holds for a 3-letter label, the dearest and the one the switch is advised for', async () => {
    const buyer = freshAccount('fork-gas-three')
    await fund(url, chain, buyer, 1000n * DAI)
    await revealed(buyer, 'zq9', '3-letter label')
  })

  it('holds for a delegated account whose code answers the receiver hook', async () => {
    const account = freshAccount('fork-gas-delegated')
    await fund(url, chain, account, 100n * DAI)
    const delegate = freshAccount('fork-gas-delegated-code')
    await anvilRpc(url, 'anvil_setCode', [delegate, '0x7ff23a6e6100000000000000000000000000000000000000000000000000000000' + '5f526020' + '5ff3'])
    await anvilRpc(url, 'anvil_setCode', [account, '0xef0100' + delegate.slice(2).toLowerCase()])
    await revealed(account, 'forkgasdelegated', 'delegated account')
  })

})
