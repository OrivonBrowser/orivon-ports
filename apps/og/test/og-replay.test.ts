import { describe, expect, it } from 'vitest'
import { CENSUS_FORMAT, censusEntryOf, type Census } from '../site/resolver/og-census.js'
import { evaluateFreshness } from '../site/resolver/og-freshness.js'
import { keyOf } from '../site/resolver/og-name.js'
import { resolveOg } from '../site/resolver/og-names.js'
import { slotAddress } from '../site/resolver/og-answer.js'
import { CENSUS_KEYS, IMPLEMENTATION, REGISTRY_CONTENT, SOURCE, TEXT_KEYS, UPGRADES } from '../site/resolver/og-pins.js'
import { readName } from '../site/resolver/og-state.js'
import { createSession } from '../site/resolver/og-tail.js'
import { cutCensus } from '../tools/cut-census.mjs'
import { fakeChain, FIRST_BLOCK, nameLogs, pinnedUpgradeLogs, worldOf } from './support/og-world.ts'
import { VECTORS, type Vector } from './support/og-vectors.ts'

const SPREAD = 300
const ZERO_WORD = `0x${'0'.repeat(64)}`
/** A cut is made after the proxy's last upgrade, the block the pinned list ends at. */
const CUT_BLOCK = 26_401_000
const TYPE = Object.fromEntries(TEXT_KEYS.map(([key, type]) => [key, type]))

/** A census cut before the first log of any name: nothing is known, so the tail is the name's whole history. */
const before = (vector: Vector): Census => ({ format: CENSUS_FORMAT, block: (vector.first ?? FIRST_BLOCK) - 1_000, blockHash: `0x${'00'.repeat(32)}`, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names: {} })
/** A vector's world: a name whose logs lie past the registry slot's floor keeps them there, close together. */
const worldFor = (vector: Vector, head?: number) => worldOf(vector, { spread: vector.spread ?? SPREAD, ...(vector.first === undefined ? {} : { first: vector.first }), ...(head === undefined ? {} : { head }) })

/** What a name that passes answers: the content records that count, in the order the answer lists them, and the registry slot's record after them. */
function expected (vector: Vector, block: number) {
  const records: { type: string | undefined, value: string | undefined | null }[] = TEXT_KEYS.filter(([key]) => vector.records.includes(key)).map(([key]) => ({ type: TYPE[key], value: vector.state.values[key] }))
  const slot = vector.records.includes(REGISTRY_CONTENT) ? slotAddress(vector.state.registryContent ?? '') : null
  if (slot !== null && !records.some((one) => one.value === slot)) records.push({ type: 'ipfs', value: slot })
  return { ownerDefault: null, records, provenance: { by: SOURCE, proven: false, block } }
}

describe('every vector answers as the freshness rule keeps it, whichever of the history is in the bundle', () => {
  it.each(VECTORS.map((vector) => [vector.id, vector] as const))('%s: all of it read from the node', async (_id, vector) => {
    const world = worldFor(vector)
    const { chain } = fakeChain(world)
    const answer = await resolveOg(chain, `${vector.label}.og`, { session: createSession(), census: before(vector) })
    expect(answer).toEqual(expected(vector, world.head))
  })

  it.each(VECTORS.map((vector) => [vector.id, vector] as const))('%s: all of it in the bundle, nothing read from the node', async (_id, vector) => {
    const world = worldFor(vector, CUT_BLOCK)
    world.logs.push(...pinnedUpgradeLogs())
    const census = await cutCensus(fakeChain(world, { maxSpan: Infinity }).chain, { block: world.head }) as Census
    const { chain, asked } = fakeChain(world)
    const answer = await resolveOg(chain, `${vector.label}.og`, { session: createSession(), census })
    expect(answer).toEqual(expected(vector, world.head))
    expect(asked.logs).toEqual([])
  })

  it('has twenty-eight names, twelve of them live ones', () => {
    expect(VECTORS).toHaveLength(28)
    expect(VECTORS.filter((vector) => vector.id.endsWith('-mainnet'))).toHaveLength(12)
  })
})

describe('the rule gives each key of each vector the reason the vector says', () => {
  it.each(VECTORS.map((vector) => [vector.id, vector] as const))('%s', async (_id, vector) => {
    const world = worldFor(vector)
    const key = keyOf(vector.label)
    const reads = await readName(fakeChain(world).chain, key, world.head, CENSUS_KEYS)
    const verdict = evaluateFreshness(key, reads, nameLogs(world, vector.label))
    for (const [name, reason] of Object.entries(vector.reasons)) expect(verdict.keys[name]?.reason, name).toBe(reason)
    if (vector.registry !== undefined) expect({ counts: verdict.registry.counts, reason: verdict.registry.reason }, 'the registry slot').toEqual(vector.registry)
    expect(verdict.records.filter((name) => name !== 'contentcontract').sort()).toEqual([...vector.records].sort())
  })

  it('has an entry in the census only for a name with a content value, in a text key or in the registry\'s slot', async () => {
    const withEntry = []
    for (const vector of VECTORS) {
      const world = worldFor(vector)
      const key = keyOf(vector.label)
      const reads = await readName(fakeChain(world).chain, key, world.head, CENSUS_KEYS)
      if (censusEntryOf(key, reads, nameLogs(world, vector.label)) !== null) withEntry.push(vector.label)
    }
    const holdsValue = (vector: Vector) => Object.keys(vector.state.values).some((name) => CENSUS_KEYS.includes(name)) || (vector.state.registryContent ?? ZERO_WORD) !== ZERO_WORD
    expect(withEntry.sort()).toEqual(VECTORS.filter(holdsValue).map((vector) => vector.label).sort())
  })
})
