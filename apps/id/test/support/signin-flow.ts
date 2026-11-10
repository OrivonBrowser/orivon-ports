// One whole sign-in, both halves, as the code runs them: the relying site makes a request, the ID site reads it,
// signs through the Chain, and the answer is read back out of a fragment. Tests start from the answer and break it.

import { parseRequest, signIn } from '../../site/connect-request.js'
import { readResponse, requestSignIn, type Store } from '../../site/sdk/connect.js'
import type { Chain } from '../../site/sdk/chain.js'
import type { SignInResponse } from '../../site/sdk/protocol.js'
import { appKey, type AppKey } from '../../site/sdk/key.js'
import { fakeId } from './fake-id.ts'
import { NOW, ORIGIN, SIGNER } from './signin-world.ts'

export function memoryStore (): Store & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value) }, removeItem: (key) => { items.delete(key) } }
}

export interface Flow {
  response: SignInResponse
  request: Extract<ReturnType<typeof parseRequest>, { ok: true }>['request']
  storage: ReturnType<typeof memoryStore>
  key: AppKey
  id: Awaited<ReturnType<typeof fakeId>>
  url: string
  /** The nonce the relying site holds. */
  nonce: string
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
}

/** The relying site asks, the ID site signs, the relying site reads the answer. */
export async function runFlow (options: FlowOptions): Promise<Flow> {
  const { chain, labels = ['alice'], withKey = false, ttl = 2_592_000, state, now = NOW, address = SIGNER, origin = ORIGIN } = options
  const id = await fakeId()
  const key = await appKey({ id: id.id }, { origin })
  const storage = memoryStore()
  const seed = options.random ?? 7
  const url = requestSignIn({
    returnUrl: `${origin}/callback`,
    ...(withKey ? { delegateKey: key.publicKey, ttl } : {}),
    ...(state === undefined ? {} : { state })
  }, { storage, now, random: (bytes) => bytes.map((_, index) => (index * 31 + seed) % 256) })
  const parsed = parseRequest(new URL(url).hash)
  if (!parsed.ok) throw new Error(`the ID site refused the relying site's request: ${parsed.reason}`)
  const lifetime = options.lifetime ?? ttl
  const signed = await signIn({ request: parsed.request, chain, address, labels, now, ...(withKey ? { lifetime } : {}) })
  const back = new URL(signed.url)
  const answer = readResponse({ hash: back.hash, pathname: back.pathname, search: back.search }, { history: { replaceState: () => {} } })
  if (answer?.kind !== 'response') throw new Error('the answer did not read back')
  return { response: answer.response, request: parsed.request, storage, key, id, url, nonce: parsed.request.nonce }
}
