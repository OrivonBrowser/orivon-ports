import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { connect } from 'node:net'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { HOST, isAllowedHost, requestAuthority, resolveRequestPath, startServer } from './serve.ts'

// WebAssembly is a real Node global, but its type lives only in lib.dom.d.ts
// -- absent here by design (this project's lib is ES2023, no dom). One
// minimal ambient declaration, scoped to this file, is cheaper than pulling
// in the whole dom lib for one test.
declare const WebAssembly: { instantiateStreaming: (source: Response | PromiseLike<Response>) => Promise<unknown> }

const ROOT = '/srv/app'

interface RawResponse {
  readonly status: number
  readonly body: string
}

/**
 * `fetch()` treats `Host` as a forbidden header and silently overwrites it
 * with the URL's own -- there is no way to drive a cross-origin Host, or an
 * absolute-form request-target, through it. `http.request`'s `path` has no
 * such restriction: handing it a full URL is what a real proxied request (a
 * PAC's `PROXY host:port`) looks like on the wire, and an explicit `Host`
 * header is what the guard must weigh against it.
 */
async function rawRequest (port: number, target: string, host: string | undefined): Promise<RawResponse> {
  return await new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path: target, headers: host === undefined ? {} : { Host: host } }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => { body += chunk.toString() })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
    })
    req.on('error', reject)
    req.end()
  })
}

/** A genuine HTTP/1.0 request has no Host header at all -- something neither
 * `fetch()` nor `http.request` can produce, since both speak HTTP/1.1 and
 * (per RFC 7230) refuse to send a request with no Host. Only a raw socket
 * reaches the handler with `req.headers.host === undefined`. */
async function rawHttp10Request (port: number, target: string): Promise<RawResponse> {
  return await new Promise((resolve, reject) => {
    const socket = connect(port, HOST, () => { socket.write(`GET ${target} HTTP/1.0\r\n\r\n`) })
    let data = ''
    socket.on('data', (chunk: Buffer) => { data += chunk.toString() })
    socket.on('end', () => {
      const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(data)?.[1] ?? 0)
      const body = data.slice(data.indexOf('\r\n\r\n') + 4)
      resolve({ status, body })
    })
    socket.on('error', reject)
  })
}

describe('resolveRequestPath', () => {
  it('resolves an ordinary asset', () => {
    expect(resolveRequestPath(ROOT, '/js/main.js')).toBe('/srv/app/js/main.js')
  })

  it('serves the entry document for /', () => {
    expect(resolveRequestPath(ROOT, '/')).toBe('/srv/app/index.html')
    expect(resolveRequestPath(ROOT, '/', 'app.html')).toBe('/srv/app/app.html')
  })

  it('refuses a traversal, however it is spelled', () => {
    for (const bad of [
      '/../secrets',
      '/../../etc/passwd',
      '/js/../../secrets',
      '/%2e%2e/secrets',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd'
    ]) {
      expect(resolveRequestPath(ROOT, bad), bad).toBeNull()
    }
  })

  // `....` is an ordinary directory name, not a traversal. The trick defeats
  // filters that strip the substring `../`; normalize-then-compare has nothing
  // to strip, so the path stays inside the root and is served as written.
  it('treats a ....// segment as an ordinary name, still inside the root', () => {
    expect(resolveRequestPath(ROOT, '/....//secrets')).toBe('/srv/app/..../secrets')
  })

  // `startsWith(root)` alone accepts this: the sibling directory shares the
  // root's name as a prefix. Only the separator test rejects it.
  it('refuses a sibling directory that shares the root as a prefix', () => {
    expect(resolveRequestPath(ROOT, '/../app-secrets/key')).toBeNull()
  })

  it('refuses a NUL byte and undecodable percent-escapes', () => {
    expect(resolveRequestPath(ROOT, '/a%00.js')).toBeNull()
    expect(resolveRequestPath(ROOT, '/%')).toBeNull()
  })

  it('allows the root itself', () => {
    expect(resolveRequestPath(ROOT, '/.')).toBe(ROOT)
  })
})

describe('requestAuthority', () => {
  it('reads an ordinary origin-form request from the Host header', () => {
    expect(requestAuthority('/watch/abc', 'freetube.eth')).toBe('freetube.eth')
    expect(requestAuthority('/watch/abc', undefined)).toBeUndefined()
  })

  // RFC 9112 SS3.2.2: an absolute-form request-target -- what a PAC-driven
  // proxy sends -- names its own authority, and the Host header must be
  // ignored in its favour. Trusting Host here would accept
  // `GET http://asgardex.eth/x` arriving with `Host: freetube.eth`, which is
  // exactly the cross-origin splice the guard exists to refuse.
  it('prefers an absolute-form request-target over a disagreeing Host header', () => {
    expect(requestAuthority('http://asgardex.eth/x', 'freetube.eth')).toBe('asgardex.eth')
  })

  it('rejects userinfo in an absolute-form target rather than picking a side', () => {
    expect(requestAuthority('http://evil.example@freetube.eth/', undefined)).toBeNull()
    expect(requestAuthority('http://freetube.eth@evil.example/', undefined)).toBeNull()
  })
})

describe('isAllowedHost', () => {
  it('allows everything when the app declares no name -- unchanged behaviour', () => {
    for (const authority of [undefined, HOST, `${HOST}:9999`, 'anything.example', 'ASGARDEX.ETH']) {
      expect(isAllowedHost(authority, undefined)).toBe(true)
    }
  })

  it('allows loopback and the declared name once one is set, any port spelling', () => {
    expect(isAllowedHost(HOST, 'freetube.eth')).toBe(true)
    expect(isAllowedHost(`${HOST}:8875`, 'freetube.eth')).toBe(true)
    expect(isAllowedHost('freetube.eth', 'freetube.eth')).toBe(true)
    expect(isAllowedHost('freetube.eth:80', 'freetube.eth')).toBe(true)
    expect(isAllowedHost('FREETUBE.ETH', 'freetube.eth')).toBe(true)
  })

  it('allows an absent authority once a name is set -- a plain HTTP/1.0 hit', () => {
    expect(isAllowedHost(undefined, 'freetube.eth')).toBe(true)
  })

  it('refuses a different declared name once one is set', () => {
    expect(isAllowedHost('asgardex.eth', 'freetube.eth')).toBe(false)
    expect(isAllowedHost('evil.example', 'freetube.eth')).toBe(false)
  })
})

describe('the server end to end', () => {
  let root: string
  let server: Server
  let base: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orivon-serve-'))
    await mkdir(join(root, 'js'), { recursive: true })
    await writeFile(join(root, 'index.html'), '<html>app</html>')
    await writeFile(join(root, 'js', 'main.js'), 'ok')
    await writeFile(join(root, 'locale.json.br'), '{"hello":"world"}')
    await writeFile(join(root, 'empty.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))
    await writeFile(join(tmpdir(), 'orivon-serve-outside.txt'), 'must never be served')
    server = await startServer({ root, port: 0, label: 'test' })
    base = `http://${HOST}:${String((server.address() as AddressInfo).port)}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await rm(root, { recursive: true, force: true })
  })

  it('serves an asset and the entry document', async () => {
    expect(await (await fetch(`${base}/js/main.js`)).text()).toBe('ok')
    expect(await (await fetch(`${base}/`)).text()).toBe('<html>app</html>')
  })

  it('404s a missing file that names an extension, so a broken script stays visible', async () => {
    expect((await fetch(`${base}/js/gone.js`)).status).toBe(404)
  })

  it('falls back to the entry document for an extensionless client-side route', async () => {
    expect(await (await fetch(`${base}/watch/abc`)).text()).toBe('<html>app</html>')
  })

  // The URL layer folds `/../..` away before the handler ever sees it, so this
  // arrives as `/etc/passwd` -- inside the root, absent, extensionless, and
  // therefore the entry document. It never reaches the real /etc/passwd, and
  // the assertion is on the BODY for exactly that reason: the status alone
  // cannot tell a safe fallback from a leak.
  it('cannot be walked out of, whether or not the escape is encoded', async () => {
    const walked = await fetch(`${base}/../../../etc/passwd`)
    expect(await walked.text()).toBe('<html>app</html>')

    const encoded = await fetch(`${base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)
    expect(encoded.status).toBe(400)
  })

  // What a gateway does with an extension it does not know, and therefore what
  // this server must do: hand back the bytes, claim nothing about them, set no
  // encoding. `Response.json()` ignores content-type, so a `.br` file holding
  // plain JSON still parses -- which is the only reason a port may ship one.
  it('serves an unknown extension as opaque bytes, with no encoding claimed', async () => {
    const response = await fetch(`${base}/locale.json.br`)
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(await response.json()).toEqual({ hello: 'world' })
  })

  // WebAssembly.instantiateStreaming refuses anything but this exact type --
  // apps/element needs it, and there is no fallback in the bundle that needs
  // it most (see that app's README). This proves it against a real fetch, not
  // only against the MIME table.
  it('serves .wasm as application/wasm, so WebAssembly.instantiateStreaming accepts it', async () => {
    expect((await fetch(`${base}/empty.wasm`)).headers.get('content-type')).toBe('application/wasm')
    await expect(WebAssembly.instantiateStreaming(fetch(`${base}/empty.wasm`))).resolves.toBeDefined()
  })
})

// A server with no declared name is covered above -- its behaviour is
// untouched. This is the guard actually running, driven on the wire rather
// than only against the pure functions, because `fetch()` cannot produce
// either shape a real misdirected request takes (see `rawRequest`'s comment).
describe('the server end to end, with a declared name', () => {
  let root: string
  let server: Server
  let port: number

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orivon-serve-eth-'))
    await writeFile(join(root, 'index.html'), '<html>freetube</html>')
    server = await startServer({ root, port: 0, label: 'freetube', name: 'freetube.eth' })
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await rm(root, { recursive: true, force: true })
  })

  it('serves its own declared name', async () => {
    const response = await rawRequest(port, '/', 'freetube.eth')
    expect(response.status).toBe(200)
    expect(response.body).toBe('<html>freetube</html>')
  })

  it('still serves plain loopback, with or without a port -- how every human and every other test drives it', async () => {
    expect((await rawRequest(port, '/', HOST)).status).toBe(200)
    expect((await rawRequest(port, '/', `${HOST}:${String(port)}`)).status).toBe(200)
  })

  it('still serves an HTTP/1.0 request with no Host header at all', async () => {
    const response = await rawHttp10Request(port, '/')
    expect(response.status).toBe(200)
    expect(response.body).toBe('<html>freetube</html>')
  })

  // The one case the guard exists for: a PAC entry (or a rewrite) pointed
  // ASGARDEX's name at FreeTube's port. The body must not confirm which app
  // actually answered.
  it('refuses a different declared name, naming neither app in the body', async () => {
    const response = await rawRequest(port, '/', 'asgardex.eth')
    expect(response.status).toBe(421)
    expect(response.body.toLowerCase()).not.toContain('freetube')
    expect(response.body).not.toBe('<html>freetube</html>')
  })

  // The realistic misroute: the request-target and the Host header agree,
  // both naming the wrong app -- this is what a PAC line pointed at the
  // wrong port actually sends, not a crafted disagreement between the two.
  it('refuses a proxied absolute-form request for a different name', async () => {
    const response = await rawRequest(port, 'http://asgardex.eth/', 'asgardex.eth')
    expect(response.status).toBe(421)
  })

  // RFC 9112 SS3.2.2: the request-target is authoritative over Host. A
  // request that claims to be for freetube.eth in its Host header while its
  // own request line addresses asgardex.eth is, per spec, an asgardex.eth
  // request -- and FreeTube's server must refuse it even though the Host
  // header alone would have matched.
  it('is not fooled by a Host header that disagrees with the request-target', async () => {
    const response = await rawRequest(port, 'http://asgardex.eth/', 'freetube.eth')
    expect(response.status).toBe(421)
  })

  it('rejects userinfo smuggled into an absolute-form target as malformed, not as either host', async () => {
    const asAttacker = await rawRequest(port, 'http://evil.example@freetube.eth/', undefined)
    expect(asAttacker.status).toBe(400)
  })
})
