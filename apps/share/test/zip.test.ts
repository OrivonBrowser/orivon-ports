import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Crc32, ZipError, blobCrc32, checkZipName, crc32, readZip, writeZip } from '../page/src/lib/zip.js'

// An archive written by Python's zipfile with ZIP_STORED and the date set to 1980-01-01: a description, a
// short file, a 256 byte file in a folder and a file with non-ASCII letters (which Python marks as UTF-8).
const PYTHON_STORED = 'UEsDBBQAAAAAAAAAIQBcWes7BwAAAAcAAAASAAAALm9yaXZvbi1zaGFyZS5qc29ueyJ4IjoxfVBLAwQUAAAAAAAAACEAIDA6NgYAAAAGAAAABQAAAGEudHh0aGVsbG8KUEsDBBQAAAAAAAAAIQBzjAUpAAEAAAABAAAJAAAAZGlyL2IuYmluAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/1BLAwQUAAAIAAAAACEAHk1dqAUAAAAFAAAACQAAAMO8bsOvLnR4dHV0ZjgKUEsBAhQDFAAAAAAAAAAhAFxZ6zsHAAAABwAAABIAAAAAAAAAAAAAAIABAAAAAC5vcml2b24tc2hhcmUuanNvblBLAQIUAxQAAAAAAAAAIQAgMDo2BgAAAAYAAAAFAAAAAAAAAAAAAACAATcAAABhLnR4dFBLAQIUAxQAAAAAAAAAIQBzjAUpAAEAAAABAAAJAAAAAAAAAAAAAACAAWAAAABkaXIvYi5iaW5QSwECFAMUAAAIAAAAACEAHk1dqAUAAAAFAAAACQAAAAAAAAAAAAAAgAGHAQAAw7xuw68udHh0UEsFBgAAAAAEAAQA4QAAALMBAAAAAA=='
// The same library with ZIP_DEFLATED.
const PYTHON_DEFLATED = 'UEsDBBQAAAAIAAAAIQCEuMTQCQAAACwBAAAFAAAAYy50eHRLTEpOHEXEIQBQSwECFAMUAAAACAAAACEAhLjE0AkAAAAsAQAABQAAAAAAAAAAAAAAgAEAAAAAYy50eHRQSwUGAAAAAAEAAQAzAAAALAAAAAAA'

const bytes = (text: string) => new TextEncoder().encode(text)
const blob = (text: string) => new Blob([text])
const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'))
const read = async (b: Blob) => new Uint8Array(await b.arrayBuffer())

async function textOf (b: Blob) {
  return await b.text()
}

describe('CRC-32', () => {
  it('matches the standard check value and is incremental', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
    const parts = new Crc32().update(bytes('1234')).update(bytes('56789'))
    expect(parts.value).toBe(0xcbf43926)
  })

  it('reads a Blob in pieces', async () => {
    const seen: number[] = []
    expect(await blobCrc32(new Blob([bytes('123456789')]), { onBytes: (n) => seen.push(n) })).toBe(0xcbf43926)
    expect(seen.reduce((a, b) => a + b, 0)).toBe(9)
  })
})

describe('checkZipName', () => {
  it('accepts plain relative paths, in any script', () => {
    for (const name of ['a.txt', 'dir/b.bin', 'ünï/日本語.txt', '.orivon-share.json', 'a b/c d.txt']) expect(() => checkZipName(name)).not.toThrow()
  })

  it('refuses a name that could leave the folder it is unpacked into', () => {
    for (const name of ['', '/etc/passwd', '../x', 'a/../x', './x', 'a//b', 'a\\b', 'a\u0000b', 'a\nb', 'dir/']) {
      expect(() => checkZipName(name), JSON.stringify(name)).toThrow(ZipError)
    }
  })
})

describe('writeZip', () => {
  it('writes an archive that unzip, Python and our reader all read', async () => {
    const files = [
      { name: '.orivon-share.json', file: blob('{"format":"orivon-share"}') },
      { name: 'a.txt', file: blob('hello\n') },
      { name: 'empty', file: new Blob([]) },
      { name: 'dir/big.bin', file: new Blob([new Uint8Array(300_000).map((_, i) => i * 7 & 255)]) },
      { name: 'ünï/日本語.txt', file: blob('utf8\n') }
    ]
    const archive = await writeZip(files)
    const entries = await readZip(archive)
    expect(entries.map((e) => e.path)).toEqual(files.map((f) => f.name))
    expect(entries.map((e) => e.size)).toEqual(files.map((f) => f.file.size))
    for (const [index, entry] of entries.entries()) expect(await read(entry.file)).toEqual(await read(files[index]!.file))

    const dir = mkdtempSync(join(tmpdir(), 'share-zip-'))
    try {
      const path = join(dir, 'out.zip')
      writeFileSync(path, await read(archive))
      const unzip = spawnSync('unzip', ['-tq', path], { encoding: 'utf8' })
      if (unzip.error === undefined) expect(unzip.stdout + unzip.stderr, 'unzip -t').toMatch(/No errors detected/)
      const python = spawnSync('python3', ['-I', '-c', 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nassert all(i.compress_type == 0 for i in z.infolist())\nprint("\\n".join(z.namelist()))', path], { encoding: 'utf8' })
      if (python.error === undefined) {
        expect(python.status, python.stderr).toBe(0)
        expect(python.stdout.trim().split('\n')).toEqual(files.map((f) => f.name))
      }
      expect(unzip.error === undefined || python.error === undefined, 'neither unzip nor python3 is installed here: the writer was checked against the reader only').toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('makes the same bytes for the same files, whenever and wherever', async () => {
    const make = async () => await read(await writeZip([{ name: 'a.txt', file: blob('x') }]))
    expect(await make()).toEqual(await make())
  })

  it('sets the UTF-8 flag, stores without compression and records sizes in the local header', async () => {
    const archive = await read(await writeZip([{ name: 'ü.txt', file: blob('abc') }]))
    const view = new DataView(archive.buffer)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800)
    expect(view.getUint16(6, true) & 0x0008, 'no data descriptor').toBe(0)
    expect(view.getUint16(8, true), 'method').toBe(0)
    expect(view.getUint32(18, true)).toBe(3)
    expect(view.getUint32(22, true)).toBe(3)
  })

  it('refuses a duplicate name, a bad name and too many files', async () => {
    await expect(writeZip([{ name: 'a', file: blob('1') }, { name: 'a', file: blob('2') }])).rejects.toThrow('twice')
    await expect(writeZip([{ name: '../a', file: blob('1') }])).rejects.toThrow(ZipError)
    await expect(writeZip(Array.from({ length: 65535 }, (_, i) => ({ name: `f${i}`, file: new Blob([]) })))).rejects.toThrow('65534')
  })

  it('stops when told to', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(writeZip([{ name: 'a', file: blob('1') }], { signal: controller.signal })).rejects.toThrow()
  })
})

describe('readZip', () => {
  it('reads an archive Python made and checks it against its bytes', async () => {
    const entries = await readZip(new Blob([fromBase64(PYTHON_STORED)]))
    expect(entries.map((e) => e.path)).toEqual(['.orivon-share.json', 'a.txt', 'dir/b.bin', 'ünï.txt'])
    expect(await textOf(entries[0]!.file)).toBe('{"x":1}')
    expect(await textOf(entries[1]!.file)).toBe('hello\n')
    expect(await read(entries[2]!.file)).toEqual(Uint8Array.from({ length: 256 }, (_, i) => i))
    expect(await textOf(entries[3]!.file)).toBe('utf8\n')
  })

  it('refuses a compressed archive', async () => {
    await expect(readZip(new Blob([fromBase64(PYTHON_DEFLATED)]))).rejects.toThrow('compressed')
  })

  /** Changes bytes of the archive at the given places. */
  function patched (changes: [number, number[]][], base = PYTHON_STORED) {
    const archive = fromBase64(base)
    for (const [at, values] of changes) archive.set(values, at)
    return new Blob([archive])
  }
  function central (archive: Uint8Array) {
    const view = new DataView(archive.buffer)
    return view.getUint32(archive.length - 22 + 16, true)
  }

  it('refuses an encrypted entry, a data descriptor and ZIP64', async () => {
    const start = central(fromBase64(PYTHON_STORED))
    await expect(readZip(patched([[start + 8, [1, 0]]]))).rejects.toThrow('encrypted')
    await expect(readZip(patched([[start + 8, [8, 0]]]))).rejects.toThrow('encrypted')
    await expect(readZip(patched([[start + 6, [45, 0]]]))).rejects.toThrow('ZIP64')
    await expect(readZip(patched([[start + 20, [255, 255, 255, 255]]]))).rejects.toThrow('ZIP64')
    const archive = fromBase64(PYTHON_STORED)
    const end = archive.length - 22
    await expect(readZip(patched([[end + 10, [255, 255]], [end + 8, [255, 255]]]))).rejects.toThrow('ZIP64')
  })

  it('refuses a comment, trailing data, a split archive and data before the first file', async () => {
    const archive = fromBase64(PYTHON_STORED)
    await expect(readZip(new Blob([archive, new Uint8Array(4)]))).rejects.toThrow('comment or data after')
    await expect(readZip(new Blob([new Uint8Array(4), archive]))).rejects.toThrow(ZipError)
    const end = archive.length - 22
    await expect(readZip(patched([[end + 4, [1, 0]]]))).rejects.toThrow('split')
    await expect(readZip(new Blob([new Uint8Array(10)]))).rejects.toThrow('not a ZIP')
    await expect(readZip(new Blob([]))).rejects.toThrow('not a ZIP')
  })

  it('refuses a file whose bytes were changed', async () => {
    const archive = fromBase64(PYTHON_STORED)
    const at = archive.indexOf(bytes('hello')[0]!, 80)
    await expect(readZip(patched([[at, [0x48]]]))).rejects.toThrow('checksum')
  })

  it('refuses names that leave the folder, in the central directory and in the local header', async () => {
    const archive = fromBase64(PYTHON_STORED)
    const start = central(archive)
    // "a.txt" in the central directory becomes "../x" + one more letter: same length, so offsets hold.
    const name = bytes('a.txt')
    const place = (from: number) => {
      for (let i = from; i < archive.length - name.length; i++) if (name.every((b, k) => archive[i + k] === b)) return i
      return -1
    }
    const centralAt = place(start)
    expect(centralAt).toBeGreaterThan(start)
    for (const bad of ['../xx', '/etc/', 'a\\b.t', 'a\u0000b.t']) {
      await expect(readZip(patched([[centralAt, [...bytes(bad)]]])), JSON.stringify(bad)).rejects.toThrow(ZipError)
    }
    // Only the local header says something else than the directory.
    const localAt = place(0)
    await expect(readZip(patched([[localAt, [...bytes('b.txt')]]]))).rejects.toThrow('does not match')
  })

  it('refuses a name in an encoding it does not read: letters beyond ASCII without the UTF-8 flag', async () => {
    const archive = await read(await writeZip([{ name: 'ü.txt', file: blob('abc') }]))
    expect((await readZip(new Blob([archive]))).map((e) => e.path)).toEqual(['ü.txt'])
    const unflagged = archive.slice()
    const view = new DataView(unflagged.buffer)
    view.setUint16(6, 0, true)
    view.setUint16(central(unflagged) + 8, 0, true)
    await expect(readZip(new Blob([unflagged]))).rejects.toThrow('encoding Share does not read')
    const invalid = archive.slice()
    invalid[30] = 0xff
    invalid[central(invalid) + 46] = 0xff
    await expect(readZip(new Blob([invalid]))).rejects.toThrow('not valid UTF-8')
  })

  it('refuses a layout the writer never makes', async () => {
    const archive = fromBase64(PYTHON_STORED)
    const start = central(archive)
    // Move the second entry's recorded offset forward: a gap before it.
    const view = new DataView(archive.buffer.slice(0))
    const second = start + 46 + 18
    view.setUint32(second + 42, view.getUint32(second + 42, true) + 1, true)
    await expect(readZip(new Blob([view.buffer]))).rejects.toThrow(ZipError)
  })

  it('caps the entries and the bytes it will read', async () => {
    const archive = new Blob([fromBase64(PYTHON_STORED)])
    await expect(readZip(archive, { maxEntries: 2 })).rejects.toThrow('more than 2')
    await expect(readZip(archive, { maxBytes: 100 })).rejects.toThrow('larger than Share opens')
  })

  it('refuses the same name twice', async () => {
    const a = await writeZip([{ name: 'a', file: blob('1') }, { name: 'b', file: blob('2') }])
    const raw = await read(a)
    const at = raw.lastIndexOf(98)
    expect(raw[at]).toBe(98)
    // The central directory's "b" becomes "a", which the local header does not match either; the duplicate is named first.
    const copy = raw.slice()
    copy[at] = 97
    await expect(readZip(new Blob([copy]))).rejects.toThrow('twice')
  })

  it('holds with the python3 reference when it is there', () => {
    const python = spawnSync('python3', ['-I', '-c', 'print(1)'], { encoding: 'utf8' })
    if (python.error !== undefined) return
    const dir = mkdtempSync(join(tmpdir(), 'share-zip-ref-'))
    try {
      const path = join(dir, 'ref.zip')
      writeFileSync(path, fromBase64(PYTHON_STORED))
      const listing = execFileSync('python3', ['-I', '-c', 'import sys, zipfile\nprint(zipfile.ZipFile(sys.argv[1]).testzip())', path], { encoding: 'utf8' })
      expect(listing.trim(), 'the embedded fixture is a valid archive').toBe('None')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
