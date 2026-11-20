import { describe, expect, it } from 'vitest'
import { IMPLEMENTATION, REGISTRY_CONTENT, REGISTRY_CONTENT_FLOOR, TOPICS, UPGRADES } from '../site/resolver/og-pins.js'
import { agreeingChain, NodesDisagree, rpcChain } from '../tools/rpc-chain.mjs'
import { censusText, cutCensus, pagedLogs, slotLabels } from '../tools/cut-census.mjs'
import { fakeChain, pinnedUpgradeLogs, transactionHashOf, upgradedLog, worldOf, type World } from './support/og-world.ts'
import { VECTORS } from './support/og-vectors.ts'

const ZERO_WORD = `0x${'0'.repeat(64)}`

/**
 * Every vector's name in one world, at the blocks the chain gave them, with the proxy's upgrades as the chain logged them. A name whose
 * logs must lie past the registry slot's floor is placed there, each a block apart from the others so no two logs share a place.
 */
function everyone (): World {
  const worlds = VECTORS.map((vector, index) => worldOf(vector, vector.first === undefined ? {} : { spread: vector.spread ?? 100, first: vector.first + index }))
  const world = worlds[0]!
  for (const other of worlds.slice(1)) {
    Object.assign(world.names, other.names)
    world.logs.push(...other.logs)
  }
  world.logs.push(...pinnedUpgradeLogs())
  world.head = world.safe = 26_401_000
  return world
}
const cut = async (world: World, options: { maxSpan?: number } = {}) => await cutCensus(fakeChain(world, { maxSpan: options.maxSpan ?? Infinity }).chain, { block: world.head })

describe('the census tool', () => {
  it('lists the names that have a SetTextRecord log and a content value, each with the rule\'s verdict at the block', async () => {
    const census = await cut(everyone())
    const listed = Object.keys(census.names)
    const withValue = VECTORS.filter((vector) => Object.keys(vector.state.values).length > 0 && vector.logs.some(([place, , , topics]) => place === 'proxy' && topics[0] === TOPICS.setTextRecord))
    const withText = withValue.filter((vector) => Object.keys(vector.state.values).some((key) => key.startsWith('content')))
    // A value in the registry's slot lists a name too, when the registry logged a change of the name past the floor.
    const withSlot = VECTORS.filter((vector) => vector.first !== undefined && (vector.state.registryContent ?? ZERO_WORD) !== ZERO_WORD)
    expect(listed.sort()).toEqual([...new Set([...withText, ...withSlot].map((vector) => vector.label))].sort())
    for (const vector of VECTORS) {
      const entry = census.names[vector.label]
      if (entry === undefined) continue
      for (const [key, reason] of Object.entries(vector.reasons)) expect(entry.keys[key]?.reason, `${vector.id} ${key}`).toBe(reason)
      for (const key of vector.records.filter((one) => one !== REGISTRY_CONTENT)) expect(entry.keys[key]?.counts, `${vector.id} ${key}`).toBe(true)
      if (vector.registry !== undefined) expect({ counts: entry.registry?.counts, reason: entry.registry?.reason }, `${vector.id} the registry slot`).toEqual(vector.registry)
      expect(entry.registry?.value ?? null, `${vector.id} the slot's value`).toBe((vector.state.registryContent ?? ZERO_WORD) === ZERO_WORD ? null : vector.state.registryContent)
    }
  })

  it('writes the same bytes each time it cuts the same block, names in order', async () => {
    const world = everyone()
    const first = censusText(await cut(world))
    expect(censusText(await cut(world))).toBe(first)
    expect(first.endsWith('}\n')).toBe(true)
    const names = Object.keys(JSON.parse(first).names)
    expect(names).toEqual([...names].sort())
  })

  it('records the block, its hash and the upgrades of the proxy up to it', async () => {
    const census = await cut(everyone())
    expect(census).toMatchObject({ format: 2, block: 26_401_000, implementation: IMPLEMENTATION })
    expect(census.blockHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(census.upgrades).toEqual(UPGRADES.map((upgrade) => ({ ...upgrade, implementation: upgrade.implementation.toLowerCase() })))
  })

  it('reads a range a node refuses in halves, and gets the same census', async () => {
    const world = everyone()
    const whole = censusText(await cut(world))
    const made = fakeChain(world, { maxSpan: 700_000 })
    expect(censusText(await cutCensus(made.chain, { block: world.head }))).toBe(whole)
    expect(made.asked.logs.length).toBeGreaterThan(10)
  })

  it('stops when a node refuses even the narrowest range', async () => {
    const chain = fakeChain(everyone(), { maxSpan: 100 }).chain
    await expect(pagedLogs(chain, { address: [], topics: [], from: 1, to: 1_000_000 })).rejects.toMatchObject({ reason: 'limit' })
  })

  it('refuses to cut when the proxy does not run the implementation the resolver is built for', async () => {
    const world = everyone()
    world.implementation = `0x${'cd'.repeat(20)}`
    await expect(cut(world)).rejects.toThrow(/not the implementation this resolver is built for/)
  })

  it('refuses to cut when the last upgrade logged names other code, though the slot holds the right one', async () => {
    const world = everyone()
    world.logs.push(upgradedLog(20_000_000, `0x${'cd'.repeat(20)}`))
    await expect(cut(world)).rejects.toThrow(/proxy logged an upgrade at block 20000000/)
  })

  it('refuses to cut after the proxy was pointed at other code and back before the block, though the last upgrade and the slot are right', async () => {
    const world = everyone()
    world.logs.push(upgradedLog(20_000_000, `0x${'cd'.repeat(20)}`), upgradedLog(20_000_002, IMPLEMENTATION))
    await expect(cut(world)).rejects.toThrow(/proxy logged an upgrade at block 20000000/)
  })

  it('refuses to cut when a node leaves out an upgrade of the pinned list, or lists one the pin does not', async () => {
    const left = everyone()
    left.logs = left.logs.filter((log) => log.blockNumber !== UPGRADES[1]!.block)
    await expect(cut(left)).rejects.toThrow(/upgrade at block 15847254 is missing/)
    const other = everyone()
    other.logs = other.logs.map((log) => log.blockNumber === UPGRADES[2]!.block ? upgradedLog(log.blockNumber, `0x${'cd'.repeat(20)}`, log.logIndex) : log)
    await expect(cut(other)).rejects.toThrow(/upgrade at block 16006600 is not the one the pin lists/)
    const none = everyone()
    none.logs = none.logs.filter((log) => log.topics[0] !== TOPICS.upgraded)
    await expect(cut(none)).rejects.toThrow(/upgrade at block 15829140 is missing/)
  })

  it('stops for a block the nodes do not have', async () => {
    const chain = { ...fakeChain(everyone()).chain, getBlock: async () => null }
    await expect(cutCensus(chain, { block: 5 })).rejects.toThrow(/no block 5/)
  })
})

describe('the census tool and the registry\'s content slot', () => {
  const live = () => VECTORS.find((vector) => vector.id === 'registry-content-rewritten-mainnet')!
  /** The name alone, its logs from `first` on a block apart, with the proxy's upgrades. */
  const alone = (first: number, head = 26_401_000): World => {
    const world = worldOf(live(), { spread: 100, first })
    world.logs.push(...pinnedUpgradeLogs())
    world.head = world.safe = head
    return world
  }

  it('finds a name from a value in its slot, with the logs of the registry past the floor, and records the latest setContent of that value', async () => {
    const census = await cut(alone(REGISTRY_CONTENT_FLOOR + 100))
    const entry = census.names[live().label]!
    expect(entry.registry).toMatchObject({ value: live().state.registryContent, counts: true, reason: 'passes' })
    // Six logs on six blocks a hundred apart: the sixth is the setContent of the value the slot holds.
    expect(entry.registry?.set).toEqual({ block: REGISTRY_CONTENT_FLOOR + 600, logIndex: 471 })
    expect(entry.keys).toEqual({})
  })

  it('does not find a name whose logs all lie before the floor: a value written then never counts, and the resolver answers nothing for it', async () => {
    const world = alone(REGISTRY_CONTENT_FLOOR - 1_000)
    const census = await cut(world)
    expect(Object.keys(census.names)).toEqual([])
    const { resolveOg } = await import('../site/resolver/og-names.js')
    const { createSession } = await import('../site/resolver/og-tail.js')
    const answer = await resolveOg(fakeChain(world).chain, `${live().label}.og`, { session: createSession(), census })
    expect(answer.records).toEqual([])
  })

  it('lists names from the registry\'s Changed logs from the floor, once each, and only those with a value in the slot', async () => {
    const world = alone(REGISTRY_CONTENT_FLOOR + 100)
    const said: string[] = []
    expect(await slotLabels(fakeChain(world, { maxSpan: Infinity }).chain, world.head, (line) => said.push(line))).toEqual([live().label])
    expect(said.join('\n')).toMatch(/6 registry Changed logs from block 26400000, on 1 names this resolver can answer, 1 with a value in the registry's content slot/)
    world.names[live().label] = { ...world.names[live().label]!, registryContent: `0x${'0'.repeat(64)}` }
    expect(await slotLabels(fakeChain(world, { maxSpan: Infinity }).chain, world.head)).toEqual([])
  })

  it('reads the transaction behind each Changed log of a name, once, and nothing it does not need', async () => {
    const world = alone(REGISTRY_CONTENT_FLOOR + 100)
    const made = fakeChain(world, { maxSpan: Infinity })
    await cutCensus(made.chain, { block: world.head })
    const changes = world.logs.filter((log) => log.topics[0] === TOPICS.changed)
    expect(made.asked.transactions.sort()).toEqual(changes.map((log) => transactionHashOf(log)).sort())
  })

  it('stops the cut, naming the hash, when a node has no transaction behind a log: the call is not guessed', async () => {
    const world = alone(REGISTRY_CONTENT_FLOOR + 100)
    const made = fakeChain(world, { maxSpan: Infinity, faults: { transaction: () => null } })
    await expect(cutCensus(made.chain, { block: world.head })).rejects.toThrow(/the nodes have no transaction 0x[0-9a-f]+, which logged a change of 0x[0-9a-f]+ at block \d+/)
  })

  it('stops the cut when a transaction is in another block than its log', async () => {
    const world = alone(REGISTRY_CONTENT_FLOOR + 100)
    const real = fakeChain(world, { maxSpan: Infinity })
    const made = fakeChain(world, { maxSpan: Infinity, faults: { transaction: async (hash) => { const found = await real.chain.getTransaction(hash); return found === null ? null : { ...found, blockNumber: 7 } } } })
    await expect(cutCensus(made.chain, { block: world.head })).rejects.toThrow(/is in block 7, not in block \d+, where its log of/)
  })
})

describe('two nodes as one', () => {
  it('answers what both say', async () => {
    const world = everyone()
    const both = agreeingChain(fakeChain(world, { maxSpan: Infinity }).chain, fakeChain(world, { maxSpan: Infinity }).chain)
    expect(censusText(await cutCensus(both, { block: world.head }))).toBe(censusText(await cut(world)))
  })

  it('throws, naming the read, when one node leaves out a log the other returns', async () => {
    const world = everyone()
    const dropped = { ...world, logs: world.logs.filter((log) => log.topics[0] !== TOPICS.setTextRecord || log.blockNumber !== 17_172_883) }
    const both = agreeingChain(fakeChain(world, { maxSpan: Infinity }).chain, fakeChain(dropped, { maxSpan: Infinity }).chain, { names: ['node A', 'node B'] })
    const failure = await cutCensus(both, { block: world.head }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(NodesDisagree)
    expect(failure).toMatchObject({ message: expect.stringMatching(/node A and node B disagree about getLogs/) })
  })

  it('throws, naming the read, when the nodes give different input for the same transaction: the call behind a log is what the cut rests on', async () => {
    const world = everyone()
    const real = fakeChain(world, { maxSpan: Infinity })
    const other = fakeChain(world, { maxSpan: Infinity, faults: { transaction: async (hash) => { const found = await real.chain.getTransaction(hash); return found === null ? null : { ...found, input: Uint8Array.of(...found.input.subarray(0, found.input.length - 1), 1) } } } })
    const both = agreeingChain(real.chain, other.chain, { names: ['node A', 'node B'] })
    const failure = await cutCensus(both, { block: world.head }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(NodesDisagree)
    expect(failure).toMatchObject({ message: expect.stringMatching(/node A and node B disagree about getTransaction/) })
  })

  it('does not take the order the nodes list the same logs in for a difference', async () => {
    const world = everyone()
    const reversed = { ...world, logs: [...world.logs].reverse() }
    const both = agreeingChain(fakeChain(world, { maxSpan: Infinity }).chain, fakeChain(reversed, { maxSpan: Infinity }).chain)
    await expect(cutCensus(both, { block: world.head })).resolves.toMatchObject({ block: world.head })
  })

  it('throws when the nodes disagree about state', async () => {
    const world = everyone()
    const other = { ...world, names: { ...world.names, chaosroadsmint: { ...world.names['chaosroadsmint']!, controller: `0x${'11'.repeat(20)}` } } }
    const both = agreeingChain(fakeChain(world, { maxSpan: Infinity }).chain, fakeChain(other, { maxSpan: Infinity }).chain)
    await expect(cutCensus(both, { block: world.head })).rejects.toBeInstanceOf(NodesDisagree)
  })
})

describe('the JSON-RPC chain', () => {
  const answering = (handler: (method: string, params: unknown[]) => unknown) => async (_url: unknown, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body)
    try {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: handler(method, params) }))
    } catch (error) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: (error as Error).message, data: (error as { data?: string }).data } }))
    }
  }

  it('asks for logs as a node expects and reads them back', async () => {
    const seen: unknown[] = []
    const fetched = answering((method, params) => {
      seen.push([method, params])
      return [{ address: '0xabc', topics: ['0x01'], data: '0x', blockNumber: '0x10', transactionHash: '0xaa', logIndex: '0x2', removed: false }]
    })
    const original = globalThis.fetch
    globalThis.fetch = fetched as unknown as typeof fetch
    try {
      const logs = await rpcChain('http://node.test').getLogs({ fromBlock: 16, toBlock: 32, address: ['0xabc'], topics: [null, '0x01'] })
      expect(seen).toEqual([['eth_getLogs', [{ fromBlock: '0x10', toBlock: '0x20', address: ['0xabc'], topics: [null, '0x01'] }]]])
      expect(logs).toEqual([{ address: '0xabc', topics: ['0x01'], data: new Uint8Array(0), blockNumber: 16, transactionHash: '0xaa', logIndex: 2, removed: false }])
    } finally {
      globalThis.fetch = original
    }
  })

  it('reads a revert as an answer of a contract and a range error as a limit', async () => {
    const original = globalThis.fetch
    globalThis.fetch = answering((method) => { throw Object.assign(new Error(method === 'eth_call' ? 'execution reverted' : 'block range too large'), method === 'eth_call' ? { data: '0x08c379a0' } : {}) }) as unknown as typeof fetch
    try {
      const node = rpcChain('http://node.test')
      await expect(node.call({ to: '0xabc', data: new Uint8Array([1]) }, 5)).resolves.toEqual({ data: null, revert: new Uint8Array([8, 195, 121, 160]), offchainLookup: null })
      await expect(node.getLogs({ fromBlock: 1, toBlock: 99_999_999 })).rejects.toMatchObject({ reason: 'limit' })
    } finally {
      globalThis.fetch = original
    }
  })
})
