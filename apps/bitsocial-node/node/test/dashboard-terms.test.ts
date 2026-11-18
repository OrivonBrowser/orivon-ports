// The app's own word for what a node hosts: 5chan's dashboard says "board" in every section and seedit's says "community", in the
// sections a person meets and in the ones the app does not offer today, with the states that carry the most words.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD, COMMUNITY, termOf } from '../../page/dashboard/terms.js'
import { SECTIONS } from '../../page/node-dashboard.js'
import { describeChallenges, registerChallenges } from '../worker/challenges.js'
import { describeReach } from '../worker/reach-api.js'
import { fakeTimers, ready, refusal } from './support/mount-dashboard.js'

beforeEach(fakeTimers)
afterEach(() => { vi.useRealTimers() })

const ADDRESS = '12D3KooWBoardOne'
const BUILT_IN = { perPage: 15, pages: 10, bumpLimit: 300, archivePurgeSeconds: 172_800 }
const managed = { address: ADDRESS, hosted: false, started: true, managed: true, enabled: true, state: 'backoff', failures: 2, restarts: 1, lastError: 'it failed', lastErrorAt: 1, since: null, nextAttemptAt: null, archivedThreads: 3, config: {}, effective: BUILT_IN, capacity: 150 }
const status = { peer: 'Qm', reachability: 'private', basis: 'looking', source: 'node', autonat: 'unknown', listen: [], external: [], relays: 0, circuits: [], puts: null, punch: null, peers: 1 }
const registry: Record<string, unknown> = {}
registerChallenges(registry)
const LIST = describeChallenges(registry, { filesDir: '/files' })
const seeded = { enabled: true, limitBytes: 1e9, usedBytes: 5_000, working: false, lastRun: null, ignored: ['gone.bso'], communities: [{ address: 'one.bso', origin: 'followed', status: 'error', bytes: 0, pins: 0, updatedAt: null, recordAt: null, error: 'unreachable', topic: false }] }

function handle (record: Record<string, unknown>) {
  return {
    reused: false, ports: { rpc: 1 }, gatewayUrl: 'x', stats: async () => ({ peer: 'Qm', peers: 1, reachability: 'private', repoBytes: 1, storageMax: 2 }),
    manager: async (call: string) => (call === 'boards' ? { boards: [managed], defaults: BUILT_IN } : { set: {}, effective: BUILT_IN }),
    listing: async (call: string) => { if (call === 'boards') return { boards: [{ address: ADDRESS, publicKey: ADDRESS }] }; return record },
    names: async (call: string) => { if (call === 'boards') return { boards: [{ address: ADDRESS, publicKey: ADDRESS, name: null }] }; throw refusal(409, 'no resolver') },
    challenges: async (call: string) => {
      if (call === 'list') return structuredClone(LIST)
      if (call === 'boards') return { boards: [{ address: ADDRESS, publicKey: ADDRESS, started: true }] }
      return { address: ADDRESS, challenges: [{ name: '@bitsocial/wordfilter-challenge', exclude: [{ roles: ['moderator'] }] }, { name: '@orivon/id-challenge' }], otherSettings: ['pages'] }
    },
    seeding: async () => seeded,
    reach: async () => describeReach({ status: status as never, bandwidth: null, relay: { relay: undefined, source: 'none' }, supported: true, node: 'up' })
  }
}

const ALL = ['board-manager', 'listing', 'listing-signature', 'name', 'challenges', 'seeding', 'reach']
const fetchNone = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch

describe('the app\'s term', () => {
  it('is board unless the app says community', () => {
    expect(termOf({})).toBe(BOARD)
    expect(termOf({ term: 'board' })).toBe(BOARD)
    expect(termOf({ term: 'community' })).toBe(COMMUNITY)
    expect(COMMUNITY).toEqual({ board: 'community', boards: 'communities', Board: 'Community', Boards: 'Communities' })
  })

  it('is offered to every section the dashboard has: each one is drawn below', () => {
    expect(SECTIONS.map((section) => section.feature).sort()).toEqual([...ALL].sort())
  })
})

describe('every section says the app\'s word', () => {
  it.each([{ signable: true, published: false }, { signable: false, published: true }, { signable: true, published: true }])('seedit says community and never board, with a listing record of %o', async (record) => {
    const found = await ready({ handle: handle(record), app: { name: 'seedit', term: 'community', features: ALL, addressSetting: "seedit's Community Settings" }, fetch: fetchNone })
    const words = found.text()
    expect(found.root.querySelector(`[data-nd-challenge-board="${ADDRESS}"]`)).not.toBeNull()
    expect(words).toContain('communit')
    expect(words.match(/\b[Bb]oards?\b/g) ?? []).toEqual([])
  })

  it.each([{ signable: true, published: false }, { signable: false, published: true }])('5chan says board and never community, with a listing record of %o', async (record) => {
    const found = await ready({ handle: handle(record), app: { name: '5chan', term: 'board', features: ALL.filter((one) => one !== 'listing-signature'), addressSetting: "5chan's Board Settings" }, fetch: fetchNone })
    const words = found.text()
    expect(words).toContain('board')
    expect(words.match(/\bcommunit(?:y|ies)\b/gi) ?? []).toEqual([])
  })

  it('says it in the labels of the board manager\'s form too', async () => {
    const found = await ready({ handle: handle({}), app: { name: 'seedit', term: 'community', features: ['board-manager'] } })
    const labels = found.root.querySelectorAll('label').map((one) => one.textContent)
    expect(labels).toContain('Archive the oldest thread when the community has more than')
    expect(labels).toContain('Stop a thread moving up the community after')
  })
})
