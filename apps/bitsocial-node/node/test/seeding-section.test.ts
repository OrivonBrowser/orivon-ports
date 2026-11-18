// The seeding section of the node dashboard over the Worker's own seeding calls and scheduler (stand-in node and communities): off by
// default, the switch, the space limit, the list with what each community holds, adding and removing one, and the app's own word.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesOf, splitSize, toBytes } from '../../page/dashboard/format.js'
import { SEEDING_API_PATH, seedingApi } from '../worker/seeding-api.js'
import { cids, fillCids, passEnds, record, seeder } from './support/seeding-fakes.js'
import { fakeTimers, ready, refusal, settle } from './support/mount-dashboard.js'

const AUTH = 'seeding-section-test-key-0123456789'
beforeAll(async () => { await fillCids() })
beforeEach(fakeTimers)
afterEach(() => { vi.useRealTimers() })

/** A node: the Worker's seeding API over a seeder with a stand-in node, reached the way a page reaches it. */
function node (over: Parameters<typeof seeder>[0] = {}, none = false) {
  const kept = seeder(over)
  kept.made.begin()
  const door = seedingApi({ authKey: AUTH, seeder: none ? null : kept.made })
  const calls: Array<[string, Record<string, unknown>]> = []
  const seeding = vi.fn(async (call: string, body: Record<string, unknown> = {}) => {
    calls.push([call, body])
    const answer = await door.handle(new Request(`http://127.0.0.1:6473${SEEDING_API_PATH}${call}`, { method: 'POST', headers: { Authorization: `Bearer ${AUTH}` }, body: JSON.stringify(body) }))
    const value = (await answer.json()) as { Message: string }
    if (!answer.ok) throw refusal(answer.status, value.Message)
    return value
  })
  return { ...kept, calls, handle: { reused: false, ports: { rpc: 9138 }, gatewayUrl: 'http://localhost:6473', stats: async () => ({ peer: 'Qm', peers: 1, reachability: 'public', repoBytes: 1, storageMax: 2 }), seeding } }
}

const app = (term: 'board' | 'community' = 'community') => ({ name: term === 'board' ? '5chan' : 'seedit', term, features: ['seeding'] })
const NOW = 1_000 + 120_000
const inCard = (found: Awaited<ReturnType<typeof view>>, address: string, selector: string) => found.by(`[data-nd-seeded="${address}"]`).querySelector(selector)!

async function view (made: ReturnType<typeof node>, term: 'board' | 'community' = 'community') {
  return ready({ handle: made.handle, app: app(term), now: () => NOW })
}

describe('what shows the section', () => {
  it('is the app naming the feature and the node answering the seeding calls', async () => {
    const found = await view(node())
    expect(found.by('[data-nd-section="seeding"]')).not.toBeNull()
    expect(found.by('[data-nd-section="seeding"]').hidden).toBe(false)
    expect(found.win['nodeDashboard']).toMatchObject({ sections: { seeding: { shown: true } } })
    const other = await ready({ handle: node().handle, app: { name: 'seedit', term: 'community', features: ['name'] } })
    expect(other.by('[data-nd-section="seeding"]')).toBeNull()
  })

  it('is hidden by a node with no seeding (503) and by one that does not know the call (403, 404)', async () => {
    expect((await view(node({}, true))).by('[data-nd-section="seeding"]').hidden).toBe(true)
    for (const status of [403, 404]) {
      const refusing = { reused: false, ports: { rpc: 1 }, gatewayUrl: 'x', stats: async () => ({}), seeding: async () => { throw refusal(status, 'no') } }
      expect((await ready({ handle: refusing, app: app() })).by('[data-nd-section="seeding"]').hidden, String(status)).toBe(true)
    }
  })

  it('says the node did not answer when the call fails for another reason, and keeps the section', async () => {
    const failing = { reused: false, ports: { rpc: 1 }, gatewayUrl: 'x', stats: async () => ({}), seeding: async () => { throw new Error('socket closed') } }
    const found = await ready({ handle: failing, app: app() })
    expect(found.by('[data-nd-section="seeding"]').hidden).toBe(false)
    expect(found.text('[role="alert"]')).toContain('socket closed')
  })
})

describe('seeding, off by default', () => {
  it('says it is off with nothing to seed, the limit it will use, and no list', async () => {
    const found = await view(node())
    expect(found.text('[data-nd-seeding="switch"]')).toBe('Off')
    expect(found.text('[data-nd-action="toggle"]')).toBe('Turn seeding on')
    expect(found.text('[data-nd-seeding="used"]')).toBe('0 B of 1.00 GB')
    expect(found.text('[data-nd-seeding="last-run"]')).toBe('Seeding is off')
    expect(found.by('[data-nd-input="limit"]').value).toBe('1')
    expect(found.by('[data-nd-input="limit-unit"]').value).toBe('GB')
    expect(found.text()).toContain('No community to seed yet')
  })

  it('turns on with the switch, and each followed community is listed with what it holds', async () => {
    const made = node({ sizes: { [cids[0]!]: 1_500, [cids[1]!]: 2_500, [cids[2]!]: 1_000 } })
    made.net.records.set('one.bso', record(0))
    const found = await view(made)
    await made.handle.seeding('follow', { addresses: ['one.bso'] })
    found.by('[data-nd-action="toggle"]').click()
    await settle()
    await made.made.settled()
    await found.refresh()
    expect(made.calls.map(([call]) => call)).toContain('enable')
    expect(found.text('[data-nd-seeding="switch"]')).toBe('On')
    expect(found.text('[data-nd-action="toggle"]')).toBe('Turn seeding off')
    const card = found.by('[data-nd-seeded="one.bso"]')
    expect(card.querySelector('.nd-badge')!.textContent).toBe('Held')
    expect(card.querySelector('[data-nd-bytes]')!.textContent).toBe('5 kB in 3 files')
    expect(card.textContent).toContain('Followed in seedit')
    expect(found.text('[data-nd-seeding="used"]')).toBe('5 kB of 1.00 GB')
    expect(found.text('[data-nd-seeding="last-run"]')).toContain('1 of 1 held')
  })

  it('turns off with the switch, and says what that frees', async () => {
    const made = node()
    made.net.records.set('one.bso', record(0))
    made.made.follow(['one.bso'])
    made.made.enable()
    const found = await view(made)
    await made.made.settled()
    await found.refresh()
    found.by('[data-nd-action="toggle"]').click()
    await settle()
    expect(made.calls.map(([call]) => call)).toContain('disable')
    expect(found.text('[data-nd-seeding="switch"]')).toBe('Off')
    expect(found.text('[data-nd-message]')).toContain('freed')
    expect(made.node.pinned.size).toBe(0)
  })
})

describe('the space limit', () => {
  it('is entered in the largest unit that holds it, and every size reads back as the same bytes', () => {
    expect(splitSize(5e9)).toEqual({ value: '5', unit: 'GB' })
    expect(splitSize(2.5e9)).toEqual({ value: '2500', unit: 'MB' })
    expect(splitSize(1e12)).toEqual({ value: '1', unit: 'TB' })
    expect(splitSize(1_234_567)).toEqual({ value: '1.234567', unit: 'MB' })
    for (const bytes of [1e6, 2.5e9, 1e12, 1_234_567]) { const { value, unit } = splitSize(bytes); expect(toBytes(value, unit)).toBe(bytes) }
    expect([bytesOf(0), bytesOf(999), bytesOf(1_000), bytesOf(2_500_000)]).toEqual(['0 B', '999 B', '1 kB', '2.5 MB'])
  })

  it('shows the limit in the largest unit that holds it, and saves what a person types as bytes', async () => {
    const made = node()
    const found = await view(made)
    found.by('[data-nd-input="limit"]').type('500')
    found.by('[data-nd-input="limit-unit"]').value = 'MB'
    found.by('[data-nd-input="limit-unit"]').dispatch('change')
    found.by('[data-nd-form="seeding-limit"]').dispatch('submit')
    await settle()
    expect(made.calls.at(-1)).toEqual(['limit', { bytes: 500_000_000 }])
    expect(found.text('[data-nd-seeding="used"]')).toBe('0 B of 500.0 MB')
    expect(found.by('[data-nd-input="limit"]').value).toBe('500')
    expect(found.by('[data-nd-input="limit-unit"]').value).toBe('MB')
    expect(found.text('[data-nd-message]')).toBe('Saved.')
  })

  it('does not overwrite what a person is typing when the page refreshes, and takes the node\'s value once saved', async () => {
    const made = node()
    const found = await view(made)
    found.by('[data-nd-input="limit"]').type('7')
    await found.refresh()
    expect(found.by('[data-nd-input="limit"]').value).toBe('7')
  })

  it('refuses text that is not a whole number above 0 before asking the node, and shows the node\'s refusal of a size outside its bounds', async () => {
    const made = node()
    const found = await view(made)
    for (const bad of ['', 'ten', '1.5', '0']) {
      found.by('[data-nd-input="limit"]').type(bad)
      found.by('[data-nd-form="seeding-limit"]').dispatch('submit')
      await settle()
      expect(found.text('[data-nd-error="limit"]'), bad).toBe('Enter a whole number above 0.')
    }
    expect(made.calls.some(([call]) => call === 'limit')).toBe(false)
    found.by('[data-nd-input="limit"]').type('5000')
    found.by('[data-nd-input="limit-unit"]').value = 'TB'
    found.by('[data-nd-form="seeding-limit"]').dispatch('submit')
    await settle()
    expect(found.text('[data-nd-error="limit"]')).toBe('Use a size from 1 MB to 1 TB.')
  })
})

describe('the list', () => {
  it('adds a community a person types, says what it is when the node refuses an address, and clears the field', async () => {
    const made = node()
    made.net.records.set('mine.bso', record(1))
    const found = await view(made)
    found.by('[data-nd-input="address"]').type('../bad')
    found.by('[data-nd-form="seeding-add"]').dispatch('submit')
    await settle()
    expect(found.text('[data-nd-error="address"]')).not.toBe('')
    found.by('[data-nd-input="address"]').type('mine.bso')
    found.by('[data-nd-form="seeding-add"]').dispatch('submit')
    await settle()
    expect(found.by('[data-nd-seeded="mine.bso"]')).not.toBeNull()
    expect(found.by('[data-nd-seeded="mine.bso"]').textContent).toContain('Added here')
    expect(found.by('[data-nd-input="address"]').value).toBe('')
    found.by('[data-nd-input="address"]').type('')
    found.by('[data-nd-form="seeding-add"]').dispatch('submit')
    await settle()
    expect(found.text('[data-nd-error="address"]')).toBe('Type the address of a community.')
  })

  it('takes a community out, lists it among those taken out, and puts it back on request', async () => {
    const made = node()
    made.made.follow(['one.bso', 'two.bso'])
    const found = await view(made)
    inCard(found, 'one.bso', '[data-nd-action="remove"]').click()
    await settle()
    expect(found.by('[data-nd-seeded="one.bso"]')).toBeNull()
    expect(found.by('[data-nd-seeded="two.bso"]')).not.toBeNull()
    expect(found.by('[data-nd-ignored="one.bso"]')).not.toBeNull()
    expect(found.text('h3.nd-section-title')).toContain('Communities you took out')
    found.by('[data-nd-ignored="one.bso"]').querySelector('[data-nd-action="add-back"]')!.click()
    await settle()
    expect(found.by('[data-nd-seeded="one.bso"]')).not.toBeNull()
    expect(found.by('[data-nd-ignored="one.bso"]')).toBeNull()
  })

  it('says why a community cannot be held: over the limit, and not readable', async () => {
    const made = node({ sizes: { [cids[0]!]: 3_000_000 } })
    made.net.records.set('big.bso', record(0))
    made.made.follow(['big.bso', 'dead.bso'])
    made.made.setLimit(1_000_000)
    made.made.enable()
    const found = await view(made)
    await passEnds(made.made, made.time)
    await found.refresh()
    expect(inCard(found, 'big.bso', '.nd-badge').textContent).toBe('Over the space limit')
    expect(inCard(found, 'dead.bso', '.nd-badge').textContent).toBe('Waiting for its record')
  })
})

describe('the app\'s own word', () => {
  it('says board in 5chan and community in seedit, and never the other', async () => {
    for (const [term, other] of [['board', /communit/i], ['community', /\bboards?\b/i]] as const) {
      const made = node()
      made.made.follow(['one.bso'])
      const found = await view(made, term)
      const words = found.text('[data-nd-section="seeding"]')
      expect(words, term).toMatch(new RegExp(term === 'board' ? 'boards you follow' : 'communities you follow'))
      expect(words, term).not.toMatch(other)
    }
  })
})

describe('what the lines say while the node works', () => {
  const answer = (over: Record<string, unknown>) => ({ enabled: true, limitBytes: 1_000_000_000, usedBytes: 219_000, working: false, lastRun: { at: 1_000, holding: 0, communities: 1 }, communities: [{ address: 'one.bso', origin: 'added', status: 'holding', bytes: 219_000, pins: 5, updatedAt: 1_000, recordAt: 1_000, error: null, topic: true }], ignored: [], ...over })
  const shown = async (state: Record<string, unknown>) => {
    const handle = { reused: false, ports: { rpc: 9138 }, gatewayUrl: 'http://localhost:6473', stats: async () => ({}), seeding: async () => state }
    return ready({ handle, app: app(), now: () => NOW })
  }

  it('says it is checking while a pass runs, not the result of the pass before, which held less', async () => {
    expect((await shown(answer({ working: true }))).text('[data-nd-seeding="last-run"]')).toBe('Checking now')
    expect((await shown(answer({ working: false }))).text('[data-nd-seeding="last-run"]')).toBe('2 min ago: 0 of 1 held')
  })

  it('names the button of a card for what it does, take it out of the list, and the empty list points at the form below it', async () => {
    const found = await shown(answer({}))
    expect(inCard(found, 'one.bso', '[data-nd-action="remove"]').textContent).toBe('Take it out')
    expect((await shown(answer({ communities: [] }))).text()).toContain('you can add one below')
  })
})
