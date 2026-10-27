import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scryptSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DamagedShareError, SCRYPT_LOG_N, WrongPasswordError, createCipher } from '../page/src/crypto/age.js'
import { decryptBlob, encryptBlob } from '../page/src/crypto/client.js'

type BlobPart = string | Blob | ArrayBuffer | Uint8Array

const blob = (bytes: Uint8Array | string) => new Blob([bytes as BlobPart])
const read = async (b: Blob) => new Uint8Array(await b.arrayBuffer())

function pattern (size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7 + (i >>> 8)) & 255)
}

/** A worker the test answers for. */
function fakeWorker (answer: (message: any, reply: (data: unknown) => void) => void) {
  const worker = {
    terminated: false,
    onmessage: null as ((event: { data: any }) => void) | null,
    onerror: null as ((event: { message?: string }) => void) | null,
    messages: [] as any[],
    postMessage (message: any) {
      worker.messages.push(message)
      queueMicrotask(() => answer(message, (data) => worker.onmessage?.({ data })))
    },
    terminate () { worker.terminated = true }
  }
  return worker
}

describe('the page\'s side of the worker', () => {
  it('sends the blob and the password, passes progress on, and resolves with the result', async () => {
    const result = blob('ciphertext')
    const worker = fakeWorker((message, reply) => {
      reply({ id: message.id, type: 'progress', done: 5, total: 10 })
      reply({ id: message.id, type: 'done', blob: result })
    })
    const progress: unknown[] = []
    const source = blob('plain')
    expect(await encryptBlob(source, 'pw pw pw pw', { spawn: () => worker, onProgress: (p) => progress.push(p) })).toBe(result)
    expect(worker.messages[0]).toMatchObject({ op: 'encrypt', blob: source, password: 'pw pw pw pw' })
    expect(progress).toEqual([{ done: 5, total: 10 }])
    expect(worker.terminated).toBe(true)
    const again = fakeWorker((message, reply) => reply({ id: message.id, type: 'done', blob: result }))
    await decryptBlob(source, 'pw', { spawn: () => again })
    expect(again.messages[0]).toMatchObject({ op: 'decrypt' })
  })

  it('tells a wrong password from a damaged share from anything else', async () => {
    const failing = (name: string, message: string) => fakeWorker((m, reply) => reply({ id: m.id, type: 'error', name, message }))
    const wrong = await decryptBlob(blob('x'), 'pw', { spawn: () => failing('WrongPasswordError', 'That password does not open this share.') }).catch((e: Error) => e)
    expect(wrong).toBeInstanceOf(WrongPasswordError)
    expect((wrong as Error).name).toBe('WrongPasswordError')
    const damaged = await decryptBlob(blob('x'), 'pw', { spawn: () => failing('DamagedShareError', 'This share is damaged and cannot be decrypted (boom).') }).catch((e: Error) => e)
    expect(damaged).toBeInstanceOf(DamagedShareError)
    expect((damaged as Error).message).toContain('boom')
    const other = await decryptBlob(blob('x'), 'pw', { spawn: () => failing('RangeError', 'out of memory') }).catch((e: Error) => e)
    expect(other).not.toBeInstanceOf(WrongPasswordError)
    expect((other as Error).message).toBe('out of memory')
  })

  it('ends the worker when the call is cancelled, at once if it was cancelled already', async () => {
    const worker = fakeWorker(() => {})
    const controller = new AbortController()
    const pending = encryptBlob(blob('x'), 'pw', { spawn: () => worker, signal: controller.signal })
    controller.abort(new DOMException('Cancelled.', 'AbortError'))
    await expect(pending).rejects.toThrow('Cancelled.')
    expect(worker.terminated).toBe(true)
    const spawn = vi.fn()
    await expect(encryptBlob(blob('x'), 'pw', { spawn: spawn as never, signal: controller.signal })).rejects.toThrow('Cancelled.')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a worker that cannot start, and a browser with no workers', async () => {
    const worker = fakeWorker(() => {})
    const pending = encryptBlob(blob('x'), 'pw', { spawn: () => worker })
    worker.onerror?.({ message: 'script failed to load' })
    await expect(pending).rejects.toThrow('script failed to load')
    expect(worker.terminated).toBe(true)
    await expect(encryptBlob(blob('x'), 'pw')).rejects.toThrow('no web workers')
  })
})

/** typage's API, enough of it for the plumbing: a stream in, a stream out. */
function stubAge (options: { headerFails?: string, payloadFails?: boolean, size?: (n: number) => number } = {}) {
  class Encrypter {
    passphrase = ''
    factor = 0
    setPassphrase (p: string) { this.passphrase = p }
    setScryptWorkFactor (n: number) { this.factor = n; stubs.factors.push(n) }
    async encrypt (stream: ReadableStream<Uint8Array>) { return stream }
  }
  class Decrypter {
    addPassphrase () {}
    async decrypt (stream: ReadableStream<Uint8Array>) {
      if (options.headerFails !== undefined) throw new Error(options.headerFails)
      const out = options.payloadFails === true
        ? new ReadableStream<Uint8Array>({ pull () { throw new Error('aead: invalid tag') } })
        : stream
      return Object.assign(out, { size: options.size ?? ((n: number) => n) })
    }
  }
  const stubs = { factors: [] as number[] }
  return { age: { Encrypter, Decrypter } as never, stubs }
}

describe('the use of age', () => {
  it('encrypts a stream with a passphrase at scrypt work factor 2^18, and counts what it reads', async () => {
    const { age, stubs } = stubAge()
    const progress: number[] = []
    const out = await createCipher(age).encrypt(blob(pattern(200_000)), 'pw', (p) => progress.push(p.done))
    expect(await read(out)).toEqual(pattern(200_000))
    expect(stubs.factors).toEqual([18])
    expect(SCRYPT_LOG_N).toBe(18)
    expect(progress.at(-1)).toBe(200_000)
    expect(progress.every((n, i) => i === 0 || n >= progress[i - 1]!)).toBe(true)
    expect(createCipher(stubAge().age, { logN: 4 })).toBeDefined()
  })

  it('says a password is wrong when no identity matched, and damaged for any other failure', async () => {
    const wrong = await createCipher(stubAge({ headerFails: 'no identity matched any of the file\'s recipients' }).age).decrypt(blob('x'), 'pw').catch((e: Error) => e)
    expect(wrong).toBeInstanceOf(WrongPasswordError)
    for (const failure of ['invalid header HMAC', 'scrypt work factor is too high', 'stream ended before reading 16 bytes', 'invalid non-ASCII byte in header']) {
      const damaged = await createCipher(stubAge({ headerFails: failure }).age).decrypt(blob('x'), 'pw').catch((e: Error) => e)
      expect(damaged, failure).toBeInstanceOf(DamagedShareError)
      expect((damaged as Error).message).toContain(failure)
    }
    const payload = await createCipher(stubAge({ payloadFails: true }).age).decrypt(blob('x'), 'pw').catch((e: Error) => e)
    expect(payload).toBeInstanceOf(DamagedShareError)
  })

  it('reports progress of a decryption against the size it will have', async () => {
    const progress: { done: number, total: number }[] = []
    await createCipher(stubAge({ size: (n) => n - 100 }).age).decrypt(blob(pattern(150_000)), 'pw', (p) => progress.push(p))
    expect(progress.at(-1)).toEqual({ done: 150_000, total: 149_900 })
    const bad = stubAge({ size: () => { throw new Error('too small') } })
    const out: { done: number, total: number }[] = []
    await createCipher(bad.age).decrypt(blob(pattern(1000)), 'pw', (p) => out.push(p))
    expect(out.at(-1)!.total).toBe(1000)
  })
})

// The real typage, from the clone the build makes: `orivon-port build share` fetches it into out/share/source/
// and installs its locked dependencies (SHARE_TYPAGE_DIR names another copy with its node_modules). Without
// one these tests are skipped, and the unit tests above are the whole of what runs.
const typageDir = process.env['SHARE_TYPAGE_DIR'] ?? resolve(process.cwd(), 'out/share/source')
const typage = resolve(typageDir, 'lib/index.ts')
const hasTypage = existsSync(typage) && existsSync(resolve(typageDir, 'node_modules/@noble/hashes'))

/** The age passphrase format read straight from its specification, with Node's own crypto. */
function referenceDecrypt (file: Uint8Array, password: string) {
  const text = Buffer.from(file)
  const macAt = text.indexOf('\n--- ') + 1
  const headerEnd = text.indexOf('\n', macAt) + 1
  const header = text.subarray(0, headerEnd).toString('latin1')
  const lines = header.split('\n')
  expect(lines[0]).toBe('age-encryption.org/v1')
  const [arrow, kind, salt64, logN] = lines[1]!.split(' ')
  expect([arrow, kind]).toEqual(['->', 'scrypt'])
  const salt = Buffer.from(salt64!, 'base64')
  const body = Buffer.from(lines[2]!, 'base64')
  const key = scryptSync(password, Buffer.concat([Buffer.from('age-encryption.org/v1/scrypt'), salt]), 32, { N: 2 ** Number(logN), r: 8, p: 1, maxmem: 2 ** 30 })
  const unwrap = createDecipheriv('chacha20-poly1305', key, Buffer.alloc(12), { authTagLength: 16 })
  unwrap.setAuthTag(body.subarray(16))
  const fileKey = Buffer.concat([unwrap.update(body.subarray(0, 16)), unwrap.final()])
  const macKey = Buffer.from(hkdfSync('sha256', fileKey, Buffer.alloc(0), 'header', 32))
  const mac = createHmac('sha256', macKey).update(text.subarray(0, macAt + 3)).digest()
  expect(Buffer.from(text.subarray(macAt + 4, headerEnd - 1).toString('latin1'), 'base64').equals(mac), 'the header MAC').toBe(true)
  const nonce = text.subarray(headerEnd, headerEnd + 16)
  const streamKey = Buffer.from(hkdfSync('sha256', fileKey, nonce, 'payload', 32))
  const payload = text.subarray(headerEnd + 16)
  const out: Buffer[] = []
  for (let at = 0, counter = 0; at < payload.length; at += 65_552, counter++) {
    const chunk = payload.subarray(at, at + 65_552)
    const last = at + 65_552 >= payload.length
    const iv = Buffer.alloc(12)
    iv.writeUIntBE(counter, 5, 6)
    iv[11] = last ? 1 : 0
    const open = createDecipheriv('chacha20-poly1305', streamKey, iv, { authTagLength: 16 })
    open.setAuthTag(chunk.subarray(chunk.length - 16))
    out.push(open.update(chunk.subarray(0, chunk.length - 16)), open.final())
  }
  return { plaintext: new Uint8Array(Buffer.concat(out)), logN: Number(logN) }
}

/** The same, the other way: a file made from the specification that typage has to open. */
function referenceEncrypt (plaintext: Uint8Array, password: string, logN: number) {
  const salt = randomBytes(16)
  const fileKey = randomBytes(16)
  const key = scryptSync(password, Buffer.concat([Buffer.from('age-encryption.org/v1/scrypt'), salt]), 32, { N: 2 ** logN, r: 8, p: 1, maxmem: 2 ** 30 })
  const wrap = createCipheriv('chacha20-poly1305', key, Buffer.alloc(12), { authTagLength: 16 })
  const wrapped = Buffer.concat([wrap.update(fileKey), wrap.final(), wrap.getAuthTag()])
  const unpadded = (b: Buffer) => b.toString('base64').replace(/=+$/, '')
  const head = `age-encryption.org/v1\n-> scrypt ${unpadded(salt)} ${logN}\n${unpadded(wrapped)}\n---`
  const macKey = Buffer.from(hkdfSync('sha256', fileKey, Buffer.alloc(0), 'header', 32))
  const header = Buffer.from(`${head} ${unpadded(createHmac('sha256', macKey).update(head).digest())}\n`, 'latin1')
  const nonce = randomBytes(16)
  const streamKey = Buffer.from(hkdfSync('sha256', fileKey, nonce, 'payload', 32))
  const chunks: Buffer[] = []
  for (let at = 0, counter = 0; at === 0 || at < plaintext.length; at += 65_536, counter++) {
    const last = at + 65_536 >= plaintext.length
    const iv = Buffer.alloc(12)
    iv.writeUIntBE(counter, 5, 6)
    iv[11] = last ? 1 : 0
    const seal = createCipheriv('chacha20-poly1305', streamKey, iv, { authTagLength: 16 })
    chunks.push(Buffer.concat([seal.update(plaintext.subarray(at, at + 65_536)), seal.final(), seal.getAuthTag()]))
  }
  return new Uint8Array(Buffer.concat([header, nonce, ...chunks]))
}

describe.skipIf(!hasTypage)('the real age (typage), against the specification', () => {
  async function real (logN?: number) {
    const age = await import(/* @vite-ignore */ typage)
    return createCipher(age, logN === undefined ? {} : { logN })
  }

  it('makes a file that the age format\'s own steps open: scrypt 2^18, the header MAC, a stream of 64 KiB chunks', async () => {
    const cipher = await real()
    const plain = pattern(200_000)
    const progress: { done: number, total: number }[] = []
    const file = await read(await cipher.encrypt(blob(plain), 'correct horse battery', (p) => progress.push(p)))
    expect(Buffer.from(file.subarray(0, 22)).toString()).toBe('age-encryption.org/v1\n')
    const opened = referenceDecrypt(file, 'correct horse battery')
    expect(opened.logN).toBe(18)
    expect(opened.plaintext).toEqual(plain)
    expect(progress.at(-1)).toEqual({ done: 200_000, total: 200_000 })
  }, 120_000)

  it('opens a file made from the specification, whatever the password holds', async () => {
    const cipher = await real()
    for (const [password, size] of [['pässwörd 日本語 😀', 0], ['x'.repeat(100), 65_536], ['correct horse', 65_537]] as const) {
      const plain = pattern(size)
      const out = await cipher.decrypt(blob(referenceEncrypt(plain, password, 10)), password)
      expect(await read(out), `${size} bytes`).toEqual(plain)
    }
  }, 120_000)

  it('says wrong password for a wrong password and damaged for a file that was changed or cut', async () => {
    const cipher = await real(10)
    const file = await read(await cipher.encrypt(blob(pattern(150_000)), 'right password'))
    expect(await cipher.decrypt(blob(file), 'wrong password').catch((e: Error) => e)).toBeInstanceOf(WrongPasswordError)
    expect(await cipher.decrypt(blob(file), 'Right password').catch((e: Error) => e)).toBeInstanceOf(WrongPasswordError)
    expect(await read(await cipher.decrypt(blob(file), 'right password'))).toEqual(pattern(150_000))
    const flipped = file.slice()
    flipped[flipped.length - 100] = flipped[flipped.length - 100]! ^ 1
    expect(await cipher.decrypt(blob(flipped), 'right password').catch((e: Error) => e)).toBeInstanceOf(DamagedShareError)
    for (const cut of [file.length - 1, file.length - 70_000, 40, 0]) {
      const failure = await cipher.decrypt(blob(file.subarray(0, cut)), 'right password').catch((e: Error) => e)
      expect(failure, `cut at ${cut}`).toBeInstanceOf(DamagedShareError)
    }
  }, 120_000)

  it('refuses a work factor above what it will spend, before spending it', async () => {
    const cipher = await real()
    const unpadded = (b: Buffer) => b.toString('base64').replace(/=+$/, '')
    const header = `age-encryption.org/v1\n-> scrypt ${unpadded(randomBytes(16))} 21\n${unpadded(randomBytes(32))}\n--- ${unpadded(randomBytes(32))}\n`
    const started = Date.now()
    const failure = await cipher.decrypt(blob(new Uint8Array(Buffer.concat([Buffer.from(header), randomBytes(64)]))), 'pw').catch((e: Error) => e)
    expect(failure).toBeInstanceOf(DamagedShareError)
    expect((failure as Error).message).toContain('too high')
    expect(Date.now() - started).toBeLessThan(2000)
  }, 120_000)
})
