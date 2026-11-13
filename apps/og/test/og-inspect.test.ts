import { describe, expect, it } from 'vitest'
import { toChecksumAddress, ZERO_ADDRESS } from '../site/sdk/abi.js'
import { CENSUS_FORMAT, type Census } from '../site/resolver/og-census.js'
import { keyOf, labelProblem } from '../site/resolver/og-name.js'
import { inspectOg, resolveOg } from '../site/resolver/og-names.js'
import { IMPLEMENTATION, UPGRADES } from '../site/resolver/og-pins.js'
import { createSession, OgRefusal } from '../site/resolver/og-tail.js'
import { fakeChain, FIRST_BLOCK, worldOf, type World } from './support/og-world.ts'
import { VECTORS } from './support/og-vectors.ts'

const vector = (id: string) => VECTORS.find((one) => one.id === id)!
const CHECKPOINT = FIRST_BLOCK - 1_000
const census = (): Census => ({ format: CENSUS_FORMAT, block: CHECKPOINT, blockHash: `0x${'00'.repeat(32)}`, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names: {} })
const inspect = (world: World, label: string, options: Parameters<typeof inspectOg>[3] = {}) => inspectOg(fakeChain(world).chain, label, { session: createSession(), census: census() }, options)

describe('labelProblem', () => {
  it('is null for a name Orivon opens', () => {
    for (const text of ['harbor', 'a', 'a-b', 'abc123', 'x'.repeat(32)]) expect(labelProblem(text), text).toBeNull()
  })
  it('says which part of the rule a name breaks', () => {
    expect(labelProblem('')).toEqual({ reason: 'empty' })
    expect(labelProblem('sub.harbor')).toMatchObject({ reason: 'dot' })
    expect(labelProblem('x'.repeat(33))).toMatchObject({ reason: 'tooLong', bytes: 33 })
    expect(labelProblem('Harbor')).toMatchObject({ reason: 'notNormal', normalized: 'harbor' })
    expect(labelProblem('a b')).toMatchObject({ reason: 'invalid' })
  })
  it('agrees with parseOgName about every name', async () => {
    const { parseOgName } = await import('../site/resolver/og-name.js')
    for (const text of ['harbor', 'Harbor', 'a.b', 'x'.repeat(40), 'ab c', 'é']) {
      expect(labelProblem(text) === null, text).toBe(parseOgName(`${text}.og`) !== null)
    }
  })
})

describe('inspectOg', () => {
  it('gives the reason behind each record, as the resolver\'s freshness rule decides it', async () => {
    for (const id of ['unwrapped-passes', 'unwrapped-sellers-leftover', 'wrapped-controller-not-holder', 'new-controller-after-record', 'stranded-in-wrapper']) {
      const one = vector(id)
      const found = await inspect(worldOf(one, { spread: 300 }), one.label)
      expect(found.refusal, id).toBeNull()
      expect(found.verdict?.records, id).toEqual(one.records)
      for (const [key, reason] of Object.entries(one.reasons)) expect(found.verdict?.keys[key]?.reason, `${id} ${key}`).toBe(reason)
    }
  })

  it('answers what resolveOg answers for the same name', async () => {
    const one = vector('unwrapped-passes')
    const world = worldOf(one, { spread: 300 })
    const answer = await resolveOg(fakeChain(world).chain, `${one.label}.og`, { session: createSession(), census: census() })
    const found = await inspect(world, one.label)
    expect(answer.records.map((record) => record.value)).toEqual(found.verdict?.records.map((key) => found.reads.values[key]))
  })

  it('finds a name that is not there, with nothing to vouch for', async () => {
    const free = vector('free-label')
    const found = await inspect(worldOf(free, { spread: 300 }), free.label)
    expect(found.holder).toMatchObject({ found: false, holder: null })
    expect(found.verdict).toBeNull()
    expect(found.refusal).toBeNull()
  })

  it('shows what a previous holder left on a name that is free again', async () => {
    const world = worldOf(vector('free-label'), { spread: 300 })
    const label = 'harbor'
    world.names[label] = {
      registryOwner: ZERO_ADDRESS, nameToId: '0', idToName: `0x${'0'.repeat(64)}`, ownerOf: null, controller: toChecksumAddress(`0x${'ee'.repeat(20)}`),
      values: { 'content.ipfs': 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }
    }
    const found = await inspect(world, label)
    expect(found.holder.found).toBe(false)
    expect(found.reads.controller).toBe(toChecksumAddress(`0x${'ee'.repeat(20)}`))
    expect(found.reads.values['content.ipfs']).toMatch(/^ipfs:/)
    expect(found.key).toBe(keyOf(label))
  })

  it('keeps a refusal as a refusal instead of throwing it, and resolveOg still throws it', async () => {
    const one = vector('unwrapped-passes')
    const world = worldOf(one, { spread: 300 })
    world.implementation = `0x${'cd'.repeat(20)}`
    const found = await inspect(world, one.label)
    expect(found.refusal).toBeInstanceOf(OgRefusal)
    expect(found.verdict).toBeNull()
    await expect(resolveOg(fakeChain(world).chain, `${one.label}.og`, { session: createSession(), census: census() })).rejects.toBeInstanceOf(OgRefusal)
  })

  it('reads the latest block when asked, and the safe one otherwise', async () => {
    const one = vector('unwrapped-passes')
    const world = worldOf(one, { spread: 300, safe: FIRST_BLOCK + 10 })
    expect((await inspect(world, one.label)).block).toBeLessThan(world.head)
    expect((await inspect(world, one.label, { latest: true })).block).toBe(world.head)
  })
})
