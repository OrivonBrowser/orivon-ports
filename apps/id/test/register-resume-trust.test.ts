// Resuming from storage. A stored record is only a hint: whatever the label fixes (its validity, its price, the
// commitment, the approval) is derived again, and a record that disagrees with itself is dropped with a name.

import { describe, expect, it } from 'vitest'
import { decode, toChecksumAddress } from '../site/sdk/abi.js'
import { price } from '../site/sdk/orivonid.js'
import { decide, parseRec, readRec, storeKey } from '../site/register-flow.js'
import { makeCommitment } from '../site/register-tx.js'
import { harness } from './support/flow-harness.ts'

const ALICE = toChecksumAddress('0x' + 'a1'.repeat(20))
const BOB = toChecksumAddress('0x' + 'b0'.repeat(20))
const MAX = 2n ** 256n - 1n
const DAI = 10n ** 18n
const SECRET = '0x' + '11'.repeat(32)

function record(resolver: string, patch: Record<string, unknown> = {}) {
  const base = { v: 1, label: 'alice', owner: ALICE, resolver, resolverMode: 'deploy', secret: SECRET, price: String(10n * DAI), private: false, texts: {}, pending: null, hashes: {}, ...patch }
  const commitment = makeCommitment(String(base.label), String(base.owner), String(base.resolver), String(base.secret))
  return { commitment, ...base }
}

const sentSteps = (h: ReturnType<typeof harness>) => h.market.sent.map((sent) => sent.step)

describe('L3: a stored price larger than the name costs', () => {
  it('is dropped on resume, so the DAI approval is never for 2^256-1, and nothing is sent', async () => {
    const h = harness({ account: ALICE })
    h.store.set(storeKey(ALICE), JSON.stringify(record(h.market.predicted, { price: MAX.toString() })))
    expect(await h.flow.resume(ALICE)).toMatchObject({ phase: 'failed', reason: 'recordDiscarded', mismatch: 'price', recover: 'edit' })
    expect(h.market.sent).toEqual([])
    expect(h.store.map.size).toBe(0)
    expect(await h.flow.resume(ALICE)).toBeNull()
  })

  it('is approved at exactly price(label) by a record that is right, whatever the label costs', async () => {
    for (const [label, cost] of [['alice', 10n * DAI], ['abcd', 200n * DAI]] as const) {
      const h = harness({ account: ALICE, dai: 1000n * DAI })
      h.store.set(storeKey(ALICE), JSON.stringify(record(h.market.predicted, { label, price: String(cost) })))
      await h.flow.resume(ALICE)
      const approve = h.market.sent.find((sent) => sent.step === 'approve')
      const [, amount] = decode(['address', 'uint256'], (approve as { data: Uint8Array }).data.subarray(4)) as [string, bigint]
      expect(amount, label).toBe(cost)
      expect(amount).toBe(price(label))
    }
  })

  it('is approved at price(label) by the pure step even when its record says otherwise', () => {
    const rec = { ...record(BOB, { price: MAX.toString() }), commitment: '0x' + '22'.repeat(32) } as unknown as Parameters<typeof decide>[0]
    const out = decide(rec, { head: { timestamp: 10_000, number: 1 }, holder: null, commitmentAt: 10_000, allowance: 0n, resolverCode: true, pending: null })
    expect(out.act['step']).toBe('approve')
    const [, amount] = decode(['address', 'uint256'], (out.act['call'] as { data: Uint8Array }).data.subarray(4)) as [string, bigint]
    expect(amount).toBe(10n * DAI)
    expect(out.view['price']).toBe(10n * DAI)
  })
})

describe('L3: what else a stored record must agree with', () => {
  const dropped = async (patch: Record<string, unknown>, mismatch: string, options: { owner?: string } = {}) => {
    const h = harness({ account: ALICE })
    h.store.set(storeKey(ALICE), JSON.stringify(record(h.market.predicted, patch)))
    const state = await h.flow.resume(options.owner ?? ALICE)
    expect(state, JSON.stringify(patch)).toMatchObject({ phase: 'failed', reason: 'recordDiscarded', mismatch })
    expect(h.market.sent, mismatch).toEqual([])
    expect(h.store.map.size, mismatch).toBe(0)
    return state
  }

  it('drops a label the registrar refuses, or keeps for itself, before committing it', async () => {
    for (const label of ['X', 'ab', '-abc', 'ab-', 'ab--c', 'Alice', 'orivon', 'a'.repeat(64), '0x' + '1'.repeat(40)]) await dropped({ label }, 'label')
  })

  it('drops a price that is not the label\'s price', async () => {
    for (const wrong of ['1', String(200n * DAI), '0', MAX.toString()]) await dropped({ price: wrong }, 'price')
  })

  it('drops a commitment that is not the hash of the record\'s own label, owner, resolver and secret', async () => {
    const h = harness({ account: ALICE })
    const good = record(h.market.predicted)
    for (const patch of [
      { commitment: '0x' + '33'.repeat(32) },
      { commitment: makeCommitment('alicf', ALICE, h.market.predicted, SECRET) },
      { commitment: makeCommitment('alice', BOB, h.market.predicted, SECRET) },
      { commitment: makeCommitment('alice', ALICE, BOB, SECRET) },
      { commitment: makeCommitment('alice', ALICE, h.market.predicted, '0x' + '12'.repeat(32)) },
      { secret: '0x' + '12'.repeat(32) }
    ]) {
      const fresh = harness({ account: ALICE })
      fresh.store.set(storeKey(ALICE), JSON.stringify({ ...good, ...patch }))
      expect(await fresh.flow.resume(ALICE), JSON.stringify(patch)).toMatchObject({ reason: 'recordDiscarded', mismatch: 'commitment' })
      expect(fresh.market.sent).toEqual([])
    }
  })

  it('drops a record whose owner is not the account it was stored for', async () => {
    await dropped({ owner: BOB, resolver: BOB }, 'owner')
  })

  it('drops a record whose resolver is not the one the factory gives its owner', async () => {
    await dropped({ resolver: BOB }, 'resolver')
  })

  it('reads the commitment in either case of hex, and a right record resumes to the end', async () => {
    const h = harness({ account: ALICE })
    const good = record(h.market.predicted)
    h.store.set(storeKey(ALICE), JSON.stringify({ ...good, commitment: good.commitment.toUpperCase().replace('0X', '0x') }))
    expect((await h.flow.resume(ALICE))?.['phase']).toBe('done')
    expect(sentSteps(h)).toEqual(['commit', 'approve', 'deploy', 'register', 'records'])
  })

  it('still treats a record that is not one at all as nothing stored', async () => {
    const h = harness({ account: ALICE })
    h.store.set(storeKey(ALICE), '{"v":1,"label":"x"}')
    expect(await h.flow.resume(ALICE)).toBeNull()
  })

  it('names what does not match when read without a chain', () => {
    const good = record(ALICE)
    expect(readRec(JSON.stringify(good))).toMatchObject({ ok: true })
    expect(readRec(JSON.stringify({ ...good, label: 'X' }))).toEqual({ ok: false, mismatch: 'label' })
    expect(readRec(JSON.stringify({ ...good, price: '1' }))).toEqual({ ok: false, mismatch: 'price' })
    expect(readRec(JSON.stringify({ ...good, commitment: '0x' + '33'.repeat(32) }))).toEqual({ ok: false, mismatch: 'commitment' })
    expect(readRec('not json')).toEqual({ ok: false, mismatch: 'shape' })
    expect(parseRec(JSON.stringify({ ...good, label: 'X' }))).toBeNull()
  })

  it('lets a new registration start over a record that disagrees with itself, instead of blocking on it', async () => {
    const h = harness({ account: ALICE })
    expect((await h.flow.check('alice'))['phase']).toBe('ready')
    h.store.set(storeKey(ALICE), JSON.stringify(record(h.market.predicted, { price: MAX.toString() })))
    expect((await h.flow.start())['phase']).toBe('done')
  })
})
