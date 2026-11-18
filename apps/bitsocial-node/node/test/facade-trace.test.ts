// What the Worker writes about the facade's refusals: the route and the status, and not every one of them.
import { describe, expect, it } from 'vitest'
import { traceFacade, traceFetch } from '../worker/facade-trace.js'

const answering = (status: number) => ({ handle: async (_request: Request) => new Response('x', { status }), gateway: '/ip4/127.0.0.1/tcp/1' })

describe('traceFacade', () => {
  it('logs the method, the path and the text of an answer of 400 or more and passes every answer through', async () => {
    const lines: string[] = []
    const fine = traceFacade(answering(200), (line) => lines.push(line))
    const refused = traceFacade(answering(404), (line) => lines.push(line))
    expect((await fine.handle(new Request('http://127.0.0.1:1/api/v0/id', { method: 'POST' }))).status).toBe(200)
    expect((await refused.handle(new Request('http://127.0.0.1:1/api/v0/pubsub/ls?arg=x', { method: 'POST' }))).status).toBe(404)
    expect(lines).toEqual(['facade POST /api/v0/pubsub/ls answered 404: x'])
    expect(refused.gateway).toBe('/ip4/127.0.0.1/tcp/1')
  })

  it('logs a call that throws, and throws it on', async () => {
    const lines: string[] = []
    const broken = traceFacade({ handle: async (_request: Request): Promise<Response> => { throw new TypeError('boom') } }, (line) => lines.push(line))
    await expect(broken.handle(new Request('http://127.0.0.1:1/ipfs/x'))).rejects.toThrow('boom')
    expect(lines).toEqual(['facade GET /ipfs/x threw TypeError: boom'])
  })

  it('stops after forty lines in a minute and starts again in the next', async () => {
    const lines: string[] = []
    let clock = 0
    const refused = traceFacade(answering(500), (line) => lines.push(line), () => clock)
    for (let index = 0; index < 100; index += 1) await refused.handle(new Request('http://127.0.0.1:1/x'))
    expect(lines).toHaveLength(40)
    clock = 61_000
    await refused.handle(new Request('http://127.0.0.1:1/x'))
    expect(lines).toHaveLength(41)
  })
})

describe('traceFacade with the call trace on', () => {

  it('logs the start and the end of a name, key or routing call and of a gateway read of a name, each with the clock and the time it took', async () => {
    const lines: string[] = []
    let clock = 1000
    const traced = traceFacade({ handle: async (_request: Request) => { clock += 250; return new Response('x', { status: 200 }) } }, (line) => lines.push(line), () => clock, { calls: true })
    await traced.handle(new Request('http://127.0.0.1:1/api/v0/name/publish?arg=%2Fipfs%2Fbafy&key=k51abc&allow-offline=true&lifetime=8760h', { method: 'POST' }))
    await traced.handle(new Request('http://127.0.0.1:1/ipns/k51abc'))
    await traced.handle(new Request('http://127.0.0.1:1/api/v0/id', { method: 'POST' }))
    expect(lines).toEqual([
      'facade call t=1000 POST /api/v0/name/publish?arg=%2Fipfs%2Fbafy&key=k51abc&allow-offline=true&lifetime=8760h',
      'facade done t=1250 POST /api/v0/name/publish answered 200 in 250 ms',
      'facade call t=1250 GET /ipns/k51abc',
      'facade done t=1500 GET /ipns/k51abc answered 200 in 250 ms'
    ])
  })

  it('says a call that throws, with the time it took', async () => {
    const lines: string[] = []
    let clock = 0
    const traced = traceFacade({ handle: async (_request: Request): Promise<Response> => { clock += 40; throw new TypeError('boom') } }, (line) => lines.push(line), () => clock, { calls: true })
    await expect(traced.handle(new Request('http://127.0.0.1:1/api/v0/name/resolve?arg=k51', { method: 'POST' }))).rejects.toThrow('boom')
    expect(lines).toEqual([
      'facade call t=0 POST /api/v0/name/resolve?arg=k51',
      'facade POST /api/v0/name/resolve threw TypeError: boom',
      'facade done t=40 POST /api/v0/name/resolve threw after 40 ms'
    ])
  })

  it('logs a call of any other route only when it took two seconds or more, and writes nothing when the trace is off', async () => {
    const lines: string[] = []
    let clock = 0
    const quiet = { handle: async (_request: Request) => { clock += 100; return new Response('x') } }
    const long = { handle: async (_request: Request) => { clock += 2500; return new Response('x') } }
    await traceFacade(quiet, (line) => lines.push(line), () => clock, { calls: true }).handle(new Request('http://127.0.0.1:1/api/v0/pubsub/ls', { method: 'POST' }))
    expect(lines).toEqual([])
    await traceFacade(long, (line) => lines.push(line), () => clock, { calls: true }).handle(new Request('http://127.0.0.1:1/api/v0/block/get?arg=x', { method: 'POST' }))
    expect(lines).toEqual(['facade done t=2600 POST /api/v0/block/get answered 200 in 2500 ms'])
    lines.length = 0
    await traceFacade(long, (line) => lines.push(line), () => clock).handle(new Request('http://127.0.0.1:1/api/v0/name/publish', { method: 'POST' }))
    expect(lines).toEqual([])
  })

  it('stops after three hundred call lines in a minute', async () => {
    const lines: string[] = []
    const traced = traceFacade(answering(200), (line) => lines.push(line), () => 0, { calls: true })
    for (let index = 0; index < 400; index += 1) await traced.handle(new Request('http://127.0.0.1:1/ipns/k51'))
    expect(lines).toHaveLength(300)
  })
})

describe('traceFetch', () => {
  it('writes the start and the end of each call to the node\'s API that the Worker makes outside the node client, with the clock', async () => {
    const lines: string[] = []
    let clock = 5000
    const fetched: string[] = []
    const inner = (async (input: string | URL) => { fetched.push(String(input)); clock += 120; return new Response('x', { status: 200 }) }) as unknown as typeof globalThis.fetch
    const traced = traceFetch(inner, (line) => lines.push(line), () => clock)
    expect((await traced('http://127.0.0.1:5351/status?peers=true')).status).toBe(200)
    expect(fetched).toEqual(['http://127.0.0.1:5351/status?peers=true'])
    expect(lines).toEqual([
      'node fetch call t=5000 GET /status',
      'node fetch done t=5120 GET /status 200 in 120 ms'
    ])
  })

  it('says a call that fails, and fails it on', async () => {
    const lines: string[] = []
    let clock = 0
    const inner = (async (_input: string | URL, _init?: RequestInit) => { clock += 30; throw new TypeError('connection refused') }) as unknown as typeof globalThis.fetch
    const traced = traceFetch(inner, (line) => lines.push(line), () => clock)
    await expect(traced('http://127.0.0.1:5351/health', { method: 'POST' })).rejects.toThrow('connection refused')
    expect(lines).toEqual([
      'node fetch call t=0 POST /health',
      'node fetch done t=30 POST /health failed in 30 ms: TypeError'
    ])
  })
})
