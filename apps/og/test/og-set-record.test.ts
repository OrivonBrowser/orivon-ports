import { describe, expect, it } from 'vitest'
import { decode, selector, toChecksumAddress, ZERO_ADDRESS } from '../site/sdk/abi.js'
import { toHex } from '../site/sdk/bytes.js'
import { ChainError, type Chain, type TxRequest } from '../site/sdk/chain.js'
import { CENSUS_FORMAT, type Census } from '../site/resolver/og-census.js'
import { evaluateFreshness, hashOf } from '../site/resolver/og-freshness.js'
import { keyOf } from '../site/resolver/og-name.js'
import { resolveOg } from '../site/resolver/og-names.js'
import { IMPLEMENTATION, PROXY, REGISTRY, TOPICS, UPGRADES, WRAPPER } from '../site/resolver/og-pins.js'
import { contenthashRecord, managerOf, setOgRecord } from '../site/resolver/og-set-record.js'
import { createSession } from '../site/resolver/og-tail.js'
import { fakeChain, type NameState, type World } from './support/og-world.ts'

const address = (n: number) => toChecksumAddress(`0x${n.toString(16).padStart(40, '0')}`)
const ALICE = address(0xa11ce)
const BOB = address(0xb0b)
const CAROL = address(0xca401)
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const OLD = 'ipfs://bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4'
const IPNS = 'ipns://k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8'
const REFERENCE = 'ab'.repeat(32)
const ZERO_WORD = `0x${'0'.repeat(64)}`
const HEAD = 26_000_000
const KEY = keyOf('mysite')
const census = (): Census => ({ format: CENSUS_FORMAT, block: HEAD - 5_000, blockHash: ZERO_WORD, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names: {} })

const owned = (state: Partial<NameState> = {}): NameState => ({ registryOwner: ALICE, nameToId: '0', idToName: ZERO_WORD, ownerOf: null, controller: ZERO_ADDRESS, values: {}, ...state })

/** The chain of a person whose wallet holds `account`: a send is applied to the world, as a block that holds it. */
function wallet (name: NameState, options: { account?: string | null, decline?: boolean, estimate?: 'reverts', receipt?: 'reverted' | 'never' | 'other', broadcast?: 'unknown' } = {}) {
  const world: World = { head: HEAD, safe: HEAD - 40, names: { mysite: name }, logs: [{ address: REGISTRY, blockNumber: HEAD - 9_000, logIndex: 0, topics: [TOPICS.changed, KEY] }], implementation: IMPLEMENTATION }
  const made = fakeChain(world)
  const sent: TxRequest[] = []
  const waits: { timeoutMs: number | undefined }[] = []
  const account = options.account === undefined ? ALICE : options.account
  const chain = {
    ...made.chain,
    addresses: async () => account === null ? [] : [account],
    sendTransaction: async (tx: TxRequest) => {
      if (options.decline === true) throw new ChainError('declined', 'the person said no')
      if (options.estimate === 'reverts') throw new ChainError('reverted', 'Not yours')
      if (options.broadcast === 'unknown') throw new ChainError('unknownOutcome', 'it may have gone out', { hash: `0x${'ee'.repeat(32)}` })
      sent.push(tx)
      const [key, name, value] = decode(['bytes32', 'string', 'string'], tx.data!.subarray(4)) as [Uint8Array, string, string]
      world.head += 1
      world.names['mysite']!.values[name] = options.receipt === 'other' ? 'ipfs://somethingelse' : value
      world.logs.push({ address: PROXY, blockNumber: world.head, logIndex: 0, topics: [TOPICS.setTextRecord, `0x${toHex(key)}`, hashOf(name), hashOf(value)] })
      return `0x${'aa'.repeat(32)}`
    },
    waitForReceipt: async (hash: string, wait?: { timeoutMs?: number }) => {
      waits.push({ timeoutMs: wait?.timeoutMs })
      if (options.receipt === 'never') throw new ChainError('timeout', 'not mined in time', { hash })
      return { transactionHash: hash, blockHash: ZERO_WORD, blockNumber: world.head, status: options.receipt === 'reverted' ? 0 : 1, gasUsed: 1, effectiveGasPrice: 1n, contractAddress: null, logs: [] }
    }
  } as unknown as Chain
  return { chain, world, sent, waits }
}

const ask = (chain: Chain, session = createSession(), request: Record<string, unknown> = {}, options: Parameters<typeof setOgRecord>[3] = {}) =>
  setOgRecord(chain, session, { name: 'mysite.og', recordType: 'contenthash', value: `ipfs://${CID}`, ...request }, options)

describe('setRecord', () => {
  it('writes the record from the person\'s wallet, reads it back, and the next lookup answers it', async () => {
    const { chain, world, sent } = wallet(owned())
    const session = createSession()
    const result = await ask(chain, session)
    expect(result).toEqual({ status: 'seen', transaction: `0x${'aa'.repeat(32)}`, value: `ipfs://${CID}`, previous: null, block: HEAD + 1, proven: false })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ from: ALICE, to: PROXY })
    expect(toHex(sent[0]!.data!.subarray(0, 4))).toBe(toHex(selector('setTextRecord(bytes32,string,string)')))
    expect(decode(['bytes32', 'string', 'string'], sent[0]!.data!.subarray(4)).slice(1)).toEqual(['content.ipfs', `ipfs://${CID}`])
    expect(world.safe).toBeLessThan(HEAD)
    const answer = await resolveOg(chain, 'mysite.og', { session, census: census() })
    expect(answer.records).toEqual([{ type: 'ipfs', value: `ipfs://${CID}` }])
    expect(answer.provenance.block).toBe(HEAD + 1)
  })

  it('says what the record was before', async () => {
    const { chain } = wallet(owned({ values: { 'content.ipfs': OLD } }))
    expect(await ask(chain)).toMatchObject({ status: 'seen', previous: OLD })
  })

  it('writes an ipns address and an ipfs one under content.ipfs, and a swarm reference under content.bzz, lower-cased', async () => {
    for (const [value, key, text] of [[IPNS, 'content.ipfs', IPNS], [`ipfs://${CID}`, 'content.ipfs', `ipfs://${CID}`], [`bzz://${REFERENCE.toUpperCase()}`, 'content.bzz', `bzz://${REFERENCE}`]] as const) {
      const { chain, sent } = wallet(owned())
      await ask(chain, createSession(), { value })
      expect(decode(['bytes32', 'string', 'string'], sent[0]!.data!.subarray(4)).slice(1), value).toEqual([key, text])
    }
  })

  it('answers not-manager, and signs nothing, for a controller that does not hold the name: the resolver would never answer its record', async () => {
    const lines: string[] = []
    const { chain, sent } = wallet(owned({ registryOwner: BOB, controller: ALICE }))
    expect(await ask(chain, createSession(), {}, { progress: (line) => { lines.push(line) } })).toEqual({ status: 'not-manager' })
    expect(sent).toEqual([])
    expect(lines).toEqual(['mysite.og is owned by another account.'])
  })

  it('answers not-manager for the owner while another account is the controller, and names setController and unsetController as the way out', async () => {
    const lines: string[] = []
    const { chain, sent } = wallet(owned({ registryOwner: ALICE, controller: BOB }))
    expect(await ask(chain, createSession(), {}, { progress: (line) => { lines.push(line) } })).toEqual({ status: 'not-manager' })
    expect(sent).toEqual([])
    expect(lines[0]).toMatch(/another account is its controller.*unsetController.*setController/)
  })

  it('answers not-manager for a name the wrapper holds without a token for it, even for the controller', async () => {
    const lines: string[] = []
    const { chain, sent } = wallet(owned({ registryOwner: WRAPPER, nameToId: '5', idToName: ZERO_WORD, ownerOf: ALICE, controller: ALICE }))
    expect(await ask(chain, createSession(), {}, { progress: (line) => { lines.push(line) } })).toEqual({ status: 'not-manager' })
    expect(sent).toEqual([])
    expect(lines[0]).toMatch(/held by the wrapper.*no token/)
  })

  it('answers not-manager, and signs nothing, for an account that is neither the owner nor the controller', async () => {
    const lines: string[] = []
    const { chain, sent } = wallet(owned({ registryOwner: BOB, controller: CAROL }))
    expect(await ask(chain, createSession(), {}, { progress: (line) => { lines.push(line) } })).toEqual({ status: 'not-manager' })
    expect(sent).toEqual([])
    expect(lines).toEqual(['mysite.og is owned by another account.'])
  })

  it('says how to fix a wrapped name whose holder is not its controller', async () => {
    const lines: string[] = []
    const wrapped = owned({ registryOwner: WRAPPER, nameToId: '5', idToName: KEY, ownerOf: ALICE, controller: BOB })
    const { chain, sent } = wallet(wrapped)
    expect(await ask(chain, createSession(), {}, { progress: (line) => { lines.push(line) } })).toEqual({ status: 'not-manager' })
    expect(sent).toEqual([])
    expect(lines[0]).toMatch(/wrapped.*controller set before the name was wrapped.*Unwrap it, make your account its controller with setController, and wrap it again/)
  })

  it('writes a wrapped name when the holder is the controller', async () => {
    const { chain } = wallet(owned({ registryOwner: WRAPPER, nameToId: '5', idToName: KEY, ownerOf: ALICE, controller: ALICE }))
    expect(await ask(chain)).toMatchObject({ status: 'seen' })
  })

  it('answers not-manager for a name nobody has registered', async () => {
    const lines: string[] = []
    const { chain, sent } = wallet(owned({ registryOwner: ZERO_ADDRESS }))
    expect(await ask(chain, createSession(), {}, { progress: (line) => { lines.push(line) } })).toEqual({ status: 'not-manager' })
    expect(sent).toEqual([])
    expect(lines[0]).toMatch(/not registered/)
  })

  it('answers declined when there is no account or the person says no, and nothing is sent', async () => {
    expect(await ask(wallet(owned(), { account: null }).chain)).toEqual({ status: 'declined' })
    const declined = wallet(owned(), { decline: true })
    expect(await ask(declined.chain)).toEqual({ status: 'declined' })
    expect(declined.sent).toEqual([])
  })

  it('answers not-manager when the contract refuses the write because the name moved since it was read', async () => {
    expect(await ask(wallet(owned(), { estimate: 'reverts' }).chain)).toEqual({ status: 'not-manager' })
  })

  it('answers failed, with the hash, for a transaction that was mined and reverted', async () => {
    expect(await ask(wallet(owned(), { receipt: 'reverted' }).chain)).toEqual({ status: 'failed', transaction: `0x${'aa'.repeat(32)}` })
  })

  it('answers sent, never seen, when it cannot show that the name has the value', async () => {
    const value = `ipfs://${CID}`
    const sent = { status: 'sent', transaction: `0x${'aa'.repeat(32)}`, value }
    expect(await ask(wallet(owned(), { receipt: 'never' }).chain)).toEqual(sent)
    expect(await ask(wallet(owned(), { receipt: 'other' }).chain)).toEqual(sent)
  })

  it('answers sent at once when the call has no time left to wait for the block', async () => {
    const made = wallet(owned())
    expect(await ask(made.chain, createSession(), {}, { deadlineAt: Date.now() + 500 })).toMatchObject({ status: 'sent' })
    expect(made.waits).toEqual([])
  })

  it('waits for the block only as long as the call has, less what it keeps to answer', async () => {
    const made = wallet(owned())
    await ask(made.chain, createSession(), {}, { deadlineAt: Date.now() + 20_000 })
    expect(made.waits).toHaveLength(1)
    expect(made.waits[0]!.timeoutMs).toBeGreaterThan(17_000)
    expect(made.waits[0]!.timeoutMs).toBeLessThanOrEqual(18_500)
  })

  it('throws what a broadcast that may have gone out threw, for the page to say it is unavailable', async () => {
    await expect(ask(wallet(owned(), { broadcast: 'unknown' }).chain)).rejects.toMatchObject({ reason: 'unknownOutcome' })
  })

  it('refuses what the standard does not define, before the wallet is asked for anything', async () => {
    const made = wallet(owned())
    for (const request of [
      { recordType: 'address' }, { recordType: 'text' }, { value: 'https://example.com' }, { value: 'ipfs://' }, { value: 'ipfs://not-a-cid' },
      { value: `ipfs://${CID}/path` }, { value: `ipfs://${CID}?x=1` }, { value: 'bzz://abcd' }, { value: `bzz://${REFERENCE}/x` }, { value: 'ipns://' },
      { value: 7 }, { value: undefined }, { name: 'mysite.eth' }, { name: 'a.b.og' }, { name: 'MySite.og' }, { name: 7 }
    ]) {
      await expect(ask(made.chain, createSession(), request), JSON.stringify(request)).rejects.toMatchObject({ code: 'invalid' })
    }
    expect(made.sent).toEqual([])
  })
})

describe('contenthashRecord', () => {
  it('maps the three schemes to their keys', () => {
    expect(contenthashRecord(`ipfs://${CID}`)).toEqual({ key: 'content.ipfs', text: `ipfs://${CID}` })
    expect(contenthashRecord(IPNS)).toEqual({ key: 'content.ipfs', text: IPNS })
    expect(contenthashRecord(`bzz://${REFERENCE}`)).toEqual({ key: 'content.bzz', text: `bzz://${REFERENCE}` })
    expect(contenthashRecord('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toEqual({ key: 'content.ipfs', text: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' })
  })

  it('finds no record in anything else', () => {
    for (const value of ['', 'ipfs://x', 'ar://x', 'https://example.com', `ipfs://${CID} `, `/ipfs/${CID}`, CID, `ipfs://${CID}#a`, null, undefined, 3]) {
      expect(contenthashRecord(value), String(value)).toBeNull()
    }
  })
})

describe('managerOf', () => {
  const reads = (state: Partial<NameState>) => ({ ...owned(state), nameToId: BigInt(state.nameToId ?? 0) })
  const wrapped = (state: Partial<NameState> = {}) => reads({ registryOwner: WRAPPER, nameToId: '5', idToName: KEY, ownerOf: ALICE, ...state })

  it('is the holder when there is no controller or the holder is the controller, and no one else', () => {
    expect(managerOf('mysite', reads({}), ALICE)).toEqual({ manager: true })
    expect(managerOf('mysite', reads({ controller: ALICE }), ALICE)).toEqual({ manager: true })
    expect(managerOf('mysite', wrapped({ controller: ALICE }), ALICE)).toEqual({ manager: true })
    expect(managerOf('mysite', reads({ controller: BOB }), BOB)).toMatchObject({ manager: false })
    expect(managerOf('mysite', reads({ controller: BOB }), ALICE)).toMatchObject({ manager: false })
    expect(managerOf('mysite', reads({ controller: BOB }), CAROL)).toMatchObject({ manager: false })
    expect(managerOf('mysite', reads({ controller: null }), ALICE)).toMatchObject({ manager: false })
    expect(managerOf('mysite', reads({ controller: null }), CAROL)).toMatchObject({ manager: false })
  })

  it('needs the holder of a wrapped name to be its controller, because the write goes through the controller', () => {
    expect(managerOf('mysite', wrapped(), ALICE)).toMatchObject({ manager: false, words: expect.stringMatching(/setController/) })
    expect(managerOf('mysite', wrapped({ controller: ZERO_ADDRESS }), ALICE)).toMatchObject({ manager: false })
    expect(managerOf('mysite', wrapped({ controller: BOB }), BOB)).toMatchObject({ manager: false })
  })

  it('does not take the zero address, which is no controller, for an account', () => {
    expect(managerOf('x', reads({ registryOwner: BOB, controller: ZERO_ADDRESS }), ZERO_ADDRESS)).toMatchObject({ manager: false })
  })

  it('never lets an account write what the resolver would not answer: the holder, with no controller or itself as the controller', () => {
    const states: Partial<NameState>[] = []
    for (const controller of [ZERO_ADDRESS, ALICE, BOB, CAROL, null]) {
      states.push({ controller }, { registryOwner: BOB, controller })
      for (const ownerOf of [ALICE, BOB]) states.push({ registryOwner: WRAPPER, nameToId: '5', idToName: KEY, ownerOf, controller })
      states.push({ registryOwner: WRAPPER, nameToId: '5', idToName: ZERO_WORD, ownerOf: ALICE, controller }, { registryOwner: WRAPPER, controller })
    }
    let managers = 0
    for (const state of states) {
      const name = reads(state)
      const empty = { setText: [], newController: [], registryChanged: [], wrapperTransfers: [] }
      const verdict = evaluateFreshness(KEY, name, empty)
      for (const account of [ALICE, BOB, CAROL]) {
        if (!managerOf('mysite', name, account).manager) continue
        managers++
        expect(verdict.holder, JSON.stringify([state, account])).toBe(account)
        expect(verdict.controllerOk, JSON.stringify([state, account])).toBe(true)
      }
    }
    expect(managers).toBeGreaterThan(5)
  })
})
