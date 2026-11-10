// The Chain of `fake-registry.ts` with what the `.orv` resolver also reads: subregistries below R1 (each a table of
// labels), a resolver that answers a multicall, and a log of every call so a test can say which contracts were asked,
// at which block, and what a resolver was asked for. Reads of R1 and of per-name resolvers are the table's.

import { decode, encode, encodeCall, selector, ZERO_ADDRESS } from '../../site/sdk/abi.js'
import { toHex } from '../../site/sdk/bytes.js'
import type { Chain } from '../../site/sdk/chain.js'
import { ADDRESSES } from '../../site/sdk/orivonid.js'
import { fakeRegistry, type World } from './fake-registry.ts'

export interface RegistryTable { [label: string]: { resolver?: string, subregistry?: string } }
export interface OrvWorld extends World {
  /** The labels of each subregistry, by its lower-case address. R1's own subregistries are the table of `ADDRESSES.r1`. */
  registries?: Record<string, RegistryTable>
  /** Whether resolvers take `resolve(name, multicall(calls))`. Default true. */
  multicall?: boolean
}
export interface CallRecord { to: string, selector: string, data: Uint8Array, block: unknown }

const SEL = {
  getSubregistry: toHex(selector('getSubregistry(string)')),
  getResolver: toHex(selector('getResolver(string)')),
  resolve: toHex(selector('resolve(bytes,bytes)')),
  multicall: toHex(selector('multicall(bytes[])'))
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
const revertEmpty = { data: null, revert: new Uint8Array(0), offchainLookup: null }

export function fakeOrv (world: OrvWorld, head = 26357300) {
  const base = fakeRegistry(world, [], head)
  const calls: CallRecord[] = []
  const tableOf = (address: string): RegistryTable | undefined => {
    const key = Object.keys(world.registries ?? {}).find((one) => same(one, address))
    return key === undefined ? undefined : world.registries?.[key]
  }
  const answerAddress = (address: string | undefined) => ({ data: encode(['address'], [address ?? ZERO_ADDRESS]), revert: null, offchainLookup: null })

  async function call(tx: { to?: string, data?: Uint8Array }, block?: unknown): Promise<{ data: Uint8Array | null, revert: Uint8Array | null, offchainLookup: Uint8Array | null }> {
    const to = tx.to ?? ''
    const data = tx.data ?? new Uint8Array(0)
    const sel = toHex(data.subarray(0, 4))
    calls.push({ to, selector: sel, data, block })
    const registry = tableOf(to)
    if (registry !== undefined && (sel === SEL.getSubregistry || sel === SEL.getResolver)) {
      const [label] = decode(['string'], data.subarray(4)) as [string]
      if (sel === SEL.getSubregistry) return answerAddress(registry[label]?.subregistry)
      if (!same(to, ADDRESSES.r1)) return answerAddress(registry[label]?.resolver)
    }
    if (sel === SEL.resolve) {
      const [name, inner] = decode(['bytes', 'bytes'], data.subarray(4)) as [Uint8Array, Uint8Array]
      if (toHex(inner.subarray(0, 4)) === SEL.multicall) {
        if (world.multicall === false) return revertEmpty
        const [items] = decode(['bytes[]'], inner.subarray(4)) as [Uint8Array[]]
        const results: Uint8Array[] = []
        for (const item of items) {
          const one = await base.chain.call({ to, data: encodeCall('resolve(bytes,bytes)', [name, item]) })
          results.push(one.data === null ? one.revert ?? new Uint8Array(0) : decode(['bytes'], one.data)[0] as Uint8Array)
        }
        return { data: encode(['bytes'], [encode(['bytes[]'], [results])]), revert: null, offchainLookup: null }
      }
    }
    return await base.chain.call({ to, data })
  }

  const chain = { ...base.chain, call } as unknown as Chain
  return { chain, world, calls }
}
