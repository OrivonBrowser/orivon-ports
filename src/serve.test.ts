import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { HOST, resolveRequestPath, startServer } from './serve.ts'

const ROOT = '/srv/app'

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

describe('the server end to end', () => {
  let root: string
  let server: Server
  let base: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orivon-serve-'))
    await mkdir(join(root, 'js'), { recursive: true })
    await writeFile(join(root, 'index.html'), '<html>app</html>')
    await writeFile(join(root, 'js', 'main.js'), 'ok')
    await writeFile(join(root, 'secret.json.br'), 'compressed-bytes')
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

  it('declares a pre-compressed asset with Content-Encoding rather than transforming it', async () => {
    const response = await fetch(`${base}/secret.json.br`)
    expect(response.headers.get('content-encoding')).toBe('br')
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })
})
