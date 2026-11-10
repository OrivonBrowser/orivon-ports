import { describe, expect, it, vi } from 'vitest'
import { toHex } from '../site/sdk/bytes.js'
import { ChainError } from '../site/sdk/chain.js'
import { keccak256 } from '../site/sdk/keccak.js'
import { advisePrivate, createRelay, PRIVATE_ADVISED_UP_TO, RELAY, RELAY_WORDS, RelayError } from '../site/relay.js'
import { orivonBroadcaster, walletBroadcaster } from '../site/register-send.js'
import { fakeOrivon } from './support/fake-orivon.ts'

const RAW = new Uint8Array([2, 0xf8, 0x70, 1, 2, 3, 4, 5])
const HASH = '0x' + toHex(keccak256(RAW))
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

const granted = [{ capability: 'https.connect', patterns: ['rpc.flashbots.net:443'] }]
const answers = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init })

function fakeApp(grants: typeof granted, decision = true) {
  const app = {
    grants: vi.fn(async () => grants),
    requestGrant: vi.fn(async (_request: { capability: string, patterns: string[] }) => { if (decision) grants.push(...granted); return decision })
  }
  return app
}

describe('the grant', () => {
  it('asks Orivon once for the one host, only when told to, and never before', async () => {
    const app = fakeApp([])
    const fetcher = vi.fn()
    const relay = createRelay({ fetch: fetcher as never, app })
    expect(app.requestGrant).not.toHaveBeenCalled()
    expect(await relay.granted()).toBe(false)
    expect(await relay.allow()).toBe(true)
    expect(app.requestGrant).toHaveBeenCalledTimes(1)
    expect(app.requestGrant).toHaveBeenCalledWith({ capability: 'https.connect', patterns: ['rpc.flashbots.net:443'] })
    expect(await relay.allow()).toBe(true)
    expect(app.requestGrant).toHaveBeenCalledTimes(1)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('answers false when the person says no, or the question cannot be asked', async () => {
    expect(await createRelay({ app: fakeApp([], false) }).allow()).toBe(false)
    const broken = { grants: async () => { throw new Error('no') }, requestGrant: async () => { throw new Error('no') } }
    const relay = createRelay({ app: broken })
    expect(await relay.granted()).toBe(false)
    expect(await relay.allow()).toBe(false)
  })

  it('holds nothing to ask outside Orivon', async () => {
    const relay = createRelay({ app: undefined })
    expect(await relay.granted()).toBe(true)
    expect(await relay.allow()).toBe(true)
  })

  it('does not take a grant for another host or another port', async () => {
    const other = [{ capability: 'https.connect', patterns: ['rpc.flashbots.net:8545', 'relay.flashbots.net:443'] }, { capability: 'tcp.connect', patterns: ['rpc.flashbots.net:443'] }]
    expect(await createRelay({ app: fakeApp(other) }).granted()).toBe(false)
  })
})

describe('send', () => {
  const relayWith = (respond: () => Promise<Response>, grants = [...granted]) => {
    const fetcher = vi.fn(respond)
    return { fetcher, relay: createRelay({ fetch: fetcher as never, app: fakeApp(grants) }) }
  }

  it('posts eth_sendRawTransaction of the signed bytes to the relay alone and answers their hash', async () => {
    const { fetcher, relay } = relayWith(async () => answers({ jsonrpc: '2.0', id: 1, result: HASH }))
    expect(await relay.send(RAW)).toBe(HASH)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://rpc.flashbots.net')
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
    expect(JSON.parse(String(init.body))).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x' + toHex(RAW)] })
  })

  it('makes no request at all without the grant', async () => {
    const { fetcher, relay } = relayWith(async () => answers({ result: HASH }), [])
    await expect(relay.send(RAW)).rejects.toMatchObject({ name: 'RelayError', reason: 'notGranted', maybeSent: false })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('names a refusal by the relay, with its words, as one that sent nothing', async () => {
    const { relay } = relayWith(async () => answers({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nonce too low' } }))
    await expect(relay.send(RAW)).rejects.toMatchObject({ reason: 'rejected', message: 'nonce too low', maybeSent: false })
  })

  it('reads "already known" as the transaction being there, so a retry after a lost answer does not fail', async () => {
    const { relay } = relayWith(async () => answers({ error: { message: 'already known' } }))
    expect(await relay.send(RAW)).toBe(HASH)
  })

  it('names an HTTP failure as unavailable, with nothing sent', async () => {
    const { relay } = relayWith(async () => answers('overloaded', { status: 503 }))
    await expect(relay.send(RAW)).rejects.toMatchObject({ reason: 'unavailable', message: expect.stringContaining('503'), maybeSent: false })
  })

  it('treats an answer that is not JSON, or names another hash, as one that may have gone through', async () => {
    await expect(relayWith(async () => answers('<html>')).relay.send(RAW)).rejects.toMatchObject({ reason: 'badAnswer', maybeSent: true })
    await expect(relayWith(async () => answers({ result: '0x' + '12'.repeat(32) })).relay.send(RAW)).rejects.toMatchObject({ reason: 'badAnswer', maybeSent: true })
    await expect(relayWith(async () => answers({ result: 5 })).relay.send(RAW)).rejects.toMatchObject({ reason: 'badAnswer' })
  })

  it('names a request that failed on the way as one that may have been received', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    await expect(relayWith(async () => { throw timeout }).relay.send(RAW)).rejects.toMatchObject({ reason: 'timeout', maybeSent: true })
    await expect(relayWith(async () => { throw new TypeError('Failed to fetch') }).relay.send(RAW)).rejects.toMatchObject({ reason: 'unavailable', maybeSent: true })
  })

  it('is a RelayError the flow can tell from a chain error', async () => {
    const { relay } = relayWith(async () => answers({ error: { message: 'no' } }))
    const error = await relay.send(RAW).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RelayError)
    expect(error).not.toBeInstanceOf(ChainError)
  })
})

describe('the words beside the switch', () => {
  it('wear the Web2 mark and say who sees what, what it protects, and that a public send stays possible', () => {
    expect(RELAY_WORDS.mark).toBe('Web2')
    const all = `${RELAY_WORDS.explanation} ${RELAY_WORDS.advice}`
    expect(all).toMatch(/server/)
    expect(all).toMatch(/IP address/)
    expect(all).toMatch(/before it is public/)
    expect(all).toMatch(/sniper/)
    expect(all).toMatch(/publicly/)
    expect(RELAY_WORDS.asking).toContain(RELAY.host)
  })

  it('do not promise a question Orivon may never ask, and say where a refused host is allowed', () => {
    expect(RELAY_WORDS.asking).not.toMatch(/asks once/i)
    expect(RELAY_WORDS.asking).toMatch(/^Checking with Orivon whether/)
    expect(RELAY_WORDS.notAllowed).toContain('does not ask again by itself')
    expect(RELAY_WORDS.notAllowed).toContain('press the key in the address bar')
    expect(RELAY_WORDS.notAllowed).toContain(`"Connect to ${RELAY.host}"`)
    expect(RELAY_WORDS.notAllowed).toContain('"Review permissions"')
    expect(RELAY_WORDS.notAllowed).toContain('goes out publicly')
    expect(RELAY_WORDS.mark).toBe('Web2')
  })

  it('advises the switch for three and four letters, not five', () => {
    expect(PRIVATE_ADVISED_UP_TO).toBe(4)
    expect(['abc', 'abcd'].map(advisePrivate)).toEqual([true, true])
    expect(['abcde', 'alice'].map(advisePrivate)).toEqual([false, false])
  })

  it('name the host the manifest declares', () => {
    expect(RELAY.pattern).toBe(`${RELAY.host}:443`)
    expect(RELAY.url).toBe(`https://${RELAY.host}`)
  })
})

describe('the Orivon broadcaster', () => {
  const chainStub = {
    getTransactionCount: async () => 7,
    getBlock: async () => ({ baseFeePerGas: 10n }),
    maxPriorityFeePerGas: async () => 2n,
    gasPrice: async () => 12n
  } as never
  const tx = { from: ALICE, to: '0x27264C6AE4ec65fD14C0FB55C2Dc71eAa8956Cb4', data: new Uint8Array([1, 2, 3]), gas: 125_000 }

  function setup(extra: Record<string, unknown> = {}, decline: string[] = []) {
    const fake = fakeOrivon({ 'ETH_0_1.chainId': 1, 'ETH_0_1.signTransaction': RAW, 'ETH_NET_0_1.sendRawTransaction': HASH, ...extra }, decline)
    const relay = { send: vi.fn(async (_raw: Uint8Array) => HASH) }
    return { fake, relay, broadcaster: orivonBroadcaster({ orivon: fake.orivon as never, chain: chainStub, relay }) }
  }

  it('signs with the nonce, the gas limit and the fees, and knows the hash before anything is sent', async () => {
    const { fake, broadcaster } = setup()
    const prepared = await broadcaster.prepare(tx)
    expect(prepared.hash).toBe(HASH)
    expect(fake.uses).toEqual([{ codes: ['ETH_0_1', 'ETH_NET_0_1'], groups: ['addresses', 'sign', 'broadcast'] }])
    const signed = fake.calls.find((call) => call.fn === 'ETH_0_1.signTransaction')?.args[0]
    expect(signed).toMatchObject({ from: ALICE, to: tx.to, gas: 125_000, nonce: 7, chainId: 1, maxFeePerGas: '0x16', maxPriorityFeePerGas: '0x2' })
    expect(fake.calls.some((call) => call.fn.endsWith('sendRawTransaction'))).toBe(false)
  })

  it('sends the signed bytes through the person\'s own node unless asked to go private', async () => {
    const { fake, relay, broadcaster } = setup()
    const prepared = await broadcaster.prepare(tx)
    expect(await prepared.send({ private: false })).toBe(HASH)
    expect(fake.calls.filter((call) => call.fn === 'ETH_NET_0_1.sendRawTransaction')).toHaveLength(1)
    expect(relay.send).not.toHaveBeenCalled()
  })

  it('gives the very bytes it signed to the relay, and not to the node, when private', async () => {
    const { fake, relay, broadcaster } = setup()
    const prepared = await broadcaster.prepare(tx)
    expect(await prepared.send({ private: true })).toBe(HASH)
    expect(relay.send).toHaveBeenCalledTimes(1)
    expect(relay.send.mock.calls[0]?.[0]).toEqual(RAW)
    expect(fake.calls.some((call) => call.fn === 'ETH_NET_0_1.sendRawTransaction')).toBe(false)
  })

  it('lets a relay failure through untouched, for the flow to name', async () => {
    const { relay, broadcaster } = setup()
    relay.send.mockRejectedValueOnce(new RelayError('rejected', 'nonce too low'))
    const prepared = await broadcaster.prepare(tx)
    await expect(prepared.send({ private: true })).rejects.toMatchObject({ name: 'RelayError', reason: 'rejected' })
  })

  it('says a broadcast that timed out is of unknown outcome, with its hash, and refuses another hash', async () => {
    const slow = setup({ 'ETH_NET_0_1.sendRawTransaction': async () => { throw Object.assign(new Error('slow'), { code: 'timeout' }) } })
    await expect((await slow.broadcaster.prepare(tx)).send({ private: false })).rejects.toMatchObject({ reason: 'unknownOutcome', hash: HASH })
    const other = setup({ 'ETH_NET_0_1.sendRawTransaction': '0x' + '34'.repeat(32) })
    await expect((await other.broadcaster.prepare(tx)).send({ private: false })).rejects.toMatchObject({ reason: 'badAnswer' })
  })

  it('names a refused wallet as declined', async () => {
    const { broadcaster } = setup({}, ['ETH_0_1'])
    await expect(broadcaster.prepare(tx)).rejects.toMatchObject({ reason: 'declined' })
    const refusing = setup({ 'ETH_0_1.signTransaction': async () => { throw Object.assign(new Error('no'), { code: 'denied' }) } })
    await expect(refusing.broadcaster.prepare(tx)).rejects.toMatchObject({ reason: 'declined' })
  })
})

describe('the wallet broadcaster', () => {
  const tx = { from: ALICE, to: '0x27264C6AE4ec65fD14C0FB55C2Dc71eAa8956Cb4', data: new Uint8Array([1]), gas: 90_000 }

  it('knows no hash beforehand, and signs and sends in one call', async () => {
    const sendTransaction = vi.fn(async () => HASH)
    const prepared = await walletBroadcaster({ sendTransaction } as never).prepare(tx)
    expect(prepared.hash).toBeNull()
    expect(await prepared.send({ private: false })).toBe(HASH)
    expect(sendTransaction).toHaveBeenCalledWith(tx)
  })

  it('cannot send privately, and says so instead of sending publicly', async () => {
    const sendTransaction = vi.fn(async () => HASH)
    const prepared = await walletBroadcaster({ sendTransaction } as never).prepare(tx)
    await expect(prepared.send({ private: true })).rejects.toMatchObject({ reason: 'invalid' })
    expect(sendTransaction).not.toHaveBeenCalled()
  })
})
