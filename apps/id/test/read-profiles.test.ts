import { describe, expect, it } from 'vitest'
import { decode, encode, selector } from '../site/sdk/abi.js'
import { fromHex, toHex } from '../site/sdk/bytes.js'
import { orivonChain } from '../site/sdk/chain-orivon.js'
import { type Chain, ChainError } from '../site/sdk/chain.js'
import { recordsAt } from '../site/sdk/orivonid.js'
import { MULTICALL3, readProfiles } from '../site/sdk/read.js'
import { fakeOrivon } from './support/fake-orivon.ts'
import {
  BATCH_AGGREGATE_DIRECT, BATCH_AGGREGATE_RESOLVE, BATCH_DNS, BATCH_HOLDER, BATCH_LABEL, BATCH_MULTICALL, BATCH_PROFILES,
  BATCH_REAL_AGGREGATE_ANSWER, BATCH_REAL_MULTICALL_ANSWER, BATCH_RESOLVE_MULTICALL, BATCH_RESOLVER
} from './support/resolver-batch.ts'

// What `readProfiles` sends and what it makes of an answer, against calldata made by Foundry's `cast` and against the
// bytes the deployed PermissionedResolver and Multicall3 returned on a mainnet fork (support/resolver-batch.ts).

const NAME = `${BATCH_LABEL}.v1.orivonid.eth`
const OUTPUTS = ['address', 'bytes', 'string', 'string', 'string']
const profiles = BATCH_PROFILES.map((call, index) => ({ call: fromHex(call), output: OUTPUTS[index] as string }))
const SUPPORTS = toHex(selector('supportsInterface(bytes4)'))
const MULTICALL = toHex(selector('multicall(bytes[])'))
const hex = (data: Uint8Array) => '0x' + toHex(data)
const TRUE = encode(['bool'], [true])
const FALSE = encode(['bool'], [false])
const REVERT = 'revert'
type Reply = Uint8Array | typeof REVERT | Error

/** The five items the resolver answered, as its multicall returned them. */
const items = decode(['bytes[]'], decode(['bytes'], fromHex(BATCH_REAL_MULTICALL_ANSWER))[0] as Uint8Array)[0] as Uint8Array[]
/** What Multicall3 returned for each call: whether it succeeded, and what the resolver's `resolve` answered. */
const results = decode(['(bool,bytes)[]'], fromHex(BATCH_REAL_AGGREGATE_ANSWER))[0] as [boolean, Uint8Array][]

const EXPECTED = [
  { ok: true, value: BATCH_HOLDER },
  { ok: true, value: fromHex('0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f') },
  { ok: true, value: 'https://p.example' },
  { ok: true, value: '' },
  { ok: false }
]

/** A Chain whose contracts are `script`, which sees each call as lower-case hex, and a record of every call made. */
function scripted (script: (to: string, data: string) => Reply) {
  const calls: { to: string, data: string }[] = []
  const answer = async (tx: { to?: string, data?: Uint8Array }) => {
    const data = hex(tx.data ?? new Uint8Array(0))
    calls.push({ to: tx.to ?? '', data })
    const reply = script(tx.to ?? '', data)
    if (reply instanceof Error) throw reply
    return reply === REVERT ? { data: null, revert: new Uint8Array(0), offchainLookup: null } : { data: reply, revert: null, offchainLookup: null }
  }
  return { chain: { call: answer } as unknown as Chain, calls, answer }
}

const isSupports = (data: string) => data.startsWith(`0x${SUPPORTS}`)
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

describe('readProfiles through the resolver\'s own multicall', () => {
  it('sends one resolve(name, multicall(calls)) after asking whether the resolver is extended, as cast encodes it', async () => {
    const { chain, calls } = scripted((_to, data) => isSupports(data) ? TRUE : same(data, BATCH_RESOLVE_MULTICALL) ? fromHex(BATCH_REAL_MULTICALL_ANSWER) : REVERT)
    await readProfiles(chain, BATCH_RESOLVER, NAME, profiles)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.to).toBe(BATCH_RESOLVER)
    expect(calls[1]?.data).toBe(BATCH_RESOLVE_MULTICALL.toLowerCase())
    expect(BATCH_MULTICALL.startsWith(`0x${MULTICALL}`)).toBe(true)
    expect(hex(fromHex(BATCH_DNS))).toBe('0x0c70726f62652d347a322d6964027631086f7269766f6e69640365746800')
  })

  it('reads the real resolver\'s answer: four values, and the fifth call it lacks as that record\'s failure', async () => {
    const { chain } = scripted((_to, data) => isSupports(data) ? TRUE : same(data, BATCH_RESOLVE_MULTICALL) ? fromHex(BATCH_REAL_MULTICALL_ANSWER) : REVERT)
    expect(await readProfiles(chain, BATCH_RESOLVER, NAME, profiles)).toEqual(EXPECTED)
  })

  it('calls multicall directly on a resolver that is not extended, and a resolver that answers no ERC-165 question is not', async () => {
    const direct = encode(['bytes[]'], [items])
    for (const supports of [FALSE, REVERT] as const) {
      const { chain, calls } = scripted((_to, data) => isSupports(data) ? supports : same(data, BATCH_MULTICALL) ? direct : REVERT)
      expect(await readProfiles(chain, BATCH_RESOLVER, NAME, profiles)).toEqual(EXPECTED)
      expect(calls.map((one) => one.data)).toEqual([calls[0]?.data, BATCH_MULTICALL.toLowerCase()])
    }
  })

  it('asks once for a single record and not by multicall', async () => {
    const { chain, calls } = scripted((_to, data) => isSupports(data) ? FALSE : encode(['address'], [BATCH_HOLDER]))
    expect(await readProfiles(chain, BATCH_RESOLVER, NAME, [profiles[0] as (typeof profiles)[number]])).toEqual([{ ok: true, value: BATCH_HOLDER }])
    expect(calls.map((one) => one.data.slice(0, 10))).toEqual([`0x${SUPPORTS}`, BATCH_PROFILES[0]?.slice(0, 10)])
  })
})

describe('readProfiles through Multicall3', () => {
  const aggregate = (data: string) => same(data, BATCH_AGGREGATE_RESOLVE) ? fromHex(BATCH_REAL_AGGREGATE_ANSWER) : REVERT

  it('sends one aggregate3 of each call allowed to fail, as cast encodes it, when the resolver has no multicall', async () => {
    const { chain, calls } = scripted((to, data) => isSupports(data) ? TRUE : same(to, MULTICALL3) ? aggregate(data) : REVERT)
    expect(await readProfiles(chain, BATCH_RESOLVER, NAME, profiles)).toEqual(EXPECTED)
    expect(calls).toHaveLength(3)
    expect(calls[1]?.data).toBe(BATCH_RESOLVE_MULTICALL.toLowerCase())
    expect(calls[2]?.to).toBe(MULTICALL3)
    expect(calls[2]?.data).toBe(BATCH_AGGREGATE_RESOLVE.toLowerCase())
  })

  it('reads the resolver\'s calls directly when it is not extended', async () => {
    const unwrapped = results.map(([ok, returned]) => [ok, ok ? decode(['bytes'], returned)[0] as Uint8Array : returned])
    const { chain, calls } = scripted((to, data) => isSupports(data) ? FALSE : same(to, MULTICALL3) && same(data, BATCH_AGGREGATE_DIRECT) ? encode(['(bool,bytes)[]'], [unwrapped]) : REVERT)
    expect(await readProfiles(chain, BATCH_RESOLVER, NAME, profiles)).toEqual(EXPECTED)
    expect(calls.map((one) => one.data.slice(0, 10))).toEqual([`0x${SUPPORTS}`, `0x${MULTICALL}`, '0x82ad56cb'])
    expect(calls[2]?.data).toBe(BATCH_AGGREGATE_DIRECT.toLowerCase())
  })

  it('is tried only after the resolver\'s multicall failed as a whole, and a chain without Multicall3 answers it with nothing', async () => {
    const { chain, calls } = scripted((to, data) => isSupports(data) ? TRUE : same(to, MULTICALL3) ? new Uint8Array(0) : REVERT)
    const answers = await readProfiles(chain, BATCH_RESOLVER, NAME, profiles)
    expect(answers.every((answer) => !answer.ok)).toBe(true)
    expect(calls.map((one) => one.to)).toEqual([BATCH_RESOLVER, BATCH_RESOLVER, MULTICALL3, ...Array(5).fill(BATCH_RESOLVER)])
  })
})

describe('readProfiles one record at a time', () => {
  const single = (data: string): Reply => {
    const at = profiles.findIndex((one) => data.includes(toHex(one.call)))
    const found = results[at]
    return found === undefined || !found[0] ? REVERT : found[1]
  }

  it('is the way left when neither the resolver nor the chain batches, and still reads the records the resolver has', async () => {
    const batch = (data: string) => data.startsWith('0x9061b923') && data.includes(MULTICALL)
    const { chain, calls } = scripted((to, data) => isSupports(data) ? TRUE : same(to, MULTICALL3) || batch(data) ? REVERT : single(data))
    expect(await readProfiles(chain, BATCH_RESOLVER, NAME, profiles)).toEqual(EXPECTED)
    expect(calls).toHaveLength(1 + 2 + 5)
  })

  it('falls through a batch that answers the wrong number of records', async () => {
    const short = encode(['bytes'], [encode(['bytes[]'], [items.slice(0, 4)])])
    const { chain, calls } = scripted((to, data) => isSupports(data) ? TRUE : same(data, BATCH_RESOLVE_MULTICALL) ? short : same(to, MULTICALL3) ? REVERT : single(data))
    expect(await readProfiles(chain, BATCH_RESOLVER, NAME, profiles)).toEqual(EXPECTED)
    expect(calls).toHaveLength(1 + 2 + 5)
  })
})

describe('readProfiles and a node that cannot be asked', () => {
  it('rejects with the node\'s reason at once, and does not try another way, however many records there are', async () => {
    const { chain, calls } = scripted((_to, data) => isSupports(data) ? TRUE : new ChainError('timeout', 'no answer'))
    await expect(readProfiles(chain, BATCH_RESOLVER, NAME, profiles)).rejects.toMatchObject({ reason: 'timeout' })
    expect(calls).toHaveLength(2)
  })
})

describe('a batch in the queue of the Orivon chain', () => {
  it('is one call of the light client, whatever the number of records', async () => {
    const four = encode(['bytes'], [encode(['bytes[]'], [items.slice(0, 4)])])
    const { answer } = scripted((_to, data) => isSupports(data) ? TRUE : data.startsWith('0x9061b923') ? four : REVERT)
    const fake = fakeOrivon({ call: (tx: { to: string, data: Uint8Array }) => answer(tx) })
    const found = await recordsAt(orivonChain(fake.orivon as never), BATCH_RESOLVER, BATCH_LABEL, ['url', 'nope'])
    expect(found).toMatchObject({ addr: BATCH_HOLDER, texts: { url: 'https://p.example', nope: null }, failed: [] })
    expect(fake.calls.filter((one) => one.fn === 'ETH_NET_0_1_READONLY.call')).toHaveLength(2)
  })
})
