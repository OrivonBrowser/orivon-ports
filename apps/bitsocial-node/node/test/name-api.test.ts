// What a page may ask of the node to give a board a name, over the gateway's socket: the key at the door, the four calls and nothing off
// them, the record a hosted board's name must hold, the check through the name resolvers pkc-js holds, and the transaction that sets the record.
import { describe, expect, it, vi } from 'vitest'
import { boardRecords } from '../worker/board-records.js'
import { gatewayOnly } from '../worker/gateway-only.js'
import { NAME_API_CALLS, NAME_API_PATH, nameApi } from '../worker/name-api.js'
import { nameClaims } from '../worker/name-claim.js'

const AUTH = 'name-api-test-key-0123456789abcdef'
const ORIGIN = 'http://127.0.0.1:6473'
const KEY = '12D3KooWJoFVU6rBeqCTZoPszCaWyENY5ahrTUsNpHqhfrpmwkZD'
const OTHER = '12D3KooWGuT5qwpG6eAiavrAoTiXKyb2UL12NvoWAEVT9CLBZoLN'
const RESOLVER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63'

type Answer = () => unknown
/** A pkc-js instance hosting two boards, holding one name resolver that answers as `answer` says. */
function pkcWith (answer: Answer, hosted = [{ address: KEY, publicKey: KEY }, { address: 'music.bso', name: 'music.bso', publicKey: OTHER }]) {
  const asked: string[] = []
  return {
    asked,
    communities: hosted.map((one) => ({ started: true, ...one })),
    createCommunity: async () => { throw new Error('the name calls never open a board') },
    nameResolvers: [{ key: 'one', provider: 'https://one.test', canResolve: () => true, resolve: async ({ name }: { name: string }) => { asked.push(name); return answer() } }]
  }
}

function api (over: { pkc?: ReturnType<typeof pkcWith> | null, boards?: null, resolver?: string, read?: Answer } = {}) {
  const pkc = 'pkc' in over ? over.pkc : pkcWith(() => ({ publicKey: KEY }))
  const createClient = vi.fn(() => ({ readContract: async () => { const value = over.read?.(); return (value ?? over.resolver ?? RESOLVER) as string } }))
  const door = nameApi({ authKey: AUTH, boards: over.boards === null ? null : boardRecords({ pkc: () => pkc as never }), claims: nameClaims({ pkc: () => pkc as never, createClient: createClient as never }) })
  return { door, pkc, createClient }
}

const ask = (door: ReturnType<typeof api>['door'], call: string, init: { method?: string, key?: string | null, body?: unknown, raw?: string } = {}) => door.handle(new Request(`${ORIGIN}${NAME_API_PATH}${call}`, {
  method: init.method ?? 'POST',
  headers: { ...(init.key === null ? {} : { Authorization: `Bearer ${init.key ?? AUTH}` }), 'Content-Type': 'application/json' },
  ...(init.method === 'GET' ? {} : { body: init.raw ?? JSON.stringify(init.body ?? {}) })
}))
const json = async (response: Response): Promise<any> => response.json()

describe('the door', () => {
  it('refuses a request with no key, a wrong key and a key of another length, before it reads anything', async () => {
    const { door, pkc } = api()
    for (const key of [null, 'wrong-key', `${AUTH}x`, AUTH.slice(1)]) expect((await ask(door, 'record', { key, body: { address: KEY, name: 'a.bso' } })).status, String(key)).toBe(401)
    expect(pkc!.asked).toEqual([])
  })

  it('refuses a request that is not a POST, a call off the list, and a body that is too large or not an object', async () => {
    const { door } = api()
    expect((await ask(door, 'record', { method: 'GET' })).status).toBe(405)
    for (const call of ['keys', 'sign', 'record/x', 'check/..', '', 'rpc']) expect((await ask(door, call, { body: { address: KEY, name: 'a.bso' } })).status, call).toBe(403)
    expect((await ask(door, 'record', { raw: JSON.stringify({ address: 'x'.repeat(20_000) }) })).status).toBe(413)
    expect((await ask(door, 'record', { raw: '[1]' })).status).toBe(400)
    expect((await ask(door, 'record', { raw: '{not json' })).status).toBe(400)
  })

  it('names exactly four calls, and says 503 when the Worker has no board to ask', async () => {
    expect([...NAME_API_CALLS].sort()).toEqual(['boards', 'check', 'record', 'transaction'])
    expect((await ask(api({ boards: null }).door, 'record', { body: { address: KEY, name: 'a.bso' } })).status).toBe(503)
    expect((await ask(api({ boards: null }).door, 'keys')).status).toBe(403)
  })

  it('is served by the gateway socket under its own path, and the socket answers 404 there when it has no such door', async () => {
    const { door } = api()
    const served = gatewayOnly({ handle: async () => new Response('facade') }, undefined, undefined, undefined, door)
    const answered = await served.handle(new Request(`${ORIGIN}${NAME_API_PATH}boards`, { method: 'POST', headers: { Authorization: `Bearer ${AUTH}` } }))
    expect(answered.status).toBe(200)
    expect((await gatewayOnly({ handle: async () => new Response('facade') }).handle(new Request(`${ORIGIN}${NAME_API_PATH}boards`, { method: 'POST' }))).status).toBe(404)
  })
})

describe('boards', () => {
  it('lists the boards the node hosts with their names and public keys, and asks nothing of any board or of Ethereum', async () => {
    const { door, createClient, pkc } = api()
    const response = await ask(door, 'boards')
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ boards: [{ address: KEY, name: null, publicKey: KEY }, { address: 'music.bso', name: 'music.bso', publicKey: OTHER }] })
    expect(createClient).not.toHaveBeenCalled()
    expect(pkc!.asked).toEqual([])
  })

  it('answers 503 while pkc-js is not up', async () => {
    expect((await ask(api({ pkc: null }).door, 'boards')).status).toBe(503)
  })
})

describe('record', () => {
  it('is the text record `bitsocial` of the name, holding the key of the board the call names by its address, its name or its key', async () => {
    const { door, createClient } = api()
    for (const address of [KEY, 'music.bso', OTHER]) {
      const expected = address === KEY ? KEY : OTHER
      const response = await ask(door, 'record', { body: { address, name: 'yourname.bso' } })
      expect(response.status, address).toBe(200)
      expect(await json(response), address).toEqual({ address: address === KEY ? KEY : 'music.bso', name: 'yourname.bso', ensName: 'yourname.eth', key: 'bitsocial', value: expected })
    }
    expect(createClient).not.toHaveBeenCalled()
  })

  it('is refused for a board the node does not host, never reading anything of the network for it', async () => {
    const { door, pkc } = api()
    const response = await ask(door, 'record', { body: { address: '12D3KooWKxen9sLMZgBL6egvZGtPQeie16KJ1w67YraKYaAvUjt9', name: 'yourname.bso' } })
    expect(response.status).toBe(404)
    expect(pkc!.asked).toEqual([])
  })

  it('is refused with a reason for a name that cannot be one, and for a call with no address', async () => {
    const { door } = api()
    for (const name of ['Yourname.bso', 'yourname.com', '', 'a b.eth']) expect((await ask(door, 'record', { body: { address: KEY, name } })).status, name).toBe(400)
    expect((await ask(door, 'record', { body: { name: 'a.bso' } })).status).toBe(400)
    expect((await ask(door, 'record', { body: { address: KEY } })).status).toBe(400)
    expect((await json(await ask(door, 'record', { body: { address: KEY, name: 'Yourname.bso' } }))).Message).toMatch(/capital letter/)
  })

  it('is refused for a board whose key a name cannot hold', async () => {
    const odd = pkcWith(() => undefined, [{ address: 'odd-board', publicKey: 'not-a-key' }])
    const response = await ask(api({ pkc: odd }).door, 'record', { body: { address: 'odd-board', name: 'yourname.bso' } })
    expect(response.status).toBe(409)
  })
})

describe('check', () => {
  it('says the name points at the board, asking the pkc-js resolvers with the name as typed', async () => {
    const { door, pkc } = api()
    expect(await json(await ask(door, 'check', { body: { address: KEY, name: 'yourname.bso' } }))).toEqual({ address: KEY, name: 'yourname.bso', ensName: 'yourname.eth', publicKey: KEY, outcome: 'here', resolved: KEY, resolver: 'one' })
    expect(pkc!.asked).toEqual(['yourname.bso'])
  })

  it('says what a name points at when it is not the board, that it has no record, and that nothing could be read', async () => {
    const elsewhere = await json(await ask(api({ pkc: pkcWith(() => ({ publicKey: OTHER })) }).door, 'check', { body: { address: KEY, name: 'yourname.bso' } }))
    expect(elsewhere).toMatchObject({ outcome: 'elsewhere', resolved: OTHER })
    expect(await json(await ask(api({ pkc: pkcWith(() => undefined) }).door, 'check', { body: { address: KEY, name: 'yourname.bso' } }))).toMatchObject({ outcome: 'none', resolved: null })
    expect(await json(await ask(api({ pkc: pkcWith(() => { throw new Error('503 Service Unavailable') }) }).door, 'check', { body: { address: KEY, name: 'yourname.bso' } }))).toMatchObject({ outcome: 'unreachable', errors: [{ resolver: 'one', message: '503 Service Unavailable' }] })
  })

  it('does not run more than two at once: a page cannot make the node ask Ethereum without end', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { door } = api({ pkc: pkcWith(() => gate.then(() => ({ publicKey: KEY })) as never) })
    const first = ask(door, 'check', { body: { address: KEY, name: 'a.bso' } })
    const second = ask(door, 'check', { body: { address: KEY, name: 'b.bso' } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await ask(door, 'check', { body: { address: KEY, name: 'c.bso' } })).status).toBe(429)
    release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect((await ask(door, 'check', { body: { address: KEY, name: 'c.bso' } })).status).toBe(200)
  })
})

describe('transaction', () => {
  it('is the transaction that sets the record on the name\'s resolver: mainnet, no value, the calldata', async () => {
    const { door } = api()
    const answer = await json(await ask(door, 'transaction', { body: { address: KEY, name: 'foo.bso' } }))
    expect(answer).toMatchObject({ address: KEY, name: 'foo.bso', ensName: 'foo.eth', key: 'bitsocial', value: KEY, chainId: 1, transaction: { to: RESOLVER, value: '0x0' } })
    expect(answer.transaction.data).toMatch(/^0x10f13a8cde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f/)
  })

  it('says a name with no resolver cannot hold a record yet (409), and that Ethereum could not be read (502), and that this node reads none (503)', async () => {
    expect((await ask(api({ resolver: '0x0000000000000000000000000000000000000000' }).door, 'transaction', { body: { address: KEY, name: 'foo.bso' } })).status).toBe(409)
    expect((await ask(api({ read: () => { throw new Error('down') } }).door, 'transaction', { body: { address: KEY, name: 'foo.bso' } })).status).toBe(502)
    const noProviders = { ...pkcWith(() => undefined), nameResolvers: [] }
    expect((await ask(api({ pkc: noProviders as never }).door, 'transaction', { body: { address: KEY, name: 'foo.bso' } })).status).toBe(503)
  })
})
