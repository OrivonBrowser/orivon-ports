// The socket.io shim, against the packets socket.io-client 4.5 actually
// writes: an engine.io v4 handshake, a bare `40` namespace connect, `42`
// event frames, `2` heartbeat pings answered by `3`, and close both ways.
import { describe, expect, it } from 'vitest'
import { installSioShim } from './lounge-sio.js'

const SOCKET_URL = 'ws://127.0.0.1:8879/socket.io/?EIO=4&transport=websocket'

interface FakeSocket {
  readyState: number
  onmessage: ((event: { data: string }) => void) | null
  onopen: ((event: unknown) => void) | null
  pingTimer: NodeJS.Timeout | null
  send: (data: string) => void
  close: () => void
}

type WindowObject = { WebSocket: new (url: string, protocols?: string) => FakeSocket }

function harness (): { server: ReturnType<typeof installSioShim>, ws: FakeSocket, received: string[] } {
  const windowObject = {} as WindowObject
  const server = installSioShim(windowObject)
  const ws = new windowObject.WebSocket(SOCKET_URL)
  const received: string[] = []
  ws.onmessage = (event) => received.push(event.data)
  return { server, ws, received }
}

async function until (condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 500
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for engine.io traffic')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('installSioShim', () => {
  it('answers the engine.io v4 handshake and the namespace connect', async () => {
    const { server, ws, received } = harness()
    const connected = new Promise((resolve) => server.on('connect', resolve))
    await until(() => received.length > 0 && ws.readyState === 1)

    expect(JSON.parse(received[0]!.slice(1))).toMatchObject({ pingInterval: 25000, pingTimeout: 20000 })

    ws.send('40')
    await connected
    await until(() => received.some((packet) => packet.startsWith('40')))
    const ack = received.find((packet) => packet.startsWith('40'))!
    expect(JSON.parse(ack.slice(2)).sid).toBeTruthy()
  })

  it('carries events both ways as socket.io frames', async () => {
    const { server, ws, received } = harness()
    await until(() => ws.readyState === 1)
    ws.send('40')

    server.emit('init', { active: -1, networks: [] })
    await until(() => received.some((packet) => packet.startsWith('42')))
    const frame = received.find((packet) => packet.startsWith('42'))!
    expect(JSON.parse(frame.slice(2))).toEqual(['init', { active: -1, networks: [] }])

    const input = new Promise((resolve) => server.on('input', resolve))
    ws.send('42["input",{"target":1,"text":"/join #chan"}]')
    await expect(input).resolves.toEqual({ target: 1, text: '/join #chan' })
  })

  it('answers heartbeat pings and reports disconnects', async () => {
    const { server, ws, received } = harness()
    await until(() => ws.readyState === 1)
    ws.send('40')
    ws.send('2')
    await until(() => received.includes('3'))

    const disconnect = new Promise((resolve) => server.on('disconnect', resolve))
    ws.close()
    await disconnect
    expect(ws.readyState).toBe(3)
  })

  it('pings the client itself, engine.io v4 style', async () => {
    const { ws } = harness()
    await until(() => ws.readyState === 1)
    // The client resets its ping-timeout on each server ping; the pong it
    // answers with is a client packet the server may ignore.
    ws.onmessage = (event) => { if (event.data === '2') ws.send('3') }
    // No 25-second wait: the interval's existence is what the e2e proves.
    expect(ws.pingTimer).not.toBeNull()
    ws.close()
    expect(ws.pingTimer).toBeNull()
  })

  it('lets the server drop the session', async () => {
    const { server, ws, received } = harness()
    await until(() => ws.readyState === 1)
    ws.send('40')
    const disconnected = new Promise((resolve) => server.on('disconnect', resolve))
    server.disconnect()
    await disconnected
    await until(() => received.some((packet) => packet.startsWith('41')))
  })

  it('routes every other WebSocket to the real one', () => {
    class RealWebSocketStub {
      readonly url: string
      constructor (url: string) { this.url = url }
    }
    const windowObject = { WebSocket: RealWebSocketStub as unknown as new (url: string, protocols?: string) => FakeSocket }
    installSioShim(windowObject)
    const routed = new windowObject.WebSocket('ws://example.invalid/other') as unknown as RealWebSocketStub
    expect(routed.url).toBe('ws://example.invalid/other')
  })
})
