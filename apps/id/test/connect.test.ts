import { describe, expect, it, vi } from 'vitest'
import { decode, encodeCall, ZERO_ADDRESS } from '../site/sdk/abi.js'
import { fromHex, toHex } from '../site/sdk/bytes.js'
import {
  clearPending, completeSignIn, DEFAULT_TTL, loadPending, PENDING_MAX_AGE, readResponse, requestSignIn, revokeAllCalldata, revokeAllCall, SignInRequestError
} from '../site/sdk/connect.js'
import { dnsEncode } from '../site/sdk/ens.js'
import { CLOCK_SKEW } from '../site/sdk/protocol.js'
import { compress } from '../site/sdk/p256.js'
import { fakeId } from './support/fake-id.ts'
import { memoryStore, runFlow } from './support/signin-flow.ts'
import { aliceWorld, NOW, ORIGIN, RESOLVER, signInChain } from './support/signin-world.ts'

const RETURN = `${ORIGIN}/callback`
const fixedRandom = (bytes: Uint8Array) => bytes.map((_, index) => index * 7 % 200)
const spy = () => {
  const calls: unknown[][] = []
  return { calls, history: { replaceState: (...args: unknown[]) => { calls.push(args) } } }
}

describe('making a request', () => {
  it('answers the URL for the ID site and keeps what the answer is checked against', () => {
    const storage = memoryStore()
    const url = requestSignIn({ returnUrl: RETURN, state: 'st-1' }, { storage, now: NOW, random: fixedRandom })
    const hash = new URL(url).hash
    expect(new URL(url).origin).toBe('https://id.orivonstack.eth')
    expect(hash).toMatch(/^#\/connect\?v=1&return=https%3A%2F%2Fapp\.example\.org%2Fcallback&nonce=[A-Za-z0-9]{32}&state=st-1$/)
    const pending = loadPending(storage)
    expect(pending).toEqual({ nonce: hash.match(/nonce=([A-Za-z0-9]+)/)?.[1], origin: ORIGIN, key: null, ttl: null, state: 'st-1', at: NOW })
  })

  it('makes a nonce of 32 letters and digits from the random bytes it is given, skipping bytes that would bias a letter', () => {
    const storage = memoryStore()
    requestSignIn({ returnUrl: RETURN }, { storage, now: NOW, random: (bytes) => bytes.fill(250).fill(3, 0, 5) })
    const nonce = loadPending(storage)?.nonce ?? ''
    expect(nonce).toHaveLength(32)
    expect(nonce).toMatch(/^[A-Za-z0-9]+$/)
  })

  it('does not repeat a nonce when the browser\'s random bytes differ', () => {
    const nonces = new Set<string>()
    for (let index = 0; index < 20; index++) {
      const storage = memoryStore()
      requestSignIn({ returnUrl: RETURN }, { storage, now: NOW })
      nonces.add(loadPending(storage)?.nonce ?? '')
    }
    expect(nonces.size).toBe(20)
  })

  it('asks for a key given as 33 bytes, 65 bytes or hex, with a lifetime of 30 days unless told', async () => {
    const { id } = await fakeId()
    const open = await id.publicKey({ curve: 'P-256' })
    const closed = compress(open) as Uint8Array
    for (const delegateKey of [closed, open, '0x' + toHex(closed), '0x' + toHex(open)]) {
      const storage = memoryStore()
      const hash = new URL(requestSignIn({ returnUrl: RETURN, delegateKey }, { storage, now: NOW })).hash
      expect(hash).toContain(`&delegate=0x${toHex(closed)}&ttl=${DEFAULT_TTL}`)
      expect(loadPending(storage)).toMatchObject({ key: '0x' + toHex(closed), ttl: DEFAULT_TTL })
    }
    const hash = new URL(requestSignIn({ returnUrl: RETURN, delegateKey: closed, ttl: 3600 }, { storage: memoryStore() })).hash
    expect(hash).toContain('&ttl=3600')
  })

  it('keeps only the request in flight', () => {
    const storage = memoryStore()
    requestSignIn({ returnUrl: RETURN, state: 'first' }, { storage, now: NOW })
    requestSignIn({ returnUrl: RETURN, state: 'second' }, { storage, now: NOW })
    expect(loadPending(storage)?.state).toBe('second')
    clearPending(storage)
    expect(loadPending(storage)).toBeNull()
  })

  const refused: [string, Parameters<typeof requestSignIn>[0], string][] = [
    ['an http return', { returnUrl: 'http://app.example.org/' }, 'returnNotHttps'],
    ['a return with a fragment', { returnUrl: `${RETURN}#x` }, 'returnHasFragment'],
    ['a key that is not a P-256 key', { returnUrl: RETURN, delegateKey: new Uint8Array(33) }, 'badKey'],
    ['a key as text that is not hex', { returnUrl: RETURN, delegateKey: 'key' }, 'badKey'],
    ['a ttl past 180 days', { returnUrl: RETURN, delegateKey: '0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978', ttl: 15_552_001 }, 'badTtl'],
    ['a ttl with no key', { returnUrl: RETURN, ttl: 600 }, 'ttlWithoutKey'],
    ['a state with a space', { returnUrl: RETURN, state: 'a b' }, 'badState']
  ]
  it.each(refused)('refuses %s, and keeps nothing', (_name, request, reason) => {
    const storage = memoryStore()
    expect(() => requestSignIn(request, { storage })).toThrow(SignInRequestError)
    try {
      requestSignIn(request, { storage })
    } catch (error) {
      expect((error as SignInRequestError).reason).toBe(reason)
    }
    expect(storage.items.size).toBe(0)
  })

  it('refuses when it cannot keep the request, since the answer could not be checked', () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
    expect(() => requestSignIn({ returnUrl: RETURN }, { storage: broken })).toThrow(expect.objectContaining({ reason: 'storage' }))
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('sessionStorage', undefined)
    expect(() => requestSignIn({ returnUrl: RETURN })).toThrow(expect.objectContaining({ reason: 'storage' }))
    vi.unstubAllGlobals()
  })

  it('keeps the request where a second tab of the page reads it, unless the page has no such store', () => {
    const local = memoryStore()
    const session = memoryStore()
    vi.stubGlobal('localStorage', local)
    vi.stubGlobal('sessionStorage', session)
    requestSignIn({ returnUrl: RETURN, state: 'tab' }, { now: NOW })
    expect(loadPending()?.state).toBe('tab')
    expect(local.items.size).toBe(1)
    expect(session.items.size).toBe(0)
    clearPending()
    expect(local.items.size).toBe(0)
    vi.stubGlobal('localStorage', undefined)
    requestSignIn({ returnUrl: RETURN, state: 'only-session' }, { now: NOW })
    expect(session.items.size).toBe(1)
    expect(loadPending()?.state).toBe('only-session')
    vi.unstubAllGlobals()
  })

  it('reads a damaged pending request as none', () => {
    const storage = memoryStore()
    for (const value of ['', '{', 'null', '{"nonce":1}', '[]', '{"nonce":"a","origin":"b","key":null,"ttl":"x","state":null,"at":1}']) {
      storage.setItem('orivonid.pending', value)
      expect(loadPending(storage), value).toBeNull()
    }
  })
})

describe('reading the answer', () => {
  const location = (hash: string) => ({ hash, pathname: '/callback', search: '?x=1' })

  it('decodes the response and takes the fragment out of the address bar', async () => {
    const env = signInChain()
    const flow = await runFlow({ chain: env.chain })
    const encoded = flow.response
    const { calls, history } = spy()
    const url = new URL((await import('../site/sdk/protocol.js')).successUrl(RETURN, encoded))
    expect(readResponse(location(url.hash), { history })).toEqual({ kind: 'response', response: encoded })
    expect(calls).toEqual([[null, '', '/callback?x=1']])
  })

  it('reads a cancellation, with its state or without', () => {
    const { calls, history } = spy()
    expect(readResponse(location('#orivonid-error=cancelled&state=st-1'), { history })).toEqual({ kind: 'error', error: 'cancelled', state: 'st-1' })
    expect(readResponse(location('#orivonid-error=cancelled'), { history })).toEqual({ kind: 'error', error: 'cancelled', state: null })
    expect(readResponse(location('#orivonid-error=invalid-request'), { history })).toEqual({ kind: 'error', error: 'invalid-request', state: null })
    expect(calls).toHaveLength(3)
  })

  it('leaves a fragment that is not ours alone, and answers nothing', () => {
    const { calls, history } = spy()
    for (const hash of ['', '#', '#/home', '#orivonidx=1', '#orivonid', '#orivonid-errors=cancelled', '#a=orivonid=1']) expect(readResponse(location(hash), { history }), hash).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('clears a fragment of ours that cannot be read, and says so', () => {
    const { calls, history } = spy()
    for (const hash of ['#orivonid=', '#orivonid=%%%', '#orivonid=e30', '#orivonid-error=', '#orivonid-error=lost', '#orivonid-error=cancelled&state=a b', '#orivonid-error=cancelled&state=', '#orivonid-error=cancelled&x=1']) {
      expect(readResponse(location(hash), { history }), hash).toEqual({ kind: 'malformed' })
    }
    expect(calls).toHaveLength(8)
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
