// What a page may ask of the node to get a board listed, over the gateway's socket: the key at the door, the two calls and nothing
// off them, a board's public record without its keys, and a signed request that the board's own address verifies.
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { beforeEach, describe, expect, it } from 'vitest'
import { gatewayOnly } from '../worker/gateway-only.js'
import { boardRecords } from '../worker/board-records.js'
import { LISTING_API_PATH, LISTING_CALLS, listingApi } from '../worker/listing-api.js'
import { messageOf, verifyRequest } from '../worker/listing-request.js'

const KEY = 'listing-api-test-key-0123456789abcdef'
const ORIGIN = 'http://127.0.0.1:6473'
const FILE = '5chan-directories/5chan-a-directory.json'
const NOW = 1_800_000_123

async function identity () {
  const key = await generateKeyPair('Ed25519')
  return { privateKey: Buffer.from(key.raw.subarray(0, 32)).toString('base64'), address: peerIdFromPrivateKey(key).toString() }
}

let mine: Awaited<ReturnType<typeof identity>>
let delegated: Awaited<ReturnType<typeof identity>>
let owners: Awaited<ReturnType<typeof identity>>
let asked: string[]
beforeEach(async () => { mine = await identity(); delegated = await identity(); owners = await identity(); asked = [] })

/** A pkc-js instance with three hosted boards: a named one, one that is not published yet, and one whose identity key the node does not hold. */
function fakePkc () {
  const records: Record<string, Record<string, unknown>> = {
    'music.bso': { address: 'music.bso', name: 'music.bso', publicKey: mine.address, title: 'Music', updatedAt: 1_799_999_000, signer: { privateKey: mine.privateKey, address: mine.address }, features: { pseudonymityMode: 'per-reply', safeForWork: true, nested: { no: 1 } }, challenges: [{ type: 'mod-queue', description: 'secret words', pendingApproval: true, exclude: [{ publicKeys: ['x'] }] }, { type: 'text-math' }], rules: ['Stay on topic.'] },
    'new.bso': { address: 'new.bso', name: 'new.bso', publicKey: delegated.address, title: undefined, updatedAt: undefined, signer: { privateKey: delegated.privateKey, address: delegated.address } },
    [owners.address]: { address: owners.address, publicKey: owners.address, updatedAt: 1, signer: { privateKey: mine.privateKey, address: delegated.address }, features: {}, challenges: [], rules: [] }
  }
  return {
    communities: [{ address: 'music.bso', name: 'music.bso', publicKey: mine.address, started: true }, { address: 'new.bso', name: 'new.bso', publicKey: delegated.address, started: false }, { address: owners.address, publicKey: owners.address, started: true }],
    async createCommunity (options: { address: string }) { asked.push(options.address); return records[options.address] }
  }
}

function api (over: { pkc?: unknown, boards?: null } = {}) {
  const pkc = 'pkc' in over ? over.pkc : fakePkc()
  return listingApi({ authKey: KEY, boards: over.boards === null ? null : boardRecords({ pkc: () => pkc as never }), now: () => NOW * 1000 })
}

const ask = (door: ReturnType<typeof listingApi>, call: string, init: { method?: string, key?: string | null, body?: unknown, raw?: string } = {}) => door.handle(new Request(`${ORIGIN}${LISTING_API_PATH}${call}`, {
  method: init.method ?? 'POST',
  headers: { ...(init.key === null ? {} : { Authorization: `Bearer ${init.key ?? KEY}` }), 'Content-Type': 'application/json' },
  ...(init.method === 'GET' ? {} : { body: init.raw ?? JSON.stringify(init.body ?? {}) })
}))
const json = async (response: Response): Promise<any> => response.json()

describe('the door', () => {
  it('refuses a request with no key, a wrong key and a key of another length, before it reads anything', async () => {
    const door = api()
    for (const key of [null, 'wrong-key', `${KEY}x`, KEY.slice(1)]) expect((await ask(door, 'board', { key, body: { address: 'music.bso' } })).status, String(key)).toBe(401)
    expect(asked).toEqual([])
  })

  it('refuses a request that is not a POST, a call off the list, and a body that is too large or not an object', async () => {
    const door = api()
    expect((await ask(door, 'board', { method: 'GET' })).status).toBe(405)
    for (const call of ['keys', 'signer', 'sign/x', 'board/..', '', 'rpc']) expect((await ask(door, call, { body: { address: 'music.bso' } })).status, call).toBe(403)
    expect((await ask(door, 'board', { raw: JSON.stringify({ address: 'x'.repeat(20_000) }) })).status).toBe(413)
    expect((await ask(door, 'board', { raw: '[1]' })).status).toBe(400)
    expect((await ask(door, 'board', { raw: '{not json' })).status).toBe(400)
    expect(asked).toEqual([])
  })

  it('names exactly three calls, and says 503 when the Worker has no board to ask', async () => {
    expect([...LISTING_CALLS].sort()).toEqual(['board', 'boards', 'sign'])
    const response = await ask(api({ boards: null }), 'board', { body: { address: 'music.bso' } })
    expect(response.status).toBe(503)
    expect((await ask(api({ boards: null }), 'keys')).status).toBe(403)
  })

  it('is served by the gateway socket under its own path, and the socket still answers 404 elsewhere under /api/', async () => {
    const door = gatewayOnly({ handle: async () => new Response('facade') }, undefined, undefined, api())
    const answered = await door.handle(new Request(`${ORIGIN}${LISTING_API_PATH}board`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: JSON.stringify({ address: 'music.bso' }) }))
    expect(answered.status).toBe(200)
    expect((await door.handle(new Request(`${ORIGIN}/api/v0/key/list`, { method: 'POST' }))).status).toBe(404)
    expect((await gatewayOnly({ handle: async () => new Response('facade') }).handle(new Request(`${ORIGIN}${LISTING_API_PATH}board`, { method: 'POST' }))).status).toBe(404)
  })
})

describe('boards', () => {
  it('lists the boards the node hosts, with their names and public keys and nothing of their records', async () => {
    const response = await ask(api(), 'boards')
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ boards: [
      { address: 'music.bso', name: 'music.bso', publicKey: mine.address },
      { address: 'new.bso', name: 'new.bso', publicKey: delegated.address },
      { address: owners.address, name: null, publicKey: owners.address }
    ] })
    expect(asked).toEqual([])
  })

  it('answers 503 while pkc-js is not up', async () => {
    expect((await ask(api({ pkc: null }), 'boards')).status).toBe(503)
  })
})

describe('board', () => {
  it('answers the record the board publishes, as far as a listing checks it, and never a key', async () => {
    const response = await ask(api(), 'board', { body: { address: 'music.bso' } })
    expect(response.status).toBe(200)
    const text = await response.clone().text()
    expect(text).not.toContain(mine.privateKey)
    expect(text).not.toContain('secret words')
    expect(await json(response)).toEqual({
      address: 'music.bso', name: 'music.bso', publicKey: mine.address, title: 'Music', published: true, signable: true,
      features: { pseudonymityMode: 'per-reply', safeForWork: true },
      challenges: [{ type: 'mod-queue', pendingApproval: true }, { type: 'text-math', pendingApproval: false }],
      rules: ['Stay on topic.']
    })
  })

  it('says a board that has published nothing yet has not, and one whose identity key the node does not hold cannot sign', async () => {
    expect(await json(await ask(api(), 'board', { body: { address: 'new.bso' } }))).toMatchObject({ address: 'new.bso', published: false, signable: true, features: {}, challenges: [], rules: [] })
    expect(await json(await ask(api(), 'board', { body: { address: owners.address } }))).toMatchObject({ published: true, signable: false })
  })

  it('finds a board by its name or its public key, and answers 404 for one the node does not host without asking pkc-js for it', async () => {
    expect((await json(await ask(api(), 'board', { body: { address: mine.address } }))).address).toBe('music.bso')
    const missing = await ask(api(), 'board', { body: { address: 'elsewhere.bso' } })
    expect(missing.status).toBe(404)
    expect((await json(missing)).Message).toMatch(/not a board this node hosts/)
    expect((await ask(api(), 'board', { body: {} })).status).toBe(400)
    expect((await ask(api(), 'board', { body: { address: 7 } })).status).toBe(400)
    expect(asked).toEqual(['music.bso'])
  })

  it('answers 503 while pkc-js is not up', async () => {
    expect((await ask(api({ pkc: null }), 'board', { body: { address: 'music.bso' } })).status).toBe(503)
  })
})

describe('sign', () => {
  const body = { address: 'music.bso', file: FILE }

  it('answers the entry, the message and the board key\'s signature, which the board\'s address verifies', async () => {
    const response = await ask(api(), 'sign', { body })
    expect(response.status).toBe(200)
    const signed = await json(response)
    expect(signed.entry).toEqual({ address: 'music.bso', publicKey: mine.address, addedAt: NOW })
    expect(signed.file).toBe(FILE)
    expect(signed.publicKey).toBe(mine.address)
    expect(signed.message).toBe(messageOf({ file: FILE, entry: signed.entry }))
    expect(await verifyRequest({ message: signed.message, signature: signed.signature, publicKey: mine.address })).toBe(true)
    expect(JSON.stringify(signed)).not.toContain(mine.privateKey)
  })

  it('adds the owner a 5chan entry names, and leaves it out of a seedit entry', async () => {
    const owned = await json(await ask(api(), 'sign', { body: { ...body, owner: 'me.bso' } }))
    expect(owned.entry).toEqual({ address: 'music.bso', publicKey: mine.address, addedAt: NOW, owner: 'me.bso' })
    const seedit = await json(await ask(api(), 'sign', { body: { address: 'music.bso', file: 'seedit-directories/seedit-cats-directory.json', owner: 'me.bso' } }))
    expect(seedit.entry).toEqual({ address: 'music.bso', addedAt: NOW, publicKey: mine.address })
  })

  it('refuses a file that is not a directory file, an owner that is not a name, and a body of the wrong shape, before the key is read', async () => {
    for (const file of ['README.md', '../x', `${FILE}\nentry: {}`, undefined, 7]) expect((await ask(api(), 'sign', { body: { address: 'music.bso', file } })).status, String(file)).toBe(400)
    for (const owner of ['me', 'me.com', 'a\nb.bso', 7, '']) expect((await ask(api(), 'sign', { body: { ...body, owner } })).status, String(owner)).toBe(400)
    expect((await ask(api(), 'sign', { body: { file: FILE } })).status).toBe(400)
    expect(asked).toEqual([])
  })

  it('answers 404 for a board the node does not host, and 409 for one whose identity key the node does not hold', async () => {
    expect((await ask(api(), 'sign', { body: { ...body, address: 'elsewhere.bso' } })).status).toBe(404)
    const refused = await ask(api(), 'sign', { body: { ...body, address: owners.address } })
    expect(refused.status).toBe(409)
    expect((await json(refused)).Message).toMatch(/does not hold the key/)
  })
})
