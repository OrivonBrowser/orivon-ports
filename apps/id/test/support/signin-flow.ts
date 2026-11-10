// One whole sign-in, both halves and the bridge between them, as the code runs them: the relying site asks and keeps its request,
// the ID site makes a challenge and sends the person to the bridge, the bridge forwards the kept request, the ID site reads it
// back and signs through the Chain, the bridge lands the answer and the relying site takes it. Tests start from the answer and break it.

import { connectEntry } from '../../site/connect-model.js'
import { signIn, startChallenge, takeChallenge } from '../../site/connect-request.js'
import { runBridge } from '../../site/sdk/bridge.js'
import { requestSignIn, takeAnswer, type Store } from '../../site/sdk/connect.js'
import type { Chain } from '../../site/sdk/chain.js'
import { bridgeUrl, checkRequest, ID_ORIGIN, type Request, type SignInResponse } from '../../site/sdk/protocol.js'
import { appKey, type AppKey } from '../../site/sdk/key.js'
import { fakeId } from './fake-id.ts'
import { NOW, ORIGIN, SIGNER } from './signin-world.ts'

export function memoryStore (): Store & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value) }, removeItem: (key) => { items.delete(key) } }
}

/**
 * `requestSignIn` for a site whose own storage is `storage`. The request is always kept where the bridge page reads it, the page's
 * `localStorage`, so the call runs with that global standing in for the site's storage.
 */
export async function requestOn (storage: Store, request: Parameters<typeof requestSignIn>[0], options: Parameters<typeof requestSignIn>[1] = {}) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
  try {
    return await requestSignIn(request, options)
  } finally {
    if (had === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
    else Object.defineProperty(globalThis, 'localStorage', had)
  }
}

/** A request as the ID site reads it from a confirmation, for a test that signs without the two hops. */
export function testRequest (parts: { origin?: string, nonce?: string, state?: string, key?: string, ttl?: number } = {}): Request {
  const checked = checkRequest({
    audience: parts.origin ?? ORIGIN,
    nonce: parts.nonce ?? 'k3Jf92LmQp0xZ7aT',
    ...(parts.state === undefined ? {} : { state: parts.state }),
    ...(parts.key === undefined ? {} : { delegate: parts.key, ttl: String(parts.ttl ?? 86_400) })
  })
  if (!checked.ok) throw new Error(`a request that does not pass: ${checked.reason}`)
  return checked.request
}

/** The bytes a test's random source gives: a fixed pattern per seed. */
export const seeded = (seed: number) => (bytes: Uint8Array) => bytes.map((_, index) => (index * 31 + seed) % 256)

export interface Flow {
  response: SignInResponse
  /** The request the consent screen showed. */
  request: Request
  /** The relying site's storage. */
  storage: ReturnType<typeof memoryStore>
  /** The ID site's tab storage. */
  tab: ReturnType<typeof memoryStore>
  key: AppKey
  id: Awaited<ReturnType<typeof fakeId>>
  /** The link the relying site sent the person to. */
  url: string
  /** The nonce the relying site holds. */
  nonce: string
  challenge: string
}

export interface FlowOptions {
  chain: Chain
  labels?: string[]
  withKey?: boolean
  ttl?: number
  lifetime?: number
  state?: string
  now?: number
  address?: string
  origin?: string
  random?: number
  after?: string
}

/** The relying site asks, the ID site signs, the relying site takes the answer. */
export async function runFlow (options: FlowOptions): Promise<Flow> {
  const { chain, labels = ['alice'], withKey = false, ttl = 2_592_000, state, now = NOW, address = SIGNER, origin = ORIGIN, after = '/callback' } = options
  const id = await fakeId()
  const key = await appKey({ id: id.id }, { origin })
  const storage = memoryStore()
  const tab = memoryStore()
  const seed = options.random ?? 7
  const url = await requestOn(storage, { after, ...(withKey ? { delegate: true, ttl } : {}), ...(state === undefined ? {} : { state }) }, { orivon: { id: id.id }, origin, now, random: seeded(seed) })

  const started = startChallenge({ storage: tab, audience: origin, now, random: seeded(seed + 1) })
  if (started === null) throw new Error('the tab would not keep the challenge')
  const bridge = (location: { search: string, hash: string }, referrer: string) => runBridge({
    location: { origin, ...location }, referrer, framed: false, storage, replace: () => {}, clearHash: () => {}, broadcast: () => {}, now
  })

  const forward = bridge({ search: new URL(started.url).search, hash: '' }, `${ID_ORIGIN}/`)
  if (forward.outcome !== 'forwarded' || forward.url === undefined) throw new Error(`the bridge did not forward the request: ${forward.outcome}`)
  const entry = connectEntry({ hash: new URL(forward.url).hash, referrer: bridgeUrl(origin, started.c), framed: false, now, challenges: { take: () => takeChallenge(tab) } })
  if (entry.kind !== 'consent') throw new Error(`the ID site refused the relying site's request: ${JSON.stringify(entry)}`)
  const lifetime = options.lifetime ?? ttl
  const signed = await signIn({ request: entry.request, chain, address, labels, now, ...(withKey ? { lifetime } : {}) })
  const back = new URL(signed.url)
  const landed = bridge({ search: back.search, hash: back.hash }, `${ID_ORIGIN}/`)
  if (landed.outcome !== 'landed') throw new Error(`the bridge did not land the answer: ${landed.outcome}`)
  const answer = takeAnswer({ storage, now })
  if (answer?.kind !== 'response') throw new Error('the answer did not read back')
  return { response: answer.response, request: entry.request, storage, tab, key, id, url, nonce: entry.request.nonce, challenge: started.c }
}
