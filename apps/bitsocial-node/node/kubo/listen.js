// The facade on a loopback socket, for callers outside the process that has the fetch hook. It listens on 127.0.0.1
// only, and refuses a request whose `Host` is not the loopback address it was reached by, which is what a page on the
// web reaching it through a rebinding DNS name looks like.

/** @param {string | undefined} host @param {number} port */
function loopbackHost (host, port) {
  return host !== undefined && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase())
}

/** A request body as a web stream, built from the request's own events so that it needs nothing from `node:stream`. @param {import('node:http').IncomingMessage} incoming */
function bodyOf (incoming) {
  return new ReadableStream({
    start (controller) {
      incoming.on('data', (chunk) => {
        controller.enqueue(chunk)
        if (controller.desiredSize !== null && controller.desiredSize <= 0) incoming.pause()
      })
      incoming.on('end', () => { controller.close() })
      incoming.on('error', (error) => { controller.error(error) })
      incoming.on('close', () => { controller.error(new Error('the request was aborted')) })
    },
    pull () { incoming.resume() },
    cancel () { incoming.destroy() }
  })
}

/**
 * @param {typeof import('node:http')} http
 * @param {number} port 0 picks a free one
 * @param {{ handle: (request: Request) => Promise<Response> }} facade
 * @param {(error: unknown) => void} [onError] told of a request that failed, which the client sees as a bare 500
 * @returns {Promise<{ port: number, url: string, close: () => Promise<void> }>}
 */
export function listenFacade (http, port, facade, onError = () => {}) {
  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const bound = /** @type {import('node:net').AddressInfo} */ (server.address()).port
      if (!loopbackHost(incoming.headers.host, bound)) {
        outgoing.writeHead(403, { 'Content-Type': 'text/plain' }).end('request host is not allowed\n')
        return
      }
      const aborted = new AbortController()
      outgoing.on('close', () => { if (!outgoing.writableFinished) aborted.abort() })
      const method = incoming.method ?? 'GET'
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      const hasBody = method !== 'GET' && method !== 'HEAD'
      const request = new Request(`http://127.0.0.1:${bound}${incoming.url ?? '/'}`, {
        method, headers, signal: aborted.signal,
        ...(hasBody ? { body: bodyOf(incoming), duplex: 'half' } : {})
      })
      const response = await facade.handle(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.flushHeaders()
      if (response.body === null) { outgoing.end(); return }
      const reader = response.body.getReader()
      outgoing.on('close', () => { reader.cancel().catch(() => {}) })
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!outgoing.write(value)) await new Promise((resolve) => outgoing.once('drain', resolve))
      }
      outgoing.end()
    } catch (error) {
      onError(error)
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'text/plain' })
      outgoing.end()
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const bound = /** @type {import('node:net').AddressInfo} */ (server.address()).port
      resolve({
        port: bound,
        url: `http://127.0.0.1:${bound}`,
        close: () => new Promise((done) => { server.close(() => done(undefined)); server.closeAllConnections() })
      })
    })
  })
}
