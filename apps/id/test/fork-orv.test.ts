import { afterAll, describe, expect, it, vi } from 'vitest'
import { fromHex } from '../site/sdk/bytes.js'
import type { Chain } from '../site/sdk/chain.js'
import { eip1193Chain } from '../site/sdk/chain-eip1193.js'
import { dnsEncode } from '../site/sdk/ens.js'
import { ADDRESSES, labelId } from '../site/sdk/orivonid.js'
import { resolveOrv } from '../site/resolver/orv-names.js'
import { FORK_BLOCK, startFork } from './support/anvil.ts'
import { rpcProvider } from './support/rpc-provider.ts'
import { buyName, freshAccount, fund, send, setRecords, type Sale } from './support/sale.ts'

// A `.orv` name bought for real from the deployed registrar on a mainnet fork, given records by its owner, and
// resolved by the page's own code through the fork's registry and the owner's own PermissionedResolver. Needs anvil
// and a public node that keeps state at the block; skips otherwise.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })
const fork = await startFork()
const reason = 'skip' in fork ? fork.skip : null
if (reason !== null) console.warn(`[fork tests skipped] ${reason}`)
afterAll(async () => { if (!('skip' in fork)) await fork.stop() })

const LABEL = 'orv-alice'
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const IPFS_HASH = 'e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f'
const IPFS_ADDRESS = 'ipfs://bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4'
const ROLE_SET_RESOLVER = 1n << 24n
const EMPTY = { ownerDefault: null, records: [] }

describe.skipIf(reason !== null)(`.orv names on a mainnet fork at block ${FORK_BLOCK}`, () => {
  const url = 'skip' in fork ? '' : fork.url
  const node = eip1193Chain(rpcProvider(url))
  const asked: string[] = []
  const chain = { ...node, call: async (...args: Parameters<Chain['call']>) => {
    asked.push((args[0].to ?? '').toLowerCase())
    return await node.call(...args)
  } } as Chain
  const state: { buyer: string, other: string, sale?: Sale } = { buyer: freshAccount('orv-buyer'), other: freshAccount('orv-other') }
  const sale = () => state.sale as Sale

  it('finds nothing for a name nobody holds', async () => {
    expect(await resolveOrv(chain, 'nobody-home.orv')).toMatchObject(EMPTY)
    expect(await resolveOrv(chain, `${LABEL}.orv`)).toMatchObject(EMPTY)
  })

  it('finds no records for a name just bought, whose resolver holds none', async () => {
    await fund(url, node, state.buyer, 100n * 10n ** 18n)
    state.sale = await buyName(url, node, LABEL, state.buyer)
    expect(await resolveOrv(chain, `${LABEL}.orv`)).toMatchObject(EMPTY)
  })

  it('answers the contenthash as the default and the content records after it, once the owner has set them', async () => {
    await setRecords(node, sale(), {
      contenthash: fromHex(IPFS_HASH),
      texts: { 'content.ipfs': `ipfs://${CID}`, 'content.https': 'https://example.org/orv', 'content.ddoc': `sha256:${'0f'.repeat(32)}`, 'url': 'https://example.org/', 'content.bzz': 'not a reference' }
    })
    asked.length = 0
    const answer = await resolveOrv(chain, `${LABEL}.orv`)
    expect(answer.ownerDefault).toEqual({ type: 'ipfs', value: IPFS_ADDRESS })
    expect(answer.records).toEqual([
      { type: 'ipfs', value: `ipfs://${CID}` }, { type: 'https', value: 'https://example.org/orv' }, { type: 'ddoc', value: `sha256:${'0f'.repeat(32)}` }
    ])
    expect(answer.provenance).toEqual({ by: 'Orivon ID', proven: false, block: await node.blockNumber() })
  })

  it('reads the registry and the owner\'s resolver only, never a Universal Resolver, and answers the same in any case', async () => {
    asked.length = 0
    const answer = await resolveOrv(chain, `${LABEL.toUpperCase()}.ORV.`)
    expect(answer.ownerDefault?.value).toBe(IPFS_ADDRESS)
    expect(new Set(asked)).toEqual(new Set([ADDRESSES.r1.toLowerCase(), sale().resolver.toLowerCase()]))
  })

  it('answers a name below it from the owner\'s resolver, which takes any name under the label (ENSIP-10)', async () => {
    expect(await resolveOrv(chain, `docs.${LABEL}.orv`)).toMatchObject(EMPTY)
    await send(node, state.buyer, sale().resolver, 'setText(bytes,string,string)', [dnsEncode(`docs.${LABEL}.v1.orivonid.eth`), 'content.https', 'https://example.org/docs'])
    expect((await resolveOrv(chain, `docs.${LABEL}.orv`)).records).toEqual([{ type: 'https', value: 'https://example.org/docs' }])
    expect((await resolveOrv(chain, `${LABEL}.orv`)).records.map((record) => record.value)).not.toContain('https://example.org/docs')
  })

  it('stops answering while someone else holds a role on the name, and answers again when it is taken back', async () => {
    const id = labelId(LABEL)
    await send(node, state.buyer, ADDRESSES.r1, 'grantRoles(uint256,uint256,address)', [id, ROLE_SET_RESOLVER, state.other])
    asked.length = 0
    expect(await resolveOrv(chain, `${LABEL}.orv`)).toMatchObject(EMPTY)
    expect(asked).not.toContain(sale().resolver.toLowerCase())
    await send(node, state.buyer, ADDRESSES.r1, 'revokeRoles(uint256,uint256,address)', [id, ROLE_SET_RESOLVER, state.other])
    expect((await resolveOrv(chain, `${LABEL}.orv`)).ownerDefault?.value).toBe(IPFS_ADDRESS)
  })

  it('finds nothing for a label the registrar would not sell, without asking the chain', async () => {
    asked.length = 0
    expect(await resolveOrv(chain, 'ab.orv')).toMatchObject(EMPTY)
    expect(await resolveOrv(chain, 'xn--abc.orv')).toMatchObject(EMPTY)
    expect(asked).toEqual([])
  })

  it('finds nothing for a reserved label the Safe holds', async () => {
    expect(await resolveOrv(chain, 'orivon.orv')).toMatchObject(EMPTY)
    expect(await resolveOrv(chain, 'orv.orv')).toMatchObject(EMPTY)
  })
})
