// The gateway's answers carry `Connection: keep-alive` and are otherwise what the facade answered.
import { describe, expect, it } from 'vitest'
import { keepAlive } from '../worker/workarounds/keep-alive.js'

describe('keepAlive', () => {
  it('adds the header and passes the status, the other headers and the body through', async () => {
    const wrapped = keepAlive({ handle: async () => new Response('bytes', { status: 206, headers: { 'Content-Type': 'image/png', 'Content-Length': '5' } }) })
    const response = await wrapped.handle(new Request('http://127.0.0.1:1/ipfs/x'))
    expect(response.status).toBe(206)
    expect(response.headers.get('connection')).toBe('keep-alive')
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(await response.text()).toBe('bytes')
  })

  it('keeps an answer with no body and no content', async () => {
    const wrapped = keepAlive({ handle: async () => new Response(null, { status: 204 }) })
    const response = await wrapped.handle(new Request('http://127.0.0.1:1/ipfs/x'))
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  it('passes a stream on as a stream', async () => {
    const wrapped = keepAlive({ handle: async () => new Response(new ReadableStream({ start (controller) { controller.enqueue(new TextEncoder().encode('a')); controller.close() } })) })
    const response = await wrapped.handle(new Request('http://127.0.0.1:1/ipfs/x'))
    expect(await response.text()).toBe('a')
  })
})
