// The packed node: the Worker's bundle and the component's program shipped as raw deflate streams, and the two small readers
// (the Worker's loader, the component glue's changed line) that unpack them. The loader is run here the way the Worker
// runs it, against a server that holds the packed file; the glue's line is checked against jco's own text.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findEncodedFiles } from '../../../../src/portable.ts'
import { addNodeComponent, packedForm, packGlue, writePin } from '../../build/node-component.mjs'
import { deflateBytes, PROGRAM_PACKED, SERVER_PACKED, switchedOn, writePackedServer } from '../../build/pack.mjs'

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

describe('deflateBytes', () => {
  // Words picked by a fixed generator, so there are many matches of many lengths for the packer to choose between.
  const sample = (() => {
    const words = ['node', 'server', 'bundle', 'function', 'const', 'return', 'await', 'packet', 'stream', 'block', 'peer', 'record']
    let seed = 12345
    let text = ''
    while (text.length < 300_000) { seed = (seed * 1103515245 + 12345) % 2147483648; text += `${words[seed % words.length] as string}${String(seed % 97)} ` }
    return Buffer.from(text)
  })()

  it('makes a raw deflate stream that unpacks to the bytes it was given', () => {
    expect(inflateRawSync(deflateBytes(sample)).equals(sample)).toBe(true)
    expect(deflateBytes(sample).length).toBeLessThan(sample.length / 3)
  })

  it('makes the same bytes every time, and these bytes on every machine (the pin is fflate\'s, not the CPU\'s)', () => {
    expect(deflateBytes(sample).equals(deflateBytes(sample))).toBe(true)
    expect(sha(deflateBytes(sample))).toBe('1d99c10b4f26b842a1dd0b548fe69036e200724d6bc9d741e66bf528ef78a9cc')
  })

  it('does not begin with a gzip or zstd magic number, so no host is expected to name a content encoding for it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bitsocial-pack-'))
    try {
      await writeFile(join(dir, SERVER_PACKED), deflateBytes(sample))
      await writeFile(join(dir, PROGRAM_PACKED), deflateBytes(Buffer.from('\0asm\x01\0\0\0' + 'x'.repeat(5000))))
      expect(await findEncodedFiles(dir)).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('switchedOn', () => {
  it('is on unless the switch is 0', () => {
    expect(switchedOn('BITSOCIAL_NODE_MINIFY', {})).toBe(true)
    expect(switchedOn('BITSOCIAL_NODE_MINIFY', { BITSOCIAL_NODE_MINIFY: '1' })).toBe(true)
    expect(switchedOn('BITSOCIAL_NODE_MINIFY', { BITSOCIAL_NODE_MINIFY: '0' })).toBe(false)
  })
})

describe('the Worker\'s loader (server.mjs of a packed tree)', () => {
  let dir: string
  let server: Server | undefined
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bitsocial-loader-')); await mkdir(join(dir, 'node')) })
  afterEach(async () => {
    const open = server
    if (open !== undefined) await new Promise<void>((resolve) => { open.close(() => { resolve() }); open.closeAllConnections() })
    await rm(dir, { recursive: true, force: true })
    delete (globalThis as { __ran?: unknown }).__ran
  })

  async function listen (): Promise<string> {
    server = createServer((request, response) => {
      const file = join(dir, new URL(request.url ?? '/', 'http://x.invalid').pathname)
      readFile(file).then((bytes) => response.writeHead(200).end(bytes), () => response.writeHead(404).end('no'))
    })
    const listening = server
    await new Promise<void>((resolve) => { listening.listen(0, '127.0.0.1', resolve) })
    const address = listening.address()
    return `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}/node/server.mjs`
  }

  /** The loader's text run as a module body whose `import.meta.url` is `address`: its top level is an async function's, as the Worker's import is. */
  async function runLoader (address: string): Promise<void> {
    const text = (await readFile(join(dir, 'node', 'server.mjs'), 'utf8')).replaceAll('import.meta.url', JSON.stringify(address))
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    await new AsyncFunction(text)()
  }

  it('writes the packed bundle beside a loader that is a small file', async () => {
    await writePackedServer(join(dir, 'node'), Buffer.from('globalThis.__ran = 1'))
    const loader = await readFile(join(dir, 'node', 'server.mjs'), 'utf8')
    expect(loader.length).toBeLessThan(3000)
    expect(loader).toContain(SERVER_PACKED)
    expect(inflateRawSync(await readFile(join(dir, 'node', SERVER_PACKED))).toString()).toBe('globalThis.__ran = 1')
  })

  it('runs the bundle strict, with its top-level await, and gives it the loader\'s address where it would read import.meta.url', async () => {
    const bundle = 'globalThis.__ran = { url: globalThis.__bitsocialServerUrl, strict: (function () { return this })() === undefined, awaited: await Promise.resolve(7), sqlite: new URL("sqlite3.wasm", globalThis.__bitsocialServerUrl).pathname }'
    await writePackedServer(join(dir, 'node'), Buffer.from(bundle))
    const address = await listen()
    await runLoader(address)
    expect((globalThis as unknown as { __ran: unknown }).__ran).toEqual({ url: address, strict: true, awaited: 7, sqlite: '/node/sqlite3.wasm' })
  })

  it('fails naming the packed file when it is not served, and with the bundle\'s own error when the bundle throws', async () => {
    await writePackedServer(join(dir, 'node'), Buffer.from('throw new Error("the bundle said no")'))
    const address = await listen()
    await expect(runLoader(address)).rejects.toThrow(/the bundle said no/)
    await rm(join(dir, 'node', SERVER_PACKED))
    await expect(runLoader(address)).rejects.toThrow(/server\.bundle\.js\.deflate\) is not served: 404/)
  })
})

describe('the component glue\'s changed line', () => {
  const glue = (load: string): string => `export function instantiate(getCoreModule, imports) {\nif (!getCoreModule) getCoreModule = (name) => fetchCompile(new URL(\`./\${name}\`, import.meta.url));\n${load}\nconst module1 = getCoreModule('ipfs-node.core2.wasm');\n}\n`
  const LOAD = "const module0 = getCoreModule('ipfs-node.core.wasm');"

  it('reads the packed program, unpacks it as it arrives and compiles it, and leaves every other line alone', () => {
    const packed = packGlue(glue(LOAD))
    expect(packed).not.toContain(LOAD)
    expect(packed).toContain(`new URL('./${PROGRAM_PACKED}', import.meta.url)`)
    expect(packed).toContain("new DecompressionStream('deflate-raw')")
    expect(packed).toContain('WebAssembly.compileStreaming')
    expect(packed).toContain("const module1 = getCoreModule('ipfs-node.core2.wasm');")
    expect(() => new Function(packed.replace('export function', 'function').replaceAll('import.meta.url', '""'))).not.toThrow()
  })

  it('refuses a glue that does not load its program exactly once, so a changed jco output fails the build', () => {
    expect(() => packGlue(glue('const module0 = somethingElse();'))).toThrow(/does not load its program once/)
    expect(() => packGlue(glue(`${LOAD}\n${LOAD}`))).toThrow(/does not load its program once/)
  })

  /** A pin's files and their packed forms, as `writePin` writes them, for the fake component of the tests below. */
  const fake = async (dir: string) => {
    const from = join(dir, 'from')
    await mkdir(from)
    const parts = { 'ipfs-node.js': Buffer.from(glue(LOAD)), 'ipfs-node.core.wasm': Buffer.from('\0asm\x01\0\0\0' + 'program '.repeat(4000)), 'ipfs-node.core2.wasm': Buffer.from('\0asm\x01\0\0\0 small') } as Record<string, Buffer>
    for (const [name, bytes] of Object.entries(parts)) await writeFile(join(from, name), bytes)
    const files = Object.entries(parts).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes), under: 'bin/ipfs-node.p2' }))
    const packed = files.flatMap((file) => {
      const form = packedForm(file.name, parts[file.name] as Buffer)
      return form === undefined ? [] : [{ name: form.name, replaces: file.name, bytes: form.bytes.length, sha256: sha(form.bytes), under: file.under }]
    })
    return { parts, files, packed }
  }

  it('packedForm is the packed file of the glue and of the program, and nothing for the rest', () => {
    const program = Buffer.from('\0asm\x01\0\0\0' + 'program '.repeat(100))
    expect(packedForm('ipfs-node.core.wasm', program)).toEqual({ name: PROGRAM_PACKED, bytes: deflateBytes(program) })
    expect(packedForm('ipfs-node.js', Buffer.from(glue(LOAD)))).toEqual({ name: 'ipfs-node.js', bytes: Buffer.from(packGlue(glue(LOAD))) })
    expect(packedForm('ipfs-node.core2.wasm', program)).toBeUndefined()
    expect(packedForm('LICENSE-MIT', program)).toBeUndefined()
  })

  it('addNodeComponent writes the program packed and the glue changed, each checked against its pin, and the rest as they are', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bitsocial-component-pack-'))
    try {
      const { parts, files, packed } = await fake(dir)
      expect(packed.map((one) => [one.replaces, one.name])).toEqual([['ipfs-node.js', 'ipfs-node.js'], ['ipfs-node.core.wasm', PROGRAM_PACKED]])
      const out = join(dir, 'out')
      await addNodeComponent(out, { BITSOCIAL_IPFS_NODE_DIR: join(dir, 'from') }, { compress: true, files, packed })
      const under = join(out, 'bin', 'ipfs-node.p2')
      expect(inflateRawSync(await readFile(join(under, PROGRAM_PACKED))).equals(parts['ipfs-node.core.wasm'] as Buffer)).toBe(true)
      expect(await readFile(join(under, 'ipfs-node.js'), 'utf8')).toBe(packGlue(glue(LOAD)))
      expect((await readFile(join(under, 'ipfs-node.core2.wasm'))).equals(parts['ipfs-node.core2.wasm'] as Buffer)).toBe(true)
      await expect(readFile(join(under, 'ipfs-node.core.wasm'))).rejects.toThrow()

      const plain = join(dir, 'plain')
      await addNodeComponent(plain, { BITSOCIAL_IPFS_NODE_DIR: join(dir, 'from') }, { files, packed })
      expect((await readFile(join(plain, 'bin', 'ipfs-node.p2', 'ipfs-node.core.wasm'))).equals(parts['ipfs-node.core.wasm'] as Buffer)).toBe(true)
      expect(await readFile(join(plain, 'bin', 'ipfs-node.p2', 'ipfs-node.js'), 'utf8')).toBe(glue(LOAD))
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('addNodeComponent refuses a packed file that is not the pinned one, or one the pin does not list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bitsocial-component-pack-'))
    try {
      const { files, packed } = await fake(dir)
      const env = { BITSOCIAL_IPFS_NODE_DIR: join(dir, 'from') }
      const changed = packed.map((one) => (one.replaces === 'ipfs-node.core.wasm' ? { ...one, sha256: '0'.repeat(64) } : one))
      await expect(addNodeComponent(join(dir, 'a'), env, { compress: true, files, packed: changed })).rejects.toThrow(/packed ipfs-node\.core\.wasm\.deflate is not the pinned one/)
      await expect(addNodeComponent(join(dir, 'b'), env, { compress: true, files, packed: packed.filter((one) => one.replaces !== 'ipfs-node.js') })).rejects.toThrow(/pins no packed form of ipfs-node\.js/)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('writePin records each file and its packed form, which addNodeComponent then checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bitsocial-component-pack-'))
    try {
      const { files, packed } = await fake(dir)
      const target = join(dir, 'pin.mjs')
      await writePin(join(dir, 'from'), ['--flag'], ['feature'], { target, files })
      const written = (await import(`${target}?${String(Date.now())}`)).default as { flags: string[], features: string[], files: unknown[], packed: unknown[] }
      expect(written.flags).toEqual(['--flag'])
      expect(written.features).toEqual(['feature'])
      expect(written.files).toEqual(files)
      expect(written.packed).toEqual(packed)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('is the line jco wrote in the glue this build is pinned to, when that glue is at hand', async () => {
    const directory = process.env['BITSOCIAL_IPFS_NODE_DIR']
    const found = directory === undefined ? undefined : await readFile(join(directory, 'ipfs-node.p2', 'ipfs-node.js'), 'utf8').catch(() => readFile(join(directory, 'ipfs-node.js'), 'utf8')).catch(() => undefined)
    if (found === undefined) return
    expect(() => packGlue(found)).not.toThrow()
  })
})
