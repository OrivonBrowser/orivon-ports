import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { importTree } from '../page/src/ipfs/unixfs.js'
import { createKeep } from '../page/src/keep/store.js'
import { memoryBackend } from '../page/src/keep/backends.js'
import { manifestText } from '../page/src/lib/manifest.js'
import { readZip } from '../page/src/lib/zip.js'
import { buildMultipart } from '../page/src/publish/multipart.js'
import { MismatchError, keptFiles, pinElsewhere } from '../page/src/publish/elsewhere.js'
import { PinningError, kuboAdd, kuboVersion, normaliseEndpoint, pinataTest, pinataUpload } from '../page/src/publish/pinning.js'
import { TARGET_KINDS, check, describe as describeTarget, nodeSetupCommands, pin } from '../page/src/publish/targets.js'
import { HOW_TO_OPEN } from '../page/src/publish/how-to-open.js'
import { createServing } from '../page/src/serve/manager.js'
import { createTrackerHub } from '../page/src/serve/tracker.js'
import { useRuntime } from '../page/src/runtime.js'

type BlobPart = string | Blob | ArrayBuffer | Uint8Array

// The password lock is a stand-in here (see receive.test.ts); crypto.test.ts tests the real one.
vi.mock('../page/src/crypto/client.js', async () => ({
  encryptBlob: async (blob: Blob, password: string) => new Blob([`FAKE:${password}:`, blob]),
  decryptBlob: async (blob: Blob, password: string) => blob.slice(`FAKE:${password}:`.length)
}))
const { publishShare } = await import('../page/src/publish/share.js')

const encoder = new TextEncoder()
const latin1 = new TextDecoder('latin1')
const bytes = (text: string) => encoder.encode(text)
const text = (data: Uint8Array) => Buffer.from(data).toString('utf8')

function pattern (size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7 + (i >>> 18)) & 255)
}

interface ParsedPart { headers: string[], bytes: Uint8Array }

/** Splits a multipart body on its boundary, keeping each part's bytes exact. */
async function parseMultipart (body: Blob, contentType: string): Promise<ParsedPart[]> {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1]
  if (!boundary) throw new Error('no boundary')
  const buffer = Buffer.from(await body.arrayBuffer())
  const delimiter = Buffer.from(`--${boundary}`)
  const parts: ParsedPart[] = []
  let at = buffer.indexOf(delimiter)
  for (;;) {
    const after = at + delimiter.length
    if (buffer.subarray(after, after + 2).toString() === '--') break
    const next = buffer.indexOf(delimiter, after)
    const chunk = buffer.subarray(after + 2, next - 2)
    const split = chunk.indexOf('\r\n\r\n')
    parts.push({ headers: latin1.decode(chunk.subarray(0, split)).split('\r\n'), bytes: new Uint8Array(chunk.subarray(split + 4)) })
    at = next
  }
  expect(buffer.subarray(buffer.length - 2).toString()).toBe('\r\n')
  return parts
}

function filenameOf (part: ParsedPart): string {
  const disposition = part.headers.find((line) => line.startsWith('Content-Disposition'))!
  return Buffer.from(/filename="([^"]*)"/.exec(disposition)![1]!, 'latin1').toString('utf8')
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

const sent = async (call: Recorded) => await parseMultipart(call.init.body as Blob, call.init.headers['content-type']!)

async function failure (promise: Promise<unknown>): Promise<PinningError> {
  try { await promise } catch (error) { return error as PinningError }
  throw new Error('expected a rejection')
}

const file = (path: string, content: string | Uint8Array) => ({ path, blob: new Blob([typeof content === 'string' ? bytes(content) : content as BlobPart]) })
const files = [file('index.html', '<html>'), file('assets/a b+c%d é.js', 'js'), file('assets/deep/x.ico', new Uint8Array([1, 2, 3])), file('assets/y.css', 'css')]

describe('buildMultipart', () => {
  it('writes exactly the headers it is given and the bytes untouched, as a Blob that refers to the files', async () => {
    const payload = new Uint8Array([0, 13, 10, 255, 45, 45])
    const { body, contentType } = buildMultipart([
      { name: 'file', filename: 'a.bin', contentType: 'application/octet-stream', bytes: new Blob([payload as BlobPart]) },
      { name: 'note', bytes: bytes('hi') }
    ], 'BOUND')
    expect(body).toBeInstanceOf(Blob)
    expect(contentType).toBe('multipart/form-data; boundary=BOUND')
    const parts = await parseMultipart(body, contentType)
    expect(parts[0]!.bytes).toEqual(payload)
    expect(parts[1]!.headers).toEqual(['Content-Disposition: form-data; name="note"'])
    expect(text(new Uint8Array(await body.slice(0, 120).arrayBuffer()))).toContain('--BOUND\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n')
  })

  it('picks a different random boundary each time and percent-escapes what would break a header', async () => {
    expect(buildMultipart([]).contentType).not.toBe(buildMultipart([]).contentType)
    expect(buildMultipart([]).contentType).toMatch(/^multipart\/form-data; boundary=----orivon[0-9a-f]{48}$/)
    const { body } = buildMultipart([{ name: 'file', filename: 'a"b\r\nc', bytes: new Uint8Array(0) }], 'B')
    expect(await body.text()).toContain('filename="a%22b%0D%0Ac"')
  })
})

describe('normaliseEndpoint', () => {
  it('trims, drops trailing slashes, and allows http only for this computer', () => {
    expect(normaliseEndpoint('  https://rpc.filebase.io/// ')).toBe('https://rpc.filebase.io')
    for (const ok of ['http://localhost:5001', 'http://[::1]:5001', 'http://127.0.0.1']) expect(() => normaliseEndpoint(ok)).not.toThrow()
    expect(() => normaliseEndpoint('http://192.168.1.5:5001')).toThrowError(/Only a service on this computer/)
    for (const bad of ['', 'ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'rpc.filebase.io']) expect(() => normaliseEndpoint(bad), bad).toThrowError(PinningError)
    expect(() => normaliseEndpoint('https://user:pw@example.com')).toThrowError(/own field/)
  })
})

describe('kuboAdd', () => {
  it('sends directories before the files inside them, with encoded names', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: '{"Name":"share","Hash":"bafyroot","Size":"9"}\n' })
    await kuboAdd({ endpoint: ' http://127.0.0.1:5001/ ', authorization: 'Bearer SECRETKEY', rootName: 'share', files, fetchImpl })
    const call = calls[0]!
    expect(call.url).toBe('http://127.0.0.1:5001/api/v0/add?cid-version=1&pin=true&quieter=false&progress=false&wrap-with-directory=false')
    expect(call.init.headers.authorization).toBe('Bearer SECRETKEY')
    expect(call.init.body).toBeInstanceOf(Blob)
    const parts = await sent(call)
    expect(parts.map(filenameOf)).toEqual(['share', 'share%2Findex.html', 'share%2Fassets', 'share%2Fassets%2Fa%20b%2Bc%25d%20%C3%A9.js', 'share%2Fassets%2Fdeep', 'share%2Fassets%2Fdeep%2Fx.ico', 'share%2Fassets%2Fy.css'])
    expect(text(parts[1]!.bytes)).toBe('<html>')
    expect(parts[5]!.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(parts[0]!.headers[1]).toBe('Content-Type: application/x-directory')
  })

  it('takes the root line, and the time a service says it keeps it until', async () => {
    const add = (body: string) => kuboAdd({ endpoint: 'http://127.0.0.1:5001', rootName: 'share', files: [file('a/b.txt', 'x')], fetchImpl: fakeFetch({ body }).fetchImpl })
    expect((await add('{"Name":"share/a/b.txt","Hash":"bafyfile"}\n{"Name":"share","Hash":"bafyroot"}\n{"Name":"share/a","Hash":"bafydir"}\n')).cid).toBe('bafyroot')
    for (const body of ['{"Name":"share/a","Hash":"bafydir"}\n', 'not json', '', '{"Name":"share","Hash":""}']) await expect(add(body), body).rejects.toMatchObject({ kind: 'bad-answer' })
    await expect(add('{"Message":"disk full","Code":0,"Type":"error"}\n')).rejects.toMatchObject({ kind: 'refused', message: expect.stringContaining('disk full') })
  })

  it('maps failures to kinds and never repeats the key', async () => {
    const run = (answer: { status?: number, body?: string } | Error) => kuboAdd({ endpoint: 'https://rpc.filebase.io', authorization: 'Bearer SECRETKEY', rootName: 's', files: [], fetchImpl: fakeFetch(answer).fetchImpl })
    for (const status of [401, 403]) await expect(run({ status })).rejects.toMatchObject({ kind: 'unauthorized' })
    await expect(run({ status: 413 })).rejects.toMatchObject({ kind: 'too-large', message: 'The share is too large for this service.' })
    await expect(run({ status: 500, body: '{"Message":"bucket missing"}' })).rejects.toMatchObject({ kind: 'refused', message: 'The service refused the upload: bucket missing' })
    await expect(run(new TypeError('fetch failed'))).rejects.toMatchObject({ kind: 'unreachable' })
    await expect(run({ body: '' })).rejects.toMatchObject({ kind: 'bad-answer', message: 'The service did not say which address the share got.' })
    for (const answer of [{ status: 401, body: 'bad key SECRETKEY' }, { status: 400, body: '{"Message":"invalid token SECRETKEY and Bearer SECRETKEY"}' }, new TypeError('SECRETKEY')]) {
      const error = await failure(run(answer))
      expect(error.message).not.toContain('SECRETKEY')
    }
  })

  it('rejects paths that could escape the folder', async () => {
    const { fetchImpl } = fakeFetch({ body: '' })
    for (const path of ['../x', '/x', 'a//b', 'a/./b', 'a\\b', '']) await expect(kuboAdd({ endpoint: 'http://localhost:5001', rootName: 's', files: [file(path, '')], fetchImpl })).rejects.toThrowError(TypeError)
  })

  it('asks a node for its version', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: '{"Version":"0.43.1"}' })
    expect(await kuboVersion({ endpoint: 'https://rpc.filebase.io/', authorization: 'Bearer K', fetchImpl })).toEqual({ version: '0.43.1' })
    expect(calls[0]!.url).toBe('https://rpc.filebase.io/api/v0/version')
    await expect(kuboVersion({ endpoint: 'http://localhost:5001', fetchImpl: fakeFetch({ body: '<html>' }).fetchImpl })).rejects.toMatchObject({ kind: 'bad-answer' })
  })
})

describe('Pinata', () => {
  it('uploads the folder with its options and metadata and returns the hash', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: '{"IpfsHash":"bafypinata"}' })
    expect(await pinataUpload({ jwt: 'JWTSECRET', rootName: 'share', name: 'My share', files, fetchImpl })).toEqual({ cid: 'bafypinata' })
    const parts = await sent(calls[0]!)
    expect(parts.slice(0, files.length).map(filenameOf)).toEqual(files.map((f) => `share/${f.path}`))
    expect(JSON.parse(text(parts[files.length]!.bytes))).toEqual({ cidVersion: 1 })
    expect(JSON.parse(text(parts[files.length + 1]!.bytes))).toEqual({ name: 'My share' })
    expect(calls[0]!.init.headers.authorization).toBe('Bearer JWTSECRET')
    expect(await pinataTest({ jwt: 'J', fetchImpl: fakeFetch({ body: '{}' }).fetchImpl })).toEqual({ ok: true })
    await expect(pinataTest({ jwt: 'J', fetchImpl: fakeFetch({ status: 401 }).fetchImpl })).rejects.toMatchObject({ kind: 'unauthorized' })
  })
})

describe('where else a share can be kept', () => {
  it('offers a node of yours, Filebase, Pinata and another service, and nothing run by Orivon', () => {
    expect(Object.keys(TARGET_KINDS)).toEqual(['kubo', 'filebase', 'pinata', 'rpc'])
    for (const kind of Object.values(TARGET_KINDS)) expect(kind.label.length + kind.blurb.length).toBeGreaterThan(20)
    expect(JSON.stringify(TARGET_KINDS)).not.toMatch(/telemetry|free|Orivon keeps/i)
  })

  it('names a target for a person', () => {
    expect(describeTarget({ id: 'a', kind: 'kubo', values: { endpoint: 'http://127.0.0.1:5001' } })).toBe('IPFS Desktop or Kubo (127.0.0.1:5001)')
    expect(describeTarget({ id: 'b', kind: 'rpc', values: { endpoint: 'not an address' } })).toBe('Another IPFS service')
    expect(describeTarget({ id: 'c', kind: 'pinata', values: { jwt: 'x' } })).toBe('Pinata')
    expect(nodeSetupCommands('https://share.orivonstack.eth.limo')[0]).toContain('Access-Control-Allow-Origin')
  })

  it('checks each kind the way its service is checked, and sends an upload where the kind says', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('pin/ls')) return new Response('{}')
      if (url.includes('/api/v0/version')) return new Response('{"Version":"1"}')
      if (url.includes('testAuthentication')) return new Response('{}')
      if (url.includes('pinFileToIPFS')) return new Response('{"IpfsHash":"bafypinata"}')
      return new Response('{"Name":"share","Hash":"bafyroot"}\n')
    })
    try {
      await check({ id: '1', kind: 'kubo', values: { endpoint: 'http://127.0.0.1:5001' } })
      await check({ id: '2', kind: 'filebase', values: { key: 'k' } })
      await check({ id: '3', kind: 'pinata', values: { jwt: 'j' } })
      await check({ id: '4', kind: 'rpc', values: { endpoint: 'https://ipfs.example.org', authorization: 'Bearer x' } })
      expect(calls).toEqual([
        'POST http://127.0.0.1:5001/api/v0/version',
        'POST https://rpc.filebase.io/api/v0/pin/ls?arg=bafkqaaa&type=recursive',
        'GET https://api.pinata.cloud/data/testAuthentication',
        'POST https://ipfs.example.org/api/v0/version'
      ])
      expect((await pin({ id: '1', kind: 'kubo', values: { endpoint: 'http://127.0.0.1:5001' } }, { name: 'n', files })).cid).toBe('bafyroot')
      expect((await pin({ id: '3', kind: 'pinata', values: { jwt: 'j' } }, { name: 'n', files })).cid).toBe('bafypinata')
      vi.stubGlobal('fetch', async () => new Response('', { status: 401 }))
      await expect(check({ id: '2', kind: 'filebase', values: { key: 'bad' } })).rejects.toMatchObject({ kind: 'unauthorized' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The pieces of a running page that publishing uses, in memory, with a hub that reaches no tracker. */
function runtime (supported = true) {
  const keep = createKeep(memoryBackend())
  const hub = createTrackerHub({ peerId: 'x'.repeat(20), WebSocketImpl: class { onopen: unknown; onclose: unknown; constructor () { /* never opens */ } close () {} send () {} } as unknown as typeof WebSocket })
  const serving = createServing({ keep, hub, supported })
  useRuntime({ keep, serving, hub, supported, storage: { durable: false, kind: 'memory' } })
  return { keep, serving, hub }
}
afterEach(() => { vi.unstubAllGlobals() })

const entry = (path: string, content: string | Uint8Array) => ({ path, file: new Blob([typeof content === 'string' ? bytes(content) : content as BlobPart]) })
const KUBO = { id: 'k', kind: 'kubo' as const, values: { endpoint: 'http://127.0.0.1:5001' } }

describe('sharing', () => {
  it('keeps a public share on this computer, at the address Kubo gives the same files, and says it is online', async () => {
    const { keep, serving } = runtime()
    const entries = [entry('a.txt', 'hello'), entry('notes/b.txt', 'deep'), entry('big.bin', pattern(700_000))]
    const progress: string[] = []
    const result = await publishShare({ kind: 'files', entries, onProgress: (p) => progress.push(p.step) })
    const expected = await importTree(entries.map((e) => ({ path: e.path, content: e.file })), () => {})
    expect(result).toEqual({
      cid: expected.cid, kind: 'files', encrypted: false, bytes: 700_009, files: 3,
      link: `https://share.orivonstack.eth.limo/#/${expected.cid}`, ipfsUrl: `ipfs://${expected.cid}`, gatewayUrl: `https://${expected.cid}.ipfs.dweb.link/`,
      online: true, service: null
    })
    expect(await keep.meta(expected.cid)).toMatchObject({ kind: 'files', encrypted: false, bytes: 700_009, files: 3, online: true })
    expect(serving.state().shares.map((s) => s.cid)).toEqual([expected.cid])
    expect(new Set(progress)).toEqual(new Set(['read', 'address', 'send']))
    await serving.close()
  }, 30_000)

  it('lays out a folder, and a website with its top folder taken off', async () => {
    runtime()
    const folder = await publishShare({ kind: 'folder', entries: [entry('photos/1.jpg', 'one'), entry('photos/2.jpg', 'two')] })
    const site = await publishShare({ kind: 'website', entries: [entry('mysite/index.html', '<h1>'), entry('mysite/css/a.css', 'b{}')] })
    const direct = await importTree([{ path: 'photos/1.jpg', content: bytes('one') }, { path: 'photos/2.jpg', content: bytes('two') }], () => {})
    const flat = await importTree([{ path: 'index.html', content: bytes('<h1>') }, { path: 'css/a.css', content: bytes('b{}') }], () => {})
    expect(folder.cid).toBe(direct.cid)
    expect(site.cid).toBe(flat.cid)
  })

  it('keeps the same share once, however many times it is shared', async () => {
    const { keep } = runtime()
    const entries = [entry('a.txt', 'same')]
    const first = await publishShare({ kind: 'files', entries })
    const created = (await keep.meta(first.cid))!.created
    await wait(5)
    const second = await publishShare({ kind: 'files', entries })
    expect(second.cid).toBe(first.cid)
    expect((await keep.meta(first.cid))!.created).toBe(created)
    expect((await keep.list()).filter((m) => m.cid === first.cid)).toHaveLength(1)
  })

  it('is not online where the page cannot serve, and says so', async () => {
    const { keep } = runtime(false)
    const result = await publishShare({ kind: 'files', entries: [entry('a.txt', 'x')] })
    expect(result.online).toBe(false)
    expect((await keep.meta(result.cid))!.online).toBe(false)
  })

  it('protects a share with a password: one age file beside a fixed note, whose ZIP holds the files after a description', async () => {
    const { keep } = runtime()
    const entries = [entry('a.txt', 'hello'), entry('dir/b.bin', pattern(5000))]
    const progress: string[] = []
    const result = await publishShare({ kind: 'files', entries, password: 'correct horse', keyInLink: true, title: 'Holiday', message: 'Enjoy', onProgress: (p) => progress.push(p.step) })
    expect(result).toMatchObject({ encrypted: true, bytes: 5005, files: 2, online: true })
    expect(result.link).toBe(`https://share.orivonstack.eth.limo/#/${result.cid}?key=${Buffer.from('correct horse').toString('base64url')}`)
    const published = await keptFiles(keep, result.cid)
    expect(published.map((f) => f.path)).toEqual(['HOW-TO-OPEN.txt', 'share.age'])
    expect(await published[0]!.blob.text()).toBe(HOW_TO_OPEN)
    const zip = published[1]!.blob.slice('FAKE:correct horse:'.length)
    const inside = await readZip(zip)
    expect(inside.map((e) => e.path)).toEqual(['.orivon-share.json', 'a.txt', 'dir/b.bin'])
    expect(JSON.parse(await inside[0]!.file.text())).toMatchObject({ format: 'orivon-share', version: 1, kind: 'files', title: 'Holiday', message: 'Enjoy', files: 2, bytes: 5005 })
    expect(manifestText({ kind: 'files', files: 0, bytes: 0 })).toContain('"format":"orivon-share"')
    expect(new Set(progress)).toEqual(new Set(['read', 'address', 'send']))
    const withoutKey = await publishShare({ kind: 'files', entries, password: 'correct horse' })
    expect(withoutKey.link).toBe(`https://share.orivonstack.eth.limo/#/${withoutKey.cid}`)
  })

  it('refuses a weak password, a selection that is not one, and a share too large', async () => {
    runtime()
    await expect(publishShare({ kind: 'files', entries: [entry('a.txt', 'x')], password: 'short' })).rejects.toThrow('too weak')
    await expect(publishShare({ kind: 'website', entries: [entry('a.txt', 'x')] })).rejects.toThrow('index.html')
    await expect(publishShare({ kind: 'files', entries: [] })).rejects.toThrow('at least one file')
    await expect(publishShare({ kind: 'files', entries: [{ path: 'big', file: { size: 2 * 1024 ** 3 } as Blob }] })).rejects.toThrow('at most')
  })

  it('stops when told to, keeping nothing', async () => {
    const { keep } = runtime()
    const controller = new AbortController()
    controller.abort()
    await expect(publishShare({ kind: 'files', entries: [entry('a.txt', 'x')], signal: controller.signal })).rejects.toThrow()
    expect(await keep.list()).toEqual([])
  })

  it('also keeps it on a service of the person\'s, accepting that only for the same address', async () => {
    runtime()
    const entries = [entry('a.txt', 'hello'), entry('d/b.txt', 'bee')]
    const expected = await importTree(entries.map((e) => ({ path: e.path, content: e.file })), () => {})
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(url)
      return new Response(`{"Name":"share","Hash":"${expected.cid}","Size":"9"}\n`)
    })
    const kept = await publishShare({ kind: 'files', entries, service: KUBO })
    expect(kept.service).toEqual({ label: 'IPFS Desktop or Kubo (127.0.0.1:5001)', ok: true })
    expect(calls).toEqual(['http://127.0.0.1:5001/api/v0/add?cid-version=1&pin=true&quieter=false&progress=false&wrap-with-directory=false'])
    vi.stubGlobal('fetch', async () => new Response('{"Name":"share","Hash":"bafybeiek6rgo53nnksskarhmyk2ussqywifoxhs45j7y3l4mlis5nlqziu"}\n'))
    const other = await publishShare({ kind: 'files', entries: [entry('z.txt', 'zed')], service: KUBO })
    expect(other.service).toMatchObject({ ok: false, error: expect.stringContaining('stored something other than this share') })
    expect(other.online).toBe(true)
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed') })
    const down = await publishShare({ kind: 'files', entries: [entry('y.txt', 'why')], service: KUBO })
    expect(down.service).toMatchObject({ ok: false, error: expect.stringContaining('Could not reach') })
  })
})

describe('keeping a share elsewhere, from the kept bytes', () => {
  it('reads the files back out of the kept DAG and uploads exactly them', async () => {
    const { keep } = runtime()
    const entries = [entry('a.txt', 'hello'), entry('d/e/big.bin', pattern(600_000)), entry('empty', '')]
    const { cid } = await publishShare({ kind: 'files', entries })
    const { fetchImpl, calls } = fakeFetch({ body: `{"Name":"share","Hash":"${cid}"}\n` })
    vi.stubGlobal('fetch', fetchImpl)
    const steps: string[] = []
    expect(await pinElsewhere(keep, cid, KUBO, { onProgress: (p) => steps.push(p.step) })).toEqual({ label: 'IPFS Desktop or Kubo (127.0.0.1:5001)', ok: true })
    const parts = await sent(calls[0]!)
    expect(parts.map(filenameOf)).toEqual(['share', 'share%2Fa.txt', 'share%2Fd', 'share%2Fd%2Fe', 'share%2Fd%2Fe%2Fbig.bin', 'share%2Fempty'])
    expect(parts[4]!.bytes).toEqual(pattern(600_000))
    expect(text(parts[1]!.bytes)).toBe('hello')
    expect(parts[5]!.bytes).toHaveLength(0)
    expect(steps).toEqual(['send', 'check'])
  }, 30_000)

  it('does not accept another address, a share it does not keep, or a nonsense answer', async () => {
    const { keep } = runtime()
    const { cid } = await publishShare({ kind: 'files', entries: [entry('a.txt', 'hello')] })
    vi.stubGlobal('fetch', fakeFetch({ body: '{"Name":"share","Hash":"bafybeiek6rgo53nnksskarhmyk2ussqywifoxhs45j7y3l4mlis5nlqziu"}\n' }).fetchImpl)
    await expect(pinElsewhere(keep, cid, KUBO)).rejects.toBeInstanceOf(MismatchError)
    vi.stubGlobal('fetch', fakeFetch({ body: '{"Name":"share","Hash":"nope"}\n' }).fetchImpl)
    await expect(pinElsewhere(keep, cid, KUBO)).rejects.toBeInstanceOf(MismatchError)
    await expect(pinElsewhere(keep, 'bafybeiek6rgo53nnksskarhmyk2ussqywifoxhs45j7y3l4mlis5nlqziu', KUBO)).rejects.toThrow('not kept')
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
    work = mkdtempSync(join(tmpdir(), 'share-kubo-'))
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
        await wait(200)
      }
    }
  }, 90_000)

  afterAll(async () => {
    if (daemon && daemon.exitCode === null) {
      const exited = new Promise((resolve) => daemon!.once('exit', resolve))
      daemon.kill('SIGTERM')
      await Promise.race([exited, wait(10_000)])
      if (daemon.exitCode === null) daemon.kill('SIGKILL')
    }
    if (work !== '') rmSync(work, { recursive: true, force: true })
  }, 30_000)

  const tree = () => [
    { path: 'index.html', bytes: bytes('<!doctype html><title>x</title>') },
    { path: 'photos/big.bin', bytes: pattern(600_000) },
    { path: 'assets/a b+c%d é.txt', bytes: bytes('named oddly') },
    { path: 'assets/deep/er/leaf.txt', bytes: bytes('leaf') },
    { path: 'empty.txt', bytes: new Uint8Array(0) }
  ]

  it('gets the same root CID from ipfs add, from the importer, and from a share kept and given to the node', async () => {
    const onDisk = join(work, 'tree')
    for (const f of tree()) {
      const target = join(onDisk, ...f.path.split('/'))
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, f.bytes)
    }
    const expected = ipfs('add', '-r', '--cid-version=1', '-Q', '--only-hash', onDisk)
    const imported = await importTree(tree().map((f) => ({ path: f.path, content: f.bytes })), () => {})
    expect(imported.cid).toBe(expected)

    const { keep } = runtime()
    const entries = tree().map((f) => ({ path: f.path, file: new Blob([f.bytes as BlobPart]) }))
    const shared = await publishShare({ kind: 'files', entries, service: { id: 'k', kind: 'kubo', values: { endpoint: `http://127.0.0.1:${apiPort}` } } })
    expect(shared.cid).toBe(expected)
    expect(shared.service).toMatchObject({ ok: true })
    expect(ipfs('pin', 'ls', '--type=recursive', '-q')).toContain(expected)
    expect(ipfs('cat', `${expected}/assets/deep/er/leaf.txt`)).toBe('leaf')

    // The CAR export of the kept bytes, given to a node that has never seen the share.
    const car = join(work, 'export.car')
    writeFileSync(car, new Uint8Array(await (await keep.car(shared.cid)).arrayBuffer()))
    const second = { ...env, IPFS_PATH: join(work, 'kubo-repo-2') }
    const run = (...args: string[]) => { const r = spawnSync('ipfs', args, { env: second, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim() }
    spawnSync('ipfs', ['init', '--profile=test'], { env: second })
    run('dag', 'import', car)
    expect(run('ls', `${expected}/assets`)).toContain('deep')
    expect(run('cat', `${expected}/index.html`)).toBe('<!doctype html><title>x</title>')
  }, 90_000)
})
