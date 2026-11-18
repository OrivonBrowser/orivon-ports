// The door a page reaches seeding by: the key, the calls, what a call changes and what a value it refuses answers.
import { describe, expect, it } from 'vitest'
import { gatewayOnly } from '../worker/gateway-only.js'
import { createSeeder } from '../worker/seeding.js'
import { blank, normalise } from '../worker/seeding-store.js'
import { SEEDING_API_PATH, seedingApi } from '../worker/seeding-api.js'

const KEY = 'seeding-test-key-0123456789abcdef'
const ORIGIN = 'http://127.0.0.1:6473'

function setup () {
  let kept = JSON.stringify(blank())
  const node = { pin: async () => ({}), unpin: async () => true, pins: async () => [], provide: async () => ({}), unprovide: async () => true, repoGc: async () => [], pubsubSubscribe: async () => ({ body: null }) }
  const seeder = createSeeder({ store: { directory: '/s', read: () => normalise(JSON.parse(kept)), write: (state: unknown) => { kept = JSON.stringify(state) } } as never, node: node as never, open: (async () => ({ record: () => null, onUpdate: () => () => {}, stop: async () => {} })) as never })
  return { api: seedingApi({ authKey: KEY, seeder }), seeder }
}
const call = (api: ReturnType<typeof setup>['api'], name: string, body: unknown = {}, key: string | null = KEY, method = 'POST') => api.handle(new Request(`${ORIGIN}${SEEDING_API_PATH}${name}`, { method, headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { Authorization: `Bearer ${key}` }) }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }))

describe('the seeding calls', () => {
  it('start off, and each call answers the state it leaves', async () => {
    const { api } = setup()
    expect(await (await call(api, 'state')).json()).toMatchObject({ enabled: false, usedBytes: 0, communities: [], limitBytes: 1e9 })
    expect(await (await call(api, 'add', { address: 'music.bso' })).json()).toMatchObject({ communities: [{ address: 'music.bso', origin: 'added' }] })
    expect(await (await call(api, 'follow', { addresses: ['a.bso', 'b.bso'] })).json()).toMatchObject({ communities: [{ address: 'a.bso', origin: 'followed' }, { address: 'b.bso' }, { address: 'music.bso', origin: 'added' }] })
    expect(await (await call(api, 'limit', { bytes: 5e9 })).json()).toMatchObject({ limitBytes: 5e9 })
    expect(((await (await call(api, 'enable')).json()) as { enabled: boolean }).enabled).toBe(true)
    expect(((await (await call(api, 'remove', { address: 'a.bso' })).json()) as { ignored: string[] }).ignored).toEqual(['a.bso'])
    expect(((await (await call(api, 'disable')).json()) as { enabled: boolean }).enabled).toBe(false)
    expect((await call(api, 'run')).status).toBe(200)
  })

  it('answers 400 for a value that is not one, with the reason, and changes nothing', async () => {
    const { api, seeder } = setup()
    for (const [name, body] of [['limit', { bytes: 12 }], ['limit', { bytes: '2GB' }], ['add', { address: '../x' }], ['add', {}], ['follow', { addresses: 'a.bso' }], ['follow', { addresses: ['ok.bso', ''] }], ['remove', { address: 7 }]] as const) {
      const answer = await call(api, name, body)
      expect([name, answer.status]).toEqual([name, 400])
      expect(typeof ((await answer.json()) as { Message: unknown }).Message).toBe('string')
    }
    expect(seeder.state()).toMatchObject({ communities: [], limitBytes: 1e9 })
  })

  it('refuses without the key (401), by a method but POST (405), a call off the list (403), a body that is not an object (400) and one that is too large (413)', async () => {
    const { api } = setup()
    expect((await call(api, 'state', {}, null)).status).toBe(401)
    expect((await call(api, 'state', {}, 'wrong')).status).toBe(401)
    expect((await call(api, 'state', {}, KEY, 'GET')).status).toBe(405)
    expect((await call(api, 'wipe')).status).toBe(403)
    expect((await call(api, 'add', '[1]')).status).toBe(400)
    expect((await call(api, 'add', 'x'.repeat(20_000))).status).toBe(413)
  })

  it('answers 503 for a build with no seeding, and is behind the gateway\'s door', async () => {
    expect((await call(seedingApi({ authKey: KEY, seeder: null }), 'state')).status).toBe(503)
    const { api } = setup()
    const facade = { handle: async () => new Response('facade') }
    expect((await gatewayOnly(facade, undefined, undefined, undefined, undefined, api).handle(new Request(`${ORIGIN}${SEEDING_API_PATH}state`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } }))).status).toBe(200)
    expect((await gatewayOnly(facade).handle(new Request(`${ORIGIN}${SEEDING_API_PATH}state`, { method: 'POST' }))).status).toBe(404)
  })
})
