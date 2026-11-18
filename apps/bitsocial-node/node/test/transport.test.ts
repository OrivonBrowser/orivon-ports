// The two ways in: the fetch hook, which answers in this process, and the loopback listener.
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFetchHook, listenFacade } from '../kubo/index.js'
import { encodeRpcText } from '../kubo/wire.js'
import { API, createEnv, GATEWAY } from './support/env.ts'

let env: Awaited<ReturnType<typeof createEnv>>
beforeEach(async () => { env = await createEnv() })
afterEach(async () => { await env.cleanup() })

describe('installFetchHook', () => {
  it('answers requests to its origin and passes every other to the fetch that was there', async () => {
    const seen: string[] = []
    const target = { fetch: (async (input: string | URL | Request) => { seen.push(String(input)); return new Response('elsewhere') }) as typeof fetch }
    const restore = installFetchHook(target, API, env.facade)
    expect((await target.fetch(`${API}/api/v0/id`, { method: 'POST' })).status).toBe(200)
    expect(await (await target.fetch('https://example.org/x')).text()).toBe('elsewhere')
    expect(seen).toEqual(['https://example.org/x'])
    restore()
    expect(await (await target.fetch(`${API}/api/v0/id`, { method: 'POST' })).text()).toBe('elsewhere')
  })

  it('covers several origins, such as a gateway on its own port', async () => {
    const target = { fetch: (async () => new Response('elsewhere')) as typeof fetch }
    installFetchHook(target, [API, 'http://127.0.0.1:8080'], env.facade)
    expect((await target.fetch('http://127.0.0.1:8080/ipns/x?format=ipns-record')).status).toBe(404)
  })

  it('reads a body whatever it is: text, bytes, FormData, a stream, an async iterable, a Request', async () => {
    const target = { fetch: globalThis.fetch }
    installFetchHook(target, API, env.facade)
    const bytes = new TextEncoder().encode('block body')
    const put = async (init: RequestInit): Promise<string> => {
      const response = await target.fetch(`${API}/api/v0/block/put?format=raw`, { method: 'POST', ...init })
      return ((await response.json()) as { Key: string }).Key
    }
    const form = new FormData()
    form.append('file', new Blob([bytes]))
    const encoder = new TextEncoder()
    const pieces = [
      encoder.encode('--B\r\nContent-Disposition: form-data; name="file"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n'),
      bytes.subarray(0, 3), bytes.subarray(3), encoder.encode('\r\n--B--\r\n')
    ]
    const multipart = { 'content-type': 'multipart/form-data; boundary=B' }
    const stream = new ReadableStream<Uint8Array>({ start (controller) { for (const piece of pieces) controller.enqueue(piece); controller.close() } })
    async function * iterate (): AsyncGenerator<Uint8Array | string> {
      yield pieces[0] as Uint8Array
      yield 'block'
      yield ' body'
      yield '\r\n--B--\r\n'
    }
    const expected = await put({ body: form })
    expect(await put({ body: iterate() as never, headers: multipart })).toBe(expected)
    expect(await put({ body: stream, headers: multipart, duplex: 'half' } as never)).toBe(expected)
    expect(await put({ body: Buffer.concat(pieces), headers: multipart })).toBe(expected)
    const request = new Request(`${API}/api/v0/block/put?format=raw`, { method: 'POST', body: form })
    expect(((await (await target.fetch(request)).json()) as { Key: string }).Key).toBe(expected)
  })

  it('rejects with an AbortError for a signal already aborted, and ends a stream the caller aborts', async () => {
    const target = { fetch: globalThis.fetch }
    installFetchHook(target, API, env.facade)
    const gone = AbortSignal.abort()
    await expect(target.fetch(`${API}/api/v0/id`, { method: 'POST', signal: gone })).rejects.toMatchObject({ name: 'AbortError' })

    const controller = new AbortController()
    const response = await target.fetch(`${API}/api/v0/pubsub/sub?arg=${encodeRpcText('topic')}`, { method: 'POST', signal: controller.signal })
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const pending = reader.read()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('listenFacade', () => {
  async function request (port: number, path: string, headers: Record<string, string> = {}, method = 'POST'): Promise<{ status: number, body: string }> {
    return new Promise((resolve, reject) => {
      const outgoing = http.request({ host: '127.0.0.1', port, path, method, headers }, (incoming) => {
        let body = ''
        incoming.on('data', (chunk) => { body += chunk })
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body }))
      })
      outgoing.on('error', reject)
      outgoing.end()
    })
  }

  it('serves the same handler on loopback, with the real fetch', async () => {
    const server = await listenFacade(http, 0, env.facade)
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const id = await (await fetch(`${server.url}/api/v0/id`, { method: 'POST' })).json() as { ID: string }
      expect(id.ID).toMatch(/^12D3Koo/)
      const form = new FormData()
      form.append('file', new Blob(['over a socket']))
      const added = await (await fetch(`${server.url}/api/v0/add`, { method: 'POST', body: form })).text()
      expect(JSON.parse(added.trim())).toMatchObject({ Hash: expect.stringMatching(/^Qm/) })
      expect((await fetch(`${server.url}/ipns/12D3KooWNoSuchName?format=ipns-record`)).status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('refuses a request whose Host is not the loopback address, and one from a web page', async () => {
    const server = await listenFacade(http, 0, env.facade)
    try {
      expect((await request(server.port, '/api/v0/id', { host: 'evil.example' })).status).toBe(403)
      expect((await request(server.port, '/api/v0/id', { host: `localhost:${server.port}` })).status).toBe(200)
      expect((await request(server.port, '/api/v0/id', { origin: 'https://evil.example' })).status).toBe(403)
    } finally {
      await server.close()
    }
  })

  it('streams a subscription and lets go of it when the client leaves', async () => {
    const server = await listenFacade(http, 0, env.facade)
    try {
      const controller = new AbortController()
      const response = await fetch(`${server.url}/api/v0/pubsub/sub?arg=${encodeRpcText('live')}`, { method: 'POST', signal: controller.signal })
      expect(env.node.subscribed()).toEqual(['live'])
      env.node.deliver('live', new TextEncoder().encode('ping'))
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      expect(JSON.parse(new TextDecoder().decode((await reader.read()).value))).toMatchObject({ topicIDs: [encodeRpcText('live')] })
      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(env.node.subscribed()).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('exports the gateway the facade was given', () => {
    expect(env.facade.gateway).toBe(GATEWAY)
  })
})
