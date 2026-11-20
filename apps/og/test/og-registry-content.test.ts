import { describe, expect, it } from 'vitest'
import { encodeCall } from '../site/sdk/abi.js'
import { fromHex, toHex, utf8 } from '../site/sdk/bytes.js'
import { dagPbCid } from '../site/sdk/cid.js'
import { keyOf } from '../site/resolver/og-name.js'
import { inspectOg } from '../site/resolver/og-names.js'
import { createSession, OgRefusal } from '../site/resolver/og-tail.js'
import { PROXY, REGISTRY, TOPICS, WRAPPER } from '../site/resolver/og-pins.js'
import { census, harness } from './support/manage-harness.ts'
import { ACCOUNT, RIVAL, SAFE } from './support/linagee-world.ts'

const LABEL = 'harbor'
const KEY = keyOf(LABEL)
const FIRST = `0x${'12'.repeat(32)}`
const SECOND = `0x${'34'.repeat(32)}`
const SITE = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const ipfsOf = (value: string) => `ipfs://${dagPbCid(fromHex(value))}`

type Setup = ReturnType<typeof harness>['setup']
/** One transaction mined as `from`, with the call encoded the way a wallet encodes it. */
function send (setup: Setup, from: string, to: string, signature: string, args: unknown[]): string {
  const nonce = setup.world.state.nonces[from.toLowerCase()] ?? 0
  return setup.mine(utf8(JSON.stringify({ from, to, data: toHex(encodeCall(signature, args)), value: '0x0', gas: 300_000, nonce })))
}
const registry = (setup: Setup, from: string, signature: string, ...rest: unknown[]) => send(setup, from, REGISTRY, signature, [KEY, ...rest])
const reserve = (setup: Setup, from = ACCOUNT) => registry(setup, from, 'reserve(bytes32)')
const setContent = (setup: Setup, from: string, value: string) => registry(setup, from, 'setContent(bytes32,bytes32)', value)
const transfer = (setup: Setup, from: string, to: string) => registry(setup, from, 'transfer(bytes32,address)', to)
const registryCalls = (setup: Setup) => setup.calls.filter((one) => String(one.fn).endsWith('.getTransaction')).length

describe('the registry content slot, read through the resolver on a simulated registry', () => {
  it('counts a value its holder wrote with a direct setContent after reserving the name, and answers it as one ipfs record', async () => {
    const { setup, answer, inspect } = harness()
    reserve(setup)
    setContent(setup, ACCOUNT, FIRST)
    expect(await answer(LABEL)).toEqual([{ type: 'ipfs', value: ipfsOf(FIRST) }])
    const found = await inspect(LABEL)
    expect(found.verdict?.registry).toMatchObject({ counts: true, reason: 'passes', value: FIRST })
    expect(found.verdict?.records).toEqual(['registry.content'])
    expect(found.reads.registryContent).toBe(FIRST)
  })

  it('does not count what the holder wrote before the name was transferred: the buyer holds a slot the seller wrote', async () => {
    const { setup, answer, inspect } = harness()
    reserve(setup)
    setContent(setup, ACCOUNT, FIRST)
    transfer(setup, ACCOUNT, RIVAL)
    expect(setup.world.state.content[KEY]).toBe(FIRST)
    expect(await answer(LABEL)).toEqual([])
    expect((await inspect(LABEL)).verdict?.registry).toMatchObject({ counts: false, reason: 'registry-content-set-before-the-last-holder-change', value: FIRST })
  })

  it('counts the new holder\'s own write after a transfer, the same value again included', async () => {
    const { setup, answer } = harness()
    reserve(setup)
    setContent(setup, ACCOUNT, FIRST)
    transfer(setup, ACCOUNT, RIVAL)
    expect(await answer(LABEL)).toEqual([])
    setContent(setup, RIVAL, FIRST)
    expect(await answer(LABEL)).toEqual([{ type: 'ipfs', value: ipfsOf(FIRST) }])
    setContent(setup, RIVAL, SECOND)
    expect(await answer(LABEL)).toEqual([{ type: 'ipfs', value: ipfsOf(SECOND) }])
  })

  it('keeps counting a value after the holder\'s other setters, which log Changed and are not a change of holder', async () => {
    const { setup, answer, inspect } = harness()
    reserve(setup)
    setContent(setup, ACCOUNT, FIRST)
    registry(setup, ACCOUNT, 'setAddress(bytes32,address,bool)', RIVAL, true)
    registry(setup, ACCOUNT, 'setSubRegistrar(bytes32,address)', RIVAL)
    expect(await answer(LABEL)).toEqual([{ type: 'ipfs', value: ipfsOf(FIRST) }])
    expect((await inspect(LABEL)).verdict?.registry.writtenAt).toMatchObject({ block: expect.any(Number) })
  })

  it('counts the value the latest setContent wrote, and not an older value that was never rewritten', async () => {
    const { setup, answer } = harness()
    reserve(setup)
    setContent(setup, ACCOUNT, FIRST)
    setContent(setup, ACCOUNT, SECOND)
    expect(await answer(LABEL)).toEqual([{ type: 'ipfs', value: ipfsOf(SECOND) }])
  })

  it('counts a text record written before the holder\'s own setter: only a call that moves the name ends a record\'s standing', async () => {
    const { setup, answer, inspect } = harness()
    reserve(setup)
    send(setup, ACCOUNT, PROXY, 'setController(bytes32,address)', [KEY, ACCOUNT])
    send(setup, ACCOUNT, PROXY, 'setTextRecord(bytes32,string,string)', [KEY, 'content.ipfs', SITE])
    registry(setup, ACCOUNT, 'setAddress(bytes32,address,bool)', RIVAL, true)
    expect((await inspect(LABEL)).verdict?.keys['content.ipfs']).toMatchObject({ counts: true, reason: 'passes' })
    expect(await answer(LABEL)).toEqual([{ type: 'ipfs', value: SITE }])
    // A transfer does end it, and the buyer is not the controller either.
    transfer(setup, ACCOUNT, RIVAL)
    expect(await answer(LABEL)).toEqual([])
  })

  it('lists the text record first and the slot\'s record after it, and one record once when both name the same file', async () => {
    const { setup, answer } = harness()
    reserve(setup)
    send(setup, ACCOUNT, PROXY, 'setController(bytes32,address)', [KEY, ACCOUNT])
    send(setup, ACCOUNT, PROXY, 'setTextRecord(bytes32,string,string)', [KEY, 'content.ipfs', SITE])
    setContent(setup, ACCOUNT, FIRST)
    expect(await answer(LABEL)).toEqual([{ type: 'ipfs', value: SITE }, { type: 'ipfs', value: ipfsOf(FIRST) }])
    send(setup, ACCOUNT, PROXY, 'setTextRecord(bytes32,string,string)', [KEY, 'content.ipfs', ipfsOf(SECOND)])
    setContent(setup, ACCOUNT, SECOND)
    expect(await answer(LABEL)).toEqual([{ type: 'ipfs', value: ipfsOf(SECOND) }])
  })

  it('does not count a value written through a contract: the transaction is to the contract, so no setter is read, whatever the contract did inside', async () => {
    const { setup, answer, inspect } = harness()
    reserve(setup)
    transfer(setup, ACCOUNT, SAFE)
    send(setup, ACCOUNT, SAFE, 'forward(address,bytes)', [REGISTRY, encodeCall('setContent(bytes32,bytes32)', [KEY, FIRST])])
    expect(setup.world.log.map((one) => one.label)).toEqual(['reserve', 'transfer', 'forward:setContent'])
    expect(setup.world.state.content[KEY]).toBe(FIRST)
    expect(await answer(LABEL)).toEqual([])
    expect((await inspect(LABEL)).verdict?.registry).toMatchObject({ counts: false, reason: 'registry-content-no-setContent-log', value: FIRST })
  })

  it('does not count a value on a name with no setContent log at all, which is what a value written before the census\'s floor looks like', async () => {
    const { setup, answer, inspect } = harness({ owner: { [KEY]: ACCOUNT }, content: { [KEY]: FIRST } })
    expect(await answer(LABEL)).toEqual([])
    expect((await inspect(LABEL)).verdict?.registry).toMatchObject({ counts: false, reason: 'registry-content-no-setContent-log' })
    expect(setup.chainLogs).toEqual([])
  })

  it('does not count a wrapped name\'s slot, whoever wrote it and whenever', async () => {
    const { setup, answer, inspect } = harness()
    reserve(setup)
    setContent(setup, ACCOUNT, FIRST)
    send(setup, ACCOUNT, WRAPPER, 'createWrapper(bytes32)', [KEY])
    transfer(setup, ACCOUNT, WRAPPER)
    send(setup, ACCOUNT, WRAPPER, 'wrap(bytes32)', [KEY])
    expect(setup.world.log.map((one) => one.label)).toEqual(['reserve', 'setContent', 'createWrapper', 'transfer', 'wrap'])
    const found = await inspect(LABEL)
    expect(found.holder).toMatchObject({ found: true, wrapped: true, holder: ACCOUNT })
    expect(found.verdict?.registry).toMatchObject({ counts: false, reason: 'registry-content-on-a-wrapped-name' })
    expect(await answer(LABEL)).toEqual([])
    // Nothing of what the registry did to the name is read for a wrapped one: no transaction was asked for.
    expect(registryCalls(setup)).toBe(0)
  })

  it('finds the slot empty after the name is disowned and another account reserves it: the previous holder\'s value does not come back', async () => {
    const { setup, answer, inspect } = harness()
    reserve(setup)
    setContent(setup, ACCOUNT, FIRST)
    registry(setup, ACCOUNT, 'disown(bytes32)')
    expect(await answer(LABEL)).toEqual([])
    reserve(setup, RIVAL)
    expect(setup.world.state.content[KEY]).toBeUndefined()
    const found = await inspect(LABEL)
    expect(found.holder).toMatchObject({ found: true, holder: RIVAL })
    expect(found.verdict?.registry).toMatchObject({ counts: false, reason: 'empty' })
    expect(await answer(LABEL)).toEqual([])
  })

  it('changes nothing when an account that does not hold the name calls setContent: the registry logs nothing, and the holder\'s value stands', async () => {
    const { setup, answer } = harness()
    reserve(setup)
    setContent(setup, ACCOUNT, FIRST)
    const logs = setup.chainLogs.length
    setContent(setup, RIVAL, SECOND)
    expect(setup.chainLogs).toHaveLength(logs)
    expect(await answer(LABEL)).toEqual([{ type: 'ipfs', value: ipfsOf(FIRST) }])
  })

  it('treats a setContent that clears the slot as no record, and a later one as the record', async () => {
    const { setup, answer } = harness()
    reserve(setup)
    setContent(setup, ACCOUNT, FIRST)
    setContent(setup, ACCOUNT, `0x${'0'.repeat(64)}`)
    expect(await answer(LABEL)).toEqual([])
    setContent(setup, ACCOUNT, SECOND)
    expect(await answer(LABEL)).toEqual([{ type: 'ipfs', value: ipfsOf(SECOND) }])
  })
})

describe('the transactions the resolver reads to tell a setter from a holder change', () => {
  it('reads the newest logs first and stops at the first change of holder, so a long run of setters is not read to its start', async () => {
    const { setup, answer } = harness()
    reserve(setup)
    for (let index = 0; index < 8; index++) setContent(setup, ACCOUNT, index % 2 === 0 ? FIRST : SECOND)
    transfer(setup, ACCOUNT, RIVAL)
    await answer(LABEL)
    // Nine logs lie after the census, the newest is the transfer: the first round of four holds it.
    expect(registryCalls(setup)).toBe(4)
  })

  it('reads on past a round of setters until it finds the call that moved the name', async () => {
    const { setup, answer } = harness()
    reserve(setup)
    for (let index = 0; index < 6; index++) setContent(setup, ACCOUNT, FIRST)
    expect(await answer(LABEL)).toEqual([{ type: 'ipfs', value: ipfsOf(FIRST) }])
    // Seven logs: two rounds of four, the second ends at the reserve.
    expect(registryCalls(setup)).toBe(7)
  })

  it('asks for a transaction once per session: a second look at the name in the same session reads nothing it has read', async () => {
    const { setup, chain } = harness()
    reserve(setup)
    setContent(setup, ACCOUNT, FIRST)
    const session = createSession()
    const look = () => inspectOg(chain, LABEL, { session, census: census() }, { latest: true })
    await look()
    const first = registryCalls(setup)
    expect(first).toBe(2)
    expect((await look()).verdict?.registry.counts).toBe(true)
    expect(registryCalls(setup)).toBe(first)
    expect(session.transactions.size).toBe(first)
  })

  it('refuses rather than answer in part when the node does not know a transaction a log names, and never reads the missing call as a setter', async () => {
    const { setup, answer, inspect } = harness()
    reserve(setup)
    setContent(setup, ACCOUNT, FIRST)
    const last = setup.chainLogs[setup.chainLogs.length - 1]!
    last.transactionHash = `0x${'ee'.repeat(32)}`
    await expect(answer(LABEL)).rejects.toBeInstanceOf(OgRefusal)
    const found = await inspect(LABEL)
    expect(found.verdict).toBeNull()
    expect(found.refusal).toBeInstanceOf(OgRefusal)
  })

  it('does not take a transaction mined in another block than its log for the call that logged it', async () => {
    const { setup, answer, inspect } = harness()
    reserve(setup)
    setContent(setup, ACCOUNT, FIRST)
    const [, second] = setup.chainLogs
    const before = setup.world.log[0]!
    // The setContent log now names the reserve's transaction, which is another block.
    second!.transactionHash = before.hash
    expect(await answer(LABEL)).toEqual([])
    expect((await inspect(LABEL)).verdict?.registry.counts).toBe(false)
  })

  it('names the topics it reads: the registry\'s Changed log is the only thing of the registry it asks about', async () => {
    const { setup } = harness()
    reserve(setup)
    expect(setup.chainLogs.map((one) => one.topics[0])).toEqual([TOPICS.changed])
  })
})
