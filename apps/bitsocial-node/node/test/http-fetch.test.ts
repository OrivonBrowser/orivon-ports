// The Worker's calls to the node's API go over `http.request`, one socket a request, as the desktop's Node does, so the engine's six connections to one host
// and port (which a Worker's `fetch` takes) are not what a key import waits behind. These tests run that `fetch` against a real `http` server: the shapes the
// node client and the readers use (JSON, bytes, a multipart body, a streamed ndjson answer, an abort, a refused connection) and the one socket a request.
import { EventEmitter } from 'node:events'
import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpFetch, createNodeFetch } from '../kubo/http-fetch.js'
import { createNodeClient } from '../kubo/node-client.js'

type Served = { base: string, port: number, connections: () => number, open: () => number, requests: Array<{ method: string, url: string, headers: http.IncomingHttpHeaders, body: Buffer }>, closed: Promise<void> }
const servers: http.Server[] = []
const sockets = new Set<net.Socket>()

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

/** A server whose handler gets each request with its body read; `closed` settles when the first request's connection closes before the answer ended. */
async function serve (handler: (request: http.IncomingMessage, response: http.ServerResponse, body: Buffer) => void | Promise<void>): Promise<Served> {
  let connections = 0
  const requests: Served['requests'] = []
  let closedOne!: () => void
  const closed = new Promise<void>((resolve) => { closedOne = resolve })
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    response.on('close', () => { if (!response.writableEnded) closedOne() })
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body })
      void Promise.resolve(handler(request, response, body))
    })
  })
  server.on('connection', (socket) => { connections += 1; sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as net.AddressInfo).port
  return { base: `http://127.0.0.1:${String(port)}`, port, connections: () => connections, open: () => sockets.size, requests, closed }
}

const over = () => createHttpFetch(http)
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('createHttpFetch: what a call to the node answers', () => {
  it('gives the status, the headers and the body as fetch does, for JSON and for a failure', async () => {
    const node = await serve((request, response) => {
      if (request.url === '/missing') { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('no such key'); return }
      response.writeHead(200, { 'content-type': 'application/json', 'x-orivon-node-features': 'a,b' })
      response.end(JSON.stringify({ name: 'k51abc', label: 'seedit' }))
    })
    const fetch = over()
    const ok = await fetch(`${node.base}/orivon/ipns/keys`)
    expect(ok.status).toBe(200)
    expect(ok.ok).toBe(true)
    expect(ok.headers.get('content-type')).toBe('application/json')
    expect(ok.headers.get('x-orivon-node-features')).toBe('a,b')
    expect(await ok.json()).toEqual({ name: 'k51abc', label: 'seedit' })
    const missing = await fetch(`${node.base}/missing`)
    expect(missing.status).toBe(404)
    expect(missing.ok).toBe(false)
    expect(await missing.text()).toBe('no such key')
  })

  it('answers a status with no body with no body, and a HEAD likewise', async () => {
    const node = await serve((request, response) => {
      if (request.method === 'HEAD') { response.writeHead(200, { 'content-length': '5' }); response.end(); return }
      response.writeHead(204); response.end()
    })
    const fetch = over()
    const none = await fetch(`${node.base}/x`, { method: 'DELETE' })
    expect(none.status).toBe(204)
    expect(none.body).toBeNull()
    expect(await none.text()).toBe('')
    const head = await fetch(`${node.base}/x`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('5')
    expect(await head.text()).toBe('')
  })

  it('keeps every value of a header sent twice, and an answer that redirects is the node\'s own answer, not followed', async () => {
    const node = await serve((request, response) => {
      if (request.url === '/moved') { response.writeHead(302, { location: '/elsewhere' }); response.end(); return }
      response.writeHead(200, { 'set-cookie': ['a=1', 'b=2'] }); response.end('x')
    })
    const fetch = over()
    expect([...(await fetch(`${node.base}/x`)).headers.getSetCookie()]).toEqual(['a=1', 'b=2'])
    const moved = await fetch(`${node.base}/moved`)
    expect(moved.status).toBe(302)
    expect(moved.headers.get('location')).toBe('/elsewhere')
    expect(node.requests.map((request) => request.url)).toEqual(['/x', '/moved'])
  })
})

describe('createHttpFetch: what a call to the node sends', () => {
  it('sends the method, the path with its query and the headers, and no keep-alive', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    await over()(`${node.base}/orivon/block/put?codec=raw&pin=true`, { method: 'POST', headers: { 'x-orivon-key': 'secret', 'x-orivon-partition': 'bitsocial' }, body: new Uint8Array([1, 2, 3]) })
    const [sent] = node.requests
    expect(sent?.method).toBe('POST')
    expect(sent?.url).toBe('/orivon/block/put?codec=raw&pin=true')
    expect(sent?.headers['x-orivon-key']).toBe('secret')
    expect(sent?.headers['x-orivon-partition']).toBe('bitsocial')
    expect(sent?.headers['connection']).toBe('close')
    expect(sent?.headers['host']).toBe(`127.0.0.1:${String(node.port)}`)
  })

  it('sends bytes exactly, a view of a larger buffer as only its own bytes, with their length', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    const whole = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9])
    await over()(`${node.base}/a`, { method: 'POST', body: whole.subarray(2, 6) })
    await over()(`${node.base}/b`, { method: 'POST', body: whole.buffer })
    await over()(`${node.base}/c`, { method: 'PUT', body: new Uint8Array(0) })
    expect([...node.requests[0]!.body]).toEqual([1, 2, 3, 4])
    expect(node.requests[0]!.headers['content-length']).toBe('4')
    expect([...node.requests[1]!.body]).toEqual([...whole])
    expect(node.requests[2]!.body.length).toBe(0)
    expect(node.requests[2]!.headers['content-length']).toBe('0')
  })

  it('sends a string as UTF-8 with the content type fetch gives it, and keeps one the caller names', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    const fetch = over()
    await fetch(`${node.base}/a`, { method: 'POST', body: 'café' })
    await fetch(`${node.base}/b`, { method: 'POST', body: JSON.stringify({ label: 'x' }), headers: { 'content-type': 'application/json' } })
    expect(decode(node.requests[0]!.body)).toBe('café')
    expect(node.requests[0]!.headers['content-length']).toBe('5')
    expect(node.requests[0]!.headers['content-type']).toBe('text/plain;charset=UTF-8')
    expect(node.requests[1]!.headers['content-type']).toBe('application/json')
    expect(JSON.parse(decode(node.requests[1]!.body))).toEqual({ label: 'x' })
  })

  it('sends a multipart body with its boundary, a form of the other body kinds as the engine encodes it', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    const fetch = over()
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array([0, 1, 2, 255])], { type: 'application/octet-stream' }), 'block.bin')
    form.append('name', 'seedit')
    await fetch(`${node.base}/api/v0/add`, { method: 'POST', body: form })
    await fetch(`${node.base}/form`, { method: 'POST', body: new URLSearchParams({ a: '1', b: 'two words' }) })
    await fetch(`${node.base}/blob`, { method: 'POST', body: new Blob(['hello'], { type: 'text/markdown' }) })
    const [add, urlencoded, blob] = node.requests
    expect(add!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    const parsed = await new Response(add!.body, { headers: { 'content-type': add!.headers['content-type']! } }).formData()
    expect(parsed.get('name')).toBe('seedit')
    const file = parsed.get('file') as File
    expect(file.name).toBe('block.bin')
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0, 1, 2, 255])
    expect(Number(add!.headers['content-length'])).toBe(add!.body.length)
    expect(urlencoded!.headers['content-type']).toMatch(/^application\/x-www-form-urlencoded/)
    expect(decode(urlencoded!.body)).toBe('a=1&b=two+words')
    expect(blob!.headers['content-type']).toBe('text/markdown')
    expect(decode(blob!.body)).toBe('hello')
  })

  it('streams a ReadableStream body in chunks, as the request goes, and ends it', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    const parts = ['one,', 'two,', 'three']
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      async pull (controller) {
        if (sent === parts.length) { controller.close(); return }
        await tick(5)
        controller.enqueue(new TextEncoder().encode(parts[sent++]))
      }
    })
    const answer = await over()(`${node.base}/pubsub/pub?topic=t`, { method: 'POST', body, duplex: 'half' } as RequestInit)
    expect(await answer.text()).toBe('ok')
    expect(decode(node.requests[0]!.body)).toBe('one,two,three')
    expect(node.requests[0]!.headers['transfer-encoding']).toBe('chunked')
  })

  it('sends a body that is a megabytes, whole', async () => {
    const node = await serve((_request, response, body) => { response.end(body) })
    const big = new Uint8Array(4 * 1024 * 1024).map((_value, index) => (index * 31) % 251)
    const answer = await over()(`${node.base}/echo`, { method: 'POST', body: big })
    const back = new Uint8Array(await answer.arrayBuffer())
    expect(back.length).toBe(big.length)
    expect(Buffer.from(back).equals(Buffer.from(big))).toBe(true)
  })

  it('sends what a Request names, with what the call adds over it', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    const request = new Request(`${node.base}/orivon/pin/bafy`, { method: 'POST', headers: { 'x-a': '1' }, body: 'hello' })
    await over()(request, { headers: { 'x-b': '2' } })
    expect(node.requests[0]!.method).toBe('POST')
    expect(node.requests[0]!.headers['x-b']).toBe('2')
    expect(decode(node.requests[0]!.body)).toBe('hello')
  })
})

describe('createHttpFetch: an answer that arrives as a stream', () => {
  it('resolves at the headers, and hands each line over as the node sends it', async () => {
    let writeSecond!: () => void
    const second = new Promise<void>((resolve) => { writeSecond = resolve })
    const node = await serve(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.write('{"n":1}\n')
      await second
      response.write('{"n":2}\n')
      response.end()
    })
    const answer = await over()(`${node.base}/pubsub/sub?topic=t`, { method: 'POST' })
    expect(answer.status).toBe(200)
    const reader = answer.body!.getReader()
    expect(decode((await reader.read()).value!)).toBe('{"n":1}\n')
    writeSecond()
    expect(decode((await reader.read()).value!)).toBe('{"n":2}\n')
    expect((await reader.read()).done).toBe(true)
  })

  it('answers a body of megabytes read slowly, whole and in order', async () => {
    const big = Buffer.from(new Uint8Array(6 * 1024 * 1024).map((_value, index) => (index * 7) % 253))
    const node = await serve((_request, response) => { response.end(big) })
    const answer = await over()(`${node.base}/orivon/cat/bafy`)
    const reader = answer.body!.getReader()
    const parts: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      if (parts.length % 16 === 0) await tick(1)
    }
    expect(Buffer.concat(parts).equals(big)).toBe(true)
  })

  it('fails the body when the node cuts the connection part-way', async () => {
    const node = await serve((_request, response) => {
      response.writeHead(200, { 'content-length': '100' })
      response.write('only a part')
      setTimeout(() => { response.socket?.destroy() }, 10)
    })
    const answer = await over()(`${node.base}/x`)
    await expect(answer.text()).rejects.toBeDefined()
  })

  it('closes the connection when the body is cancelled', async () => {
    const node = await serve((_request, response) => { response.writeHead(200); response.write('start') })
    const answer = await over()(`${node.base}/pubsub/sub`, { method: 'POST' })
    const reader = answer.body!.getReader()
    await reader.read()
    await reader.cancel()
    await node.closed
    await tick()
    expect(node.open()).toBe(0)
  })
})

describe('createHttpFetch: an abort', () => {
  it('rejects at once with the signal\'s reason, and sends nothing, when it was aborted already', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    const controller = new AbortController()
    controller.abort()
    await expect(over()(`${node.base}/x`, { signal: controller.signal })).rejects.toBe(controller.signal.reason)
    await tick()
    expect(node.connections()).toBe(0)
  })

  it('rejects with the reason when the signal aborts while the node has not answered, and closes the connection', async () => {
    const node = await serve(() => { /* never answers */ })
    const controller = new AbortController()
    const asking = over()(`${node.base}/orivon/name/resolve/k51`, { signal: controller.signal })
    await tick(30)
    controller.abort()
    await expect(asking).rejects.toMatchObject({ name: 'AbortError' })
    await node.closed
  })

  it('rejects with a timeout signal\'s own reason', async () => {
    const node = await serve(() => { /* never answers */ })
    await expect(over()(`${node.base}/x`, { signal: AbortSignal.timeout(40) })).rejects.toMatchObject({ name: 'TimeoutError' })
    await node.closed
  })

  it('fails the body being read, with the reason, when the signal aborts after the headers', async () => {
    const node = await serve((_request, response) => { response.writeHead(200); response.write('start') })
    const controller = new AbortController()
    const answer = await over()(`${node.base}/pubsub/sub`, { method: 'POST', signal: controller.signal })
    const reader = answer.body!.getReader()
    expect(decode((await reader.read()).value!)).toBe('start')
    const next = reader.read()
    controller.abort(new Error('stopped'))
    await expect(next).rejects.toThrow('stopped')
    await node.closed
  })

  it('stops sending a body that is a stream when the signal aborts', async () => {
    const node = await serve(() => { /* waits for the whole body */ })
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({ start (stream) { stream.enqueue(new Uint8Array([1])) } })
    const asking = over()(`${node.base}/x`, { method: 'POST', body, signal: controller.signal, duplex: 'half' } as RequestInit)
    await tick(30)
    controller.abort()
    await expect(asking).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('createHttpFetch: a call that cannot be made', () => {
  it('rejects a refused connection as fetch does: a TypeError "fetch failed" that keeps the cause', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    const gone = node.base
    await new Promise((resolve) => servers[0]!.close(resolve))
    const error = await over()(`${gone}/health`).catch((caught: unknown) => caught) as TypeError & { cause?: { code?: string } }
    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toBe('fetch failed')
    expect(error.cause?.code).toBe('ECONNREFUSED')
  })

  it('rejects a URL that is not http as fetch does, without a connection', async () => {
    await expect(over()('https://127.0.0.1:1/x')).rejects.toBeInstanceOf(TypeError)
    await expect(over()('not a url')).rejects.toBeInstanceOf(TypeError)
  })
})

describe('createHttpFetch: one socket a request', () => {
  it('keeps more than six calls out at once, each on a socket of its own', async () => {
    const waiting: http.ServerResponse[] = []
    const node = await serve((_request, response) => {
      waiting.push(response)
      if (waiting.length === 12) for (const one of waiting) one.end('ok')
    })
    const fetch = over()
    const answers = await Promise.all(Array.from({ length: 12 }, (_value, index) => fetch(`${node.base}/orivon/name/resolve/${String(index)}`).then((answer) => answer.text())))
    expect(answers).toEqual(Array.from({ length: 12 }, () => 'ok'))
    expect(node.connections()).toBe(12)
  })

  it('does not reuse a socket for the next call', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    const fetch = over()
    for (let index = 0; index < 5; index += 1) await (await fetch(`${node.base}/health`)).text()
    expect(node.connections()).toBe(5)
    await tick()
    expect(node.open()).toBe(0)
  })
})

/** `http` as the shim has it when the origin's call limiter refuses the first `refusals` dials: a request that fails with code "limit" before it reaches the server. */
function refusing (refusals: number) {
  const state = { left: refusals, asked: 0 }
  const module = {
    request (options: Record<string, unknown>) {
      state.asked += 1
      if (state.left <= 0) return http.request(options)
      state.left -= 1
      const request = new EventEmitter() as EventEmitter & { end: () => void, write: () => boolean, destroy: () => void }
      request.end = () => { queueMicrotask(() => { request.emit('error', Object.assign(new Error('this origin is calling too frequently; wait and retry'), { code: 'limit' })) }) }
      request.write = () => true
      request.destroy = () => {}
      return request
    }
  }
  return { module, state }
}

describe('createHttpFetch: a call the origin\'s limiter refuses', () => {
  it('sends it again after the shim\'s pauses, and the node gets it once, whole', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    const { module, state } = refusing(3)
    const pauses: number[] = []
    const notes: string[] = []
    const fetch = createHttpFetch(module, { pause: async (ms) => { pauses.push(ms) }, note: (line) => notes.push(line) })
    const answer = await fetch(`${node.base}/orivon/ipns/keys/import?label=x`, { method: 'POST', body: new Uint8Array([7, 8, 9]) })
    expect(await answer.text()).toBe('ok')
    expect(pauses).toEqual([10, 25, 50])
    expect(state.asked).toBe(4)
    expect(node.requests).toHaveLength(1)
    expect([...node.requests[0]!.body]).toEqual([7, 8, 9])
    expect(notes).toHaveLength(3)
    expect(notes[0]).toBe('node http POST /orivon/ipns/keys/import refused by the origin\'s call limit, asking again in 10 ms (ask 2)')
  })

  it('gives up after the last pause and rejects as a call that cannot be made, with the limit as the cause', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    const { module, state } = refusing(100)
    const pauses: number[] = []
    const error = await createHttpFetch(module, { pause: async (ms) => { pauses.push(ms) } })(`${node.base}/x`).catch((caught: unknown) => caught) as TypeError & { cause?: { code?: string } }
    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toBe('fetch failed')
    expect(error.cause?.code).toBe('limit')
    expect(pauses).toEqual([10, 25, 50, 100, 200, 200, 200, 400, 400, 400, 800, 800, 800])
    expect(state.asked).toBe(14)
    expect(node.connections()).toBe(0)
  })

  it('does not send again a call that failed for any other reason', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    const gone = node.base
    await new Promise((resolve) => servers[0]!.close(resolve))
    const pauses: number[] = []
    await expect(createHttpFetch(http, { pause: async (ms) => { pauses.push(ms) } })(`${gone}/health`)).rejects.toBeInstanceOf(TypeError)
    expect(pauses).toEqual([])
  })

  it('does not send a streamed body again, because it was consumed', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    const { module, state } = refusing(1)
    const body = new ReadableStream<Uint8Array>({ start (controller) { controller.enqueue(new Uint8Array([1])); controller.close() } })
    await expect(createHttpFetch(module, { pause: async () => {} })(`${node.base}/x`, { method: 'POST', body, duplex: 'half' } as RequestInit)).rejects.toBeInstanceOf(TypeError)
    expect(state.asked).toBe(1)
  })

  it('stops waiting to ask again when the signal aborts', async () => {
    const node = await serve((_request, response) => { response.end('ok') })
    const { module, state } = refusing(100)
    const controller = new AbortController()
    const asking = createHttpFetch(module, { pause: () => new Promise(() => {}) })(`${node.base}/x`, { signal: controller.signal })
    await tick(30)
    controller.abort()
    await expect(asking).rejects.toMatchObject({ name: 'AbortError' })
    expect(state.asked).toBe(1)
  })
})

describe('createNodeFetch', () => {
  it('sends the node API\'s own calls over http and every other URL to the fetch it was given', async () => {
    const node = await serve((_request, response) => { response.end('from the node') })
    const other: string[] = []
    const fallback = (async (input: string | URL | Request) => { other.push(String(input instanceof Request ? input.url : input)); return new Response('from the engine') }) as typeof fetch
    const fetch = createNodeFetch({ http, base: node.base, fetch: fallback })
    expect(await (await fetch(`${node.base}/health`)).text()).toBe('from the node')
    expect(await (await fetch(new URL(`${node.base}/status`))).text()).toBe('from the node')
    expect(await (await fetch(new Request(`${node.base}/id`))).text()).toBe('from the node')
    expect(await (await fetch('https://ethereum.example/rpc', { method: 'POST', body: '{}' })).text()).toBe('from the engine')
    expect(await (await fetch(`http://127.0.0.1:${String(node.port + 1)}/x`)).text()).toBe('from the engine')
    expect(other).toEqual(['https://ethereum.example/rpc', `http://127.0.0.1:${String(node.port + 1)}/x`])
    expect(node.requests.map((request) => request.url)).toEqual(['/health', '/status', '/id'])
  })

  it('serves the node client: its key and partition headers, a block put, an answer read as JSON, a pubsub stream held open', async () => {
    const node = await serve((request, response, body) => {
      if (request.url?.startsWith('/orivon/block/put') === true) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ cid: 'bafy', size: body.length })); return }
      if (request.url === '/orivon/ipns/keys') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify([{ label: 'seedit', name: 'k51abc' }])); return }
      if (request.url === '/pubsub/sub?topic=t') { response.writeHead(200); response.write('{"data":"x"}\n'); return }
      response.writeHead(404); response.end('no such route')
    })
    const lines: string[] = []
    const client = createNodeClient({ base: node.base, key: 'k', fetch: createNodeFetch({ http, base: node.base, fetch: globalThis.fetch }), trace: (line) => lines.push(line) })
    expect(await client.putBlock(new Uint8Array([1, 2, 3]), { codec: 'raw', pin: true })).toEqual({ cid: 'bafy', size: 3 })
    expect(await client.listKeys()).toEqual([{ label: 'seedit', name: 'k51abc' }])
    const stream = await client.pubsubSubscribe('t')
    expect(decode((await stream.body!.getReader().read()).value!)).toBe('{"data":"x"}\n')
    await expect(client.cat('bafy/missing')).rejects.toMatchObject({ name: 'NodeError', status: 404, text: 'no such route' })
    expect(node.requests[0]!.headers['x-orivon-key']).toBe('k')
    expect(node.requests[0]!.headers['x-orivon-partition']).toBe('bitsocial')
    expect(lines.filter((line) => line.startsWith('node call ')).map((line) => line.split(' ').slice(3, 5).join(' '))).toEqual(['POST /orivon/block/put', 'GET /orivon/ipns/keys', 'POST /pubsub/sub', 'GET /orivon/cat/bafy/missing'])
    expect(lines.filter((line) => line.startsWith('node done ')).length).toBe(4)
  })
})
