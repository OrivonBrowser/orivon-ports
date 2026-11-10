import { describe, expect, it } from 'vitest'
import { toChecksumAddress } from '../site/sdk/abi.js'
import { ChainError } from '../site/sdk/chain.js'
import { attribution } from '../site/sdk/orivonid.js'
import { copyKeys, NOT_YET_HELD } from '../site/move-model.js'
import { createMove } from '../site/move-flow.js'
import { fakeMarket, type Market } from './support/fake-market.ts'
import { OWNER_ROLES, type Name } from './support/fake-registry.ts'

const ALICE = toChecksumAddress('0x' + 'a1'.repeat(20))
const GIVER = toChecksumAddress('0x' + 'b0'.repeat(20))
const OLD = toChecksumAddress('0x' + '0d'.repeat(20))
const CONTENTHASH = '0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f'
const TEXTS = { url: 'https://alice.example', description: 'Builds things.' }
const STEP_OF: Record<string, string> = { '5d84121a': 'deploy', ac9650d8: 'records', bc7b6d62: 'resolver' }

interface Setup {
  resolver?: 'none' | 'ours' | 'foreign'
  name?: Partial<Name>
  /** The old resolver is the giver's: the factory vouches for it, and the holder holds no role on it. */
  giver?: boolean
  oldRecords?: boolean
}

function setup (options: Setup = {}) {
  const market = fakeMarket({
    account: ALICE, resolver: options.resolver ?? 'none',
    world: {
      names: { alice: { owner: ALICE, resolver: OLD, ...options.name } },
      resolvers: {
        [OLD]: {
          extended: true, addr: GIVER, texts: options.oldRecords === false ? {} : TEXTS, ...(options.oldRecords === false ? {} : { contenthash: CONTENTHASH }),
          ...(options.giver === true ? { roles: {} } : { foreign: true })
        }
      },
      registrar: {}
    }
  })
  const prepares: { step: string, gas: number }[] = []
  const control: { declineAt: string | null, afterSend: ((step: string) => void) | null } = { declineAt: null, afterSend: null }
  const broadcaster = {
    async prepare (tx: { from: string, to: string, data: Uint8Array, gas: number }) {
      const step = STEP_OF[Array.from(tx.data.subarray(0, 4), (byte) => byte.toString(16).padStart(2, '0')).join('')] ?? 'other'
      if (control.declineAt === step) throw new ChainError('declined', 'the person declined')
      prepares.push({ step, gas: tx.gas })
      const hash = market.nextHash()
      return {
        hash,
        async send () {
          market.broadcast(tx, hash)
          control.afterSend?.(step)
          return hash
        }
      }
    }
  }
  const states: Record<string, any>[] = []
  /** A page that has just loaded: nothing is remembered from the one before. */
  const page = () => createMove({ chain: market.chain, broadcaster, clock: market.clock, keys: copyKeys(), pollMs: 10, pendingTimeoutMs: 5000, onState: (state) => { states.push(state) } })
  const sent = () => market.sent.map((one) => one.step)
  return { market, page, prepares, control, states, sent }
}

const resolverOf = (market: Market) => market.world.names['alice']?.resolver
const copiedTo = (market: Market) => market.world.resolvers[market.predicted]

describe('a move over a fake chain', () => {
  it('reads where it stands and offers the move, with the plan and what a copy would carry', async () => {
    const { page, sent } = setup()
    const ready = await page().check('alice', ALICE)
    expect(ready).toMatchObject({ phase: 'ready', label: 'alice', holder: ALICE })
    expect(ready['plan'].steps.map((step: any) => `${step.id}:${step.state}`)).toEqual(['deploy:pending', 'records:pending', 'resolver:pending'])
    expect(ready['plan'].copying).toMatchObject({ readable: true, count: 3 })
    expect(sent()).toEqual([])
  })

  it('moves a name off a resolver the factory does not vouch for: the resolver, the records, then the registry', async () => {
    const { market, page, prepares, sent } = setup()
    expect(await attribution(market.chain, 'alice', ALICE)).toMatchObject({ ok: false, owner: { ok: true }, roles: { ok: true }, records: { ok: false, problem: 'notPermissionedResolver' } })
    const done = await page().run('alice', ALICE, { copy: true })
    expect(done['phase']).toBe('done')
    expect(sent()).toEqual(['deploy', 'records', 'resolver'])
    expect(prepares.map((one) => one.step)).toEqual(['deploy', 'records', 'resolver'])
    expect(resolverOf(market)).toBe(market.predicted)
    expect(copiedTo(market)).toMatchObject({ addr: ALICE, texts: TEXTS, contenthash: CONTENTHASH })
    expect(done['facts'].attribution).toMatchObject({ ok: true, records: { ok: true, resolver: market.predicted } })
    expect(Object.keys(done['hashes'])).toEqual(['deploy', 'records', 'resolver'])
    expect(done['plan'].steps.map((step: any) => step.state)).toEqual(['done', 'done', 'done'])
  })

  it('moves a gifted name whose giver kept the resolver, and leaves the giver\'s records as they were', async () => {
    const { market, page } = setup({ giver: true })
    expect(await attribution(market.chain, 'alice', ALICE)).toMatchObject({ records: { ok: false, resolver: OLD, problem: 'textRoleMissing' } })
    expect((await page().run('alice', ALICE, { copy: true }))['phase']).toBe('done')
    expect(market.world.resolvers[OLD]).toMatchObject({ addr: GIVER, texts: TEXTS, contenthash: CONTENTHASH })
  })

  it('estimates each transaction as a public reveal is, and sends it with a quarter more gas', async () => {
    const { page, prepares } = setup()
    await page().run('alice', ALICE, { copy: true })
    expect(prepares.map((one) => one.gas)).toEqual([125_000, 125_000, 125_000])
  })

  it('sets only the address record when the person does not copy', async () => {
    const { market, page } = setup()
    expect((await page().run('alice', ALICE, { copy: false }))['phase']).toBe('done')
    expect(copiedTo(market)).toMatchObject({ addr: ALICE, texts: {} })
    expect(copiedTo(market)?.contenthash).toBeUndefined()
  })

  it('moves a name with no resolver at all, and one whose old resolver holds nothing to copy', async () => {
    const empty = setup({ oldRecords: false })
    expect(await empty.page().check('alice', ALICE)).toMatchObject({ phase: 'ready', plan: { copying: { count: 0 } } })
    expect((await empty.page().run('alice', ALICE, { copy: true }))['phase']).toBe('done')
    const none = setup({ name: { resolver: undefined } })
    expect((await none.page().run('alice', ALICE, { copy: true }))['phase']).toBe('done')
    expect(resolverOf(none.market)).toBe(none.market.predicted)
  })

  it('reuses the holder\'s resolver when it is already there, and sends two transactions', async () => {
    const { market, page, sent } = setup({ resolver: 'ours' })
    expect(await page().check('alice', ALICE)).toMatchObject({ phase: 'ready', plan: { next: 'records', started: true } })
    expect((await page().run('alice', ALICE, { copy: true }))['phase']).toBe('done')
    expect(sent()).toEqual(['records', 'resolver'])
    expect(resolverOf(market)).toBe(market.predicted)
  })
})

describe('a page that reloads halfway', () => {
  it('continues from the first step that is not done, whichever step the person stopped at', async () => {
    for (const [stopAt, remaining] of [['records', ['records', 'resolver']], ['resolver', ['resolver']]] as const) {
      const { market, page, control, sent } = setup()
      control.declineAt = stopAt
      const stopped = await page().run('alice', ALICE, { copy: true })
      expect(stopped).toMatchObject({ phase: 'failed', reason: 'declined', step: stopAt })
      const done = sent().length
      control.declineAt = null
      const again = page()
      const ready = await again.check('alice', ALICE)
      expect(ready).toMatchObject({ phase: 'ready', plan: { next: stopAt, started: true } })
      expect((await again.run('alice', ALICE, { copy: true }))['phase']).toBe('done')
      expect(sent().slice(done)).toEqual(remaining)
      expect(sent()).toEqual(['deploy', 'records', 'resolver'])
      expect(resolverOf(market)).toBe(market.predicted)
    }
  })

  it('has nothing left to do once the registry names the holder\'s resolver, and says so', async () => {
    const { page, sent } = setup()
    await page().run('alice', ALICE, { copy: true })
    const before = sent().length
    expect(await page().check('alice', ALICE)).toMatchObject({ phase: 'done' })
    expect((await page().run('alice', ALICE, { copy: true }))['phase']).toBe('done')
    expect(sent()).toHaveLength(before)
  })

  it('sets the records again when they were set without the copy and the person now wants it', async () => {
    const { market, page, control, sent } = setup()
    control.declineAt = 'resolver'
    expect(await page().run('alice', ALICE, { copy: false })).toMatchObject({ phase: 'failed', step: 'resolver' })
    expect(copiedTo(market)?.texts).toEqual({})
    control.declineAt = null
    const again = page()
    expect(await again.check('alice', ALICE, { copy: true })).toMatchObject({ phase: 'ready', plan: { next: 'records' } })
    expect((await again.run('alice', ALICE, { copy: true }))['phase']).toBe('done')
    expect(sent()).toEqual(['deploy', 'records', 'records', 'resolver'])
    expect(copiedTo(market)).toMatchObject({ texts: TEXTS, contenthash: CONTENTHASH })
  })

  it('trusts the chain over anything it was told: a step done elsewhere is not sent again', async () => {
    const { market, page, sent } = setup({ resolver: 'ours' })
    market.world.resolvers[market.predicted] = { extended: true, addr: ALICE, texts: TEXTS, contenthash: CONTENTHASH }
    expect(await page().check('alice', ALICE)).toMatchObject({ phase: 'ready', plan: { next: 'resolver' } })
    expect((await page().run('alice', ALICE, { copy: true }))['phase']).toBe('done')
    expect(sent()).toEqual(['resolver'])
  })
})

describe('a name that is not the address\'s to move', () => {
  const refusal = async (options: Setup, reason: string) => {
    const { page, sent } = setup(options)
    const checked = await page().check('alice', ALICE)
    expect(checked, reason).toMatchObject({ phase: 'refused', reason })
    expect(checked['words'].length).toBeGreaterThan(20)
    expect(await page().run('alice', ALICE, { copy: true }), reason).toMatchObject({ phase: 'refused', reason })
    expect(sent(), reason).toEqual([])
  }

  it('is refused, and nothing is sent, when another account holds a role on it', () => refusal({ name: { roleCount: OWNER_ROLES + (1n << 5n) } }, 'roles'))
  it('is refused when somebody else holds it', () => refusal({ name: { owner: GIVER } }, 'owner'))
  it('is refused when the holder does not hold the right to change the resolver', () => refusal({ name: { roleCount: 1n << 20n, roles: { [ALICE]: 1n << 20n } } }, 'setResolver'))
  it('is refused when something else sits where the holder\'s resolver goes', () => refusal({ resolver: 'foreign' }, 'resolverBlocked'))

  it('is not offered a move where the records are already held', async () => {
    const { market, page } = setup({ resolver: 'ours' })
    market.world.names['alice'] = { owner: ALICE, resolver: market.predicted }
    expect(await page().check('alice', ALICE)).toMatchObject({ phase: 'done' })
  })
})

describe('when a step goes wrong', () => {
  it('says which step failed, keeps the steps before it done, and goes on from it once it can', async () => {
    const { market, page, sent } = setup()
    market.hooks.revertMined = 'records'
    const flow = page()
    const failed = await flow.run('alice', ALICE, { copy: true })
    expect(failed).toMatchObject({ phase: 'failed', step: 'records', reason: 'reverted' })
    expect(failed['words']).toContain('Your resolver refused the records.')
    expect(failed['hash']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(failed['plan'].steps.map((step: any) => `${step.id}:${step.state}`)).toEqual(['deploy:done', 'records:failed', 'resolver:pending'])
    market.hooks.revertMined = null
    expect((await flow.run('alice', ALICE, { copy: true }))['phase']).toBe('done')
    expect(sent()).toEqual(['deploy', 'records', 'records', 'resolver'])
  })

  it('names a transaction the node says would fail, before anything is signed', async () => {
    const { market, prepares } = setup()
    const refusing = { ...market.chain, estimateGas: async () => { throw new ChainError('reverted', 'execution reverted') } }
    const flow = createMove({ chain: refusing, broadcaster: { prepare: async () => { throw new Error('nothing should be signed') } }, clock: market.clock, keys: copyKeys() })
    expect(await flow.run('alice', ALICE, { copy: true })).toMatchObject({ phase: 'failed', step: 'deploy', reason: 'reverted' })
    expect(prepares).toEqual([])
  })

  it('waits for the node to show the block of the last transaction before it reads again', async () => {
    const { market } = setup()
    const lag = { blocks: 0 }
    const behind = { ...market.chain, getBlock: async (ref: Parameters<typeof market.chain.getBlock>[0]) => {
      const block = await market.chain.getBlock(ref)
      return block !== null && lag.blocks > 0 ? { ...block, number: block.number - 1 } : block
    } }
    const broadcaster = { prepare: async (tx: any) => {
      const hash = market.nextHash()
      return { hash, send: async () => { market.broadcast(tx, hash); lag.blocks = 1; return hash } }
    } }
    const clock = { now: market.clock.now, sleep: async (ms: number) => { lag.blocks = 0; await market.clock.sleep(ms) } }
    const flow = createMove({ chain: behind, broadcaster, clock, keys: copyKeys(), pollMs: 10 })
    expect((await flow.run('alice', ALICE, { copy: true }))['phase']).toBe('done')
    expect(market.sent.map((one) => one.step)).toEqual(['deploy', 'records', 'resolver'])
  })

  it('fails with words, and sends nothing more, when the chain never shows the holder able to write the records', async () => {
    const { market, page, control, sent } = setup()
    control.afterSend = (step) => { if (step === 'resolver') market.world.resolvers[market.predicted]!.rolesRevert = true }
    const failed = await page().run('alice', ALICE, { copy: true })
    expect(failed).toMatchObject({ phase: 'failed', during: 'verifying', words: NOT_YET_HELD })
    expect(sent()).toEqual(['deploy', 'records', 'resolver'])
  })

  it('reports a node that cannot be read without a plan', async () => {
    const { market, control } = setup()
    const dead = { ...market.chain, getBlock: async () => { throw new ChainError('unavailable', 'the node is gone') } }
    const flow = createMove({ chain: dead, broadcaster: { prepare: async () => { throw new Error('unreachable') } }, clock: market.clock, keys: copyKeys() })
    expect(control.declineAt).toBeNull()
    expect(await flow.check('alice', ALICE)).toMatchObject({ phase: 'failed', during: 'reading', reason: 'unavailable' })
  })
})
