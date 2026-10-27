import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'

const system = fs as unknown as { readdirSync: unknown }
const original = system.readdirSync

afterEach(() => {
  system.readdirSync = original
  vi.resetModules()
})

describe('sorted-readdir', () => {
  // NTFS lists a directory without regard to case; the stand-in gives that order.
  it('lists a directory in byte order whatever order the system gave', async () => {
    system.readdirSync = () => ['alltiddlers.template.html.tid', 'MOTW.html.tid', 'Zed.tid', 'beta.tid']
    await import('../build/sorted-readdir.mjs')
    expect(fs.readdirSync('anywhere')).toEqual(['MOTW.html.tid', 'Zed.tid', 'alltiddlers.template.html.tid', 'beta.tid'])
  })

  it('sorts directory entries by name too, and leaves anything else alone', async () => {
    system.readdirSync = (_path: string, options?: { withFileTypes?: boolean }) => options?.withFileTypes === true ? [{ name: 'b' }, { name: 'B' }, { name: 'a' }] : 'not a list'
    await import('../build/sorted-readdir.mjs')
    const entries = fs.readdirSync('anywhere', { withFileTypes: true }) as unknown as Array<{ name: string }>
    expect(entries.map((entry) => entry.name)).toEqual(['B', 'a', 'b'])
    expect(fs.readdirSync('anywhere')).toBe('not a list')
  })

  it('leaves the order alone on a real directory, which Linux and macOS already list by bytes', async () => {
    await import('../build/sorted-readdir.mjs')
    const names = fs.readdirSync(new URL('.', import.meta.url))
    expect(names).toEqual([...names].sort())
  })
})
