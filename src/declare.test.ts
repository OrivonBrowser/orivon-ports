import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MAX_ASSET_BYTES, MAX_BUNDLE_ENTRIES } from './bundle-hash.ts'
import { DDOC, MANIFEST, MAX_MANIFEST_BYTES, declareBundle } from './declare.ts'

interface Ddoc {
  readonly bundleHash: string
  readonly leaves: Record<string, string>
}

const MANIFEST_JSON = { orivonApiVersion: 0, id: 'demo', name: 'Demo', version: '1.0.0', entry: 'index.html', capabilities: {} }

/**
 * The construction written out a second time, straight from the spec, so the
 * test does not check bundle-hash.ts against itself.
 */
function independentRoot (leaves: Record<string, Buffer>): string {
  const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
  const u64 = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b }
  const digests = Object.keys(leaves).sort().map((path) => {
    const content = leaves[path]!
    const pathBytes = Buffer.from(path)
    return createHash('sha256').update(Buffer.concat([Buffer.of(0), u32(pathBytes.length), pathBytes, u64(content.length), content])).digest()
  })
  const version = Buffer.from('orivon-bundle-v1')
  return `sha256:${createHash('sha256').update(Buffer.concat([Buffer.of(1), u32(version.length), version, u32(digests.length), ...digests])).digest('hex')}`
}

describe('declareBundle', () => {
  let root: string

  const put = async (path: string, content: string | Buffer): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const manifest = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(root, MANIFEST), 'utf8')) as Record<string, unknown>
  const ddoc = async (): Promise<Ddoc> => JSON.parse(await readFile(join(root, DDOC), 'utf8')) as Ddoc

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orivon-declare-'))
    await put(MANIFEST, JSON.stringify(MANIFEST_JSON))
    await put('index.html', '<!doctype html><title>demo</title>')
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('lists every file but the entry as an encoded asset, right after entry', async () => {
    await put(join('js', 'app.js'), 'console.log(1)')
    await put(join('img', 'logo@2x.png'), 'png')
    await put('x#y.js', 'hash')
    await put('a b.js', 'space')
    await declareBundle(root, { check: false })
    const written = await manifest()
    expect(Object.keys(written)).toEqual(['orivonApiVersion', 'id', 'name', 'version', 'entry', 'assets', 'capabilities'])
    expect(written['assets']).toEqual(['a%20b.js', 'img/logo@2x.png', 'js/app.js', 'x%23y.js'])
    expect(await readFile(join(root, MANIFEST), 'utf8')).toBe(`${JSON.stringify(written, null, 2)}\n`)
  })

  it('writes a ddoc whose root and leaves match the construction done independently', async () => {
    await put(join('js', 'app.js'), 'console.log(1)')
    await put('x#y.js', 'hash')
    const result = await declareBundle(root, { check: false })
    const files: Record<string, Buffer> = {
      '/.well-known/orivon.json': await readFile(join(root, MANIFEST)),
      '/index.html': await readFile(join(root, 'index.html')),
      '/js/app.js': await readFile(join(root, 'js', 'app.js')),
      '/x%23y.js': await readFile(join(root, 'x#y.js'))
    }
    const written = await ddoc()
    expect(written.bundleHash).toBe(independentRoot(files))
    expect(result).toEqual({ bundleHash: written.bundleHash, files: 4, manifestBytes: files['/.well-known/orivon.json']!.length })
    expect(Object.keys(written.leaves)).toEqual(['/.well-known/orivon.json', '/index.html', '/js/app.js', '/x%23y.js'])
    expect(Object.keys(written)).toEqual(['bundleHash', 'leaves'])
    expect(await readFile(join(root, DDOC), 'utf8')).toBe(`${JSON.stringify(written, null, 2)}\n`)
  })

  it('omits assets entirely when the entry is the only file', async () => {
    await put(MANIFEST, JSON.stringify({ ...MANIFEST_JSON, assets: ['gone.js'] }))
    await declareBundle(root, { check: false })
    expect(await manifest()).not.toHaveProperty('assets')
    expect(Object.keys((await ddoc()).leaves)).toEqual(['/.well-known/orivon.json', '/index.html'])
  })

  it('writes the same bytes every time it runs', async () => {
    await put('app.js', 'app')
    await declareBundle(root, { check: false })
    const first = [await readFile(join(root, MANIFEST)), await readFile(join(root, DDOC))]
    await declareBundle(root, { check: false })
    expect([await readFile(join(root, MANIFEST)), await readFile(join(root, DDOC))]).toEqual(first)
  })

  it('refuses a symbolic link rather than following or skipping it', async () => {
    await put('real.js', 'x')
    await symlink('real.js', join(root, 'link.js'))
    await expect(declareBundle(root, { check: false })).rejects.toThrow(/link\.js is a symbolic link/)
  })

  it('names the fix when the tree has no manifest', async () => {
    await rm(join(root, MANIFEST))
    await expect(declareBundle(root, { check: false })).rejects.toThrow(/has no \.well-known\/orivon\.json.*orivon-port build/)
  })

  it('refuses a manifest whose entry names no file', async () => {
    await put(MANIFEST, JSON.stringify({ ...MANIFEST_JSON, entry: 'main.html' }))
    await expect(declareBundle(root, { check: false })).rejects.toThrow(/entry "main\.html" names no file/)
    await put(MANIFEST, JSON.stringify({ ...MANIFEST_JSON, entry: undefined }))
    await expect(declareBundle(root, { check: false })).rejects.toThrow(/no usable "entry"/)
  })

  it('refuses two names that are one file on a case-insensitive disk', async () => {
    await put('A.js', '1')
    await put('a.js', '2')
    await expect(declareBundle(root, { check: false })).rejects.toThrow(/A\.js and a\.js are one file/)
  })

  it('refuses a second manifest in another case', async () => {
    await put(join('.well-known', 'Orivon.json'), '{}')
    await expect(declareBundle(root, { check: false })).rejects.toThrow(/Orivon\.json are one file/)
  })

  it('refuses a name the client refuses, and says which rule it broke', async () => {
    await put('CON.js', 'x')
    await put('trail.js ', 'x')
    await expect(declareBundle(root, { check: false })).rejects.toThrow(/2 file name\(s\)[\s\S]*CON\.js: "CON\.js" is a Windows device name[\s\S]*trail\.js : a URL parser rewrites it/)
  })

  it(`accepts ${String(MAX_BUNDLE_ENTRIES)} files including the manifest, and refuses one more`, async () => {
    await mkdir(join(root, 'many'))
    for (let index = 0; index < MAX_BUNDLE_ENTRIES - 2; index += 1) await writeFile(join(root, 'many', String(index)), '')
    const result = await declareBundle(root, { check: false })
    expect(result.files).toBe(MAX_BUNDLE_ENTRIES)
    expect(((await manifest())['assets'] as string[]).length).toBe(MAX_BUNDLE_ENTRIES - 2)
    await put('one-more.js', '')
    await expect(declareBundle(root, { check: false })).rejects.toThrow(/4097 files including the manifest, over the client's limit of 4096/)
  })

  // Unreadable as well as too big: if the size were found by reading, the
  // error would be EACCES rather than the cap.
  it('refuses a file over the per-file cap before reading a byte of it', async () => {
    await put('huge.bin', '')
    await truncate(join(root, 'huge.bin'), MAX_ASSET_BYTES + 1)
    await chmod(join(root, 'huge.bin'), 0o000)
    await expect(declareBundle(root, { check: false })).rejects.toThrow(/huge\.bin is 67108865 bytes, over the client's 67108864-byte limit/)
  })

  it('refuses a tree over the per-bundle cap before reading it', async () => {
    for (let index = 0; index < 9; index += 1) {
      await put(`chunk-${String(index)}.bin`, '')
      await truncate(join(root, `chunk-${String(index)}.bin`), 60 * 1024 * 1024)
      await chmod(join(root, `chunk-${String(index)}.bin`), 0o000)
    }
    await expect(declareBundle(root, { check: false })).rejects.toThrow(/over the client's 536870912-byte limit for one app/)
  })

  it('refuses a manifest the client would refuse for its size', async () => {
    await put(MANIFEST, JSON.stringify({ ...MANIFEST_JSON, padding: 'x'.repeat(MAX_MANIFEST_BYTES) }))
    await expect(declareBundle(root, { check: false })).rejects.toThrow(/generated manifest is \d+ bytes, over the client's limit of 278400/)
  })

  describe('check', () => {
    beforeEach(async () => {
      await put('app.js', 'app')
      await declareBundle(root, { check: false })
    })

    it('passes on a tree declared as it is, and writes nothing', async () => {
      const before = [await readFile(join(root, MANIFEST)), await readFile(join(root, DDOC))]
      await expect(declareBundle(root, { check: true })).resolves.toMatchObject({ files: 3 })
      expect([await readFile(join(root, MANIFEST)), await readFile(join(root, DDOC))]).toEqual(before)
    })

    it('fails when one byte of a file changed after it was declared', async () => {
      await appendFile(join(root, 'index.html'), ' ')
      await expect(declareBundle(root, { check: true })).rejects.toThrow(/orivon-ddoc\.json no longer match/)
    })

    it('fails when a file was added, so the assets list is stale', async () => {
      await put('late.js', 'late')
      const before = await readFile(join(root, MANIFEST))
      await expect(declareBundle(root, { check: true })).rejects.toThrow(/orivon\.json and \.well-known\/orivon-ddoc\.json no longer match/)
      expect(await readFile(join(root, MANIFEST))).toEqual(before)
    })

    it('fails when the ddoc file was edited by hand', async () => {
      const edited = await ddoc()
      await writeFile(join(root, DDOC), `${JSON.stringify({ ...edited, bundleHash: `sha256:${'0'.repeat(64)}` }, null, 2)}\n`)
      await expect(declareBundle(root, { check: true })).rejects.toThrow(/orivon-ddoc\.json no longer match/)
    })

    it('fails on a tree that was never declared', async () => {
      await rm(join(root, DDOC))
      await expect(declareBundle(root, { check: true })).rejects.toThrow(/orivon-ddoc\.json no longer match/)
    })
  })
})
