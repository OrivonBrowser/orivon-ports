// The door in front of pkc-js's RPC server: a real HTTP server with the guard on it and a `ws` server behind it, which
// is the shape pkc-js builds, reached by real WebSocket clients.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guardServer, sameKey } from '../worker/rpc-guard.js'

const KEY = 'correct-horse-battery-staple-key'
let server: http.Server
let port: number
let reached: string[]

beforeEach(async () => {
  reached = []
  server = guardServer(http.createServer(), KEY)
  // What pkc-js registers on the server it is given: a listener for HTTP requests and a WebSocket server with a verifier
  // that, like pkc-js's, lets a loopback client in with no key at all.
  server.on('request', (request, response) => { reached.push(`request ${request.url ?? ''}`); response.writeHead(200).end('export bytes') })
  const sockets = new WebSocketServer({ server, verifyClient: ({ req }, done) => { reached.push(`verify ${req.url ?? ''}`); done(true) } })
  sockets.on('connection', (socket) => { socket.send('welcome') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterEach(async () => { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) })

/** Opens a WebSocket and says whether it opened, with the first message when it did. */
function connect (path: string): Promise<{ opened: boolean, message?: string }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    socket.onmessage = (event) => { socket.close(); resolve({ opened: true, message: String(event.data) }) }
    socket.onerror = () => { resolve({ opened: false }) }
  })
}

describe('sameKey', () => {
  it('is true for the same text and false for any difference, a prefix or an extension', () => {
    expect(sameKey('abc', 'abc')).toBe(true)
    expect(sameKey('abd', 'abc')).toBe(false)
    expect(sameKey('ab', 'abc')).toBe(false)
    expect(sameKey('abcd', 'abc')).toBe(false)
    expect(sameKey('', 'abc')).toBe(false)
  })
})

describe('guardServer', () => {
  it('lets a WebSocket in at the path of the key', async () => {
    expect(await connect(`/${KEY}`)).toEqual({ opened: true, message: 'welcome' })
    expect(reached).toEqual([`verify /${KEY}`])
  })

  it.each([
    ['no path', '/'],
    ['the wrong key', '/not-the-key'],
    ['a prefix of the key', `/${KEY.slice(0, -1)}`],
    ['the key with a character added', `/${KEY}x`],
    ['the key with more path after it', `/${KEY}/x`],
    ['the key with a query', `/${KEY}?a=1`]
  ])('refuses %s before pkc-js\'s verifier hears of it', async (_name, path) => {
    expect((await connect(path)).opened).toBe(false)
    expect(reached).toEqual([])
  })

  it('answers a refused upgrade with a 403 that reaches the client whole', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = http.request({ host: '127.0.0.1', port, path: '/not-the-key', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } })
      outgoing.on('response', (incoming) => { incoming.resume(); resolve(incoming.statusCode ?? 0) })
      outgoing.on('upgrade', () => { reject(new Error('the upgrade was accepted')) })
      outgoing.on('error', reject)
      outgoing.end()
    })
    expect(status).toBe(403)
  })

  it('refuses a plain HTTP request, except for an export download pkc-js serves', async () => {
    const root = await fetch(`http://127.0.0.1:${port}/`)
    expect(root.status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${port}/exports/not-an-id`)).status).toBe(404)
    expect(reached).toEqual([])
    const download = await fetch(`http://127.0.0.1:${port}/exports/0123456789abcdef0123456789abcdef0123`)
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('export bytes')
  })
})
