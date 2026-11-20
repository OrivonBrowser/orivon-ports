import { describe, expect, it } from 'vitest'
import { encodeCall, toChecksumAddress, ZERO_ADDRESS } from '../site/sdk/abi.js'
import { toHex, utf8 } from '../site/sdk/bytes.js'
import { keyOf } from '../site/resolver/og-name.js'
import { CENSUS_FORMAT, type Census } from '../site/resolver/og-census.js'
import { inspectOg } from '../site/resolver/og-names.js'
import { IMPLEMENTATION, REGISTRY, UPGRADES, WRAPPER } from '../site/resolver/og-pins.js'
import { slotAddress } from '../site/resolver/og-answer.js'
import { createSession } from '../site/resolver/og-tail.js'
import { gateManage, verifyManage } from '../site/manage-flow.js'
import { menuOf, PREVIOUS_HOLDER, previewOf, recordChoices, requestOf } from '../site/manage-model.js'
import { actionWords, FIX_LABELS, manageDoneWords } from '../site/manage-words.js'
import { describeName } from '../site/search-model.js'
import { fakeChain, FIRST_BLOCK, worldOf, type NameState } from './support/og-world.ts'
import { VECTORS } from './support/og-vectors.ts'
import { ACCOUNT, RIVAL } from './support/linagee-world.ts'
import { harness } from './support/manage-harness.ts'

const ME = toChecksumAddress(`0x${'a1'.repeat(20)}`)
const OTHER = toChecksumAddress(`0x${'b2'.repeat(20)}`)
const SLOT = `0x${'12'.repeat(32)}`
const FIRST = `0x${'12'.repeat(32)}`
const SECOND = `0x${'34'.repeat(32)}`
const ZERO = `0x${'0'.repeat(64)}`
const LABEL = 'harbor'
const KEY = keyOf(LABEL)

const vector = (id: string) => VECTORS.find((one) => one.id === id)!
const census = (): Census => ({ format: CENSUS_FORMAT, block: FIRST_BLOCK - 1_000, blockHash: `0x${'00'.repeat(32)}`, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names: {} })

/** The view of one name as the page of it shows it to `account`. */
async function view (id: string, change?: (state: NameState) => void, options: { implementation?: string, account?: string } = {}) {
  const one = vector(id)
  const world = worldOf(one, { spread: 300 })
  change?.(world.names[one.label]!)
  if (options.implementation !== undefined) world.implementation = options.implementation
  const inspection = await inspectOg(fakeChain(world).chain, one.label, { session: createSession(), census: census() }, { latest: true })
  const facts = { key: inspection.key, ...inspection.reads, waitForWrap: ZERO_ADDRESS, wrapEnabled: true }
  return { label: one.label, view: describeName({ label: one.label, inspection, facts: facts as never, account: options.account ?? null }) }
}
const actions = (menu: ReturnType<typeof menuOf>) => menu.map((item) => item.action)

describe('what the page of a name offers for the registry\'s content slot', () => {
  it('offers both for a value a previous holder left, to the holder, and says why the value does not open', async () => {
    const { view: shown } = await view('registry-content-sellers-leftover')
    const menu = menuOf({ view: shown, account: OTHER })
    expect(actions(menu)).toEqual(expect.arrayContaining(['confirmSlot', 'clearSlot']))
    expect(actions(menu).indexOf('confirmSlot')).toBeLessThan(actions(menu).indexOf('clearSlot'))
    expect(actions(menu)).not.toContain('reconfirm')
    expect(actions(menu)).not.toContain('clear')
    expect(menu.find((item) => item.action === 'confirmSlot')).toMatchObject({ title: 'Confirm the registry\'s site as yours', calls: 'Linagee registry: setContent', attention: expect.stringMatching(/does not open for this name until you confirm it/) })
    expect(menu.find((item) => item.action === 'clearSlot')).toMatchObject({ title: 'Clear the registry\'s site', calls: 'Linagee registry: setContent', attention: null })
    expect(actionWords('confirmSlot', false).button).toBe('Confirm it as yours')
    expect(actionWords('clearSlot', false).button).toBe('Clear it')
    expect(actionWords('confirmSlot', false).words).toMatch(/the site the previous holder set will open for this name/)
  })

  it('offers only Clear it for a value that counts, and says the site is set', async () => {
    const { view: shown } = await view('registry-content-set-by-holder')
    const menu = menuOf({ view: shown, account: ME })
    expect(actions(menu)).toContain('clearSlot')
    expect(actions(menu)).not.toContain('confirmSlot')
    expect(menu.find((item) => item.action === 'clearSlot')?.attention).toBeNull()
    expect(menu.find((item) => item.action === 'setSite')?.attention).toBeNull()
  })

  it('offers only Clear it for a value no direct call wrote, and says it does not open', async () => {
    const one = vector('registry-content-through-a-contract')
    const { view: shown } = await view(one.id)
    const menu = menuOf({ view: shown, account: shown.holder! })
    expect(actions(menu)).toContain('clearSlot')
    expect(actions(menu)).not.toContain('confirmSlot')
    expect(menu.find((item) => item.action === 'clearSlot')?.attention).toMatch(/does not count, so Orivon does not open it/)
  })

  it('offers Clear it, and no confirmation, when the history could not be vouched for', async () => {
    const { view: shown } = await view('text-record-and-slot-with-holders-setters', undefined, { implementation: `0x${'cd'.repeat(20)}` })
    expect(shown.rows.map((row) => row.reason)).toEqual(['unverified', 'unverified'])
    const menu = menuOf({ view: shown, account: ME })
    expect(actions(menu)).toEqual(expect.arrayContaining(['reconfirm', 'clear', 'clearSlot']))
    expect(actions(menu)).not.toContain('confirmSlot')
    expect(menu.find((item) => item.action === 'clearSlot')?.attention).toBeNull()
  })

  it('offers nothing for the slot of a wrapped name, one it holds none for, or one the account does not hold', async () => {
    const wrapped = await view('wrapped-passes', (state) => { state.registryContent = SLOT })
    expect(wrapped.view.rows.find((row) => row.slot === true)?.reason).toBe('registry-content-on-a-wrapped-name')
    const wrappedMenu = actions(menuOf({ view: wrapped.view, account: wrapped.view.holder! }))
    expect(wrappedMenu).toContain('unwrap')
    expect(wrappedMenu).not.toContain('clearSlot')
    expect(wrappedMenu).not.toContain('confirmSlot')
    const empty = await view('unwrapped-passes', undefined, { account: ME })
    expect(actions(menuOf({ view: empty.view, account: vector('unwrapped-passes').state.registryOwner }))).not.toEqual(expect.arrayContaining(['clearSlot']))
    const left = await view('registry-content-sellers-leftover')
    expect(menuOf({ view: left.view, account: ME })).toEqual([])
  })

  it('keeps the slot out of the text records the confirm-again and clear actions work on', async () => {
    const { view: shown, label } = await view('text-record-and-slot-with-holders-setters')
    expect(recordChoices(shown).map((one) => one.key)).toEqual(['content.ipfs'])
    const clear = requestOf('clear', { keys: ['content.ipfs', 'registry.content'] }, { view: shown, account: ME, label })
    expect(clear.request).toMatchObject({ keys: ['content.ipfs'] })
    const wrap = requestOf('wrap', {}, { view: shown, account: ME, label })
    expect(wrap.request.keep).toEqual([{ key: 'content.ipfs', text: expect.stringMatching(/^ipfs:\/\//) }])
    const only = await view('registry-content-set-by-holder')
    expect(menuOf({ view: only.view, account: ME }).map((item) => item.action)).not.toEqual(expect.arrayContaining(['reconfirm']))
  })

  it('asks for the value it showed, and previews the one write with its gas', async () => {
    const { view: shown, label } = await view('registry-content-sellers-leftover')
    for (const action of ['confirmSlot', 'clearSlot'] as const) {
      const { request, problem } = requestOf(action, {}, { view: shown, account: OTHER, label })
      expect(problem).toBeNull()
      expect(request).toMatchObject({ action, label, account: OTHER, slot: shown.facts.registryContent })
      const preview = previewOf(request, shown)
      expect(preview.problem).toBeNull()
      expect(preview.steps.map((step) => step.kind)).toEqual(['setContent'])
      expect(preview.limit).toBe(preview.steps[0]!.gas)
      expect(preview.expected).toBeGreaterThan(0)
    }
    expect(slotAddress(shown.facts.registryContent!)).toBe(shown.rows.find((row) => row.slot === true)?.value)
    expect(PREVIOUS_HOLDER).toBe(shown.rows.find((row) => row.slot === true)?.reason)
  })
})

describe('what a finished change to the registry\'s slot says', () => {
  const costs = { gasUsed: 0, feeWei: 10n ** 15n, tipWei: 0n }
  const done = (action: string) => manageDoneWords({ name: 'harbor.og', action, costs, steps: [{ kind: 'setContent', state: 'done', hash: '0xab' }], facts: null, request: {} })

  it('says a confirmed value opens for the name and a cleared one is gone, and when Orivon shows it', () => {
    expect(done('confirmSlot').title).toBe('The registry\'s site of harbor.og is confirmed as yours.')
    expect(done('confirmSlot').lines.join(' ')).toMatch(/written again from your address/)
    expect(done('clearSlot').title).toBe('The registry\'s site of harbor.og is cleared.')
    expect(done('clearSlot').lines.join(' ')).toMatch(/nothing a previous holder wrote there can be opened through this name/)
    for (const action of ['confirmSlot', 'clearSlot']) expect(done(action).lines.join(' '), action).toMatch(/in Orivon's address bar shows this change in about 13 minutes/)
  })

  it('has a label for the action that would put a refusal right', () => {
    expect(FIX_LABELS.clearSlot).toBe('Clear the registry\'s site')
    expect(FIX_LABELS.confirmSlot).toBe('Confirm the registry\'s site as yours')
  })
})

type Setup = ReturnType<typeof harness>['setup']
/** One transaction mined as `from`, with the call encoded the way a wallet encodes it. */
function send (setup: Setup, from: string, signature: string, ...args: unknown[]): string {
  const nonce = setup.world.state.nonces[from.toLowerCase()] ?? 0
  return setup.mine(utf8(JSON.stringify({ from, to: REGISTRY, data: toHex(encodeCall(signature, [KEY, ...args])), value: '0x0', gas: 300_000, nonce })))
}
/** A name `RIVAL` reserved, wrote a site to, and gave to the account: the account holds a slot a previous holder wrote. */
function leftBehind (setup: Setup, value = FIRST) {
  send(setup, RIVAL, 'reserve(bytes32)')
  send(setup, RIVAL, 'setContent(bytes32,bytes32)', value)
  send(setup, RIVAL, 'transfer(bytes32,address)', ACCOUNT)
}
const ipfsOf = (value: string) => slotAddress(value)!
const ids = (shown: Record<string, any>) => shown['steps'].map((step: Record<string, any>) => step['id'])

describe('clearing and confirming the registry\'s slot through the flow, over a simulated registry', () => {
  it('confirms a value a previous holder left: it does not count before, one setContent of the same value later it does', async () => {
    const made = harness()
    leftBehind(made.setup)
    expect(await made.answer(LABEL)).toEqual([])
    expect((await made.inspect(LABEL)).verdict?.registry).toMatchObject({ counts: false, reason: PREVIOUS_HOLDER, value: FIRST })
    const shown = await made.run({ action: 'confirmSlot', label: LABEL, slot: FIRST })
    expect(shown['phase']).toBe('done')
    expect(ids(shown)).toEqual(['setContent'])
    expect(made.labels()).toEqual(['reserve', 'setContent', 'transfer', 'setContent'])
    expect(made.setup.world.state.content[KEY]).toBe(FIRST)
    expect((await made.inspect(LABEL)).verdict?.registry).toMatchObject({ counts: true, reason: 'passes', value: FIRST })
    expect(await made.answer(LABEL)).toEqual([{ type: 'ipfs', value: ipfsOf(FIRST) }])
  })

  it('clears a value a previous holder left, and the resolver finds the slot empty', async () => {
    const made = harness()
    leftBehind(made.setup)
    const shown = await made.run({ action: 'clearSlot', label: LABEL, slot: FIRST })
    expect(shown['phase']).toBe('done')
    expect(ids(shown)).toEqual(['setContent'])
    expect(made.setup.world.state.content[KEY]).toBe(ZERO)
    expect((await made.inspect(LABEL)).verdict?.registry).toMatchObject({ counts: false, reason: 'empty' })
    expect(await made.answer(LABEL)).toEqual([])
  })

  it('clears a value that counts too: clearing a site the holder set is a choice', async () => {
    const made = harness()
    send(made.setup, ACCOUNT, 'reserve(bytes32)')
    send(made.setup, ACCOUNT, 'setContent(bytes32,bytes32)', SECOND)
    expect(await made.answer(LABEL)).toEqual([{ type: 'ipfs', value: ipfsOf(SECOND) }])
    const shown = await made.run({ action: 'clearSlot', label: LABEL })
    expect(shown['phase']).toBe('done')
    expect(await made.answer(LABEL)).toEqual([])
  })

  it('is signed as one transaction, and costs one write', async () => {
    const made = harness()
    leftBehind(made.setup)
    const shown = await made.run({ action: 'confirmSlot', label: LABEL, slot: FIRST })
    expect(shown['costs'].gasUsed).toBeGreaterThan(0)
    expect(shown['steps'][0].gas).toBe(45_000)
    expect(made.setup.world.signatures).toBe(1)
  })

  it('refuses with a reason, signing nothing, when the slot changed since the page read it, when it holds nothing, and for a wrapped name', async () => {
    const made = harness()
    leftBehind(made.setup)
    const changed = await made.run({ action: 'confirmSlot', label: LABEL, slot: SECOND })
    expect(changed['phase']).toBe('refused')
    expect(changed['problem']).toMatch(/changed since this page read it/)
    expect(made.setup.world.signatures).toBe(0)
    const empty = harness({ owner: { [KEY]: ACCOUNT } })
    expect((await empty.run({ action: 'clearSlot', label: LABEL }))['problem']).toMatch(/stores no site/)
    const wrapped = harness({ owner: { [KEY]: WRAPPER }, content: { [KEY]: FIRST }, nameToId: { [KEY]: 5n }, idToName: { '5': KEY }, tokenOwner: { '5': ACCOUNT }, nextId: 6n })
    const refused = await wrapped.run({ action: 'clearSlot', label: LABEL })
    expect(refused).toMatchObject({ phase: 'refused', fix: 'unwrap' })
    expect(wrapped.setup.world.signatures).toBe(0)
  })

  it('stops with "did not do what it should" when the name moved to another account before the write, which the registry answers with a success that does nothing', async () => {
    const made = harness()
    leftBehind(made.setup)
    made.setup.world.before.set(made.setup.world.log.length, (state) => { state.owner[KEY] = RIVAL })
    const shown = await made.run({ action: 'clearSlot', label: LABEL, slot: FIRST })
    expect(shown['phase']).toBe('stopped')
    expect(shown['outcome']).toMatchObject({ kind: 'unexpected', at: 'setContent' })
    expect(made.setup.world.state.content[KEY]).toBe(FIRST)
  })
})

describe('the rule of the setContent step', () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    key: KEY, registryOwner: ACCOUNT, nameToId: 0n, idToName: null, ownerOf: null, controller: ACCOUNT, registryContent: SLOT, values: {}, waitForWrap: ZERO_ADDRESS, wrapEnabled: true, ...over
  }) as never
  const step = (value: string) => ({ kind: 'setContent', id: 'setContent', value }) as never
  const context = { account: ACCOUNT, created: false }

  it('is sent only by the registry\'s owner of the name', () => {
    expect(gateManage(step(ZERO), facts(), context)).toEqual({ ok: true })
    expect(gateManage(step(ZERO), facts({ registryOwner: RIVAL }), context)).toEqual({ ok: false, stop: 'taken' })
    expect(gateManage(step(ZERO), facts({ registryOwner: WRAPPER }), context)).toEqual({ ok: false, stop: 'taken' })
  })

  it('is accepted only when the slot holds what it wrote, in either case of the digits', () => {
    expect(verifyManage(step(ZERO), facts({ registryContent: ZERO }), context)).toEqual({ ok: true })
    expect(verifyManage(step(ZERO), facts(), context)).toEqual({ ok: false, stop: 'unexpected' })
    expect(verifyManage(step(SLOT), facts({ registryContent: SLOT.toUpperCase().replace('0X', '0x') }), context)).toEqual({ ok: true })
    expect(verifyManage(step(SLOT), facts({ registryContent: ZERO }), context)).toEqual({ ok: false, stop: 'unexpected' })
    expect(verifyManage(step(ZERO), facts({ registryContent: null }), context)).toEqual({ ok: false, stop: 'unexpected' })
  })
})
