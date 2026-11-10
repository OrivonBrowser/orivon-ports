// A registration wired to a fake market: a store that remembers every write, a broadcaster that records what it was
// asked to sign and send (and what the store held at the moment of sending), and a relay that can be told to fail.

import { createRegistration, storeKey } from '../../site/register-flow.js'
import { RelayError } from '../../site/relay.js'
import { fakeMarket, type Market, type MarketOptions } from './fake-market.ts'

export function memoryStore() {
  const map = new Map<string, string>()
  const writes: { key: string, value: string }[] = []
  return {
    map, writes,
    get: (key: string) => map.get(key) ?? null,
    set: (key: string, value: string) => { map.set(key, value); writes.push({ key, value }) },
    delete: (key: string) => { map.delete(key) }
  }
}

export type MemoryStore = ReturnType<typeof memoryStore>

export interface Harness {
  market: Market
  store: MemoryStore
  flow: ReturnType<typeof createRegistration>
  states: Record<string, any>[]
  prepares: { step: string, gas: number }[]
  sends: { step: string, private: boolean, stored: Record<string, any> | null }[]
  relay: { failure: RelayError | null, calls: number }
  crash: { on: string | null, error: Error }
  phases: () => string[]
}

let secrets = 0

export function harness(options: MarketOptions & { market?: Market, store?: MemoryStore, relay?: Harness['relay'], pollMs?: number, pendingTimeoutMs?: number, onState?: (state: Record<string, any>) => void }): Harness {
  const market = options.market ?? fakeMarket(options)
  const store = options.store ?? memoryStore()
  const relay = options.relay ?? { failure: null, calls: 0 }
  const crash: Harness['crash'] = { on: null, error: new Error('the tab was closed') }
  const states: Record<string, any>[] = []
  const prepares: Harness['prepares'] = []
  const sends: Harness['sends'] = []
  const broadcaster = {
    async prepare(tx: { from: string, to: string, data: Uint8Array, gas: number }) {
      const hash = market.nextHash()
      const step = stepName(tx.data)
      if (crash.on === step) throw crash.error
      prepares.push({ step, gas: tx.gas })
      return {
        hash,
        async send({ private: priv }: { private: boolean }) {
          const stored = store.get(storeKey(tx.from))
          sends.push({ step, private: priv, stored: stored === null ? null : JSON.parse(stored) })
          if (priv) {
            relay.calls++
            if (relay.failure !== null) throw relay.failure
          }
          market.broadcast(tx, hash)
          return hash
        }
      }
    }
  }
  const flow = createRegistration({
    chain: market.chain, broadcaster, store, clock: market.clock, pollMs: options.pollMs ?? 4000, pendingTimeoutMs: options.pendingTimeoutMs ?? 120_000,
    random: (bytes) => new Uint8Array(bytes).fill(++secrets % 250 + 1),
    onState: (state) => { states.push(state); options.onState?.(state) }
  })
  const phases = () => states.map((state) => String(state['phase'])).filter((phase, index, all) => phase !== all[index - 1])
  return { market, store, flow, states, prepares, sends, relay, crash, phases }
}

function stepName(data: Uint8Array): string {
  const head = Array.from(data.subarray(0, 4), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const steps: Record<string, string> = { f14fcbc8: 'commit', '095ea7b3': 'approve', '5d84121a': 'deploy', '787c7cf2': 'register', ac9650d8: 'records' }
  return steps[head] ?? 'other'
}
