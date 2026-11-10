import { afterAll, describe, expect, it, vi } from 'vitest'
import { encodeCall } from '../site/sdk/abi.js'
import { eip1193Chain } from '../site/sdk/chain-eip1193.js'
import { attribution, ownerOf, records } from '../site/sdk/orivonid.js'
import { createRegistration } from '../site/register-flow.js'
import { registerTx } from '../site/register-tx.js'
import { walletBroadcaster } from '../site/register-send.js'
import { anvilRpc, FORK_BLOCK, startFork } from './support/anvil.ts'
import { memoryStore } from './support/flow-harness.ts'
import { rpcProvider } from './support/rpc-provider.ts'
import { daiBalance, freshAccount, fund, mineSeconds } from './support/sale.ts'

// The whole registration, through the state machine, against the deployed registrar on a mainnet fork. Needs anvil and a
// public node that keeps state at the pinned block; skips otherwise. Accounts are derived and impersonated.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 })
const fork = await startFork()
const reason = 'skip' in fork ? fork.skip : null
if (reason !== null) console.warn(`[fork tests skipped] ${reason}`)
afterAll(async () => { if (!('skip' in fork)) await fork.stop() })

const DAI = 10n ** 18n
const BENEFICIARY = '0x0C8B0442753E888B6261Bc94a02CEFEd4c56b90c'
const STEPS = ['commit', 'approve', 'deploy', 'register', 'records']

describe.skipIf(reason !== null)(`a registration on a mainnet fork at block ${FORK_BLOCK}`, () => {
  const url = 'skip' in fork ? '' : fork.url
  const chain = eip1193Chain(rpcProvider(url))
  const gas: Record<string, number> = {}

  function flowFor(store = memoryStore()) {
    const states: Record<string, any>[] = []
    const flow = createRegistration({
      chain, store, broadcaster: walletBroadcaster(chain), pollMs: 30_000, pendingTimeoutMs: 120_000,
      clock: { now: () => Date.now(), sleep: async (ms) => { await mineSeconds(url, Math.ceil(ms / 1000)) } },
      onState: (state) => { states.push(state) }
    })
    return { flow, states, store, phases: () => states.map((state) => String(state['phase'])).filter((phase, index, all) => phase !== all[index - 1]) }
  }

  async function register(account: string, label: string, expectSteps: string[]) {
    const { flow, states, phases } = flowFor()
    const ready = await flow.check(label, account)
    expect(ready['phase'], JSON.stringify(ready, (_, value) => typeof value === 'bigint' ? String(value) : value)).toBe('ready')
    const done = await flow.start({ texts: { url: 'https://forkreg.example' } })
    expect(done['phase'], String(done['reason'])).toBe('done')
    const hashes = done['hashes'] as Record<string, string>
    expect(Object.keys(hashes).sort()).toEqual([...expectSteps].sort())
    for (const [step, hash] of Object.entries(hashes)) {
      const receipt = await chain.getTransactionReceipt(hash)
      expect(receipt?.status, step).toBe(1)
      gas[step] = receipt?.gasUsed ?? 0
    }
    return { ready, done, states, phases }
  }

  it('buys a five-letter name from first look to attribution, with every transaction mined once', async () => {
    const buyer = freshAccount('fork-register-buyer')
    await fund(url, chain, buyer, 100n * DAI)
    const payee = await daiBalance(chain, BENEFICIARY)
    const { ready, phases } = await register(buyer, 'forkreg', STEPS)
    expect(ready).toMatchObject({ price: 10n * DAI, resolverMode: 'deploy', receiver: 'account', needs: { approve: true, deployResolver: true } })
    expect(phases()).toEqual(['checking', 'ready', 'committing', 'maturing', 'revealing', 'recording', 'verifying', 'done'])
    expect(await daiBalance(chain, buyer)).toBe(90n * DAI)
    expect(await daiBalance(chain, BENEFICIARY)).toBe(payee + 10n * DAI)
    expect(await ownerOf(chain, 'forkreg')).toBe(buyer)
    expect((await attribution(chain, 'forkreg', buyer)).ok).toBe(true)
    expect(await records(chain, 'forkreg', ['url'])).toMatchObject({ addr: buyer, texts: { url: 'https://forkreg.example' } })
    console.log('gas used per step on the fork:', JSON.stringify(gas))
  })

  it('reuses the account\'s resolver for a second name and deploys nothing', async () => {
    const buyer = freshAccount('fork-register-reuse')
    await fund(url, chain, buyer, 100n * DAI)
    const first = await register(buyer, 'forkreuse1', STEPS)
    const resolver = first.ready['resolver']
    const second = flowFor()
    const ready = await second.flow.check('forkreuse2', buyer)
    expect(ready).toMatchObject({ phase: 'ready', resolver, resolverMode: 'reuse', needs: { approve: true, deployResolver: false }, transactions: ['commit', 'approve', 'register', 'records'] })
    const done = await second.flow.start()
    expect(done['phase']).toBe('done')
    expect(Object.keys(done['hashes'] as object).sort()).toEqual(['approve', 'commit', 'records', 'register'])
    expect(done['resolver']).toBe(resolver)
    for (const label of ['forkreuse1', 'forkreuse2']) {
      expect((await attribution(chain, label, buyer)).forward).toMatchObject({ ok: true, resolver, address: buyer })
    }
  })

  it('stops a 7702-delegated account at the preflight, in words, before anything is sent', async () => {
    const account = freshAccount('fork-register-delegated')
    await fund(url, chain, account, 100n * DAI)
    await anvilRpc(url, 'anvil_setCode', [account, '0xef0100' + '6B175474E89094C44Da98b954EedeAC495271d0F'.toLowerCase()])
    const { flow } = flowFor()
    const nonceBefore = await chain.getTransactionCount(account)
    const state = await flow.check('forkdelegated', account)
    expect(state).toMatchObject({ phase: 'failed', reason: 'receiverRefuses', recover: 'none', during: 'checking' })
    expect(String(state['detail'])).toContain('delegates to code')
    expect(String(state['words'])).toContain('does not accept the name token')
    expect(await chain.getTransactionCount(account)).toBe(nonceBefore)
    await expect(flow.start()).rejects.toThrow('check the name first')
  })

  it('shows the preflight is right: the registrar does revert the sale to that account', async () => {
    const account = freshAccount('fork-register-delegated-sale')
    await fund(url, chain, account, 100n * DAI)
    await anvilRpc(url, 'anvil_setCode', [account, '0xef0100' + '6B175474E89094C44Da98b954EedeAC495271d0F'.toLowerCase()])
    const secret = new Uint8Array(32).fill(9)
    const resolver = '0x0000000000000000000000000000000000000000'
    const commitment = await import('../site/register-tx.js').then((m) => m.makeCommitment('forkdelegatedsale', account, resolver, secret))
    const send = async (to: string, data: Uint8Array) => await chain.waitForReceipt(await chain.sendTransaction({ from: account, to, data, gas: 400_000 }), { intervalMs: 20 })
    await send('0x27264C6AE4ec65fD14C0FB55C2Dc71eAa8956Cb4', encodeCall('commit(bytes32)', [commitment]))
    await send('0x6B175474E89094C44Da98b954EedeAC495271d0F', encodeCall('approve(address,uint256)', ['0x27264C6AE4ec65fD14C0FB55C2Dc71eAa8956Cb4', 10n * DAI]))
    await mineSeconds(url, 61)
    const sale = registerTx('forkdelegatedsale', account, resolver, secret)
    await expect(chain.estimateGas({ from: account, to: sale.to, data: sale.data })).rejects.toMatchObject({ reason: 'reverted' })
  })

  it('lets a delegated account through when what it delegates to accepts the name token, and completes', async () => {
    const account = freshAccount('fork-register-accepting')
    await fund(url, chain, account, 100n * DAI)
    const delegate = freshAccount('fork-register-accepting-code')
    const answerHook = '0x7ff23a6e6100000000000000000000000000000000000000000000000000000000' + '5f526020' + '5ff3'
    await anvilRpc(url, 'anvil_setCode', [delegate, answerHook])
    await anvilRpc(url, 'anvil_setCode', [account, '0xef0100' + delegate.slice(2).toLowerCase()])
    const done = await register(account, 'forkaccepting', STEPS)
    expect(done.ready).toMatchObject({ receiver: 'accepts' })
    expect(await ownerOf(chain, 'forkaccepting')).toBe(account)
  })
})
