import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { assertHostAgnostic, findEncodedFiles } from './portable.ts'

describe('findEncodedFiles', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'orivon-portable-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  // The shape this port ships: the name the app fetches, over bytes that need
  // no header. Nothing about the name is what makes a file unservable.
  it('passes a .br file that holds plain bytes', async () => {
    await writeFile(join(root, 'en-US.json.br'), '{"hello":"world"}')
    await writeFile(join(root, 'index.html'), '<html>app</html>')
    expect(await findEncodedFiles(root)).toEqual([])
  })

  it('catches real brotli under any name, however deep', async () => {
    await mkdir(join(root, 'static', 'locales'), { recursive: true })
    await writeFile(join(root, 'static', 'locales', 'en-US.json.br'), brotliCompressSync('{"a":1}'))
    const found = await findEncodedFiles(root)
    expect(found).toEqual([{ path: join('static', 'locales', 'en-US.json.br'), encoding: 'br' }])
  })

  // gzip and zstd are caught by magic number, so the name is irrelevant: a
  // pre-gzipped `app.js` is as unservable as one called `app.js.gz`.
  it('catches gzip and zstd by their bytes, not their extension', async () => {
    await writeFile(join(root, 'app.js'), gzipSync('console.log(1)'))
    await writeFile(join(root, 'data.bin'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]))
    const found = await findEncodedFiles(root)
    expect(found.map((file) => file.encoding).sort()).toEqual(['gzip', 'zstd'])
  })

  it('names the file and what it would take to serve it', async () => {
    await writeFile(join(root, 'en-US.json.br'), brotliCompressSync('{"a":1}'))
    await expect(assertHostAgnostic(root, 'freetube')).rejects.toThrow(/en-US\.json\.br \(br\)/)
    await expect(assertHostAgnostic(root, 'freetube')).rejects.toThrow(/Content-Encoding/)
  })

  it('says how many it did not list', async () => {
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(root, `${String(index)}.json.br`), brotliCompressSync('{"a":1}'))
    }
    await expect(assertHostAgnostic(root, 'freetube')).rejects.toThrow(/\.\.\.and 3 more/)
  })
})
