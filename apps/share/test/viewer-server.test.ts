import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { base32Encode } from '../page/src/ipfs/cid.js'
import { PORTS, createSiteServer, mimeTypeOf, parseRange, parseRequest, pathOf } from '../page/src/viewer/server.js'

type BlobPart = string | Blob | ArrayBuffer | Uint8Array

const CID = 'bafybeiek6rgo53nnksskarhmyk2ussqywifoxhs45j7y3l4mlis5nlqziu'
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const encoder = new TextEncoder()

const entry = (path: string, content: string | Uint8Array) => ({ path, file: new Blob([typeof content === 'string' ? encoder.encode(content) : content as BlobPart]) })
const SITE = [
  entry('index.html', '<!doctype html><title>home</title>'),
  entry('css/a.css', 'body{margin:0}'),
  entry('docs/index.html', '<h1>docs'),
  entry('a b.txt', 'spaced'),
  entry('data.bin', Uint8Array.from({ length: 1000 }, (_, i) => i & 255)),
  entry('noext', 'no extension'),
  entry('clip.mp4', new Uint8Array(100))
]

/** The listener of the page, and a way to connect to it as a browser would. */
function fakeListener (busy: number[] = []) {
  let push: (socket: unknown) => void = () => {}
  const attempts: number[] = []
  const state = { closed: false }
  const connections = new ReadableStream<unknown>({ start (controller) { push = (socket) => controller.enqueue(socket) }, cancel () { state.closed = true } })
  const listen = async ({ port }: { port: number, scope: string }) => {
    attempts.push(port)
    if (busy.includes(port)) throw new Error('address in use')
    return { localPort: port, connections: connections as ReadableStream<never>, close: async () => { state.closed = true } }
  }
  /** Sends the pieces as a request and resolves with everything the server wrote, once it closed the socket. */
  const request = (...pieces: (string | Uint8Array)[]) => new Promise<{ head: string, body: Uint8Array, text: string, closed: boolean }>((resolve) => {
    const written: Uint8Array[] = []
    let closed = false
    const socket = {
      readable: new ReadableStream<Uint8Array>({ start (controller) { for (const piece of pieces) controller.enqueue(typeof piece === 'string' ? Buffer.from(piece, 'latin1') : piece) } }),
      writable: new WritableStream<Uint8Array>({
        write (chunk) { written.push(chunk.slice()) },
        close () {
          const all = Buffer.concat(written)
          const split = all.indexOf('\r\n\r\n')
          setTimeout(() => resolve({ head: all.subarray(0, split).toString('latin1'), body: new Uint8Array(all.subarray(split + 4)), text: all.subarray(split + 4).toString('utf8'), closed }), 5)
        }
      }),
      close: async () => { closed = true }
    }
    push(socket)
  })
  return { listen, attempts, state, request }
}

function get (path: string, host: string, extra = '', method = 'GET') {
  return `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}\r\n`
}

const headerOf = (head: string, name: string) => new RegExp(`^${name}: (.*)$`, 'im').exec(head)?.[1]

async function started (busy: number[] = []) {
  const listener = fakeListener(busy)
  const server = createSiteServer({ listen: listener.listen as never })
  const site = await server.add(CID, SITE, SECRET)
  const host = new URL(site.url).host
  return { listener, server, site, host }
}

describe('the address of a site', () => {
  it('is the first 32 characters of the base32 of HMAC-SHA256(secret, address), on the first free port', async () => {
    const { site, listener } = await started()
    const label = base32Encode(new Uint8Array(createHmac('sha256', SECRET).update(CID).digest())).slice(0, 32)
    expect(site.url).toBe(`http://${label}.localhost:5210/`)
    expect(site.origin).toBe(`http://${label}.localhost:5210`)
    expect(label).toMatch(/^[a-z2-7]{32}$/)
    expect(listener.attempts).toEqual([5210])
    expect(PORTS).toEqual([5210, 5211, 5212, 5213])
  })

  it('is the same for the same share and secret, and another for another share or another secret', async () => {
    const listener = fakeListener()
    const server = createSiteServer({ listen: listener.listen as never })
    const one = await server.add(CID, SITE, SECRET)
    const again = await server.add(CID, SITE, SECRET)
    const other = await server.add('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', SITE, SECRET)
    const secret = await server.add(CID, SITE, new Uint8Array(32))
    expect(again.url).toBe(one.url)
    expect(new Set([one.url, other.url, secret.url]).size).toBe(3)
    expect(listener.attempts, 'one listener serves every site').toEqual([5210])
  })

  it('takes the next port when one is in use, and fails plainly when all are', async () => {
    expect((await started([5210, 5211])).site.url).toContain(':5212/')
    const all = createSiteServer({ listen: fakeListener(PORTS).listen as never })
    await expect(all.add(CID, SITE, SECRET)).rejects.toThrow('could not start: address in use')
  })

  it('stops serving a site, and lets go of the port when the last one stops', async () => {
    const { listener, server, site, host } = await started()
    const other = await server.add('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', SITE, SECRET)
    await site.stop()
    expect((await listener.request(get('/', host))).head).toContain('404')
    expect(listener.state.closed).toBe(false)
    await other.stop()
    expect(listener.state.closed).toBe(true)
    expect(server.sites).toBe(0)
  })
})

describe('answering a browser', () => {
  it('serves a file with its type, its size and nothing that keeps the connection open', async () => {
    const { listener, host } = await started()
    const reply = await listener.request(get('/css/a.css', host))
    expect(reply.head.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
    expect(headerOf(reply.head, 'Content-Type')).toBe('text/css; charset=utf-8')
    expect(headerOf(reply.head, 'Content-Length')).toBe('14')
    expect(headerOf(reply.head, 'Connection')).toBe('close')
    expect(headerOf(reply.head, 'Accept-Ranges')).toBe('bytes')
    expect(headerOf(reply.head, 'X-Content-Type-Options')).toBe('nosniff')
    expect(reply.text).toBe('body{margin:0}')
    expect(reply.closed).toBe(true)
  })

  it('serves index.html for the root and for a folder, sends a folder without its slash to the slash, and ignores the query', async () => {
    const { listener, host } = await started()
    expect((await listener.request(get('/', host))).text).toContain('<title>home</title>')
    expect((await listener.request(get('/?x=1#top', host))).text).toContain('<title>home</title>')
    expect((await listener.request(get('/docs/', host))).text).toBe('<h1>docs')
    const redirect = await listener.request(get('/docs', host))
    expect(redirect.head.split('\r\n')[0]).toBe('HTTP/1.1 301 Moved Permanently')
    expect(headerOf(redirect.head, 'Location')).toBe('/docs/')
    expect((await listener.request(get('/a%20b.txt', host))).text).toBe('spaced')
  })

  it('answers HEAD with the headers and no body', async () => {
    const { listener, host } = await started()
    const reply = await listener.request(get('/data.bin', host, '', 'HEAD'))
    expect(reply.head.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
    expect(headerOf(reply.head, 'Content-Length')).toBe('1000')
    expect(reply.body).toHaveLength(0)
  })

  it('gives one range of a file, for media', async () => {
    const { listener, host } = await started()
    const part = await listener.request(get('/data.bin', host, 'Range: bytes=10-19\r\n'))
    expect(part.head.split('\r\n')[0]).toBe('HTTP/1.1 206 Partial Content')
    expect(headerOf(part.head, 'Content-Range')).toBe('bytes 10-19/1000')
    expect(headerOf(part.head, 'Content-Length')).toBe('10')
    expect(Array.from(part.body)).toEqual(Array.from({ length: 10 }, (_, i) => (10 + i) & 255))
    expect(headerOf((await listener.request(get('/data.bin', host, 'Range: bytes=990-\r\n'))).head, 'Content-Range')).toBe('bytes 990-999/1000')
    expect(headerOf((await listener.request(get('/data.bin', host, 'Range: bytes=-5\r\n'))).head, 'Content-Range')).toBe('bytes 995-999/1000')
    expect(headerOf((await listener.request(get('/data.bin', host, 'Range: bytes=0-99999\r\n'))).head, 'Content-Range')).toBe('bytes 0-999/1000')
    const unsatisfiable = await listener.request(get('/data.bin', host, 'Range: bytes=5000-\r\n'))
    expect(unsatisfiable.head.split('\r\n')[0]).toBe('HTTP/1.1 416 Range Not Satisfiable')
    expect(headerOf(unsatisfiable.head, 'Content-Range')).toBe('bytes */1000')
    const several = await listener.request(get('/data.bin', host, 'Range: bytes=0-1,5-6\r\n'))
    expect(several.head.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
    expect(several.body).toHaveLength(1000)
    expect(headerOf((await listener.request(get('/clip.mp4', host, 'Range: bytes=0-\r\n'))).head, 'Content-Type')).toBe('video/mp4')
  })

  it('says 404 for a page that is not in the site, in words a person can read', async () => {
    const { listener, host } = await started()
    const reply = await listener.request(get('/missing.html', host))
    expect(reply.head.split('\r\n')[0]).toBe('HTTP/1.1 404 Not Found')
    expect(reply.text).toContain('not in the shared site')
    expect((await listener.request(get('/missing.html', host, '', 'HEAD'))).body).toHaveLength(0)
  })

  it('answers 404 to a request whose Host is not a site being shown, whatever it asks for', async () => {
    const { listener, host } = await started()
    const label = host.split('.')[0]!
    const hosts = [`${label}.localhost:5211`, `${'a'.repeat(32)}.localhost:5210`, 'localhost:5210', '127.0.0.1:5210', `${label}.localhost`, `${label}.example.com:5210`, `x.${label}.localhost:5210`, '']
    for (const wrong of hosts) {
      const reply = await listener.request(get('/index.html', wrong))
      expect(reply.head.split('\r\n')[0], wrong).toBe('HTTP/1.1 404 Not Found')
      expect(reply.text).not.toContain('home')
    }
    expect((await listener.request('GET /index.html HTTP/1.1\r\n\r\n')).head).toContain('404')
    expect((await listener.request(get('/index.html', host.toUpperCase()))).head).toContain('200 OK')
  })

  it('keeps each site to its own name when several are shown', async () => {
    const { listener, server, host } = await started()
    const second = await server.add('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', [entry('index.html', 'second site')], SECRET)
    expect((await listener.request(get('/', new URL(second.url).host))).text).toBe('second site')
    expect((await listener.request(get('/', host))).text).toContain('home')
    expect((await listener.request(get('/css/a.css', new URL(second.url).host))).head).toContain('404')
  })

  it('refuses a method other than GET and HEAD', async () => {
    const { listener, host } = await started()
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      const reply = await listener.request(get('/', host, 'Content-Length: 0\r\n', method))
      expect(reply.head.split('\r\n')[0], method).toBe('HTTP/1.1 405 Method Not Allowed')
      expect(headerOf(reply.head, 'Allow')).toBe('GET, HEAD')
    }
  })

  it('refuses a request line it does not understand and a path that leaves the site', async () => {
    const { listener, host } = await started()
    expect((await listener.request('nonsense\r\n\r\n')).head).toContain('400')
    expect((await listener.request('GET / HTTP/2\r\nHost: x\r\n\r\n')).head).toContain('400')
    for (const path of ['/../etc/passwd', '/%2e%2e/x', '/a/%2E%2E/b', '/a%5cb', '/a%00b', '/%zz', '/css/../index.html']) {
      expect((await listener.request(get(path, host))).head.split('\r\n')[0], path).toBe('HTTP/1.1 400 Bad Request')
    }
    expect((await listener.request(get('http://evil.example/', host))).head).toContain('400')
  })

  it('refuses headers over 16 KiB with 431, whether or not they end', async () => {
    const { listener, host } = await started()
    const big = 'X-Pad: ' + 'a'.repeat(17_000) + '\r\n'
    expect((await listener.request(get('/', host, big))).head.split('\r\n')[0]).toBe('HTTP/1.1 431 Request Header Fields Too Large')
    expect((await listener.request(`GET / HTTP/1.1\r\nHost: ${host}\r\n`, 'a'.repeat(9000), 'a'.repeat(9000))).head).toContain('431')
  })

  it('reads a request that arrives in pieces', async () => {
    const { listener, host } = await started()
    const request = get('/css/a.css', host)
    const reply = await listener.request(request.slice(0, 7), request.slice(7, 30), request.slice(30))
    expect(reply.text).toBe('body{margin:0}')
  })

  it('serves a large file in pieces and all of it', async () => {
    const listener = fakeListener()
    const server = createSiteServer({ listen: listener.listen as never })
    const big = Uint8Array.from({ length: 700_000 }, (_, i) => (i * 7) & 255)
    const site = await server.add(CID, [entry('big.bin', big)], SECRET)
    const reply = await listener.request(get('/big.bin', new URL(site.url).host))
    expect(reply.body).toHaveLength(700_000)
    expect(Buffer.from(reply.body).equals(Buffer.from(big))).toBe(true)
  })
})

describe('the parts of a request', () => {
  it('knows the type of a file by its extension, and calls the rest bytes', () => {
    expect(mimeTypeOf('a/b/index.HTML')).toBe('text/html; charset=utf-8')
    expect(mimeTypeOf('x.js')).toBe('text/javascript; charset=utf-8')
    expect(mimeTypeOf('x.wasm')).toBe('application/wasm')
    expect(mimeTypeOf('x.woff2')).toBe('font/woff2')
    expect(mimeTypeOf('x.svg')).toBe('image/svg+xml')
    expect(mimeTypeOf('x.webm')).toBe('video/webm')
    expect(mimeTypeOf('x.unknown')).toBe('application/octet-stream')
    expect(mimeTypeOf('README')).toBe('application/octet-stream')
    expect(mimeTypeOf('.hidden')).toBe('application/octet-stream')
  })

  it('reads one range of a file of ten bytes', () => {
    expect(parseRange(undefined, 10)).toBeNull()
    expect(parseRange('bytes=2-4', 10)).toEqual([2, 4])
    expect(parseRange('bytes=2-', 10)).toEqual([2, 9])
    expect(parseRange('bytes=-3', 10)).toEqual([7, 9])
    expect(parseRange('bytes=-30', 10)).toEqual([0, 9])
    expect(parseRange('bytes=0-100', 10)).toEqual([0, 9])
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable')
    expect(parseRange('bytes=5-2', 10)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-1', 0)).toBe('unsatisfiable')
    for (const unknown of ['items=0-1', 'bytes=0-1,3-4', 'bytes=', 'bytes=a-b', 'bytes=-']) expect(parseRange(unknown, 10), unknown).toBeNull()
  })

  it('reads the request line and headers, lower-casing the names', () => {
    expect(parseRequest('GET /a HTTP/1.1\r\nHost: x:1\r\nRange: bytes=0-1\r\n')).toEqual({ method: 'GET', target: '/a', headers: new Map([['host', 'x:1'], ['range', 'bytes=0-1']]) })
    expect(parseRequest('GET /a HTTP/1.0\r\n')).not.toBeNull()
    expect(parseRequest('get /a HTTP/1.1\r\n')).toBeNull()
    expect(parseRequest('GET /a HTTP/1.1\r\nbroken header\r\n')).toBeNull()
    expect(parseRequest('GET /a HTTP/1.1\r\n' + Array.from({ length: 101 }, (_, i) => `H${i}: v\r\n`).join(''))).toBeNull()
  })

  it('turns a target into a path of the site, or nothing', () => {
    expect(pathOf('/')).toEqual({ path: '', directory: true })
    expect(pathOf('/a/b.txt?x=1')).toEqual({ path: 'a/b.txt', directory: false })
    expect(pathOf('/a//b/')).toEqual({ path: 'a/b', directory: true })
    expect(pathOf('/a%20b')).toEqual({ path: 'a b', directory: false })
    for (const bad of ['a', '', '/..', '/a/../b', '/%2e%2e', '/a%5Cb', '/a\\b', '/%00', '/%E0%A4%A']) expect(pathOf(bad), bad).toBeNull()
  })
})
