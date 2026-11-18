// The Worker calls the node's API over `http.request`, one socket a request, when its entry asks it to, and the trace switch still writes each call. The node here
// is a real `http` server on the API port; the engine's `fetch` fails on any call to that port, so a call that reaches the server did not go through it.
import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startWorker } from '../worker/run.js'
import { setup, useWorkerFolder } from './support/worker-harness.ts'

useWorkerFolder()

const open: http.Server[] = []
afterEach(async () => { await Promise.all(open.splice(0).map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))) })

/** A node's API on `port`: what the Worker asks it before it is ready, a key list and an id, and every request it receives. */
async function standInNode (port: number) {
  const seen: Array<{ method: string, url: string, key: string | undefined }> = []
  const sockets = new Set<net.Socket>()
  const server = http.createServer((request, response) => {
    seen.push({ method: request.method ?? '', url: request.url ?? '', key: request.headers['x-orivon-key'] as string | undefined })
    request.resume()
    if (request.url === '/health') { response.end('ok\n'); return }
    if (request.url === '/orivon/publishing') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ keys: 'sealed' })); return }
    if (request.url === '/id') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ peer: '12D3KooWnode', addresses: [] })); return }
    if (request.url?.startsWith('/status') === true) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ peer: '12D3KooWnode', reachability: 'unknown', listen: [], external: [] })); return }
    response.writeHead(404); response.end('no such route')
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  open.push(server)
  await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve) })
  return { seen, connections: () => sockets.size }
}

/** The engine's fetch as the Worker has it: it fails on a call to the node's API port, so only a call over `http` reaches the stand-in. */
const refusingTheNode = (port: number) => (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input))
  if (url.port === String(port)) throw new Error(`the engine's fetch reached the node's API: ${url.href}`)
  return new Response('other', { status: 200 })
}) as typeof fetch

/** A node's API that holds each read of a name until `release` lets it answer, and how many it holds. */
async function holdingNameReads (port: number) {
  const waiting: http.ServerResponse[] = []
  const server = http.createServer((request, response) => {
    request.resume()
    if (request.url === '/health') { response.end('ok\n'); return }
    if (request.url === '/orivon/publishing') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ keys: 'sealed' })); return }
    if (request.url?.startsWith('/orivon/name/resolve/') === true) { waiting.push(response); return }
    response.writeHead(404); response.end('no such route')
  })
  open.push(server)
  await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve) })
  return {
    held: () => waiting.length,
    release: (count = waiting.length) => { for (const response of waiting.splice(0, count)) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ value: '/ipfs/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })) } }
  }
}

/** Waits until `check` holds, for up to two seconds. */
async function until (check: () => boolean): Promise<void> {
  for (let waited = 0; !check() && waited < 2000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
}

/** Asks the facade, as pkc-js does, for `count` names at once with no recursion; resolves with the answers once the node gives them. */
function askNames (run: Awaited<ReturnType<typeof setup>>, count: number) {
  return Array.from({ length: count }, (_, index) => run.scope.fetch(`http://127.0.0.1:${String(run.config.ports.kubo)}/api/v0/name/resolve?arg=12D3KooWname${String(index)}&recursive=false`, { method: 'POST' }))
}

describe('the reads that wait on the network, out at once', () => {
  it('are all sent when the node is called over http, because the engine\'s six connections are not in the way', async () => {
    const run = await setup()
    const node = await holdingNameReads(run.config.ports.nodeApi)
    Object.assign(run.environment, { nodeOverHttp: true })
    await startWorker(run.environment as never)
    const answers = askNames(run, 10)
    await until(() => node.held() === 10)
    expect(node.held()).toBe(10)
    node.release()
    expect((await Promise.all(answers)).map((answer) => answer.status)).toEqual(Array(10).fill(200))
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('keep the engine\'s share of the six when the node is called with the engine\'s fetch', async () => {
    const run = await setup()
    const waiting: Array<(response: Response) => void> = []
    const engine = run.environment.fetch
    run.environment.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      if (!url.pathname.startsWith('/orivon/name/resolve/')) return engine(input, init)
      return new Promise<Response>((resolve) => { waiting.push(resolve) })
    }) as typeof fetch
    await startWorker(run.environment as never)
    const answers = askNames(run, 10)
    await until(() => waiting.length === 4)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(waiting.length).toBe(4)
    while (waiting.length > 0) { waiting.shift()!(Response.json({ value: '/ipfs/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })); await new Promise((resolve) => setTimeout(resolve, 10)) }
    expect((await Promise.all(answers)).map((answer) => answer.status)).toEqual(Array(10).fill(200))
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('are held to the share of the six over http when BITSOCIAL_SLOW_CALLS is "share", and to a number when it is one', async () => {
    for (const [setting, cap] of [['share', 4], ['2', 2]] as const) {
      const run = await setup()
      const node = await holdingNameReads(run.config.ports.nodeApi)
      Object.assign(run.environment, { nodeOverHttp: true })
      run.environment.env['BITSOCIAL_SLOW_CALLS'] = setting
      await startWorker(run.environment as never)
      const answers = askNames(run, 10)
      await until(() => node.held() === cap)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(node.held()).toBe(cap)
      for (let guard = 0; guard < 20 && node.held() > 0; guard += 1) { node.release(1); await new Promise((resolve) => setTimeout(resolve, 15)) }
      expect((await Promise.all(answers)).map((answer) => answer.status)).toEqual(Array(10).fill(200))
      await run.handlers[0]!({ cmd: 'stop' })
    }
  })
})

describe('startWorker with the node called over http', () => {
  it('reaches the node\'s API with its health check, the node client and the readers over http, and never with the engine\'s fetch', async () => {
    const run = await setup({ flags: ['--publish'] })
    const node = await standInNode(run.config.ports.nodeApi)
    run.environment.fetch = refusingTheNode(run.config.ports.nodeApi)
    Object.assign(run.environment, { nodeOverHttp: true })
    await startWorker(run.environment as never)
    expect(run.sent.filter((message) => message['type'] === 'node').map((message) => message['state'])).toEqual(['starting', 'up'])
    await run.scope.fetch(`http://127.0.0.1:${String(run.config.ports.kubo)}/api/v0/id`, { method: 'POST' })
    const paths = node.seen.map((call) => `${call.method} ${call.url}`)
    expect(paths).toContain('GET /health')
    expect(paths).toContain('GET /orivon/publishing')
    expect(paths).toContain('GET /id')
    expect(node.seen.find((call) => call.url === '/id')?.key).toBe('f'.repeat(64))
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('writes each call over http to the log when BITSOCIAL_FACADE_TRACE is 1, the node client\'s and the Worker\'s own', async () => {
    const run = await setup({ flags: ['--publish'] })
    await standInNode(run.config.ports.nodeApi)
    run.environment.fetch = refusingTheNode(run.config.ports.nodeApi)
    Object.assign(run.environment, { nodeOverHttp: true })
    ;(run.environment.env as Record<string, string>)['BITSOCIAL_FACADE_TRACE'] = '1'
    await startWorker(run.environment as never)
    await run.scope.fetch(`http://127.0.0.1:${String(run.config.ports.kubo)}/api/v0/id`, { method: 'POST' })
    expect(run.lines.filter((line) => /^node fetch call t=\d+ GET \/health/.test(line)).length).toBeGreaterThan(0)
    expect(run.lines.filter((line) => /^node fetch done t=\d+ GET \/health 200 in \d+ ms/.test(line)).length).toBeGreaterThan(0)
    expect(run.lines.filter((line) => /^node call t=\d+ GET \/id lane=control waited=\d+ out=\d+ held=\d+$/.test(line))).toHaveLength(1)
    expect(run.lines.filter((line) => /^node done t=\d+ GET \/id 200 in \d+ ms$/.test(line))).toHaveLength(1)
    await run.handlers[0]!({ cmd: 'stop' })
  })

  it('keeps the engine\'s fetch for the node when the entry does not ask for http, and no call reaches the server', async () => {
    const run = await setup()
    const node = await standInNode(run.config.ports.nodeApi)
    await startWorker(run.environment as never)
    await run.scope.fetch(`http://127.0.0.1:${String(run.config.ports.kubo)}/api/v0/id`, { method: 'POST' })
    expect(node.seen).toEqual([])
    expect(run.sent.filter((message) => message['type'] === 'node').map((message) => message['state'])).toEqual(['starting', 'up'])
    await run.handlers[0]!({ cmd: 'stop' })
  })
})
