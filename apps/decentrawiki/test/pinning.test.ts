import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildMultipart } from '../page/src/publish/multipart.js'
import {
  PinningError, kuboAdd, kuboVersion, normaliseEndpoint, pinataTest, pinataUpload
} from '../page/src/publish/pinning.js'

const encoder = new TextEncoder()
const latin1 = new TextDecoder('latin1')

interface ParsedPart { headers: string[], bytes: Uint8Array }

/** Splits a multipart body on its boundary, keeping each part's bytes exact. */
function parseMultipart (body: Uint8Array, contentType: string): ParsedPart[] {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1]
  if (!boundary) throw new Error('no boundary')
  const buffer = Buffer.from(body)
  const delimiter = Buffer.from(`--${boundary}`)
  const parts: ParsedPart[] = []
  let at = buffer.indexOf(delimiter)
  for (;;) {
    const after = at + delimiter.length
    if (buffer.subarray(after, after + 2).toString() === '--') break
    const next = buffer.indexOf(delimiter, after)
    // Each part is "\r\n" headers "\r\n\r\n" bytes "\r\n" before the next delimiter.
    const chunk = buffer.subarray(after + 2, next - 2)
    const split = chunk.indexOf('\r\n\r\n')
    parts.push({
      headers: latin1.decode(chunk.subarray(0, split)).split('\r\n'),
      bytes: new Uint8Array(chunk.subarray(split + 4))
    })
    at = next
  }
  expect(buffer.subarray(buffer.length - 2).toString()).toBe('\r\n')
  return parts
}

/** The filename parameter of a part, as the bytes sent (UTF-8 read back). */
function filenameOf (part: ParsedPart): string {
  const disposition = part.headers.find((line) => line.startsWith('Content-Disposition'))!
  const raw = /filename="([^"]*)"/.exec(disposition)![1]!
  return Buffer.from(raw, 'latin1').toString('utf8')
}

interface Recorded { url: string, init: RequestInit & { headers: Record<string, string> } }

function fakeFetch (answer: { status?: number, body?: string } | Error): { fetchImpl: typeof fetch, calls: Recorded[] } {
  const calls: Recorded[] = []
  const fetchImpl = (async (url: string, init: Recorded['init']) => {
    calls.push({ url, init })
    if (answer instanceof Error) throw answer
    return new Response(answer.body ?? '', { status: answer.status ?? 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function sent (call: Recorded): ParsedPart[] {
  return parseMultipart(call.init.body as Uint8Array, call.init.headers['content-type']!)
}

/** The error a promise rejects with. */
async function failure (promise: Promise<unknown>): Promise<PinningError> {
  try {
    await promise
  } catch (error) {
    return error as PinningError
  }
  throw new Error('expected a rejection')
}

const bytes = (text: string) => encoder.encode(text)
const text = (data: Uint8Array) => Buffer.from(data).toString('utf8')

describe('buildMultipart', () => {
  it('writes exactly the headers it is given and the bytes untouched', () => {
    const payload = new Uint8Array([0, 13, 10, 255, 45, 45])
    const { body, contentType } = buildMultipart([
      { name: 'file', filename: 'a.bin', contentType: 'application/octet-stream', bytes: payload },
      { name: 'note', bytes: bytes('hi') }
    ], 'BOUND')
    expect(contentType).toBe('multipart/form-data; boundary=BOUND')
    expect(text(body)).toBe(
      '--BOUND\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n' +
      Buffer.from(payload).toString('utf8') + '\r\n' +
      '--BOUND\r\nContent-Disposition: form-data; name="note"\r\n\r\nhi\r\n--BOUND--\r\n'
    )
    const parts = parseMultipart(body, contentType)
    expect(parts[0]!.bytes).toEqual(payload)
    expect(parts[1]!.headers).toEqual(['Content-Disposition: form-data; name="note"'])
  })

  it('picks a different random boundary each time', () => {
    const a = buildMultipart([]).contentType
    const b = buildMultipart([]).contentType
    expect(a).not.toBe(b)
    expect(a).toMatch(/^multipart\/form-data; boundary=----orivon[0-9a-f]{48}$/)
  })

  it('percent-escapes the characters that would break a header', () => {
    const { body } = buildMultipart([{ name: 'file', filename: 'a"b\r\nc', bytes: new Uint8Array(0) }], 'B')
    expect(text(body)).toContain('filename="a%22b%0D%0Ac"')
  })
})

describe('normaliseEndpoint', () => {
  it('trims and drops trailing slashes', () => {
    expect(normaliseEndpoint('  https://rpc.filebase.io/// ')).toBe('https://rpc.filebase.io')
    expect(normaliseEndpoint('http://127.0.0.1:5001/')).toBe('http://127.0.0.1:5001')
    expect(normaliseEndpoint('https://example.com/ipfs-api/')).toBe('https://example.com/ipfs-api')
  })

  it('allows http only for this computer', () => {
    for (const ok of ['http://localhost:5001', 'http://[::1]:5001', 'http://127.0.0.1']) {
      expect(() => normaliseEndpoint(ok)).not.toThrow()
    }
    expect(() => normaliseEndpoint('http://192.168.1.5:5001')).toThrowError(/Only a service on this computer/)
    expect(() => normaliseEndpoint('http://example.com')).toThrowError(PinningError)
  })

  it('refuses anything that is not an http(s) address', () => {
    for (const bad of ['', '   ', 'ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'rpc.filebase.io', 'https://']) {
      expect(() => normaliseEndpoint(bad), bad).toThrowError(PinningError)
    }
    expect(() => normaliseEndpoint('https://user:pw@example.com')).toThrowError(/own field/)
  })
})

const files = [
  { path: 'index.html', bytes: bytes('<html>') },
  { path: 'assets/a b+c%d é.js', bytes: bytes('js') },
  { path: 'assets/deep/x.ico', bytes: new Uint8Array([1, 2, 3]) },
  { path: 'assets/y.css', bytes: bytes('css') }
]

describe('kuboAdd request', () => {
  it('sends directories before the files inside them, with encoded names', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: '{"Name":"site","Hash":"bafyroot","Size":"9"}\n' })
    await kuboAdd({ endpoint: ' http://127.0.0.1:5001/ ', authorization: 'Bearer SECRETKEY', rootName: 'site', files, fetchImpl })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('http://127.0.0.1:5001/api/v0/add?cid-version=1&pin=true&quieter=false&progress=false&wrap-with-directory=false')
    expect(call.init.method).toBe('POST')
    expect(call.init.headers.authorization).toBe('Bearer SECRETKEY')
    expect(call.init.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)

    const parts = sent(call)
    expect(parts.map(filenameOf)).toEqual([
      'site',
      'site%2Findex.html',
      'site%2Fassets',
      'site%2Fassets%2Fa%20b%2Bc%25d%20%C3%A9.js',
      'site%2Fassets%2Fdeep',
      'site%2Fassets%2Fdeep%2Fx.ico',
      'site%2Fassets%2Fy.css'
    ])
    const dirs = [0, 2, 4]
    parts.forEach((part, index) => {
      expect(part.headers[0]).toMatch(/^Content-Disposition: form-data; name="file"; filename="[^"]+"$/)
      if (dirs.includes(index)) {
        expect(part.headers[1]).toBe('Content-Type: application/x-directory')
        expect(part.bytes).toHaveLength(0)
      } else {
        expect(part.headers[1]).toBe('Content-Type: application/octet-stream')
      }
      expect(part.headers).toHaveLength(2)
    })
    expect(text(parts[1]!.bytes)).toBe('<html>')
    expect(parts[5]!.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(decodeURIComponent(filenameOf(parts[3]!))).toBe('site/assets/a b+c%d é.js')
  })

  it('sends no authorization header when none is given', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: '{"Name":"s","Hash":"bafy"}' })
    await kuboAdd({ endpoint: 'http://localhost:5001', rootName: 's', files: [], fetchImpl })
    expect(Object.keys(calls[0]!.init.headers)).toEqual(['content-type'])
  })

  it('rejects paths that could escape the folder', async () => {
    const { fetchImpl } = fakeFetch({ body: '' })
    for (const path of ['../x', '/x', 'a//b', 'a/./b', 'a\\b', '']) {
      await expect(kuboAdd({ endpoint: 'http://localhost:5001', rootName: 's', files: [{ path, bytes: bytes('') }], fetchImpl })).rejects.toThrowError(TypeError)
    }
    await expect(kuboAdd({ endpoint: 'http://localhost:5001', rootName: 'a/b', files: [], fetchImpl })).rejects.toThrowError(TypeError)
  })
})

describe('kuboAdd answer', () => {
  const add = (body: string) => kuboAdd({
    endpoint: 'http://127.0.0.1:5001', rootName: 'site', files: [{ path: 'a/b.txt', bytes: bytes('x') }], fetchImpl: fakeFetch({ body }).fetchImpl
  })

  it('takes the line named after the root, wherever it is', async () => {
    const result = await add(
      '{"Name":"site/a/b.txt","Hash":"bafyfile","Size":"1"}\n' +
      '{"Name":"site","Hash":"bafyroot","Size":"120"}\n' +
      '{"Name":"site/a","Hash":"bafydir","Size":"60"}\n'
    )
    expect(result.cid).toBe('bafyroot')
    expect(result.entries).toEqual([
      { name: 'site/a/b.txt', hash: 'bafyfile', size: 1 },
      { name: 'site', hash: 'bafyroot', size: 120 },
      { name: 'site/a', hash: 'bafydir', size: 60 }
    ])
  })

  it('reads an answer without a trailing newline or with blank lines', async () => {
    expect((await add('{"Name":"site","Hash":"bafyone","Size":"1"}')).cid).toBe('bafyone')
    expect((await add('\n{"Name":"site","Hash":"bafytwo"}\n\n')).cid).toBe('bafytwo')
  })

  it('is a bad answer without a root line, with garbage, or empty', async () => {
    for (const body of ['{"Name":"site/a","Hash":"bafydir"}\n', 'not json', '', '{"Name":"site","Hash":""}']) {
      await expect(add(body), body).rejects.toMatchObject({ kind: 'bad-answer' })
    }
  })

  it('turns an error line inside a 200 answer into a refusal', async () => {
    await expect(add('{"Message":"disk full","Code":0,"Type":"error"}\n')).rejects.toMatchObject({
      kind: 'refused', message: expect.stringContaining('disk full')
    })
  })
})

describe('PinningError kinds', () => {
  const run = (answer: { status?: number, body?: string } | Error, authorization = 'Bearer SECRETKEY', signal?: AbortSignal) =>
    kuboAdd({
      endpoint: 'https://rpc.filebase.io', authorization, rootName: 's', files: [], fetchImpl: fakeFetch(answer).fetchImpl, ...(signal ? { signal } : {})
    })

  it('unauthorized for 401 and 403', async () => {
    for (const status of [401, 403]) {
      await expect(run({ status })).rejects.toMatchObject({ kind: 'unauthorized', message: 'The service refused the key: check it and try again.' })
    }
  })

  it('too-large for 413', async () => {
    await expect(run({ status: 413 })).rejects.toMatchObject({ kind: 'too-large' })
  })

  it('refused for any other failure, with the service words cut to 300 characters', async () => {
    await expect(run({ status: 500, body: '{"Message":"bucket missing","Code":0,"Type":"error"}' })).rejects.toMatchObject({
      kind: 'refused', message: 'The service refused the upload: bucket missing'
    })
    const long = await failure(run({ status: 400, body: 'x'.repeat(1000) }))
    expect(long.kind).toBe('refused')
    expect(long.message.length).toBeLessThan(400)
    expect(long.message).toContain('x'.repeat(290))
    expect(long.message).not.toContain('x'.repeat(301))
    await expect(run({ status: 502, body: '<html>Bad gateway</html>' })).rejects.toMatchObject({
      kind: 'refused', message: 'The service refused the upload (status 502).'
    })
  })

  it('unreachable when the request cannot be made', async () => {
    await expect(run(new TypeError('fetch failed'))).rejects.toMatchObject({ kind: 'unreachable' })
  })

  it('bad-answer for a 2xx without a usable CID', async () => {
    await expect(run({ body: '' })).rejects.toMatchObject({ kind: 'bad-answer' })
  })

  it('aborted when the caller cancels', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(run(new DOMException('aborted', 'AbortError'), 'Bearer SECRETKEY', controller.signal)).rejects.toMatchObject({ kind: 'aborted' })
    await expect(run(new DOMException('aborted', 'AbortError'))).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('bad-address for an endpoint it will not use', async () => {
    await expect(kuboAdd({ endpoint: 'ftp://x', rootName: 's', files: [], fetchImpl: fakeFetch({}).fetchImpl })).rejects.toMatchObject({ kind: 'bad-address' })
  })

  it('never carries the key, even when the service repeats it', async () => {
    const answers = [
      { status: 401, body: 'bad key SECRETKEY' },
      { status: 400, body: '{"Message":"invalid token SECRETKEY and Bearer SECRETKEY"}' },
      { status: 413 }, { status: 500 }, { body: 'x' }, new TypeError('SECRETKEY')
    ]
    for (const answer of answers) {
      const error = await failure(run(answer))
      expect(error).toBeInstanceOf(PinningError)
      expect(error.message).not.toContain('SECRETKEY')
      expect(String(error.stack)).not.toContain('SECRETKEY')
    }
  })
})

describe('kuboVersion', () => {
  it('posts to /api/v0/version and returns the version', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: '{"Version":"0.43.1","Commit":"x"}' })
    const result = await kuboVersion({ endpoint: 'https://rpc.filebase.io/', authorization: 'Bearer SECRETKEY', fetchImpl })
    expect(result).toEqual({ version: '0.43.1' })
    expect(calls[0]!.url).toBe('https://rpc.filebase.io/api/v0/version')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers.authorization).toBe('Bearer SECRETKEY')
  })

  it('reports a wrong key, an unreachable node and a non-IPFS answer', async () => {
    const call = (answer: { status?: number, body?: string } | Error) =>
      kuboVersion({ endpoint: 'http://localhost:5001', authorization: 'Bearer SECRETKEY', fetchImpl: fakeFetch(answer).fetchImpl })
    await expect(call({ status: 403 })).rejects.toMatchObject({ kind: 'unauthorized' })
    await expect(call(new TypeError('x'))).rejects.toMatchObject({ kind: 'unreachable' })
    await expect(call({ body: '<html>' })).rejects.toMatchObject({ kind: 'bad-answer' })
  })
})

describe('pinataUpload', () => {
  it('uploads the folder with its options and metadata and returns the hash', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: '{"IpfsHash":"bafypinata","PinSize":5,"Timestamp":"2026-01-01T00:00:00Z"}' })
    const result = await pinataUpload({ jwt: 'JWTSECRET', rootName: 'site', name: 'My wiki', files, fetchImpl })
    expect(result).toEqual({ cid: 'bafypinata' })
    const call = calls[0]!
    expect(call.url).toBe('https://api.pinata.cloud/pinning/pinFileToIPFS')
    expect(call.init.method).toBe('POST')
    expect(call.init.headers.authorization).toBe('Bearer JWTSECRET')

    const parts = sent(call)
    expect(parts).toHaveLength(files.length + 2)
    expect(parts.slice(0, files.length).map(filenameOf)).toEqual(files.map((file) => `site/${file.path}`))
    for (const part of parts.slice(0, files.length)) {
      expect(part.headers[0]).toMatch(/^Content-Disposition: form-data; name="file"; filename="site\//)
      expect(part.headers[1]).toBe('Content-Type: application/octet-stream')
    }
    expect(parts[2]!.bytes).toEqual(files[2]!.bytes)
    expect(parts[files.length]!.headers).toEqual(['Content-Disposition: form-data; name="pinataOptions"'])
    expect(JSON.parse(text(parts[files.length]!.bytes))).toEqual({ cidVersion: 1 })
    expect(parts[files.length + 1]!.headers).toEqual(['Content-Disposition: form-data; name="pinataMetadata"'])
    expect(JSON.parse(text(parts[files.length + 1]!.bytes))).toEqual({ name: 'My wiki' })
  })

  it('maps its failures to the same kinds and keeps the token out', async () => {
    const call = (answer: { status?: number, body?: string } | Error) =>
      pinataUpload({ jwt: 'JWTSECRET', rootName: 's', name: 'n', files: [], fetchImpl: fakeFetch(answer).fetchImpl })
    await expect(call({ status: 401, body: '{"error":{"reason":"INVALID_CREDENTIALS"}}' })).rejects.toMatchObject({ kind: 'unauthorized' })
    await expect(call({ status: 413 })).rejects.toMatchObject({ kind: 'too-large' })
    await expect(call(new TypeError('x'))).rejects.toMatchObject({ kind: 'unreachable' })
    await expect(call({ body: '{}' })).rejects.toMatchObject({ kind: 'bad-answer' })
    const refused = await failure(call({ status: 400, body: '{"error":{"reason":"BAD_REQUEST","details":"JWTSECRET is odd"}}' }))
    expect(refused.kind).toBe('refused')
    expect(refused.message).toContain('BAD_REQUEST')
    expect(refused.message).not.toContain('JWTSECRET')
  })
})

describe('pinataTest', () => {
  it('sends a GET with the token', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: '{"message":"Congratulations!"}' })
    expect(await pinataTest({ jwt: 'JWTSECRET', fetchImpl })).toEqual({ ok: true })
    expect(calls[0]!.url).toBe('https://api.pinata.cloud/data/testAuthentication')
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.headers.authorization).toBe('Bearer JWTSECRET')
    await expect(pinataTest({ jwt: 'JWTSECRET', fetchImpl: fakeFetch({ status: 401 }).fetchImpl })).rejects.toMatchObject({ kind: 'unauthorized' })
  })
})

const kuboAvailable = spawnSync('ipfs', ['--version'], { stdio: 'ignore' }).status === 0

async function freePort (): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

describe.skipIf(!kuboAvailable)('against a real Kubo node', () => {
  let work = ''
  let daemon: ChildProcess | undefined
  let apiPort = 0
  let env: NodeJS.ProcessEnv = {}

  const ipfs = (...args: string[]) => {
    const run = spawnSync('ipfs', args, { env, encoding: 'utf8' })
    if (run.status !== 0) throw new Error(`ipfs ${args.join(' ')} failed: ${run.stderr}`)
    return run.stdout.trim()
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'decentrawiki-kubo-'))
    apiPort = await freePort()
    let gatewayPort = await freePort()
    while (gatewayPort === apiPort) gatewayPort = await freePort()
    env = { ...process.env, IPFS_PATH: join(work, 'kubo-repo') }
    ipfs('init', '--profile=test')
    ipfs('config', 'Addresses.API', `/ip4/127.0.0.1/tcp/${apiPort}`)
    ipfs('config', 'Addresses.Gateway', `/ip4/127.0.0.1/tcp/${gatewayPort}`)
    ipfs('config', '--json', 'Addresses.Swarm', '[]')
    daemon = spawn('ipfs', ['daemon', '--offline'], { env, stdio: 'ignore' })

    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        await kuboVersion({ endpoint: `http://127.0.0.1:${apiPort}` })
        break
      } catch (error) {
        if (Date.now() > deadline || daemon.exitCode !== null) throw new Error(`Kubo did not start: ${String(error)}`)
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
  }, 90_000)

  afterAll(async () => {
    if (daemon && daemon.exitCode === null) {
      const exited = new Promise((resolve) => daemon!.once('exit', resolve))
      daemon.kill('SIGTERM')
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))])
      if (daemon.exitCode === null) daemon.kill('SIGKILL')
    }
    if (work !== '') rmSync(work, { recursive: true, force: true })
  }, 30_000)

  it('gets the same root CID as ipfs add --cid-version=1 on the same tree', async () => {
    const tree: Array<{ path: string, bytes: Uint8Array }> = []
    const big = new Uint8Array(600_000)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8)) & 255
    tree.push({ path: 'index.html', bytes: bytes('<!doctype html><title>x</title>') })
    tree.push({ path: 'tiddlywikicore-5.4.1.js', bytes: big })
    tree.push({ path: 'assets/a b+c%d é.txt', bytes: bytes('named oddly') })
    tree.push({ path: 'assets/deep/er/leaf.txt', bytes: bytes('leaf') })
    tree.push({ path: 'favicon.ico', bytes: new Uint8Array([0, 0, 1, 0]) })

    const onDisk = join(work, 'site')
    for (const file of tree) {
      const target = join(onDisk, ...file.path.split('/'))
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, file.bytes)
    }
    const expected = ipfs('add', '-r', '--cid-version=1', '-Q', '--only-hash', onDisk)

    const result = await kuboAdd({ endpoint: `http://127.0.0.1:${apiPort}`, rootName: 'site', files: tree })
    expect(result.cid).toBe(expected)
    expect(result.entries.map((entry) => entry.name)).toContain('site/assets/a b+c%d é.txt')
    expect(ipfs('pin', 'ls', '--type=recursive', '-q')).toContain(result.cid)
  }, 60_000)
})
