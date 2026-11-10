import { describe, expect, it, vi } from 'vitest'
import { decode, encodeCall, ZERO_ADDRESS } from '../site/sdk/abi.js'
import { fromHex, toHex } from '../site/sdk/bytes.js'
import {
  clearPending, completeSignIn, DEFAULT_TTL, loadPending, onAnswer, PENDING_MAX_AGE, requestSignIn, revokeAllCalldata, revokeAllCall, SignInRequestError, takeAnswer
} from '../site/sdk/connect.js'
import { dnsEncode } from '../site/sdk/ens.js'
import { ANSWER_KEY, readAnswer, storeAnswer } from '../site/sdk/pending.js'
import { arrivalUrl, CLOCK_SKEW, encodeResponse } from '../site/sdk/protocol.js'
import { compress } from '../site/sdk/p256.js'
import { fakeId } from './support/fake-id.ts'
import { memoryStore, requestOn, runFlow } from './support/signin-flow.ts'
import { aliceWorld, NOW, ORIGIN, RESOLVER, signInChain } from './support/signin-world.ts'

const fixedRandom = (bytes: Uint8Array) => bytes.map((_, index) => index * 7 % 200)

describe('making a request', () => {
  it('answers the link for the ID site, which carries the audience and nothing else, and keeps the request', async () => {
    const storage = memoryStore()
    const url = await requestOn(storage, { state: 'st-1', after: '/signed-in' }, { origin: ORIGIN, now: NOW, random: fixedRandom })
    expect(url).toBe(arrivalUrl(ORIGIN))
    expect(new URL(url).hash).toBe('#/connect?v=2&aud=https%3A%2F%2Fapp.example.org')
    expect(loadPending(storage)).toMatchObject({ v: 2, origin: ORIGIN, key: null, ttl: null, state: 'st-1', after: '/signed-in', at: NOW })
    expect(loadPending(storage)?.nonce).toMatch(/^[A-Za-z0-9]{32}$/)
  })

  it('lands on the root unless told a path, and takes the origin of the page it runs on', async () => {
    const storage = memoryStore()
    vi.stubGlobal('location', { origin: ORIGIN })
    await requestOn(storage, {}, { now: NOW })
    vi.unstubAllGlobals()
    expect(loadPending(storage)).toMatchObject({ after: '/', origin: ORIGIN })
  })

  it('makes a nonce of 32 letters and digits from the random bytes it is given, skipping bytes that would bias a letter', async () => {
    const storage = memoryStore()
    await requestOn(storage, {}, { origin: ORIGIN, now: NOW, random: (bytes) => bytes.fill(250).fill(3, 0, 5) })
    const nonce = loadPending(storage)?.nonce ?? ''
    expect(nonce).toHaveLength(32)
    expect(nonce).toMatch(/^[A-Za-z0-9]+$/)
  })

  it('does not repeat a nonce when the browser\'s random bytes differ', async () => {
    const nonces = new Set<string>()
    for (let index = 0; index < 20; index++) {
      const storage = memoryStore()
      await requestOn(storage, {}, { origin: ORIGIN, now: NOW })
      nonces.add(loadPending(storage)?.nonce ?? '')
    }
    expect(nonces.size).toBe(20)
  })

  it('reads the key Orivon keeps for the origin itself, with a lifetime of 30 days unless told, and never takes one from the arguments', async () => {
    const { id } = await fakeId()
    const closed = compress(await id.publicKey({ curve: 'P-256' })) as Uint8Array
    const storage = memoryStore()
    const url = await requestOn(storage, { delegate: true }, { orivon: { id }, origin: ORIGIN, now: NOW })
    expect(url).toBe(arrivalUrl(ORIGIN))
    expect(loadPending(storage)).toMatchObject({ key: '0x' + toHex(closed), ttl: DEFAULT_TTL })
    await requestOn(storage, { delegate: true, ttl: 3600 }, { orivon: { id }, origin: ORIGIN, now: NOW })
    expect(loadPending(storage)).toMatchObject({ key: '0x' + toHex(closed), ttl: 3600 })
  })

  it('keeps only the request in flight', async () => {
    const storage = memoryStore()
    await requestOn(storage, { state: 'first' }, { origin: ORIGIN, now: NOW })
    await requestOn(storage, { state: 'second' }, { origin: ORIGIN, now: NOW })
    expect(loadPending(storage)?.state).toBe('second')
    clearPending(storage)
    expect(loadPending(storage)).toBeNull()
  })

  const refused: [string, Parameters<typeof requestSignIn>[0], string][] = [
    ['a key from the arguments (version 1)', { delegateKey: '0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978' } as never, 'olderOption'],
    ['a return address (version 1)', { returnUrl: `${ORIGIN}/callback` } as never, 'olderOption'],
    ['a delegate that is not true', { delegate: '0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978' } as never, 'badKey'],
    ['a ttl past 180 days', { delegate: true, ttl: 15_552_001 }, 'badTtl'],
    ['a ttl with no key', { ttl: 600 }, 'ttlWithoutKey'],
    ['a state with a space', { state: 'a b' }, 'badState'],
    ['an after on another host', { after: '//evil.example/' }, 'badAfter'],
    ['an after with a backslash', { after: '/\\evil.example' }, 'badAfter'],
    ['an after that is a URL', { after: 'https://evil.example/' }, 'badAfter'],
    ['an after that is not a path', { after: 'signed-in' }, 'badAfter']
  ]
  it.each(refused)('refuses %s, and keeps nothing', async (_name, request, reason) => {
    const storage = memoryStore()
    const { id } = await fakeId()
    const thrown = await requestOn(storage, request, { orivon: { id }, origin: ORIGIN }).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(SignInRequestError)
    expect((thrown as SignInRequestError).reason).toBe(reason)
    expect(storage.items.size).toBe(0)
  })

  it('refuses a key when it is not told where Orivon is, and an origin that is not an origin', async () => {
    const storage = memoryStore()
    await expect(requestOn(storage, { delegate: true }, { origin: ORIGIN })).rejects.toMatchObject({ reason: 'badKey' })
    await expect(requestOn(storage, {}, { origin: `${ORIGIN}/path` })).rejects.toMatchObject({ reason: 'audienceNotOrigin' })
    await expect(requestOn(storage, {}, { origin: 'http://app.example.org' })).rejects.toMatchObject({ reason: 'audienceNotHttps' })
    await expect(requestOn(storage, {}, {})).rejects.toMatchObject({ reason: 'missingAudience' })
    expect(storage.items.size).toBe(0)
  })

  it('refuses when it cannot keep the request, since the answer could not be checked', async () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
    await expect(requestOn(broken, {}, { origin: ORIGIN })).rejects.toMatchObject({ reason: 'storage' })
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('sessionStorage', undefined)
    await expect(requestSignIn({}, { origin: ORIGIN })).rejects.toMatchObject({ reason: 'storage' })
    vi.unstubAllGlobals()
  })

  it('refuses a storage option: the request is always kept where the bridge page reads it, so a site cannot point it elsewhere', async () => {
    const elsewhere = memoryStore()
    const local = memoryStore()
    vi.stubGlobal('localStorage', local)
    await expect(requestSignIn({}, { origin: ORIGIN, storage: elsewhere } as never)).rejects.toMatchObject({ reason: 'olderOption', field: 'storage' })
    expect(elsewhere.items.size).toBe(0)
    expect(local.items.size).toBe(0)
    vi.unstubAllGlobals()
  })

  it('keeps the request where a second tab of the page reads it, unless the page has no such store', async () => {
    const local = memoryStore()
    const session = memoryStore()
    vi.stubGlobal('localStorage', local)
    vi.stubGlobal('sessionStorage', session)
    await requestSignIn({ state: 'tab' }, { origin: ORIGIN, now: NOW })
    expect(loadPending()?.state).toBe('tab')
    expect(local.items.size).toBe(1)
    expect(session.items.size).toBe(0)
    clearPending()
    expect(local.items.size).toBe(0)
    vi.stubGlobal('localStorage', undefined)
    await requestSignIn({ state: 'only-session' }, { origin: ORIGIN, now: NOW })
    expect(session.items.size).toBe(1)
    expect(loadPending()?.state).toBe('only-session')
    vi.unstubAllGlobals()
  })

  it('reads a damaged pending request as none', () => {
    const storage = memoryStore()
    const good = { v: 2, origin: ORIGIN, nonce: 'n'.repeat(32), key: null, ttl: null, state: null, after: '/', at: NOW }
    for (const value of ['', '{', 'null', '{"nonce":1}', '[]', JSON.stringify({ ...good, ttl: 'x' }), JSON.stringify({ ...good, v: 1 }), JSON.stringify({ ...good, after: '//evil.example' }), JSON.stringify({ ...good, after: undefined })]) {
      storage.setItem('orivonid.pending', value)
      expect(loadPending(storage), value).toBeNull()
    }
    storage.setItem('orivonid.pending', JSON.stringify(good))
    expect(loadPending(storage)).toEqual(good)
  })
})

describe('reading the answer the bridge left', () => {
  const answer = async () => (await runFlow({ chain: signInChain().chain })).response

  it('takes the response once: the store is emptied before it is read', async () => {
    const storage = memoryStore()
    const response = await answer()
    expect(storeAnswer(storage, { kind: 'response', response }, NOW)).toBe(true)
    expect(takeAnswer({ storage, now: NOW + 5 })).toEqual({ kind: 'response', response })
    expect(storage.items.has(ANSWER_KEY)).toBe(false)
    expect(takeAnswer({ storage, now: NOW + 5 })).toBeNull()
  })

  it('takes a cancellation, with its state or without', () => {
    const storage = memoryStore()
    storeAnswer(storage, { kind: 'error', error: 'cancelled', state: 'st-1' }, NOW)
    expect(takeAnswer({ storage, now: NOW })).toEqual({ kind: 'error', error: 'cancelled', state: 'st-1' })
    storeAnswer(storage, { kind: 'error', error: 'cancelled', state: null }, NOW)
    expect(takeAnswer({ storage, now: NOW })).toEqual({ kind: 'error', error: 'cancelled', state: null })
  })

  it('answers none when nothing was left, when it is older than an hour, and when what is there is not an answer, and still empties the store', async () => {
    const storage = memoryStore()
    expect(takeAnswer({ storage, now: NOW })).toBeNull()
    storeAnswer(storage, { kind: 'response', response: await answer() }, NOW)
    expect(takeAnswer({ storage, now: NOW + PENDING_MAX_AGE + 1 })).toBeNull()
    expect(storage.items.has(ANSWER_KEY)).toBe(false)
    for (const text of ['', '{', 'null', '{"at":1}', JSON.stringify({ at: NOW, answer: { kind: 'response', response: { v: 1 } } }), JSON.stringify({ at: NOW, answer: { kind: 'error', error: 'invalid-request', state: null } }), JSON.stringify({ at: NOW, answer: { kind: 'error', error: 'cancelled', state: 'a b' } })]) {
      storage.setItem(ANSWER_KEY, text)
      expect(takeAnswer({ storage, now: NOW }), text).toBeNull()
      expect(storage.items.has(ANSWER_KEY), text).toBe(false)
    }
  })

  it('reads the fragment the ID site writes, and leaves one that is not ours alone', async () => {
    const response = await answer()
    expect(readAnswer(`#orivonid=${encodeResponse(response)}`)).toEqual({ kind: 'response', response })
    expect(readAnswer('#orivonid-error=cancelled&state=st-1')).toEqual({ kind: 'error', error: 'cancelled', state: 'st-1' })
    expect(readAnswer('#orivonid-error=cancelled')).toEqual({ kind: 'error', error: 'cancelled', state: null })
    for (const hash of ['', '#', '#/home', '#orivonidx=1', '#orivonid', '#orivonid-errors=cancelled', '#a=orivonid=1']) expect(readAnswer(hash), hash).toBeNull()
  })

  it('calls a fragment of ours that cannot be read malformed', () => {
    for (const hash of ['#orivonid=', '#orivonid=%%%', '#orivonid=e30', '#orivonid-error=', '#orivonid-error=lost', '#orivonid-error=invalid-request', '#orivonid-error=cancelled&state=a b', '#orivonid-error=cancelled&state=', '#orivonid-error=cancelled&x=1']) {
      expect(readAnswer(hash), hash).toEqual({ kind: 'malformed' })
    }
  })

  it('tells a tab that an answer was left, on the channel the bridge posts to, and stops when asked', () => {
    const channels: { name: string, onmessage: ((event: { data?: unknown }) => void) | null, closed: boolean }[] = []
    class FakeChannel {
      onmessage: ((event: { data?: unknown }) => void) | null = null
      closed = false
      constructor (public name: string) { channels.push(this) }
      close () { this.closed = true }
    }
    const handler = vi.fn()
    const stop = onAnswer(handler, { channel: FakeChannel })
    expect(channels.map((one) => one.name)).toEqual(['orivonid'])
    channels[0]?.onmessage?.({ data: { kind: 'answer' } })
    channels[0]?.onmessage?.({ data: { kind: 'other' } })
    channels[0]?.onmessage?.({ data: null })
    expect(handler).toHaveBeenCalledTimes(1)
    stop()
    expect(channels[0]?.closed).toBe(true)
  })

  it('does nothing in a browser without BroadcastChannel', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    expect(() => onAnswer(() => {})()).not.toThrow()
    vi.unstubAllGlobals()
  })
})

describe('finishing a sign-in', () => {
  async function started (options: Parameters<typeof runFlow>[0] extends infer T ? Partial<T> : never = {}) {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain, ...options })
    return { env, flow }
  }
  const finish = (env: ReturnType<typeof signInChain>, flow: Awaited<ReturnType<typeof runFlow>>, now = NOW + 30) =>
    completeSignIn(flow.response, { chain: env.chain, now, storage: flow.storage })

  it('checks the answer against the request that was kept, and verifies it', async () => {
    const { env, flow } = await started({ withKey: true, state: 'st' })
    expect(await finish(env, flow)).toMatchObject({ ok: true, key: flow.key.hex, names: ['alice.v1.orivonid.eth'] })
  })

  it('takes the request out once the answer is decided, so the same answer cannot be presented twice', async () => {
    const { env, flow } = await started()
    expect(await finish(env, flow)).toMatchObject({ ok: true })
    expect(loadPending(flow.storage)).toBeNull()
    expect(await finish(env, flow)).toEqual({ ok: false, failure: 'noPendingRequest' })
  })

  it('takes it out when the answer is bad too: a definite refusal is a verdict', async () => {
    const { env, flow } = await started()
    expect(await completeSignIn({ ...flow.response, address: '0x' + '11'.repeat(20) }, { chain: env.chain, now: NOW, storage: flow.storage })).toMatchObject({ ok: false })
    expect(loadPending(flow.storage)).toBeNull()
  })

  it('does not answer a request older than an hour, or one that was never made', async () => {
    const { env, flow } = await started()
    expect(await finish(env, flow, NOW + PENDING_MAX_AGE + 1)).toEqual({ ok: false, failure: 'noPendingRequest' })
    expect(await completeSignIn(flow.response, { chain: env.chain, now: NOW, storage: memoryStore() })).toEqual({ ok: false, failure: 'noPendingRequest' })
  })

  it('refuses an answer to another request: another nonce, or a state that was not sent', async () => {
    const { env, flow } = await started({ state: 'st' })
    const other = await runFlow({ chain: env.chain, random: 99, state: 'st' })
    expect(await completeSignIn(other.response, { chain: env.chain, now: NOW, storage: flow.storage })).toMatchObject({ failure: 'wrongNonce' })
    const second = await started({ state: 'st' })
    expect(await completeSignIn({ ...second.flow.response, state: 'other' }, { chain: second.env.chain, now: NOW, storage: second.flow.storage })).toMatchObject({ failure: 'wrongState' })
  })

  it('refuses a key the request did not ask for, and a lifetime longer than it asked', async () => {
    const env = signInChain()
    const asked = await runFlow({ chain: env.chain, withKey: true, ttl: 3600 })
    const stored = JSON.parse(asked.storage.getItem('orivonid.pending') as string)
    asked.storage.setItem('orivonid.pending', JSON.stringify({ ...stored, ttl: 600 }))
    expect(await completeSignIn(asked.response, { chain: env.chain, now: NOW, storage: asked.storage })).toMatchObject({ failure: 'badLifetime' })
    const plain = await runFlow({ chain: env.chain })
    const keyed = await runFlow({ chain: env.chain, withKey: true })
    plain.storage.setItem('orivonid.pending', JSON.stringify({ ...JSON.parse(plain.storage.getItem('orivonid.pending') as string), nonce: keyed.nonce }))
    expect(await completeSignIn(keyed.response, { chain: env.chain, now: NOW, storage: plain.storage })).toMatchObject({ failure: 'keyMismatch' })
  })

  it('takes the page\'s own origin when it is not the return URL\'s', async () => {
    const { env, flow } = await started()
    expect(await completeSignIn(flow.response, { chain: env.chain, now: NOW, storage: flow.storage, origin: 'https://elsewhere.example' })).toMatchObject({ failure: 'wrongAudience' })
  })
})

describe('ending all sign-ins', () => {
  it('builds the setText call that stores the time under the record the verifier reads', () => {
    const data = revokeAllCalldata('alice', 1_793_966_400)
    expect(toHex(data)).toBe(toHex(revokeAllCalldata('alice.v1.orivonid.eth', 1_793_966_400)))
    expect(toHex(data.subarray(0, 4))).toBe(toHex(encodeCall('setText(bytes,string,string)', ['0x00', '', '']).subarray(0, 4)))
    expect(decode(['bytes', 'string', 'string'], data.subarray(4))).toEqual([dnsEncode('alice.v1.orivonid.eth'), 'eth.orivonstack.id.not-before', '1793966400'])
  })

  it('refuses a name that is not a username, and a time that is not whole seconds', () => {
    for (const name of ['', 'Alice', 'a.b.v1.orivonid.eth', 'alice.orivonid.eth', 'al']) expect(() => revokeAllCalldata(name, NOW), name).toThrow(TypeError)
    expect(() => revokeAllCalldata('alice', NOW * 1000 + 0.5)).toThrow(TypeError)
    expect(() => revokeAllCalldata('alice', -1)).toThrow(TypeError)
  })

  it('sends it to the resolver the registry names for the username, with the time plus the clock allowance', async () => {
    const env = signInChain(aliceWorld())
    expect(await revokeAllCall(env.chain, 'alice', NOW)).toEqual({ to: RESOLVER, data: revokeAllCalldata('alice', NOW + CLOCK_SKEW) })
    expect(fromHex('0x' + toHex(revokeAllCalldata('alice', NOW))).length).toBeGreaterThan(100)
  })

  it('says so when the username has no resolver, or no holder', async () => {
    const env = signInChain(aliceWorld())
    env.world.names['alice']!.resolver = ZERO_ADDRESS
    await expect(revokeAllCall(env.chain, 'alice', NOW)).rejects.toThrow('no resolver')
    await expect(revokeAllCall(env.chain, 'alice', NOW)).rejects.toMatchObject({ name: 'RevokeError', reason: 'noResolver' })
    const orphan = signInChain(aliceWorld())
    orphan.world.names['alice']!.owner = ZERO_ADDRESS
    await expect(revokeAllCall(orphan.chain, 'alice', NOW)).rejects.toMatchObject({ reason: 'noOwner' })
  })
})
