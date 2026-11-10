import { afterAll, describe, expect, it, vi } from 'vitest'
import { encodeCall } from '../site/sdk/abi.js'
import { eip1193Chain } from '../site/sdk/chain-eip1193.js'
import {
  ADDRESSES, attribution, FIRST_BLOCK, isValidLabel, labelId, namesOf, ownerOf, price, readContract, records, RESERVED, REORG_MARGIN, salesStatus
} from '../site/sdk/orivonid.js'
import { FORK_BLOCK, startFork } from './support/anvil.ts'
import { LABEL_CASES } from './support/labels.ts'
import { rpcProvider } from './support/rpc-provider.ts'
import { buyName, daiBalance, freshAccount, fund, setRecords } from './support/sale.ts'

// The pinned block comes after the registry's setup and before any sale, so the reserved names and the open
// sale are what the chain says. Needs anvil and a public node that keeps state at that block; skips otherwise.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 })
const fork = await startFork()
const reason = 'skip' in fork ? fork.skip : null
if (reason !== null) console.warn(`[fork tests skipped] ${reason}`)
afterAll(async () => { if (!('skip' in fork)) await fork.stop() })

const BENEFICIARY = '0x0C8B0442753E888B6261Bc94a02CEFEd4c56b90c'

describe.skipIf(reason !== null)(`on a mainnet fork at block ${FORK_BLOCK}`, () => {
  const url = 'skip' in fork ? '' : fork.url
  const chain = eip1193Chain(rpcProvider(url))
  const registrar = (signature: string, args: unknown[], output: string) => readContract(chain, ADDRESSES.registrar, signature, args, [output]).then((out) => out[0])

  it('starts at the pinned block of Ethereum mainnet', async () => {
    expect(await chain.blockNumber()).toBe(FORK_BLOCK)
    expect(await chain.chainId()).toBe(1)
  })

  it('has an isValidLabel that agrees with the deployed registrar on every case of the table', async () => {
    const answers = await Promise.all(LABEL_CASES.map(async ([label]) => await registrar('isValidLabel(string)', [label], 'bool')))
    LABEL_CASES.forEach(([label, valid], index) => {
      expect(answers[index], JSON.stringify(label)).toBe(valid)
      expect(isValidLabel(label), JSON.stringify(label)).toBe(answers[index])
    })
  })

  it('has a price that agrees with the deployed registrar for labels of every length that matters', async () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 10, 63, 64]) {
      const label = 'a'.repeat(length)
      expect(price(label), `${length} letters`).toBe(await registrar('price(string)', [label], 'uint256'))
    }
  })

  it('reads the live sale: DAI above the floor, the payee, and the pointers to v1', async () => {
    expect(await salesStatus(chain)).toEqual({
      open: true, daiAboveFloor: true, daiRevert: null, beneficiary: BENEFICIARY, beneficiaryRevert: null, reachable: { ethToR0: true, r0ToR1: true }
    })
  })

  it('shows the Safe holding every reserved label on R1, and nobody holding an ordinary one', async () => {
    for (const label of RESERVED) expect(await ownerOf(chain, label), label).toBe(ADDRESSES.safe)
    expect(await ownerOf(chain, 'alice')).toBeNull()
  })

  it('reports the reserved label orivon as the Safe\'s on clauses (a) and (b) and failing (c): it has no resolver', async () => {
    const found = await attribution(chain, 'orivon', ADDRESSES.safe)
    expect(found.owner).toEqual({ ok: true, owner: ADDRESSES.safe })
    expect(found.roles.ok).toBe(true)
    expect(found.roles.roleCount).toBe(found.roles.roles)
    expect(found.forward).toEqual({ ok: false, resolver: null, address: null, problem: 'noResolver' })
    expect(found.ok).toBe(false)
    expect((await attribution(chain, 'orivon', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).owner.ok).toBe(false)
  })

  it('lists the reserved labels as the Safe\'s names, none of them usable to sign in', async () => {
    const found = await namesOf(chain, ADDRESSES.safe)
    expect(found.coverage, 'the scan of the registry read every range').toMatchObject({ failed: false, complete: true })
    expect(found.names.map((name) => name.label).sort()).toEqual([...RESERVED].sort())
    expect(found.names.every((name) => !name.attribution.ok && name.attribution.owner.ok && name.attribution.roles.ok)).toBe(true)
    expect(found.cache.lastBlock).toBe(FORK_BLOCK - REORG_MARGIN)
    expect(found.cache.held).toHaveLength(RESERVED.length)
    expect(found.cache.labels[(labelId('orivon') >> 32n).toString(16).padStart(56, '0')]).toBe('orivon')
    expect(FIRST_BLOCK).toBeLessThan(FORK_BLOCK)
  })

  it('lists no names for an address that holds none', async () => {
    expect((await namesOf(chain, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).names).toEqual([])
  })

  it('answers records as empty for a label with no resolver, a reserved label, and a label nobody holds', async () => {
    for (const label of ['orivon', 'alice']) {
      expect(await records(chain, label, ['url', 'avatar']), label).toEqual({ resolver: null, addr: null, texts: { url: null, avatar: null }, contenthash: null, failed: [] })
    }
  })
})

describe.skipIf(reason !== null)('a sale, from the reveal to the records, then a transfer', () => {
  const url = 'skip' in fork ? '' : fork.url
  const chain = eip1193Chain(rpcProvider(url))
  const LABEL = 'sale-test'
  const state: { buyer: string, other: string, sale?: Awaited<ReturnType<typeof buyName>>, beneficiaryBefore?: bigint } = { buyer: '', other: '' }

  it('has a buyer with DAI, and a name nobody holds yet', async () => {
    state.buyer = freshAccount('buyer')
    state.other = freshAccount('other')
    await fund(url, chain, state.buyer, 100n * 10n ** 18n)
    state.beneficiaryBefore = await daiBalance(chain, BENEFICIARY)
    expect(await ownerOf(chain, LABEL)).toBeNull()
    expect((await attribution(chain, LABEL, state.buyer)).ok).toBe(false)
  })

  it('sells the name for its price, to the payee, with the buyer\'s own resolver', async () => {
    const sale = await buyName(url, chain, LABEL, state.buyer)
    state.sale = sale
    expect(sale.price).toBe(price(LABEL))
    expect(await daiBalance(chain, state.buyer)).toBe(100n * 10n ** 18n - sale.price)
    expect(await daiBalance(chain, BENEFICIARY)).toBe((state.beneficiaryBefore ?? 0n) + sale.price)
    expect(await ownerOf(chain, LABEL)).toBe(state.buyer)
  })

  it('does not attribute the name until it resolves to the buyer', async () => {
    const found = await attribution(chain, LABEL, state.buyer)
    expect(found.owner.ok).toBe(true)
    expect(found.roles.ok).toBe(true)
    expect(found.forward).toEqual({ ok: false, resolver: state.sale?.resolver, address: null, problem: 'noAddress' })
    expect(found.ok).toBe(false)
  })

  it('attributes the name once the address record is set, and reads the rest of the records', async () => {
    const sale = state.sale as NonNullable<typeof state.sale>
    await setRecords(chain, sale, { texts: { url: 'https://example.org', 'eth.orivonstack.id.not-before': '1700000000' }, contenthash: new Uint8Array([0xe5, 0x01, 0x72, 0x00]) })
    const found = await attribution(chain, LABEL, state.buyer)
    expect(found.ok).toBe(true)
    expect(found.forward).toEqual({ ok: true, resolver: sale.resolver, address: state.buyer, problem: null })
    expect(await records(chain, LABEL, ['url', 'eth.orivonstack.id.not-before', 'avatar'])).toEqual({
      resolver: sale.resolver, addr: state.buyer, failed: [], contenthash: new Uint8Array([0xe5, 0x01, 0x72, 0x00]),
      texts: { url: 'https://example.org', 'eth.orivonstack.id.not-before': '1700000000', avatar: null }
    })
    expect((await attribution(chain, LABEL, state.other)).ok).toBe(false)
  })

  it('finds the name for the buyer, and a second look scans only the blocks since the first', async () => {
    const first = await namesOf(chain, state.buyer)
    expect(first.names.map((name) => [name.label, name.attribution.ok])).toEqual([[LABEL, true]])
    const queries: [number, number][] = []
    const watched = { ...chain, getLogs: async (filter: Parameters<typeof chain.getLogs>[0]) => { queries.push([Number(filter.fromBlock), Number(filter.toBlock)]); return await chain.getLogs(filter) } }
    const second = await namesOf(watched, state.buyer, { cache: first.cache })
    expect(second.names.map((name) => name.label)).toEqual([LABEL])
    expect(queries.every(([from]) => from === first.cache.lastBlock + 1)).toBe(true)
    expect(queries.length).toBe(3)
  })

  it('stops attributing the name to the buyer once it is sent away, and lists it for its new holder as not theirs to sign with', async () => {
    const sale = state.sale as NonNullable<typeof state.sale>
    const [tokenId] = await readContract(chain, ADDRESSES.r1, 'getTokenId(uint256)', [labelId(LABEL)], ['uint256'])
    const hash = await chain.sendTransaction({ from: sale.buyer, to: ADDRESSES.r1, data: encodeCall('safeTransferFrom(address,address,uint256,uint256,bytes)', [sale.buyer, state.other, tokenId, 1n, '0x']) })
    expect((await chain.waitForReceipt(hash, { intervalMs: 50 })).status).toBe(1)
    expect(await ownerOf(chain, LABEL)).toBe(state.other)
    const before = await attribution(chain, LABEL, sale.buyer)
    expect(before.owner.ok).toBe(false)
    expect(before.ok).toBe(false)
    const after = await attribution(chain, LABEL, state.other)
    expect(after.owner.ok).toBe(true)
    expect(after.forward).toMatchObject({ ok: false, address: sale.buyer, problem: 'differentAddress' })
    expect(after.ok).toBe(false)
    expect((await namesOf(chain, sale.buyer)).names).toEqual([])
    expect((await namesOf(chain, state.other)).names.map((name) => [name.label, name.attribution.ok])).toEqual([[LABEL, false]])
  })
})
