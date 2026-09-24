// The socket.io v4 server, in the page. The client's own socket.io-client
// opens a WebSocket to `socket.io/` on its origin, which a static file server
// cannot answer — so this replaces window.WebSocket and speaks the engine.io
// v4 framing that client expects: `0{...}` open packet, `40` namespace
// connect, `42[...]` event packets, `2`/`3` heartbeat. Anything that is not
// that URL falls through to the real WebSocket.

const OPEN_PACKET = JSON.stringify({
  sid: 'orivon-' + Math.random().toString(36).slice(2, 10),
  upgrades: [],
  pingInterval: 25000,
  pingTimeout: 20000,
  maxPayload: 1000000
})

function isSocketIoUrl (url) {
  return typeof url === 'string' && /[?&]EIO=4&transport=websocket/.test(url)
}

// The server side of the one socket.io session the client opens.
export class SioServer {
  constructor () {
    this.handlers = new Map()
    this.client = null
    this.connected = false
  }

  on (event, handler) {
    this.handlers.set(event, handler)
    return this
  }

  emit (event, ...args) {
    if (!this.connected) return
    this.client.message('42' + JSON.stringify([event, ...args]))
  }

  disconnect () {
    if (this.connected) {
      this.connected = false
      this.client.message('41')
      this.dispatch('disconnect')
    }
  }

  // Socket.io layer packets: the engine.io `4` (MESSAGE) prefix is already
  // stripped, so CONNECT is `0`, DISCONNECT is `1`, EVENT is `2[...]`.
  handlePacket (packet) {
    if (packet.startsWith('0')) {
      this.connected = true
      this.client.message('40{"sid":"' + OPEN_PACKET.sid + '"}')
      this.dispatch('connect')
    } else if (packet.startsWith('1')) {
      this.connected = false
      this.dispatch('disconnect')
    } else if (packet.startsWith('2')) {
      const [event, ...args] = JSON.parse(packet.slice(1))
      this.dispatch(event, ...args)
    }
  }

  dispatch (event, ...args) {
    const handler = this.handlers.get(event)
    if (handler) handler(...args)
  }
}

// The WebSocket the client sees. One per connection; forwards engine.io
// frames between the real socket.io-client and the SioServer. Sends made
// while still connecting are queued, the same buffering the engine.io client
// does for its own packets before the transport is open.
class FakeWebSocket {
  constructor (server) {
    this.readyState = 0
    this.bufferedAmount = 0
    this.extensions = ''
    this.binaryType = 'blob'
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    this.server = server
    this.queue = []
    this.pingTimer = null
    server.client = this
    const open = () => {
      this.readyState = 1
      if (this.onopen) this.onopen({ type: 'open' })
      this.message('0' + OPEN_PACKET)
      for (const data of this.queue.splice(0)) this.deliver(data)
      // engine.io v4 (the one inside socket.io-client 4.x): the SERVER pings
      // and the client answers with a pong, resetting its ping-timeout
      // timer. A server that stays silent is closed by the client after
      // pingInterval + pingTimeout.
      this.pingTimer = setInterval(() => this.message('2'), 25000)
    }
    // The real client treats a WebSocket that opens in the same tick as a
    // protocol error; always open it on a future turn.
    setTimeout(open, 0)
  }

  // Server -> client.
  message (packet) {
    setTimeout(() => {
      if (this.readyState !== 1) return
      if (this.onmessage) this.onmessage({ data: packet })
    }, 0)
  }

  // Client -> server.
  send (data) {
    if (this.readyState === 0) { this.queue.push(data); return }
    if (this.readyState !== 1) return
    this.deliver(data)
  }

  deliver (data) {
    if (data === '2') { this.message('3'); return }
    const packet = typeof data === 'string' ? data : new TextDecoder().decode(data)
    if (packet === '1') { this.server.dispatch('disconnect'); return }
    if (packet.startsWith('4')) this.server.handlePacket(packet.slice(1))
  }

  close () {
    if (this.readyState === 3) return
    const wasConnected = this.readyState === 1
    this.readyState = 3
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (wasConnected) this.server.dispatch('disconnect')
    if (this.onclose) this.onclose({ code: 1000, reason: '', wasClean: true })
  }
}

// Installs the shim and returns the server. The real WebSocket is kept for
// anything the client might open that is not its own socket.io session.
export function installSioShim (windowObject) {
  const server = new SioServer()
  const RealWebSocket = windowObject.WebSocket
  windowObject.WebSocket = function OrivonSocketIo (url, protocols) {
    if (!isSocketIoUrl(url)) {
      if (RealWebSocket === undefined) throw new TypeError('WebSocket is not defined')
      return new RealWebSocket(url, protocols)
    }
    return new FakeWebSocket(server)
  }
  if (RealWebSocket !== undefined) {
    windowObject.WebSocket.prototype = RealWebSocket.prototype
    windowObject.WebSocket.CONNECTING = RealWebSocket.CONNECTING
    windowObject.WebSocket.OPEN = RealWebSocket.OPEN
    windowObject.WebSocket.CLOSING = RealWebSocket.CLOSING
    windowObject.WebSocket.CLOSED = RealWebSocket.CLOSED
  } else {
    windowObject.WebSocket.CONNECTING = 0
    windowObject.WebSocket.OPEN = 1
    windowObject.WebSocket.CLOSING = 2
    windowObject.WebSocket.CLOSED = 3
  }
  return server
}
