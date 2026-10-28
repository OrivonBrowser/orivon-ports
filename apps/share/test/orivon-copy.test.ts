import { afterEach, describe, expect, it, vi } from 'vitest'
import { listDirectory, readCar } from '../page/src/ipfs/car.js'
import { memoryBackend } from '../page/src/keep/backends.js'
import { createKeep } from '../page/src/keep/store.js'
import { COPY_MAX_BYTES, CopyError, keepOnOrivon } from '../page/src/publish/orivon-copy.js'
import { createServing } from '../page/src/serve/manager.js'
import { createTrackerHub } from '../page/src/serve/tracker.js'
import { useRuntime } from '../page/src/runtime.js'

// The password lock is a stand-in here (crypto.test.ts tests the real one): it scrambles every byte, so that a
// plaintext which reaches a request shows up as itself.
vi.mock('../page/src/crypto/client.js', async () => ({
  encryptBlob: async (blob: Blob, password: string) => new Blob([`AGE:${password.length}:`, Uint8Array.from(new Uint8Array(await blob.arrayBuffer()), (b) => b ^ 0x5a)]),
  decryptBlob: async (blob: Blob) => blob
}))
const { publishShare } = await import('../page/src/publish/share.js')

const SERVICE = 'https://copy.example/share'
const entry = (path: string, content: string) => ({ path, file: new Blob([content]) })

function runtime () {
  const keep = createKeep(memoryBackend())
  const hub = createTrackerHub({ peerId: 'x'.repeat(20), WebSocketImpl: class { onopen: unknown; onclose: unknown; close () {} send () {} } as unknown as typeof WebSocket })
  const serving = createServing({ keep, hub, supported: true })
  useRuntime({ keep, serving, hub, supported: true, storage: { durable: false, kind: 'memory' } })
  return keep
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

interface Call { url: string, init: RequestInit }

/** A copy service that answers status with "not kept" and keeps what it is sent, naming `hash` when it is given one. */
function service (options: { hash?: string, kept?: boolean, refuse?: { status: number, message: string } } = {}) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (options.refuse) return new Response(JSON.stringify({ Message: options.refuse.message, Code: 0, Type: 'error' }), { status: options.refuse.status })
    const cid = new URL(url).searchParams.get('arg')
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString()
    const isStatus = url.includes('/status')
    return new Response(`${JSON.stringify({ Name: 'share', Hash: options.hash ?? cid, KeptUntil: isStatus && options.kept !== true ? null : until })}\n`)
  })
  return calls
}

describe('keeping a copy on Orivon\'s server', () => {
  it('asks first, then sends the share\'s CAR, and accepts the answer that names the same address', async () => {
    const keep = runtime()
    const { cid } = await publishShare({ kind: 'files', entries: [entry('a.txt', 'hello'), entry('b/c.txt', 'deep')] })
    const calls = service()
    const progress: string[] = []
    const kept = await keepOnOrivon(keep, cid, { service: SERVICE, onProgress: (p) => progress.push(p.step) })
    expect(kept).toMatchObject({ label: 'Orivon\'s server', ok: true })
    expect(kept.keptUntil).toBeGreaterThan(Date.now() + 29 * 86_400_000)
    expect(calls.map((c) => c.url.replace(cid, '<cid>'))).toEqual([`${SERVICE}/api/v0/status?arg=<cid>&size=${(await keep.car(cid)).size}`, `${SERVICE}/api/v0/keep?arg=<cid>`])
    expect(new Headers(calls[1]!.init.headers).get('content-type')).toBe('application/vnd.ipld.car')
    const sent = await readCar(new Uint8Array(await (calls[1]!.init.body as Blob).arrayBuffer()), cid)
    expect(listDirectory(sent, cid).map((e) => e.name)).toEqual(['a.txt', 'b'])
    expect(progress).toEqual(['send'])
  })

  it('sends nothing for a share the service already keeps', async () => {
    const keep = runtime()
    const { cid } = await publishShare({ kind: 'files', entries: [entry('a.txt', 'hello')] })
    const calls = service({ kept: true })
    expect((await keepOnOrivon(keep, cid, { service: SERVICE })).ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('refuses an answer that names another address, whether the share is new or already kept', async () => {
    const keep = runtime()
    const { cid } = await publishShare({ kind: 'files', entries: [entry('a.txt', 'hello')] })
    const other = 'bafybeiek6rgo53nnksskarhmyk2ussqywifoxhs45j7y3l4mlis5nlqziu'
    for (const kept of [false, true]) {
      service({ hash: other, kept })
      const error = await keepOnOrivon(keep, cid, { service: SERVICE }).catch((e) => e)
      expect(error).toBeInstanceOf(CopyError)
      expect(error).toMatchObject({ kind: 'mismatch' })
      expect(error.message).toContain('kept something other than this share')
    }
  })

  it('refuses a share over the limit before it makes the CAR or sends a byte', async () => {
    const calls = service()
    const bigKept = { meta: async () => ({ stored: COPY_MAX_BYTES + 1 }), car: async () => { throw new Error('the CAR should not be made') } }
    const error = await keepOnOrivon(bigKept as never, 'bafybeiek6rgo53nnksskarhmyk2ussqywifoxhs45j7y3l4mlis5nlqziu', { service: SERVICE }).catch((e) => e)
    expect(error).toMatchObject({ kind: 'too-large' })
    expect(error.message).toContain('200 MiB')
    const bigCar = { meta: async () => ({ stored: 10 }), car: async () => ({ size: COPY_MAX_BYTES + 1 }) }
    expect(await keepOnOrivon(bigCar as never, 'bafybeiek6rgo53nnksskarhmyk2ussqywifoxhs45j7y3l4mlis5nlqziu', { service: SERVICE }).catch((e) => e)).toMatchObject({ kind: 'too-large' })
    expect(calls).toHaveLength(0)
  })

  it('says why the service refused, in its words, and when it cannot be reached', async () => {
    const keep = runtime()
    const { cid } = await publishShare({ kind: 'files', entries: [entry('a.txt', 'hello')] })
    service({ refuse: { status: 429, message: 'Orivon\'s server takes 512 MiB a day from one address.' } })
    expect(await keepOnOrivon(keep, cid, { service: SERVICE }).catch((e) => e)).toMatchObject({ kind: 'refused', message: 'Orivon\'s server takes 512 MiB a day from one address.' })
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed') })
    expect(await keepOnOrivon(keep, cid, { service: SERVICE }).catch((e) => e)).toMatchObject({ kind: 'unreachable' })
    vi.stubGlobal('fetch', async () => new Response('<html>nope</html>'))
    expect(await keepOnOrivon(keep, cid, { service: SERVICE }).catch((e) => e)).toMatchObject({ kind: 'bad-answer' })
  })

  it('writes one [share-copy] line per attempt', async () => {
    const keep = runtime()
    const { cid } = await publishShare({ kind: 'files', entries: [entry('a.txt', 'hello')] })
    const lines: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((line: string) => { lines.push(line) })
    service()
    await keepOnOrivon(keep, cid, { service: SERVICE })
    service({ refuse: { status: 503, message: 'No room.' } })
    await keepOnOrivon(keep, cid, { service: SERVICE }).catch(() => {})
    expect(lines.filter((l) => l.startsWith('[share-copy]'))).toHaveLength(2)
    expect(lines[0]).toMatch(/^\[share-copy\] kept bafy\S{8}… \(\d+ bytes\) until \d{4}-\d{2}-\d{2}$/)
    expect(lines[1]).toBe('[share-copy] not kept ' + cid.slice(0, 12) + '…: refused, No room.')
  })
})

describe('the box when sharing', () => {
  it('sends a copy only when asked, and says in the result what happened', async () => {
    runtime()
    const calls = service()
    const plain = await publishShare({ kind: 'files', entries: [entry('a.txt', 'hello')] })
    expect(plain.copy).toBeNull()
    expect(calls).toHaveLength(0)
    const asked = await publishShare({ kind: 'files', entries: [entry('a.txt', 'hello'), entry('z.txt', 'zed')], orivonCopy: true })
    expect(asked.copy).toMatchObject({ ok: true, label: 'Orivon\'s server' })
    expect(calls.length).toBeGreaterThan(0)
  })

  it('keeps the share online here and reports the refusal when the copy fails', async () => {
    const keep = runtime()
    service({ refuse: { status: 503, message: 'Orivon\'s server has no room for another copy right now.' } })
    const result = await publishShare({ kind: 'files', entries: [entry('a.txt', 'hello')], orivonCopy: true })
    expect(result.online).toBe(true)
    expect(result.copy).toEqual({ label: 'Orivon\'s server', ok: false, error: 'Orivon\'s server has no room for another copy right now.' })
    expect(await keep.meta(result.cid)).not.toBeNull()
  })

  it('sends only the locked file of a protected share, never the files or the password', async () => {
    runtime()
    const calls = service()
    const secret = 'plaintext-marker-5f1c9e0d'
    const password = 'correct horse battery'
    const result = await publishShare({ kind: 'files', entries: [entry('diary.txt', secret), entry('d/photo.txt', secret)], password, orivonCopy: true })
    expect(result.copy).toMatchObject({ ok: true })
    const body = new Uint8Array(await (calls.find((c) => c.url.includes('/keep'))!.init.body as Blob).arrayBuffer())
    const blocks = await readCar(body, result.cid)
    expect(listDirectory(blocks, result.cid).map((e) => e.name).sort()).toEqual(['HOW-TO-OPEN.txt', 'share.age'])
    const text = Buffer.from(body).toString('latin1')
    expect(text).not.toContain(secret)
    expect(text).not.toContain('diary.txt')
    expect(text).not.toContain(password)
    expect(text).toContain('AGE:')
  })
})
