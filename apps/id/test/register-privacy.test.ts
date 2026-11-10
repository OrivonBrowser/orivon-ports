// What a registration tells the person's Ethereum node about the label, and when. Inside Orivon that node is a light
// client whose execution server sees every slot and call, so the label must not reach it before the commitment, a
// short label must be asked among decoys, and the private reveal must not be simulated.

import { describe, expect, it } from 'vitest'
import { encode, selector, toChecksumAddress } from '../site/sdk/abi.js'
import { toHex, utf8 } from '../site/sdk/bytes.js'
import { keccak256 } from '../site/sdk/keccak.js'
import { isReserved, isValidLabel, labelId } from '../site/sdk/orivonid.js'
import { createHider, DECOY_COUNT, decoysFor, SEARCH_WORDS } from '../site/register-decoys.js'
import { REGISTER_GAS_LIMIT } from '../site/register-tx.js'
import { RelayError } from '../site/relay.js'
import { fakeMarket } from './support/fake-market.ts'
import { harness, type Harness } from './support/flow-harness.ts'

const ALICE = toChecksumAddress('0x' + 'a1'.repeat(20))
const LABEL = 'q7x'
const DAI = 10n ** 18n
const sel = (signature: string) => toHex(selector(signature))
const REVEAL = sel('register(string,address,address,bytes32)')
const RECEIVER_HOOK = sel('onERC1155Received(address,address,uint256,uint256,bytes)')
const GET_OWNER = sel('getOwner(uint256)')
const QUIET_READS = [sel('commitmentAt(bytes32)'), sel('allowance(address,address)'), sel('balanceOf(address)')]

interface Seen { kind: 'call' | 'estimate', hex: string, sends: string[], at: number }

function watched (options: { accountCode?: 'accepting' } = {}) {
  const market = fakeMarket({ account: ALICE, dai: 1000n * DAI, ...options })
  const seen: Seen[] = []
  const box: { h?: Harness } = {}
  const sendsSoFar = () => (box.h?.sends ?? []).map((send) => `${send.step}${send.private ? ':private' : ''}`)
  const call = market.chain.call.bind(market.chain)
  const estimate = market.chain.estimateGas.bind(market.chain)
  market.chain.call = async (tx, ...rest) => { seen.push({ kind: 'call', hex: toHex(tx.data ?? new Uint8Array(0)), sends: sendsSoFar(), at: market.time() }); return await call(tx, ...rest) }
  market.chain.estimateGas = async (tx, ...rest) => { seen.push({ kind: 'estimate', hex: toHex(tx.data ?? new Uint8Array(0)), sends: sendsSoFar(), at: market.time() }); return await estimate(tx, ...rest) }
  box.h = harness({ account: ALICE, market })
  return { h: box.h, seen, box }
}

const idHex = (label: string) => labelId(label).toString(16).padStart(64, '0')
const wordsOf = (reads: Seen[]) => reads.flatMap((one) => one.hex.slice(8).match(/.{64}/g) ?? [])
const mentions = (one: Seen, label: string) => one.hex.includes(idHex(label)) || one.hex.includes(toHex(utf8(label)))
const ownerReads = (seen: Seen[]) => seen.filter((one) => one.kind === 'call' && one.hex.startsWith(GET_OWNER))
const isReveal = (send: string) => send.startsWith('register')

/** What a reader of the node's requests does with the 32-byte words it saw: every label of `length` characters whose id is among them. */
function reverse (words: Set<string>, length: number): string[] {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const found: string[] = []
  const walk = (prefix: string) => {
    if (prefix.length === length) { if (words.has(toHex(keccak256(utf8(prefix))))) found.push(prefix); return }
    for (const letter of alphabet) walk(prefix + letter)
  }
  walk('')
  return found
}

describe('M1: the availability check', () => {
  it('asks about a 3-letter label among 7 others, so a dictionary reading finds 8 names and cannot tell which is meant', async () => {
    const { h, seen } = watched()
    expect((await h.flow.check(LABEL))['phase']).toBe('ready')
    expect(h.market.sent).toEqual([])
    const owners = ownerReads(seen)
    expect(owners).toHaveLength(1 + DECOY_COUNT)
    const found = reverse(new Set(wordsOf(owners)), 3)
    expect(found).toHaveLength(1 + DECOY_COUNT)
    expect(found).toContain(LABEL)
    expect(found.every((name) => isValidLabel(name) && !isReserved(name))).toBe(true)
  }, 120_000)

  it('does the same for 4 letters, and for a label with digits and hyphens', async () => {
    for (const label of ['abcd', 'a-b', 'x9-z']) {
      const { h, seen } = watched()
      expect((await h.flow.check(label))['phase'], label).toBe('ready')
      const asked = ownerReads(seen).map((one) => one.hex.slice(8))
      expect(new Set(asked).size, label).toBe(1 + DECOY_COUNT)
      expect(asked, label).toContain(idHex(label))
    }
  })

  it('asks about a longer label once, with no decoy: its spellings are too many to try', async () => {
    const { h, seen } = watched()
    expect((await h.flow.check('alice'))['phase']).toBe('ready')
    expect(ownerReads(seen).map((one) => one.hex.slice(8))).toEqual([idHex('alice')])
  })

  it('asks the receiver hook among the same 8 names, never a different set, when the account has code', async () => {
    const { h, seen } = watched({ accountCode: 'accepting' })
    expect(await h.flow.check(LABEL)).toMatchObject({ phase: 'ready', receiver: 'accepts' })
    const owners = new Set(ownerReads(seen).map((one) => one.hex.slice(8)))
    const hooks = seen.filter((one) => one.kind === 'call' && one.hex.startsWith(RECEIVER_HOOK))
    const hookIds = new Set(hooks.map((one) => one.hex.slice(8).match(/.{64}/g)?.[2]))
    expect(hooks).toHaveLength(1 + DECOY_COUNT)
    expect(hookIds).toEqual(owners)
    expect(hookIds.has(idHex(LABEL))).toBe(true)
  })

  it('uses the same decoys when the same label is searched again, because two fresh sets would share only the real name', async () => {
    const { h, seen } = watched()
    await h.flow.check(LABEL)
    await h.flow.check(LABEL)
    const rounds = ownerReads(seen).map((one) => one.hex.slice(8))
    expect(rounds).toHaveLength(2 * (1 + DECOY_COUNT))
    expect(new Set(rounds).size).toBe(1 + DECOY_COUNT)
  })

  it('reports the real label\'s holder, whatever the decoys hold', async () => {
    const holder = toChecksumAddress('0x' + 'b0'.repeat(20))
    const answering = (heldBy: (id: string) => boolean) => {
      const market = fakeMarket({ account: ALICE, dai: 1000n * DAI })
      const call = market.chain.call.bind(market.chain)
      market.chain.call = async (tx, ...rest) => {
        const hex = toHex(tx.data ?? new Uint8Array(0))
        if (hex.startsWith(GET_OWNER) && heldBy(hex.slice(8))) return { data: encode(['address'], [holder]), revert: null, offchainLookup: null }
        return await call(tx, ...rest)
      }
      return harness({ account: ALICE, market })
    }
    expect((await answering((id) => id !== idHex(LABEL)).flow.check(LABEL))['phase']).toBe('ready')
    expect(await answering((id) => id === idHex(LABEL)).flow.check(LABEL)).toMatchObject({ phase: 'failed', reason: 'taken', holder })
  })

  it('keeps the node\'s questions in flight under its limit of 16, even for two searches made at once', async () => {
    const market = fakeMarket({ account: ALICE, dai: 1000n * DAI, accountCode: 'accepting' })
    const call = market.chain.call.bind(market.chain)
    let open = 0
    let most = 0
    market.chain.call = async (tx, ...rest) => {
      most = Math.max(most, ++open)
      await new Promise((resolve) => setTimeout(resolve, 2))
      try { return await call(tx, ...rest) } finally { open-- }
    }
    const h = harness({ account: ALICE, market })
    const both = await Promise.all([h.flow.check('abc'), h.flow.check('abd')])
    expect(both.map((state) => state['phase'])).toEqual(['ready', 'ready'])
    expect(most).toBeGreaterThanOrEqual(1 + DECOY_COUNT)
    expect(most).toBeLessThanOrEqual(16)
  })

  it('has words for the page that say what the node\'s server sees and that decoys hide a short name', () => {
    expect(SEARCH_WORDS).toMatch(/server behind your Ethereum node can see which names you check/)
    expect(SEARCH_WORDS).toMatch(/3 or 4 letters/)
    expect(SEARCH_WORDS).toMatch(/7 other names/)
    expect(SEARCH_WORDS).not.toMatch(/[^\x20-\x7e]/)
    expect(SEARCH_WORDS.match(/\./g)).toHaveLength(1)
  })
})

describe('M1: while the commitment matures', () => {
  it('names the label to the node only once the commitment can be revealed: nothing before the commit, nothing while it matures', async () => {
    const { h, seen } = watched()
    await h.flow.check(LABEL)
    const checked = seen.length
    expect((await h.flow.start({ private: true }))['phase']).toBe('done')
    const flow = seen.slice(checked)
    const matureAt = (h.market.sent.find((sent) => sent.step === 'commit')?.ts ?? 0) + 60
    const maturing = flow.filter((one) => one.sends.includes('commit') && one.at < matureAt)
    expect(maturing.length).toBeGreaterThan(5)
    expect(maturing.filter((one) => mentions(one, LABEL))).toEqual([])
    expect(flow.filter((one) => !one.sends.includes('commit') && mentions(one, LABEL))).toEqual([])
    const atReveal = flow.filter((one) => one.at >= matureAt && !one.sends.some(isReveal) && mentions(one, LABEL))
    expect(atReveal.length).toBeGreaterThan(0)
  })

  it('asks only for the commitment\'s age and the account\'s DAI while it waits', async () => {
    const { h, seen } = watched()
    await h.flow.check(LABEL)
    const checked = seen.length
    await h.flow.start()
    const waiting = seen.slice(checked).filter((one) => one.kind === 'call' && one.sends.includes('commit') && !one.sends.includes('deploy'))
    expect(waiting.length).toBeGreaterThan(3)
    for (const one of waiting) expect(QUIET_READS, one.hex.slice(0, 8)).toContain(one.hex.slice(0, 8))
  })

  it('resumes after a reload the same way: the owner is read once the commitment can be revealed, not before', async () => {
    const first = watched()
    await first.h.flow.check(LABEL)
    first.h.crash.on = 'approve'
    await first.h.flow.start()
    first.h.crash.on = null
    const before = first.seen.length
    const second = harness({ account: ALICE, market: first.h.market, store: first.h.store })
    first.box.h = second
    expect((await second.flow.resume())?.['phase']).toBe('done')
    const resumed = first.seen.slice(before)
    const matureAt = (first.h.market.sent.find((sent) => sent.step === 'commit')?.ts ?? 0) + 60
    const naming = resumed.filter((one) => mentions(one, LABEL))
    expect(naming.length).toBeGreaterThan(0)
    expect(naming.filter((one) => one.at < matureAt)).toEqual([])
  })
})

describe('M1: the private reveal', () => {
  it('is signed with a fixed gas limit and never simulated, so the node sees neither the label nor the secret first', async () => {
    const { h, seen } = watched()
    await h.flow.check(LABEL)
    expect((await h.flow.start({ private: true }))['phase']).toBe('done')
    const stored = JSON.parse(h.store.writes.find((write) => write.value.includes('"secret"'))?.value ?? '{}') as { secret: string }
    expect(seen.filter((one) => one.kind === 'estimate' && one.hex.startsWith(REVEAL))).toEqual([])
    const beforeReveal = seen.filter((one) => one.kind === 'estimate' && !one.sends.some(isReveal))
    expect(beforeReveal.some((one) => one.hex.includes(toHex(utf8(LABEL))) || one.hex.includes(stored.secret.slice(2)))).toBe(false)
    expect(h.prepares.find((prepared) => prepared.step === 'register')?.gas).toBe(REGISTER_GAS_LIMIT)
    expect(h.sends.find((send) => send.step === 'register')?.private).toBe(true)
    expect(h.prepares.filter((prepared) => prepared.step !== 'register').map((prepared) => prepared.gas)).toEqual([125_000, 125_000, 125_000, 125_000])
  })

  it('keeps that limit when the person sends the signed transaction publicly after the relay failed', async () => {
    const { h, seen } = watched()
    await h.flow.check(LABEL)
    h.relay.failure = new RelayError('unavailable', 'HTTP 503')
    await h.flow.start({ private: true })
    expect((await h.flow.retry({ private: false }))['phase']).toBe('done')
    expect(seen.filter((one) => one.kind === 'estimate' && one.hex.startsWith(REVEAL))).toEqual([])
    expect(h.prepares.filter((prepared) => prepared.step === 'register').map((prepared) => prepared.gas)).toEqual([REGISTER_GAS_LIMIT])
  })

  it('still estimates a reveal that goes out publicly', async () => {
    const { h, seen } = watched()
    await h.flow.check(LABEL)
    await h.flow.start()
    expect(seen.filter((one) => one.kind === 'estimate' && one.hex.startsWith(REVEAL))).toHaveLength(1)
    expect(h.prepares.find((prepared) => prepared.step === 'register')?.gas).toBe(125_000)
  })
})

describe('the decoys', () => {
  const counter = (seed: number) => {
    let state = seed >>> 0
    return (bytes: number) => Uint8Array.from({ length: bytes }, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 24 })
  }
  const shape = (name: string) => [...name].map((char) => char === '-' ? '-' : /\d/.test(char) ? '9' : 'a').join('')

  it('are 7 other valid, unreserved labels of the real length and shape, all different', () => {
    for (const label of ['q7x', 'abc', 'a-c', '007', 'abcd', 'z9-1', 'w4rd']) {
      const decoys = decoysFor(label, counter(label.length * 7919))
      expect(decoys, label).toHaveLength(DECOY_COUNT)
      expect(new Set(decoys).size, label).toBe(DECOY_COUNT)
      expect(decoys, label).not.toContain(label)
      for (const decoy of decoys) {
        expect(isValidLabel(decoy), decoy).toBe(true)
        expect(isReserved(decoy), decoy).toBe(false)
        expect(shape(decoy), decoy).toBe(shape(label))
      }
    }
  })

  it('exist for labels of 3 and 4 bytes only', () => {
    expect(decoysFor('abcde')).toEqual([])
    expect(decoysFor('a'.repeat(63))).toEqual([])
    expect(decoysFor('abcd')).toHaveLength(DECOY_COUNT)
  })

  it('differ from one fresh draw to the next, and still come out right from a source that repeats one byte', () => {
    expect(decoysFor('q7x', counter(1))).not.toEqual(decoysFor('q7x', counter(2)))
    for (const fill of [0, 1, 255]) {
      const stuck = decoysFor('q7x', (bytes) => new Uint8Array(bytes).fill(fill))
      expect(new Set(stuck).size, String(fill)).toBe(DECOY_COUNT)
      expect(stuck.every((decoy) => isValidLabel(decoy) && decoy !== 'q7x' && !isReserved(decoy))).toBe(true)
    }
  })

  it('never include a reserved name, which a real search would not have asked about', () => {
    for (let seed = 1; seed <= 300; seed++) for (const decoy of decoysFor('eta', counter(seed))) expect(isReserved(decoy), decoy).toBe(false)
  })

  it('put the real label anywhere in the order, evenly enough that no position gives it away', async () => {
    const places = new Array<number>(1 + DECOY_COUNT).fill(0)
    for (let seed = 1; seed <= 800; seed++) {
      const order: string[] = []
      await createHider(counter(seed)).among('q7x', async (name) => { order.push(name) })
      const place = order.indexOf('q7x')
      places[place] = (places[place] ?? 0) + 1
    }
    for (const count of places) expect(count).toBeGreaterThan(50)
  })

  it('are asked together with the real name, their answers and failures dropped, and only the real answer kept', async () => {
    const hider = createHider(counter(5))
    const asked: string[] = []
    const answer = await hider.among('q7x', async (name) => {
      asked.push(name)
      if (name !== 'q7x') throw new Error('a decoy failed')
      return 'the real answer'
    })
    expect(answer).toBe('the real answer')
    expect(asked).toHaveLength(1 + DECOY_COUNT)
    await expect(hider.among('q7x', async (name) => { if (name === 'q7x') throw new Error('real failure'); return 1 })).rejects.toThrow('real failure')
  })

  it('wait for every question before the next, so the node\'s limit on questions in flight is not crossed', async () => {
    let open = 0
    let most = 0
    await createHider(counter(9)).among('q7x', async () => { most = Math.max(most, ++open); await new Promise((resolve) => setTimeout(resolve, 5)); open-- })
    expect(most).toBe(1 + DECOY_COUNT)
    expect(open).toBe(0)
  })
})
