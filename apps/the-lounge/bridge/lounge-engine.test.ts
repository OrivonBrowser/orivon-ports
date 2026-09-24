// The engine end to end, as the client would drive it: a socket.io client
// against the shim, a LoungeServer attached to it, and an orivon.net fake
// whose sockets record what is written and can be fed lines like an IRC
// server would send them. Wire expectations come from upstream's own
// handlers (server/plugins/) and typed contracts (shared/types/).
import { describe, expect, it } from 'vitest'
import { installSioShim } from './lounge-sio.js'
import { LoungeServer } from './lounge-server.js'

const SOCKET_URL = 'ws://127.0.0.1:8879/socket.io/?EIO=4&transport=websocket'

interface FakeSocket {
  readyState: number
  onmessage: ((event: { data: string }) => void) | null
  send: (data: string) => void
  close: () => void
}

interface ConnectionRecord {
  opts: Record<string, unknown>
  send: (lines: string | string[]) => void
  lines: () => string[]
}

interface ClientStub {
  received: [string, any][]
  ws: FakeSocket
  connect: () => void
  emit: (event: string, ...args: any[]) => void
}

type Harness = {
  engine: LoungeServer
  client: ClientStub
  untilEvent: (name: string, predicate?: (payload: any) => boolean, occurrence?: number) => Promise<any>
  connectNetwork: (args?: Record<string, unknown>) => Promise<{ network: any, lobby: any, connection: ConnectionRecord }>
  connections: ConnectionRecord[]
}

type WindowObject = { orivon: { net: { connect: (opts: Record<string, unknown>) => Promise<unknown>, connectSecure: (opts: Record<string, unknown>) => Promise<unknown> } }, WebSocket: new (url: string) => FakeSocket }

function fakeOrivonNet (): { net: WindowObject['orivon']['net'], connections: ConnectionRecord[] } {
  const connections: ConnectionRecord[] = []
  function openConnection (opts: Record<string, unknown>) {
    let enqueue: (line: string) => void = () => {}
    const readable = new ReadableStream<Uint8Array>({ start (controller) { enqueue = (line: string) => controller.enqueue(new TextEncoder().encode(line)) } })
    const written: string[] = []
    const writable = new WritableStream<Uint8Array>({ write (chunk) { written.push(new TextDecoder().decode(chunk)) } })
    connections.push({
      opts,
      send: (lines) => enqueue(Array.isArray(lines) ? lines.join('\r\n') + '\r\n' : lines.endsWith('\r\n') ? lines : lines + '\r\n'),
      lines: () => written.join('').split('\r\n').filter(Boolean)
    })
    return Promise.resolve({ readable, writable, close: async () => {} })
  }
  return { net: { connect: openConnection, connectSecure: openConnection }, connections }
}

function harness (): Harness {
  const { net, connections } = fakeOrivonNet()
  const windowObject = { orivon: { net } } as unknown as WindowObject
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) }
  }
  const sio = installSioShim(windowObject)
  // IrcClient reads window.orivon like it would in the page.
  ;(globalThis as { window?: unknown }).window = windowObject
  const engine = new LoungeServer()
  engine.attach(sio)

  const client: ClientStub = {
    received: [],
    ws: new windowObject.WebSocket(SOCKET_URL),
    connect () { this.ws.send('40') },
    emit (event, ...args) { this.ws.send('42' + JSON.stringify([event, ...args])) }
  }
  client.ws.onmessage = (event) => {
    if (event.data.startsWith('42')) client.received.push(JSON.parse(event.data.slice(2)))
  }

  async function untilEvent (name: string, predicate: (payload: any) => boolean = () => true, occurrence = 1): Promise<any> {
    const deadline = Date.now() + 1000
    let seen = 0
    while (true) {
      const found = client.received.find(([eventName, payload]) => eventName === name && predicate(payload) && ++seen >= occurrence)
      if (found) return found[1]
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`)
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  async function connectNetwork (args: Record<string, unknown> = {}): Promise<{ network: any, lobby: any, connection: ConnectionRecord }> {
    client.connect()
    await untilEvent('auth:success')
    client.emit('network:new', { name: 'Example', host: 'irc.example.com', port: 6697, tls: true, rejectUnauthorized: true, nick: 'tester', username: 'test', realname: 'Test', join: '', ...args })
    const network = (await untilEvent('network')).network
    return { network, lobby: network.channels[0], connection: connections[0]! }
  }

  return { engine, client, untilEvent, connectNetwork, connections }
}

async function registeredSession (h: Harness, args: Record<string, unknown> = {}): Promise<{ network: any, lobby: any, connection: ConnectionRecord }> {
  const { untilEvent, connectNetwork } = h
  const session = await connectNetwork(args)
  await untilEvent('network:status', (payload: any) => payload.connected)
  session.connection.send([
    ':orb.example 001 tester :Welcome to the Example IRC Network',
    ':orb.example 005 tester PREFIX=(qaohv)~&@%+ CHANTYPES=# NETWORK=Example :are supported by this server'
  ])
  await untilEvent('network:options')
  return session

}

describe('boot, in upstream public mode', () => {
  it('sends auth:success, configuration, push:issubscribed, init and commands', async () => {
    const { client, untilEvent } = harness()
    client.connect()

    await untilEvent('auth:success')
    const configuration = await untilEvent('configuration')
    expect(configuration.public).toBe(true)
    expect(configuration.lockNetwork).toBe(false)
    expect(configuration.defaults.nick).toMatch(/^thelounge\d\d$/)
    expect(configuration.themes.map((theme: any) => theme.name)).toEqual(['default', 'morning'])

    expect(await untilEvent('push:issubscribed')).toBe(false)

    const init = await untilEvent('init')
    expect(init.networks).toEqual([])
    expect(init.active).toBe(-1)

    const commands = await untilEvent('commands')
    expect(commands).toContain('/join')
    expect(commands).toContain('/msg')
    expect(commands).toContain('/collapse')
    expect(commands).not.toContain('/search-input')
  })
})

describe('connecting a network over orivon.net', () => {
  it('opens a TLS socket and registers with NICK/USER', async () => {
    const { connectNetwork, connections } = harness()
    const { network, connection } = await connectNetwork({ nick: 'tester', username: 'test', realname: 'Test' })
    expect(connection.opts).toEqual({ host: 'irc.example.com', port: 6697, rejectUnauthorized: true })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(connection.lines()).toEqual(['NICK tester', 'USER test 0 * Test'])
    expect(network.channels.map((chan: any) => chan.type)).toEqual(['lobby'])
  })

  it('uses plain TCP for a non-TLS network', async () => {
    const { connectNetwork } = harness()
    const { connection } = await connectNetwork({ tls: false, port: 6667 })
    expect(connection.opts).toEqual({ host: 'irc.example.com', port: 6667 })
  })

  it('refuses a network without host or nick', async () => {
    const { client, untilEvent } = harness()
    client.connect()
    await untilEvent('auth:success')
    client.emit('network:new', { host: '', nick: '' })
    const message = await untilEvent('msg', (payload) => payload.msg.type === 'error')
    expect(message.msg.text).toBe('You must specify a hostname and a nickname.')
  })

  it('reports 433 and retries with a random nick', async () => {
    const { connectNetwork, connections } = harness()
    const { connection } = await connectNetwork({ nick: 'tester' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    connection.send(':orb.example 433 * tester :Nickname is already in use.')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const lines = connection.lines()
    expect(lines[lines.length - 1]).toMatch(/^NICK tester\d$/)
  })

  it('registers with SASL PLAIN when the network asks for it', async () => {
    const { connectNetwork } = harness()
    const { connection } = await connectNetwork({ nick: 'tester', sasl: 'plain', saslAccount: 'tester', saslPassword: 'secret' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(connection.lines()).toEqual(['CAP LS 302'])
    connection.send(':orb.example CAP tester LS :multi-prefix sasl account-notify')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(connection.lines()).toContain('CAP REQ sasl')
    connection.send(':orb.example CAP tester ACK :sasl')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(connection.lines()).toContain('AUTHENTICATE PLAIN')
    connection.send('AUTHENTICATE +')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const token = Buffer.from(`\0tester\0secret`).toString('base64')
    expect(connection.lines()).toContain(`AUTHENTICATE ${token}`)
    connection.send(':orb.example 903 tester :SASL authentication successful')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const lines = connection.lines()
    expect(lines.slice(-3)).toEqual(['CAP END', 'NICK tester', 'USER test 0 * Test'])
  })
})

describe('a connected session', () => {
  async function session () {
    const harnessInstance = harness()
    const state = await registeredSession(harnessInstance)
    return { ...state, client: harnessInstance.client, untilEvent: harnessInstance.untilEvent }
  }

  it('adopts the server-given nick from 001', async () => {
    const { network, untilEvent } = await session()
    await untilEvent('nick', (payload) => payload.nick === 'tester')
    expect(network.nick).toBe('tester')
    expect(network.serverOptions.PREFIX.modeToSymbol.o).toBe('@')
    expect(network.serverOptions.NETWORK).toBe('Example')
  })

  it('joins a channel on the JOIN echo and tracks the userlist', async () => {
    const { client, untilEvent, connection, lobby } = await session()
    client.emit('input', { target: lobby.id, text: '/join #chat' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(connection.lines()).toContain('join #chat')

    connection.send(':tester!test@host.example JOIN #chat')
    const join = await untilEvent('join', (payload) => payload.chan.name === '#chat')
    const chanId = join.chan.id
    expect(join.shouldOpen).toBe(false)

    connection.send(':orb.example 353 tester = #chat :@tester +alice')
    connection.send(':orb.example 366 tester #chat :End of /NAMES list')
    // The join handler emits one users event, the userlist-driven one is
    // the second; wait for it so the modes have been applied.
    await untilEvent('users', (payload) => payload.chan === chanId, 2)
    client.emit('names', { target: chanId })
    const names = await untilEvent('names')
    expect(names.id).toBe(chanId)
    const tester = names.users.find((user: any) => user.nick === 'tester')
    expect(tester.modes).toEqual(['@'])
  })

  it('delivers a channel message, with highlight on own nick', async () => {
    const { client, untilEvent, connection, lobby } = await session()
    client.emit('input', { target: lobby.id, text: '/join #chat' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    connection.send(':tester!test@host.example JOIN #chat')
    const join = await untilEvent('join', (payload) => payload.chan.name === '#chat')
    connection.send(':alice!a@host.example PRIVMSG #chat :hello tester!')
    const delivered = await untilEvent('msg', (payload) => payload.msg.text === 'hello tester!')
    expect(delivered.chan).toBe(join.chan.id)
    expect(delivered.msg.from.nick).toBe('alice')
    expect(delivered.msg.highlight).toBe(true)
    expect(delivered.msg.type).toBe('message')
  })

  it('sends what the user types and echoes it back without echo-message', async () => {
    const { client, untilEvent, connection, lobby } = await session()
    client.emit('input', { target: lobby.id, text: '/join #chat' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    connection.send(':tester!test@host.example JOIN #chat')
    const join = await untilEvent('join', (payload) => payload.chan.name === '#chat')
    const chanId = join.chan.id

    client.emit('input', { target: chanId, text: 'hi alice' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(connection.lines()).toContain('PRIVMSG #chat :hi alice')
    const echo = await untilEvent('msg', (payload) => payload.msg.text === 'hi alice')
    expect(echo.chan).toBe(chanId)
    expect(echo.msg.self).toBe(true)
    expect(echo.msg.highlight).toBeFalsy()
  })

  it('answers more with in-memory history', async () => {
    const { client, untilEvent, connection, lobby } = await session()
    client.emit('input', { target: lobby.id, text: '/join #chat' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    connection.send(':tester!test@host.example JOIN #chat')
    const join = await untilEvent('join', (payload) => payload.chan.name === '#chat')
    connection.send(':alice!a@host.example PRIVMSG #chat :one\r\n:bob!b@host.example PRIVMSG #chat :two')
    await untilEvent('msg', (payload) => payload.msg.text === 'two')

    client.emit('more', { target: join.chan.id, lastId: -1 })
    const more = await untilEvent('more')
    expect(more.chan).toBe(join.chan.id)
    expect(more.totalMessages).toBe(3) // JOIN echo, "one", "two"
    expect(more.messages.map((message: any) => message.text)).toEqual(['', 'one', 'two'])
  })

  it('opens a query with /query and relays /msg to it', async () => {
    const { client, untilEvent, connection, lobby } = await session()
    client.emit('input', { target: lobby.id, text: '/query bob' })
    const join = await untilEvent('join', (payload) => payload.chan.type === 'query')
    expect(join.chan.name).toBe('bob')
    expect(join.shouldOpen).toBe(true)

    client.emit('input', { target: join.chan.id, text: 'hi bob' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(connection.lines()).toContain('PRIVMSG bob :hi bob')
  })

  it('rejects messages to the lobby the way upstream does', async () => {
    const { client, untilEvent, lobby } = await session()
    client.emit('input', { target: lobby.id, text: 'hello?' })
    const message = await untilEvent('msg', (payload) => payload.msg.type === 'error')
    expect(message.msg.text).toBe('Messages can not be sent to lobbies.')
  })

  it('forwards unknown commands to the IRC connection verbatim', async () => {
    const { client, connection, lobby } = await session()
    client.emit('input', { target: lobby.id, text: '/join #a,#b key' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    // No server-side /join exists upstream either: the line is forwarded raw
    // (server/client.ts inputLine) and the JOIN echo opens the windows.
    expect(connection.lines()).toContain('join #a,#b key')
  })

  it('keeps topic updates in sync', async () => {
    const { client, untilEvent, connection, lobby } = await session()
    client.emit('input', { target: lobby.id, text: '/join #chat' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    connection.send(':tester!test@host.example JOIN #chat')
    const join = await untilEvent('join', (payload) => payload.chan.name === '#chat')
    connection.send(':alice!a@host.example TOPIC #chat :Welcome to chat')
    const topic = await untilEvent('topic')
    expect(topic.chan).toBe(join.chan.id)
    expect(topic.topic).toBe('Welcome to chat')
  })

  it('quits IRC networks when the page session ends', async () => {
    const { client, connection } = await session()
    client.ws.close()
    // After the session ends nothing is emitted to the client -- it is gone.
    // The proof the engine handled it is the QUIT on the IRC connection.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(connection.lines()).toContain('QUIT :Page closed')
  })

  it('persists synced settings and answers setting:get', async () => {
    const { client, untilEvent } = await session()
    client.emit('setting:set', { name: 'theme', value: 'morning' })
    const updated = await untilEvent('setting:new')
    expect(updated).toEqual({ name: 'theme', value: 'morning' })
    client.emit('setting:get')
    const all = await untilEvent('setting:all')
    expect(all.theme).toBe('morning')
  })

  it('collects mentions for the mentions panel', async () => {
    const { client, untilEvent, connection, lobby } = await session()
    client.emit('input', { target: lobby.id, text: '/join #chat' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    connection.send(':tester!test@host.example JOIN #chat')
    const join = await untilEvent('join', (payload) => payload.chan.name === '#chat')
    connection.send(':alice!a@host.example PRIVMSG #chat :hey tester')
    await untilEvent('msg', (payload) => payload.msg.text === 'hey tester')
    client.emit('mentions:get')
    const list = await untilEvent('mentions:list')
    expect(list).toHaveLength(1)
    expect(list[0].chanId).toBe(join.chan.id)
  })
})
