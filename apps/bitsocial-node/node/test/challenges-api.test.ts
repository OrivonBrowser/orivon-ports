// What a page may ask of the challenge list over the gateway's socket: the key at the door, one call and nothing else, what it
// answers, what is refused with which status, and that the socket still serves no RPC and no other path.
import { describe, expect, it } from 'vitest'
import { ALL, describeChallenges, registerChallenges } from '../worker/challenges.js'
import { boardChallenges } from '../worker/board-challenges.js'
import { CHALLENGES_API_PATH, CHALLENGE_CALLS, challengesApi } from '../worker/challenges-api.js'
import { gatewayOnly } from '../worker/gateway-only.js'

const KEY = 'challenges-api-test-key-0123456789abcdef'
const ORIGIN = 'http://127.0.0.1:6473'

const registry = () => { const one: Record<string, unknown> = { 'text-math': () => ({ description: 'math', type: 'text/plain', optionInputs: [], getChallenge: () => ({ success: true }) }) }; registerChallenges(one); return one }
const listing = () => ({ list: () => describeChallenges(registry()) })

const ask = (api: ReturnType<typeof challengesApi>, call: string, init: { method?: string, key?: string | null, body?: unknown, raw?: string } = {}) => api.handle(new Request(`${ORIGIN}${CHALLENGES_API_PATH}${call}`, {
  method: init.method ?? 'POST',
  headers: { ...(init.key === null ? {} : { Authorization: `Bearer ${init.key ?? KEY}` }), 'Content-Type': 'application/json' },
  ...(init.method === 'GET' ? {} : { body: init.raw ?? JSON.stringify(init.body ?? {}) })
}))
const json = async (response: Response): Promise<any> => response.json()

describe('the door', () => {
  it('refuses a request with no key, a wrong key and a key of another length, before it reads anything', async () => {
    let asked = 0
    const api = challengesApi({ authKey: KEY, challenges: { list: () => { asked += 1; return describeChallenges(registry()) } } })
    for (const key of [null, 'wrong-key', `${KEY}x`, KEY.slice(1)]) expect((await ask(api, 'list', { key })).status, String(key)).toBe(401)
    expect(asked).toBe(0)
  })

  it('refuses a request that is not a POST', async () => {
    const api = challengesApi({ authKey: KEY, challenges: listing() })
    expect((await ask(api, 'list', { method: 'GET' })).status).toBe(405)
    expect((await ask(api, 'list', { method: 'DELETE' })).status).toBe(405)
  })
})

describe('the list', () => {
  it('is three read calls and one write, which sets the challenges of a board this node hosts; nothing installs or removes a challenge', () => {
    expect([...CHALLENGE_CALLS]).toEqual(['list', 'boards', 'board', 'apply'])
  })

  it.each(['install', 'remove', 'reload', 'register', 'add', 'list/x', 'rpc', 'exec', '../manager/boards', '', 'key', 'id'])('refuses %j with 403', async (call) => {
    const api = challengesApi({ authKey: KEY, challenges: listing() })
    const response = await ask(api, call)
    expect(response.status).toBe(403)
    expect((await json(response)).Type).toBe('error')
  })

  it('says so, with 503, when this build has no challenges', async () => {
    const api = challengesApi({ authKey: KEY, challenges: null })
    const response = await ask(api, 'list')
    expect(response.status).toBe(503)
    expect((await json(response)).Message).toMatch(/no challenges/)
    expect((await ask(api, 'install')).status).toBe(403)
    expect((await ask(api, 'list', { key: 'wrong' })).status).toBe(401)
  })
})

describe('what list answers', () => {
  it('the registered challenges with their version, licence, description and option schema, and each one left out with why', async () => {
    const api = challengesApi({ authKey: KEY, challenges: listing() })
    const answer = await json(await ask(api, 'list'))
    expect(answer.challenges.map((one: { name: string }) => one.name)).toEqual(['text-math', ...ALL.map((one) => one.name).sort()])
    expect(answer.challenges[0]).toMatchObject({ name: 'text-math', source: 'pkc-js', version: null })
    const flags = answer.challenges.find((one: { name: string }) => one.name === '@bitsocial/flags-challenge')
    expect(flags).toMatchObject({ source: 'bundled', version: '0.1.3', licence: 'GPL-3.0-or-later', type: 'url/iframe', hosts: ['flags.5chan.app'], hostOptions: ['serviceUrl'] })
    expect(flags.optionInputs.map((input: { option: string }) => input.option)).toContain('serviceUrl')
    expect(answer.unavailable).toEqual([{ name: '@bitsocial/mintpass-challenge', version: '1.5.0', licence: 'GPL-3.0-or-later', reason: expect.stringMatching(/needs a native module.*not available in this build/) }])
  })

  it('answers the same for a body of an empty object and for no body, and refuses what is not a JSON object', async () => {
    const api = challengesApi({ authKey: KEY, challenges: listing() })
    expect((await ask(api, 'list', { raw: '' })).status).toBe(200)
    expect((await ask(api, 'list', { body: {} })).status).toBe(200)
    expect((await ask(api, 'list', { raw: '{ nope' })).status).toBe(400)
    expect((await ask(api, 'list', { raw: '[1]' })).status).toBe(400)
    expect((await ask(api, 'list', { raw: JSON.stringify({ pad: 'x'.repeat(20_000) }) })).status).toBe(413)
  })

  it('never carries a key, an address of the RPC or a function', async () => {
    const api = challengesApi({ authKey: KEY, challenges: listing() })
    const text = await (await ask(api, 'list')).text()
    expect(text).not.toContain(KEY)
    expect(text).not.toMatch(/ws:\/\//)
    expect(JSON.parse(text)).toBeTypeOf('object')
  })
})

describe('on the gateway\'s socket', () => {
  const facade = { handle: async () => new Response('facade', { status: 200 }) }

  it('answers the challenges\' path, and still no other part of the kubo API or the unlisted paths', async () => {
    const gateway = gatewayOnly(facade, undefined, undefined, undefined, undefined, undefined, undefined, challengesApi({ authKey: KEY, challenges: listing() }))
    expect((await gateway.handle(new Request(`${ORIGIN}${CHALLENGES_API_PATH}list`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } }))).status).toBe(200)
    expect((await gateway.handle(new Request(`${ORIGIN}/api/v0/key/gen`, { method: 'POST' }))).status).toBe(404)
    expect((await gateway.handle(new Request(`${ORIGIN}/orivon/manager/boards`, { method: 'POST' }))).status).toBe(404)
    expect((await gateway.handle(new Request(`${ORIGIN}/ipfs/bafy`))).status).toBe(200)
  })

  it('answers 404 on the challenges\' path when the Worker has no such API', async () => {
    const gateway = gatewayOnly(facade)
    expect((await gateway.handle(new Request(`${ORIGIN}${CHALLENGES_API_PATH}list`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } }))).status).toBe(404)
  })
})

describe('a board\'s challenges', () => {
  const BOARD = '12D3KooWBoardA'
  const WORD = { name: '@bitsocial/wordfilter-challenge', options: { 'wordfilter/v1/rules': '[]' } }
  const world = () => {
    const settings: Record<string, Record<string, unknown>> = { [BOARD]: { challenges: [WORD], pages: { posts: [] } } }
    const edits: Array<Record<string, unknown>> = []
    const boards = boardChallenges({
      hosted: () => [{ address: BOARD, publicKey: BOARD, started: true }],
      read: async (address: string) => structuredClone(settings[address] ?? {}),
      edit: async (address: string, next: Record<string, unknown>) => { edits.push(next); settings[address] = next; return next }
    })
    return { api: challengesApi({ authKey: KEY, challenges: listing(), boards }), edits, settings }
  }

  it('lists the boards, reads one, and applies a list to it', async () => {
    const { api, edits } = world()
    expect(await json(await ask(api, 'boards'))).toEqual({ boards: [{ address: BOARD, publicKey: BOARD, started: true }] })
    expect(await json(await ask(api, 'board', { body: { address: BOARD } }))).toEqual({ address: BOARD, challenges: [WORD], otherSettings: ['pages'] })
    const applied = await ask(api, 'apply', { body: { address: BOARD, challenges: [], expect: [WORD] } })
    expect(applied.status).toBe(200)
    expect(await json(applied)).toEqual({ address: BOARD, challenges: [], otherSettings: ['pages'] })
    expect(edits).toEqual([{ challenges: [], pages: { posts: [] } }])
  })

  it('says with the boards which path reads Ethereum now, when the Worker has one, so the page names the right host for a challenge that reads it', async () => {
    const answers = [{ path: 'asking', lightClient: 0, public: 0 }, { path: 'light-client', lightClient: 2, public: 0 }]
    let asked = 0
    const hosted = () => [{ address: BOARD, publicKey: BOARD, started: true }]
    const boards = boardChallenges({ hosted, read: async () => ({}), edit: async (_address: string, next: Record<string, unknown>) => next })
    const api = challengesApi({ authKey: KEY, challenges: listing(), boards, ethereum: () => { asked += 1; return answers[Math.min(asked, answers.length) - 1] as Record<string, unknown> } })
    expect(await json(await ask(api, 'boards'))).toEqual({ boards: [{ address: BOARD, publicKey: BOARD, started: true }], ethereum: answers[0] })
    expect(await json(await ask(api, 'boards'))).toMatchObject({ ethereum: answers[1] })
    const other = challengesApi({ authKey: KEY, challenges: listing(), boards })
    expect(await json(await ask(other, 'boards'))).not.toHaveProperty('ethereum')
    // only the board list says it: not the list of challenges, and not the key
    expect(await json(await ask(api, 'list'))).not.toHaveProperty('ethereum')
    expect(asked).toBe(2)
  })

  it('answers 404 for a board this node does not host, 409 for a list that changed since the page read it, and 400 for what is not a request', async () => {
    const { api, edits } = world()
    expect((await ask(api, 'board', { body: { address: 'other.bso' } })).status).toBe(404)
    expect((await ask(api, 'apply', { body: { address: 'other.bso', challenges: [] } })).status).toBe(404)
    const stale = await ask(api, 'apply', { body: { address: BOARD, challenges: [], expect: [] } })
    expect(stale.status).toBe(409)
    expect((await json(stale)).Message).toMatch(/changed since/)
    for (const body of [{}, { address: 7 }, { address: BOARD }, { address: BOARD, challenges: 'x' }, { address: BOARD, challenges: [], expect: 'x' }]) {
      expect((await ask(api, 'apply', { body })).status, JSON.stringify(body)).toBe(400)
    }
    expect((await ask(api, 'board', { body: {} })).status).toBe(400)
    expect(edits).toEqual([])
  })

  it('answers 400 with the failures of each challenge, where pkc-js refuses the settings', async () => {
    const settings: Record<string, any> = { [BOARD]: {} }
    const boards = boardChallenges({
      hosted: () => [{ address: BOARD, publicKey: BOARD, started: false }],
      read: async () => ({}),
      edit: async () => { throw Object.assign(new Error('x'), { code: 'ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED_FOR_CHALLENGES', details: { failures: [{ challengeIndex: 0, challengeName: 'text-math', error: Object.assign(new Error('x'), { code: 'ERR_CHALLENGE_REQUIRED_OPTION_MISSING', details: { missingOption: 'difficulty' } }) }] } }) }
    })
    const response = await ask(challengesApi({ authKey: KEY, challenges: listing(), boards }), 'apply', { body: { address: BOARD, challenges: [{ name: 'text-math' }] } })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ Type: 'error', Message: 'Challenge 1 (text-math): a required option is missing: difficulty.', failures: [{ index: 0, name: 'text-math', option: 'difficulty' }] })
    expect(settings[BOARD]).toEqual({})
  })

  it('takes a list larger than the 16 KiB a read call takes, and refuses one above 256 KiB', async () => {
    const { api } = world()
    const big = { name: 'text-math', options: { note: 'x'.repeat(30_000) } }
    expect((await ask(api, 'apply', { body: { address: BOARD, challenges: [big] } })).status).toBe(200)
    expect((await ask(api, 'apply', { raw: JSON.stringify({ address: BOARD, challenges: [{ name: 'x', options: { pad: 'x'.repeat(300_000) } }] }) })).status).toBe(413)
    expect((await ask(api, 'board', { raw: JSON.stringify({ address: BOARD, pad: 'x'.repeat(20_000) }) })).status).toBe(413)
  })

  it('needs the key before it reads a board, and says 503 for a build that cannot edit one', async () => {
    const { api, edits } = world()
    for (const call of ['boards', 'board', 'apply']) expect((await ask(api, call, { key: 'wrong', body: { address: BOARD, challenges: [] } })).status, call).toBe(401)
    expect(edits).toEqual([])
    const none = challengesApi({ authKey: KEY, challenges: listing() })
    for (const call of ['boards', 'board', 'apply']) {
      const response = await ask(none, call, { body: { address: BOARD, challenges: [] } })
      expect(response.status, call).toBe(503)
      expect((await json(response)).Message).toMatch(/cannot edit/)
    }
    expect((await ask(none, 'list')).status).toBe(200)
  })

  it('never carries a key or an address of the RPC', async () => {
    const { api } = world()
    for (const call of ['boards', 'board']) {
      const text = await (await ask(api, call, { body: { address: BOARD } })).text()
      expect(text).not.toContain(KEY)
      expect(text).not.toMatch(/ws:\/\//)
    }
  })
})
