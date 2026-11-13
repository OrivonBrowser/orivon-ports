import { describe, expect, it } from 'vitest'
import { CENSUS_FORMAT, censusEntryOf, type Census } from '../site/resolver/og-census.js'
import { evaluateFreshness } from '../site/resolver/og-freshness.js'
import { keyOf } from '../site/resolver/og-name.js'
import { resolveOg } from '../site/resolver/og-names.js'
import { CENSUS_KEYS, IMPLEMENTATION, SOURCE, TEXT_KEYS, UPGRADES } from '../site/resolver/og-pins.js'
import { readName } from '../site/resolver/og-state.js'
import { createSession } from '../site/resolver/og-tail.js'
import { cutCensus } from '../tools/cut-census.mjs'
import { fakeChain, FIRST_BLOCK, nameLogs, pinnedUpgradeLogs, worldOf } from './support/og-world.ts'
import { VECTORS, type Vector } from './support/og-vectors.ts'

const SPREAD = 300
/** A cut is made after the proxy's last upgrade, the block the pinned list ends at. */
const CUT_BLOCK = 26_401_000
const TYPE = Object.fromEntries(TEXT_KEYS.map(([key, type]) => [key, type]))

/** A census cut before the first log of any name: nothing is known, so the tail is the name's whole history. */
const before = (): Census => ({ format: CENSUS_FORMAT, block: FIRST_BLOCK - 1_000, blockHash: `0x${'00'.repeat(32)}`, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names: {} })

/** What a name that passes answers: the content records that count, in the order the answer lists them. */
function expected (vector: Vector, block: number) {
  const records = TEXT_KEYS.filter(([key]) => vector.records.includes(key)).map(([key]) => ({ type: TYPE[key], value: vector.state.values[key] }))
  return { ownerDefault: null, records, provenance: { by: SOURCE, proven: false, block } }
}

describe('every vector answers as the freshness rule keeps it, whichever of the history is in the bundle', () => {
  it.each(VECTORS.map((vector) => [vector.id, vector] as const))('%s: all of it read from the node', async (_id, vector) => {
    const world = worldOf(vector, { spread: SPREAD })
    const { chain } = fakeChain(world)
    const answer = await resolveOg(chain, `${vector.label}.og`, { session: createSession(), census: before() })
    expect(answer).toEqual(expected(vector, world.head))
  })

  it.each(VECTORS.map((vector) => [vector.id, vector] as const))('%s: all of it in the bundle, nothing read from the node', async (_id, vector) => {
    const world = worldOf(vector, { spread: SPREAD, head: CUT_BLOCK })
    world.logs.push(...pinnedUpgradeLogs())
    const census = await cutCensus(fakeChain(world, { maxSpan: Infinity }).chain, { block: world.head }) as Census
    const { chain, asked } = fakeChain(world)
    const answer = await resolveOg(chain, `${vector.label}.og`, { session: createSession(), census })
    expect(answer).toEqual(expected(vector, world.head))
    expect(asked.logs).toEqual([])
  })

  it('has twenty names, nine of them live ones', () => {
    expect(VECTORS).toHaveLength(20)
    expect(VECTORS.filter((vector) => vector.id.endsWith('-mainnet'))).toHaveLength(9)
  })
})

describe('the rule gives each key of each vector the reason the vector says', () => {
  it.each(VECTORS.map((vector) => [vector.id, vector] as const))('%s', async (_id, vector) => {
    const world = worldOf(vector, { spread: SPREAD })
    const key = keyOf(vector.label)
    const reads = await readName(fakeChain(world).chain, key, world.head, CENSUS_KEYS)
    const verdict = evaluateFreshness(key, reads, nameLogs(world, vector.label))
    for (const [name, reason] of Object.entries(vector.reasons)) expect(verdict.keys[name]?.reason, name).toBe(reason)
    expect(verdict.records.filter((name) => name !== 'contentcontract').sort()).toEqual([...vector.records].sort())
  })

  it('has an entry in the census only for a name with a content value', async () => {
    const withEntry = []
    for (const vector of VECTORS) {
      const world = worldOf(vector, { spread: SPREAD })
      const key = keyOf(vector.label)
      const reads = await readName(fakeChain(world).chain, key, world.head, CENSUS_KEYS)
      if (censusEntryOf(key, reads, nameLogs(world, vector.label)) !== null) withEntry.push(vector.label)
    }
    expect(withEntry.sort()).toEqual(VECTORS.filter((vector) => Object.keys(vector.state.values).some((name) => CENSUS_KEYS.includes(name))).map((vector) => vector.label).sort())
  })
})
