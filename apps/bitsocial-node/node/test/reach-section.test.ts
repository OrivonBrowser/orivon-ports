// The reach section of the node dashboard over the Worker's own reach calls: the node's word and its reason in a person's words, the
// circuits, the puts, the traffic, and the relay a person names: saved, seen holding a place, and removed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkRelay } from '../worker/config.js'
import { describeReach, REACH_API_PATH, reachApi } from '../worker/reach-api.js'
import { REASONS, reachabilityOf } from '../worker/reachability.js'
import { REASON_WORDS } from '../../page/dashboard/reach-words.js'
import { fakeTimers, ready, refusal, settle } from './support/mount-dashboard.js'

const AUTH = 'reach-section-test-key-0123456789ab'
const RELAY_PEER = '12D3KooWRelayRelayRelayRelayRelayRelayRelayRelay1'
const RELAY = `/dns4/relay.example.com/tcp/4001/p2p/${RELAY_PEER}`
const OTHER = '/ip4/145.40.68.9/tcp/4001/p2p/12D3KooWOtherOtherOtherOtherOtherOtherOtherOther2'
beforeEach(fakeTimers)
afterEach(() => { vi.useRealTimers() })

type Setup = { status?: Record<string, unknown> | null, supported?: boolean, node?: string, relay?: string, bandwidth?: unknown, restartError?: Error }

/** A node: the Worker's reach API over a stand-in network that keeps the named relay in memory, reached the way a page reaches it. */
function node (setup: Setup = {}) {
  const live = { status: setup.status === undefined ? { peer: 'Qm', reachability: 'private', basis: 'symmetric-nat', source: 'node', autonat: 'unknown', listen: [], external: [], relays: 0, circuits: [] as string[], puts: { pending: 2, ok: 7, retries: 1, superseded: 0, gaveUp: 0 }, punch: null, peers: 9 } as Record<string, unknown> | null : setup.status, relay: setup.relay as string | undefined, holds: false, restarts: 0 }
  const network = {
    state: async () => {
      const status = live.status === null ? null : { ...live.status, circuits: live.holds && live.relay !== undefined ? [`${live.relay}/p2p-circuit`] : [], relays: live.holds ? 1 : 0 }
      return describeReach({ status: status as never, bandwidth: (setup.bandwidth === undefined ? { TotalIn: 4_096, TotalOut: 1_000_000, RateIn: 12, RateOut: 2_000 } : setup.bandwidth) as never, relay: { relay: live.relay, source: live.relay === undefined ? 'none' : 'saved' }, supported: setup.supported !== false, node: setup.node ?? 'up' })
    },
    setRelay: async (address: unknown) => { if (setup.restartError !== undefined) throw setup.restartError; live.relay = checkRelay(address); live.restarts += 1 },
    removeRelay: async () => { live.relay = undefined; live.holds = false; live.restarts += 1 }
  }
  const door = reachApi({ authKey: AUTH, network })
  const calls: Array<[string, Record<string, unknown>]> = []
  const reach = vi.fn(async (call: string, body: Record<string, unknown> = {}) => {
    calls.push([call, body])
    const answer = await door.handle(new Request(`http://127.0.0.1:6473${REACH_API_PATH}${call}`, { method: 'POST', headers: { Authorization: `Bearer ${AUTH}` }, body: JSON.stringify(body) }))
    const value = (await answer.json()) as { Message: string }
    if (!answer.ok) throw refusal(answer.status, value.Message)
    return value
  })
  return { live, calls, handle: { reused: false, ports: { rpc: 9138 }, gatewayUrl: 'http://localhost:6473', stats: async () => ({ peer: 'Qm', peers: 1, reachability: 'public', repoBytes: 1, storageMax: 2 }), reach } }
}

const open = (made: ReturnType<typeof node>) => ready({ handle: made.handle, app: { name: 'seedit', term: 'community', features: ['reach'] } })

describe('what shows the section', () => {
  it('is the app naming the feature and the node answering the reach calls', async () => {
    const found = await open(node())
    expect(found.by('[data-nd-section="reach"]').hidden).toBe(false)
    expect(found.win['nodeDashboard']).toMatchObject({ sections: { reach: { shown: true } } })
    expect((await ready({ handle: node().handle, app: { name: 'seedit', features: ['name'] } })).by('[data-nd-section="reach"]')).toBeNull()
  })

  it('is hidden by a node that cannot report how it is reached (503) and one that does not know the call (403, 404)', async () => {
    for (const status of [503, 403, 404]) {
      const refusing = { reused: false, ports: { rpc: 1 }, gatewayUrl: 'x', stats: async () => ({}), reach: async () => { throw refusal(status, 'no') } }
      expect((await ready({ handle: refusing, app: { name: 'seedit', features: ['reach'] } })).by('[data-nd-section="reach"]').hidden, String(status)).toBe(true)
    }
  })

  it('says the node did not answer when the call fails for another reason, and keeps the section', async () => {
    const failing = { reused: false, ports: { rpc: 1 }, gatewayUrl: 'x', stats: async () => ({}), reach: async () => { throw new Error('socket closed') } }
    const found = await ready({ handle: failing, app: { name: 'seedit', features: ['reach'] } })
    expect(found.by('[data-nd-section="reach"]').hidden).toBe(false)
    expect(found.text('[role="alert"]')).toContain('socket closed')
  })
})

describe('what the section says of how the node is reached', () => {
  it('gives the node\'s state, its reason in words, the peers, the puts and the traffic', async () => {
    const found = await open(node())
    expect(found.text('[data-nd-reach="node"]')).toBe('Running')
    expect(found.text('[data-nd-reach="reach"]')).toBe('Not reachable from the internet (behind a router)')
    expect(found.by('[data-nd-reach="reach"]').getAttribute('data-nd-state')).toBe('private')
    expect(found.text('[data-nd-reach="why"]')).toBe(REASON_WORDS['symmetric-nat'])
    expect(found.text('[data-nd-reach="peers"]')).toBe('9')
    expect(found.text('[data-nd-reach="puts"]')).toBe('2 waiting, 7 sent, 1 tried again, 0 given up')
    expect(found.text('[data-nd-reach="traffic"]')).toBe('In 4 kB (12 B/s), out 1.0 MB (2 kB/s)')
    expect(found.text('[data-nd-reach="circuits"]')).toBe('None')
  })

  it('says each reason in its own words, whatever state it comes with', async () => {
    for (const [reason, words] of Object.entries(REASON_WORDS)) {
      const made = node({ status: { peer: 'Qm', reachability: 'unknown', basis: reason, source: 'node', autonat: 'unknown', listen: [], external: [], relays: 0, circuits: [], puts: null, punch: null, peers: 1 } })
      expect((await open(made)).text('[data-nd-reach="why"]'), reason).toBe(words)
    }
  })

  it('shows a reason a newer node adds as the node says it, and a node that did not answer as not known', async () => {
    const newer = node({ status: { peer: 'Qm', reachability: 'public', basis: 'brand-new', source: 'node', autonat: 'unknown', listen: [], external: [], relays: 0, circuits: [], puts: null, punch: null, peers: null } })
    const found = await open(newer)
    expect(found.text('[data-nd-reach="why"]')).toBe('The node says: brand-new.')
    expect(found.text('[data-nd-reach="peers"]')).toBe('Not known')
    expect(found.text('[data-nd-reach="puts"]')).toBe('Not reported')
    const silent = await open(node({ status: null, node: 'restarting' }))
    expect(silent.text('[data-nd-reach="reach"]')).toBe('Not known: the node did not answer')
    expect(silent.text('[data-nd-reach="node"]')).toBe('Restarting')
  })

  it('lists the relays holding a place for the node, and marks the one a person named', async () => {
    const made = node({ relay: RELAY })
    made.live.holds = true
    const found = await open(made)
    expect(found.text('[data-nd-reach="circuits"]')).toBe(`${RELAY} (the one you named)`)
  })
})

describe('the relay field', () => {
  it('explains why a relay helps and that Orivon names none, and says the node starts again on save', async () => {
    const found = await open(node())
    expect(found.text('[data-nd-reach="relay-why"]')).toContain('Behind a home router')
    expect(found.text('[data-nd-reach="relay-why"]')).toContain('Orivon names no relay')
    expect(found.text('[data-nd-form="reach-relay"]')).toContain('starts again')
    expect(found.text('[data-nd-reach="relay"]')).toBe('No relay is named.')
    expect(found.by('[data-nd-action="remove-relay"]').hidden).toBe(true)
  })

  it('saves the relay a person types, restarts the node with it, and says when it holds a place', async () => {
    const made = node()
    const found = await open(made)
    found.by('[data-nd-input="relay"]').type(`  ${RELAY}  `)
    found.by('[data-nd-form="reach-relay"]').dispatch('submit')
    await settle()
    expect(made.calls.at(-1)).toEqual(['relay/set', { relay: RELAY }])
    expect(made.live.restarts).toBe(1)
    expect(found.text('[data-nd-message]')).toContain('starts again')
    expect(found.text('[data-nd-reach="relay"]')).toContain('holds no place for the node yet')
    expect(found.by('[data-nd-reach="relay"]').getAttribute('data-nd-holds')).toBe('false')
    expect(found.by('[data-nd-input="relay"]').value).toBe(RELAY)
    expect(found.by('[data-nd-action="remove-relay"]').hidden).toBe(false)
    made.live.holds = true
    await found.refresh()
    expect(found.text('[data-nd-reach="relay"]')).toBe(`${RELAY}: it holds a place for the node.`)
    expect(found.by('[data-nd-reach="relay"]').getAttribute('data-nd-holds')).toBe('true')
  })

  it('removes the relay, restarts the node without it, and empties the field', async () => {
    const made = node({ relay: RELAY })
    made.live.holds = true
    const found = await open(made)
    expect(found.by('[data-nd-input="relay"]').value).toBe(RELAY)
    found.by('[data-nd-action="remove-relay"]').click()
    await settle()
    expect(made.calls.some(([call]) => call === 'relay/remove')).toBe(true)
    expect(made.live.relay).toBeUndefined()
    expect(found.by('[data-nd-input="relay"]').value).toBe('')
    expect(found.text('[data-nd-reach="relay"]')).toBe('No relay is named.')
    expect(found.text('[data-nd-reach="circuits"]')).toBe('None')
  })

  it('shows the node\'s refusal of an address beside the field, and asks for an address when none is typed', async () => {
    const made = node()
    const found = await open(made)
    found.by('[data-nd-input="relay"]').type('not a relay')
    found.by('[data-nd-form="reach-relay"]').dispatch('submit')
    await settle()
    expect(found.text('[data-nd-error="relay"]')).toMatch(/relay/i)
    expect(made.live.restarts).toBe(0)
    found.by('[data-nd-input="relay"]').type('')
    found.by('[data-nd-form="reach-relay"]').dispatch('submit')
    await settle()
    expect(found.text('[data-nd-error="relay"]')).toBe('Type the relay address, or use Remove.')
    found.by('[data-nd-input="relay"]').type(OTHER)
    expect(found.text('[data-nd-error="relay"]')).toBe('')
  })

  it('keeps what a person is typing while the page refreshes', async () => {
    const found = await open(node())
    found.by('[data-nd-input="relay"]').type('/dns4/half')
    await found.refresh()
    expect(found.by('[data-nd-input="relay"]').value).toBe('/dns4/half')
  })

  it('says a node that takes no relay takes none, and offers no form', async () => {
    const found = await open(node({ supported: false }))
    expect(found.text('[data-nd-reach="relay"]')).toBe('This build of the node takes no relay.')
    expect(found.by('[data-nd-form="reach-relay"]').hidden).toBe(true)
  })

  it('says a refusal that names no relay in the form\'s own message', async () => {
    const found = await open(node({ restartError: Object.assign(new Error('the node did not start'), {}) }))
    found.by('[data-nd-input="relay"]').type(RELAY)
    found.by('[data-nd-form="reach-relay"]').dispatch('submit')
    await settle()
    expect(found.text('[data-nd-message]').length).toBeGreaterThan(0)
  })
})

describe('REASONS and the words', () => {
  it('has a sentence for every reason the Worker knows', () => {
    expect(Object.keys(REASON_WORDS).sort()).toEqual(Object.keys(REASONS).sort())
  })

  it('has one for every reason the Worker gives when the node says none', () => {
    const punch = (state: string, extra = {}) => ({ state, relaysKnown: 1, relaysHeld: 1, punched: 0, failed: 0, ...extra })
    const circuit = '/ip4/198.51.100.4/tcp/4001/p2p/12D3KooWRelay/p2p-circuit/p2p/12D3KooWnode'
    const reasons = [
      { autonat: 'public' }, { punch: punch('ready', { punched: 1 }) }, { relays: [circuit], namedRelay: '12D3KooWRelay' }, { punch: punch('ready') }, { punch: punch('ready', { failed: 1 }) },
      { punch: punch('checking') }, { punch: punch('symmetric-nat') }, { punch: punch('no-public-relay') }, {}, { autonat: 'private' }
    ].map((one) => reachabilityOf({ autonat: 'unknown', external: [], relays: [], punch: null, ...one } as never).basis)
    for (const reason of reasons) expect(Object.keys(REASON_WORDS), reason).toContain(reason)
  })
})
