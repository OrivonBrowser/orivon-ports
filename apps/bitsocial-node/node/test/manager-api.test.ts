// What a page may ask of the board manager over the gateway's socket: the key at the door, the list of calls and nothing off
// it, what each call answers, what is refused with which status, and that the socket still serves no RPC and no other path.
import * as fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boardConfigStore } from '../worker/board-config.js'
import { superviseBoardManagers } from '../worker/board-managers.js'
import { gatewayOnly } from '../worker/gateway-only.js'
import { MANAGER_API_PATH, MANAGER_CALLS, managerApi } from '../worker/manager-api.js'

const KEY = 'manager-api-test-key-0123456789abcdef'
const ORIGIN = 'http://127.0.0.1:6473'

let dir: string
let started: Array<Record<string, any>>
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bitsocial-manager-api-')); started = [] })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function managers () {
  const store = boardConfigStore({ directory: dir, fs: fs as never })
  store.writeBoard({ address: 'a.bso', perPage: 2 })
  const supervisor = superviseBoardManagers({
    start: async (options) => { started.push(options); return { stop: async () => {} } },
    resolve: (board) => ({ communityAddress: board['address'], ...board }),
    store, rpcUrl: `ws://127.0.0.1:9138/${KEY}`, hosted: () => [{ address: 'a.bso', started: true }, { address: 'free.bso', started: false }]
  })
  supervisor.begin()
  return supervisor
}

const ask = (api: ReturnType<typeof managerApi>, call: string, init: { method?: string, key?: string | null, body?: unknown, raw?: string } = {}) => api.handle(new Request(`${ORIGIN}${MANAGER_API_PATH}${call}`, {
  method: init.method ?? 'POST',
  headers: { ...(init.key === null ? {} : { Authorization: `Bearer ${init.key ?? KEY}` }), 'Content-Type': 'application/json' },
  ...(init.method === 'GET' ? {} : { body: init.raw ?? JSON.stringify(init.body ?? {}) })
}))
const json = async (response: Response): Promise<any> => response.json()

describe('the door', () => {
  it('refuses a request with no key, a wrong key and a key of another length, before it reads anything', async () => {
    const api = managerApi({ authKey: KEY, managers: managers() })
    for (const key of [null, 'wrong-key', `${KEY}x`, KEY.slice(1)]) expect((await ask(api, 'boards', { key })).status, String(key)).toBe(401)
    expect((await ask(api, 'enable', { key: null, body: { address: 'free.bso' } })).status).toBe(401)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(started).toHaveLength(1)
  })

  it('refuses a request that is not a POST', async () => {
    const api = managerApi({ authKey: KEY, managers: managers() })
    expect((await ask(api, 'boards', { method: 'GET' })).status).toBe(405)
    expect((await ask(api, 'boards', { method: 'DELETE' })).status).toBe(405)
  })
})

describe('the list', () => {
  it('is the calls that read and set the manager\'s config and turn it on and off', () => {
    expect([...MANAGER_CALLS].sort()).toEqual(['board', 'boards', 'config', 'defaults', 'defaults/set', 'disable', 'enable'])
  })

  it.each(['forget', 'state', 'start', 'stop', 'restart', 'rpc', 'exec', 'boards/../rpc', '', 'config/x', 'key', 'id'])('refuses %j with 403, and nothing happens', async (call) => {
    const api = managerApi({ authKey: KEY, managers: managers() })
    const response = await ask(api, call, { body: { address: 'a.bso' } })
    expect(response.status).toBe(403)
    expect((await json(response)).Type).toBe('error')
  })

  it('says so, with 503, when this build has no board manager', async () => {
    const api = managerApi({ authKey: KEY, managers: null })
    const response = await ask(api, 'boards')
    expect(response.status).toBe(503)
    expect((await json(response)).Message).toMatch(/no board manager/)
    expect((await ask(api, 'rpc')).status).toBe(403)
    expect((await ask(api, 'boards', { key: 'wrong' })).status).toBe(401)
  })
})

describe('the calls', () => {
  it('boards: every board the node hosts and every board with a manager, with the defaults', async () => {
    const api = managerApi({ authKey: KEY, managers: managers() })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const answer = await json(await ask(api, 'boards'))
    expect(answer.defaults).toEqual({ perPage: 15, pages: 10, bumpLimit: 300, archivePurgeSeconds: 172800 })
    expect(answer.boards.map((board: Record<string, unknown>) => [board['address'], board['managed'], board['state']])).toEqual([['a.bso', true, 'running'], ['free.bso', false, 'off']])
  })

  it('board: one board, and 404 for one the node does not host', async () => {
    const api = managerApi({ authKey: KEY, managers: managers() })
    expect(await json(await ask(api, 'board', { body: { address: 'a.bso' } }))).toMatchObject({ address: 'a.bso', config: { perPage: 2 }, capacity: 20 })
    expect((await ask(api, 'board', { body: { address: 'other.bso' } })).status).toBe(404)
    expect((await ask(api, 'board', { body: {} })).status).toBe(400)
  })

  it('every board\'s view says whether its community has no archive: what the Worker reads, and not known when it reads nothing', async () => {
    const asked: string[] = []
    const api = managerApi({ authKey: KEY, managers: managers(), noArchive: async (address) => { asked.push(address); return address === 'a.bso' ? true : null } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await json(await ask(api, 'boards'))).boards.map((board: Record<string, unknown>) => [board['address'], board['noArchive']])).toEqual([['a.bso', true], ['free.bso', null]])
    expect(await json(await ask(api, 'board', { body: { address: 'a.bso' } }))).toMatchObject({ noArchive: true })
    expect(await json(await ask(api, 'config', { body: { address: 'a.bso', config: { perPage: 4 } } }))).toMatchObject({ noArchive: true, config: { perPage: 4 } })
    expect(await json(await ask(api, 'disable', { body: { address: 'a.bso' } }))).toMatchObject({ noArchive: true })
    expect(asked).toContain('free.bso')
    expect(await json(await ask(managerApi({ authKey: KEY, managers: managers() }), 'board', { body: { address: 'a.bso' } }))).toMatchObject({ noArchive: null })
  })

  it('enable and disable: turn the manager on and off for a board', async () => {
    const api = managerApi({ authKey: KEY, managers: managers() })
    const on = await json(await ask(api, 'enable', { body: { address: 'free.bso', config: { bumpLimit: 30 } } }))
    expect(on).toMatchObject({ address: 'free.bso', managed: true, enabled: true, config: { bumpLimit: 30 } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(started.map((options) => options['communityAddress'])).toEqual(['a.bso', 'free.bso'])
    const off = await json(await ask(api, 'disable', { body: { address: 'free.bso' } }))
    expect(off).toMatchObject({ enabled: false, state: 'off', config: { bumpLimit: 30 } })
  })

  it('config: sets and resets a board\'s limits', async () => {
    const api = managerApi({ authKey: KEY, managers: managers() })
    expect(await json(await ask(api, 'config', { body: { address: 'a.bso', config: { perPage: 7, pages: null } } }))).toMatchObject({ config: { perPage: 7 }, effective: { perPage: 7, pages: 10 } })
  })

  it('defaults and defaults/set: the defaults every board takes', async () => {
    const api = managerApi({ authKey: KEY, managers: managers() })
    expect(await json(await ask(api, 'defaults'))).toEqual({ set: {}, effective: { perPage: 15, pages: 10, bumpLimit: 300, archivePurgeSeconds: 172800 } })
    expect(await json(await ask(api, 'defaults/set', { body: { defaults: { archivePurgeSeconds: 60 } } }))).toEqual({ set: { archivePurgeSeconds: 60 }, effective: { perPage: 15, pages: 10, bumpLimit: 300, archivePurgeSeconds: 60 } })
  })
})

describe('what is refused', () => {
  it.each([
    ['config', { address: 'a.bso', config: { perPage: 0 } }, 400, /perPage must be a positive integer/],
    ['config', { address: 'a.bso', config: { enabled: false } }, 400, /not a setting/],
    ['config', { address: 'a.bso', config: { rpcUrl: 'ws://evil' } }, 400, /not a setting/],
    ['enable', { address: '../../etc', config: {} }, 400, /board address/],
    ['enable', { address: 'a.bso', config: 'big' }, 400, /must be an object/],
    ['disable', { address: 'nobody.bso' }, 404, /not a community this node hosts/],
    ['defaults/set', { defaults: { pages: 'many' } }, 400, /pages must be a positive integer/]
  ])('%s %j answers %i', async (call, body, status, message) => {
    const api = managerApi({ authKey: KEY, managers: managers() })
    const response = await ask(api, call, { body })
    expect(response.status).toBe(status)
    expect((await json(response)).Message).toMatch(message)
  })

  it('refuses a body that is not a JSON object, and one that is too large', async () => {
    const api = managerApi({ authKey: KEY, managers: managers() })
    expect((await ask(api, 'boards', { raw: '{ nope' })).status).toBe(400)
    expect((await ask(api, 'boards', { raw: '[1]' })).status).toBe(400)
    expect((await ask(api, 'boards', { raw: JSON.stringify({ pad: 'x'.repeat(20_000) }) })).status).toBe(413)
  })

  it('writes nothing for a refused call', async () => {
    const api = managerApi({ authKey: KEY, managers: managers() })
    await ask(api, 'config', { body: { address: 'a.bso', config: { perPage: 4, pages: 0 } } })
    expect(boardConfigStore({ directory: dir, fs: fs as never }).load().boards).toEqual([{ address: 'a.bso', perPage: 2 }])
  })
})

describe('on the gateway\'s socket', () => {
  const facade = { handle: async () => new Response('facade', { status: 200 }) }

  it('answers the manager\'s path, and still no other part of the kubo API or the page API\'s unlisted paths', async () => {
    const api = managerApi({ authKey: KEY, managers: managers() })
    const gateway = gatewayOnly(facade, undefined, api)
    expect((await gateway.handle(new Request(`${ORIGIN}${MANAGER_API_PATH}boards`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } }))).status).toBe(200)
    expect((await gateway.handle(new Request(`${ORIGIN}/api/v0/key/gen`, { method: 'POST' }))).status).toBe(404)
    expect((await gateway.handle(new Request(`${ORIGIN}/orivon/api/id`, { method: 'POST' }))).status).toBe(404)
    expect((await gateway.handle(new Request(`${ORIGIN}/ipfs/bafy`))).status).toBe(200)
  })

  it('answers 404 on the manager\'s path when the Worker has no such API', async () => {
    const gateway = gatewayOnly(facade)
    expect((await gateway.handle(new Request(`${ORIGIN}${MANAGER_API_PATH}boards`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } }))).status).toBe(404)
  })
})
