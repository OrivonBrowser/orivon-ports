// Stand-ins for what seeding runs on: the node's pin, provide and gc calls, communities that answer when asked, a clock a test moves,
// and a store in memory. The scheduler's tests and the dashboard section's tests share them.
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { canonical } from '../../kubo/ipfs.js'
import { createSeeder } from '../../worker/seeding.js'
import { blank, normalise } from '../../worker/seeding-store.js'

export const MB = 1024 ** 2
export const cids: string[] = []
/** Makes the CIDs the fakes use; a test file calls it once, in `beforeAll`. */
export async function fillCids () {
  for (let index = 0; index < 40; index++) cids.push(CID.createV1(0x55, await sha256.digest(new TextEncoder().encode(`block ${String(index)}`))).toString())
}

/** The node's pin, provide and gc calls in memory. `sizes` is what each pin weighs. */
export function fakeNode (sizes: Record<string, number> = {}) {
  const pinned = new Map<string, number>()
  const node = {
    pinned, provided: new Set<string>(), joined: [] as string[], gcs: 0, failPin: null as string | null, unfindable: null as string | null, timesOut: null as string | null, hang: new Set<string>(), hangProvide: new Set<string>(), hangUnpin: new Set<string>(), pinsCalls: 0, hangPinsFrom: null as number | null, provideError: null as number | null, order: [] as string[],
    async pin (cid: string, signal?: AbortSignal) { node.order.push(`pin ${cid}`); if (node.hang.has(cid)) await new Promise<never>((_, reject) => { signal?.addEventListener('abort', () => { reject(Object.assign(new Error('the pin was cancelled'), { name: 'AbortError' })) }) }); if (node.failPin === cid) throw new Error(`the node cannot fetch ${cid}`); if (node.unfindable === cid) throw Object.assign(new Error('no provider has this block'), { status: 404 }); if (node.timesOut === cid) throw Object.assign(new Error('retrieval timeout'), { status: 504 }); pinned.set(canonical(cid), sizes[cid] ?? 100) },
    async unpin (cid: string) { node.order.push(`unpin ${cid}`); if (node.hangUnpin.has(cid)) await new Promise<never>(() => {}); return pinned.delete(canonical(cid)) },
    async pins (signal?: AbortSignal) {
      node.pinsCalls += 1
      if (node.hangPinsFrom !== null && node.pinsCalls >= node.hangPinsFrom) await new Promise<never>((_, reject) => { signal?.addEventListener('abort', () => { reject(Object.assign(new Error('the pin list was cancelled'), { name: 'AbortError' })) }) })
      return [...pinned].map(([cid, bytes]) => ({ cid, blocks: 1, bytes }))
    },
    async provide (cid: string, _recursive?: boolean, signal?: AbortSignal) { if (node.hangProvide.has(cid)) await new Promise<never>((_, reject) => { signal?.addEventListener('abort', () => { reject(Object.assign(new Error('the announce was cancelled'), { name: 'AbortError' })) }) }); if (node.provideError !== null) throw Object.assign(new Error('full'), { status: node.provideError }); node.provided.add(cid) },
    async unprovide (cid: string) { node.order.push(`unprovide ${cid}`); return node.provided.delete(cid) },
    async repoGc () { node.gcs += 1; return [] },
    async pubsubSubscribe (topic: string) { node.joined.push(topic); return { body: null } }
  }
  return node
}

export type SeededRecord = { updatedAt: number, updateCid: string, posts: { pageCids: Record<string, string> }, pubsubTopic: string, postUpdates?: Record<string, string> }
export const record = (index: number, at = 1): SeededRecord => ({ updatedAt: at, updateCid: cids[index * 3]!, posts: { pageCids: { hot: cids[index * 3 + 1]!, new: cids[index * 3 + 2]! } }, pubsubTopic: `topic-${String(index)}` })

/** Communities that answer when asked: `known` holds the record each one has, and a test changes it and calls `changed`. */
export function fakeNetwork () {
  const records = new Map<string, SeededRecord | null>()
  const listeners = new Map<string, Array<() => void>>()
  const opened: string[] = []
  const stopped: string[] = []
  const net = {
    records, opened, stopped, slowStop: false, slowOpen: new Set<string>(), active: 0, peak: 0,
    changed (address: string) { for (const listener of listeners.get(address) ?? []) listener() },
    async open (address: string) {
      opened.push(address)
      if (net.slowOpen.has(address)) await new Promise<never>(() => {})
      net.active += 1
      net.peak = Math.max(net.peak, net.active)
      return {
        record: () => records.get(address) ?? null,
        onUpdate: (listener: () => void) => { listeners.set(address, [...(listeners.get(address) ?? []), listener]); return () => { listeners.set(address, (listeners.get(address) ?? []).filter((one) => one !== listener)) } },
        stop: () => { stopped.push(address); net.active -= 1; return net.slowStop ? new Promise<void>(() => {}) : Promise.resolve() }
      }
    }
  }
  return net
}

export function clockOf () {
  let now = 1_000
  const timers: Array<{ at: number, then: () => void, live: boolean }> = []
  return {
    clock: { now: () => now, after: (ms: number, then: () => void) => { const timer = { at: now + ms, then, live: true }; timers.push(timer); return () => { timer.live = false } } },
    advance (ms: number) { now += ms; for (const timer of timers.filter((one) => one.live && one.at <= now)) { timer.live = false; timer.then() } }
  }
}

export function memoryStore (first = blank()) {
  let kept = JSON.stringify(first)
  return { directory: '/seeding', read: () => normalise(JSON.parse(kept)), write: (state: unknown) => { kept = JSON.stringify(state) }, raw: () => JSON.parse(kept) }
}

export function seeder (over: { sizes?: Record<string, number>, hosted?: Array<{ address: string }>, store?: ReturnType<typeof memoryStore>, node?: ReturnType<typeof fakeNode>, net?: ReturnType<typeof fakeNetwork>, timing?: Record<string, number> } = {}) {
  const node = over.node ?? fakeNode(over.sizes)
  const net = over.net ?? fakeNetwork()
  const store = over.store ?? memoryStore()
  const time = clockOf()
  const warnings: string[] = []
  let hosted = over.hosted ?? []
  const made = createSeeder({ store: store as never, node: node as never, open: net.open as never, hosted: () => hosted, clock: time.clock, warn: (line) => { warnings.push(line) }, ...(over.timing === undefined ? {} : { timing: over.timing }) })
  return { made, node, net, store, time, warnings, setHosted (next: Array<{ address: string }>) { hosted = next } }
}


/** Runs the clock forward until the seeder has nothing left to wait for: a community with no record keeps a pass waiting until the time it waits is up. */
export async function passEnds (made: { settled: () => Promise<void>, state: () => { working: boolean } }, time: { advance: (ms: number) => void }) {
  for (let round = 0; round < 60; round++) {
    for (let hop = 0; hop < 50; hop++) await Promise.resolve()
    if (!made.state().working) return
    time.advance(120_001)
  }
  await made.settled()
}
