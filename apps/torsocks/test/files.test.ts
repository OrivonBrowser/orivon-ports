import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planFiles, planPicture, planWebsite } from '../page/src/core/publication.js'
import { retried, writePublication } from '../page/src/core/files.js'

/**
 * `window.orivon.fs` with the members a page's handle has in Orivon and no
 * others: a call to anything else fails here as it fails in the browser.
 */
function fakeFs (options: { failWriteAt?: number, limitedCalls?: number } = {}): { files: Map<string, Uint8Array>, removed: string[], fs: unknown } {
  const files = new Map<string, Uint8Array>()
  const removed: string[] = []
  const put = (path: string, position: number, data: Uint8Array): void => {
    const before = files.get(path) ?? new Uint8Array(0)
    const after = new Uint8Array(Math.max(before.length, position + data.length))
    after.set(before)
    after.set(data, position)
    files.set(path, after)
  }
  // The first `limitedCalls` path calls are refused by the per-app limiter, as Orivon refuses a burst.
  let limited = options.limitedCalls ?? 0
  const limiter = (): void => { if (limited-- > 0) throw Object.assign(new Error('this origin is calling too frequently; wait and retry'), { code: 'limit' }) }
  const fs = {
    mkdir: async () => { limiter() },
    writeFile: async (path: string, data: Uint8Array) => { files.set(path, new Uint8Array(data)) },
    readFile: async (path: string) => files.get(path) ?? new Uint8Array(0),
    rename: async (from: string, to: string) => { files.set(to, files.get(from) ?? new Uint8Array(0)); files.delete(from) },
    rm: async (path: string) => {
      removed.push(path)
      for (const name of [...files.keys()]) if (name.startsWith(`${path}/`)) files.delete(name)
    },
    open: async (path: string) => {
      limiter()
      files.set(path, new Uint8Array(0))
      return Object.freeze({
        id: 'h', name: path.slice(path.lastIndexOf('/') + 1),
        // A short write: at most 300 KiB a call, as a real one may.
        write: async ({ position, data }: { position: number, data: Uint8Array }) => {
          if (options.failWriteAt !== undefined && position >= options.failWriteAt) throw Object.assign(new Error('over the quota'), { code: 'limit' })
          const count = Math.min(data.length, 300 * 1024)
          put(path, position, data.subarray(0, count))
          return count
        },
        read: async () => new Uint8Array(0),
        stat: async () => ({ size: files.get(path)?.length ?? 0, isFile: true, isDirectory: false, mtimeMs: 0 }),
        truncate: async () => {},
        sync: async () => {},
        close: async () => {}
      })
    }
  }
  return { files, removed, fs }
}

const bytes = (size: number): Uint8Array => {
  const made = new Uint8Array(size)
  for (let i = 0; i < size; i++) made[i] = (i * 7) % 251
  return made
}
/** Byte-equal, compared as Buffers: a deep `toEqual` over megabytes is slow. */
const same = (a: Uint8Array | undefined, b: Uint8Array): boolean => a !== undefined && Buffer.from(a).equals(Buffer.from(b))
const picked = (name: string, data: Uint8Array, relativePath = ''): File => {
  const made = new File([data], name)
  if (relativePath !== '') Object.defineProperty(made, 'webkitRelativePath', { value: relativePath })
  return made
}

let installed: ReturnType<typeof fakeFs>
const install = (made: ReturnType<typeof fakeFs>): void => {
  installed = made
  ;(globalThis as { window?: unknown }).window = { orivon: { fs: made.fs } }
}
beforeEach(() => { install(fakeFs()) })
afterEach(() => { delete (globalThis as { window?: unknown }).window })

describe('writePublication', () => {
  it('writes a picked picture whole, larger than one write and with short writes, and reports every byte', async () => {
    const data = bytes(2.5 * 1024 * 1024)
    const plan = planPicture({ title: 'A picture', note: '', files: [picked('shot.png', data)] })
    let reported = 0
    await writePublication('aaaaaaaaaaaa', plan, (done: number) => { reported = done })
    const written = [...installed.files.entries()].find(([path]) => path.endsWith('.png'))
    expect(same(written?.[1], data)).toBe(true)
    expect(reported).toBe(plan.entries.reduce((sum: number, entry: { size: number }) => sum + entry.size, 0))
    expect(installed.files.has('torsocks/sites/aaaaaaaaaaaa/site.json')).toBe(true)
  })

  it('writes several files and a website folder at their paths', async () => {
    const one = bytes(10)
    const two = bytes(1024 * 1024 + 1)
    await writePublication('bbbbbbbbbbbb', planFiles({ title: 'Files', note: '', files: [picked('one.txt', one), picked('two.bin', two)] }))
    const paths = [...installed.files.keys()]
    expect(installed.files.get(paths.find((path) => path.endsWith('/one.txt')) ?? '')).toEqual(one)
    expect(same(installed.files.get(paths.find((path) => path.endsWith('/two.bin')) ?? ''), two)).toBe(true)

    const page = new TextEncoder().encode('<!doctype html><title>site</title>')
    const style = bytes(2048)
    await writePublication('cccccccccccc', planWebsite({ title: 'Site', files: [picked('index.html', page, 'site/index.html'), picked('a.css', style, 'site/css/a.css')] }))
    expect(installed.files.get('torsocks/sites/cccccccccccc/www/index.html')).toEqual(page)
    expect(installed.files.get('torsocks/sites/cccccccccccc/www/css/a.css')).toEqual(style)
  })

  it('asks again while Orivon refuses a burst of calls, and publishes whole', async () => {
    install(fakeFs({ limitedCalls: 4 }))
    const data = bytes(10_000)
    await writePublication('eeeeeeeeeeee', planPicture({ title: 'Busy', note: '', files: [picked('busy.png', data)] }))
    const written = [...installed.files.entries()].find(([path]) => path.endsWith('.png'))
    expect(same(written?.[1], data)).toBe(true)
  })

  it('leaves nothing of a publication whose write is refused, and says why', async () => {
    install(fakeFs({ failWriteAt: 1024 * 1024 }))
    const plan = planPicture({ title: 'Too big', note: '', files: [picked('big.png', bytes(3 * 1024 * 1024))] })
    await expect(writePublication('dddddddddddd', plan)).rejects.toThrow('over the quota')
    expect(installed.removed).toContain('torsocks/sites/dddddddddddd')
  })
})

describe('retried', () => {
  const limit = (): Error => Object.assign(new Error('busy'), { code: 'limit' })
  const noPause = async (): Promise<void> => {}

  it('gives any other error back at once', async () => {
    let calls = 0
    await expect(retried(async () => { calls++; throw Object.assign(new Error('gone'), { code: 'notFound' }) }, noPause)).rejects.toThrow('gone')
    expect(calls).toBe(1)
  })

  it('gives the refusal back once its pauses are spent', async () => {
    let calls = 0
    await expect(retried(async () => { calls++; throw limit() }, noPause)).rejects.toThrow('busy')
    expect(calls).toBe(14)
  })
})
