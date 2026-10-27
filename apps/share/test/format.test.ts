import { describe, expect, it } from 'vitest'
import { baseName, count, fileNameFor, formatAgo, formatBytes, formatDay, hostOf, nameOfEntries, shortCid, topFolder } from '../page/src/format.js'

describe('formatBytes', () => {
  it('reads sizes as a file manager does, in binary units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(50 * 1024)).toBe('50 KB')
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 MB')
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB')
    expect(formatBytes(40 * 1024 ** 3)).toBe('40.0 GB')
  })
})

describe('count', () => {
  it('says one or many', () => {
    expect(count(1, 'file')).toBe('1 file')
    expect(count(3, 'file')).toBe('3 files')
    expect(count(2, 'person', 'people')).toBe('2 people')
  })
})

describe('formatAgo', () => {
  const now = Date.UTC(2026, 9, 26, 12, 0, 0)
  it('counts back from now, then gives a date', () => {
    expect(formatAgo(now - 10_000, now)).toBe('just now')
    expect(formatAgo(now - 60_000, now)).toBe('1 minute ago')
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5 minutes ago')
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3 hours ago')
    expect(formatAgo(now - 24 * 3_600_000, now)).toBe('yesterday')
    expect(formatAgo(now - 3 * 24 * 3_600_000, now)).toBe('3 days ago')
    expect(formatAgo(now - 30 * 24 * 3_600_000, now)).toBe(formatDay(now - 30 * 24 * 3_600_000))
  })
})

describe('names', () => {
  it('shortens an address to something two can be told apart by', () => {
    expect(shortCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe('bafybeigdy…5fbzdi')
    expect(shortCid('short')).toBe('short')
  })

  it('takes the last segment of a path and the host of an address', () => {
    expect(baseName('a/b/c.txt')).toBe('c.txt')
    expect(baseName('c.txt')).toBe('c.txt')
    expect(hostOf('http://127.0.0.1:5001/api')).toBe('127.0.0.1:5001')
    expect(hostOf('not an address')).toBe('not an address')
  })

  it('makes a file name from a title, or uses the fallback', () => {
    expect(fileNameFor('Holiday photos 2026!', 'share')).toBe('holiday-photos-2026')
    expect(fileNameFor('???', 'share')).toBe('share')
    expect(fileNameFor('é à ü', 'share')).toBe('e-a-u')
    expect(fileNameFor('x'.repeat(100), 'share')).toHaveLength(60)
  })
})

describe('topFolder and nameOfEntries', () => {
  const entry = (path: string) => ({ path })
  it('finds the folder every path starts in', () => {
    expect(topFolder([entry('site/index.html'), entry('site/a/b.css')])).toBe('site')
    expect(topFolder([entry('a/x'), entry('b/y')])).toBeNull()
    expect(topFolder([entry('index.html')])).toBeNull()
    expect(topFolder([])).toBeNull()
  })

  it('names a share by what it holds when nobody titled it', () => {
    expect(nameOfEntries([entry('notes.txt')], 'files')).toBe('notes.txt')
    expect(nameOfEntries([entry('a'), entry('b'), entry('c')], 'files')).toBe('Shared files')
    expect(nameOfEntries([entry('Holiday/a.jpg'), entry('Holiday/b.jpg')], 'folder')).toBe('Holiday')
    expect(nameOfEntries([entry('a'), entry('b/c')], 'folder')).toBe('Shared folder')
    expect(nameOfEntries([entry('index.html')], 'website')).toBe('Website')
    expect(nameOfEntries([entry('mysite/index.html')], 'website')).toBe('mysite')
  })

  it('does not repeat in the title what the line under it says', () => {
    for (const names of [['a', 'b'], ['a', 'b', 'c', 'd']]) expect(nameOfEntries(names.map(entry), 'files')).not.toMatch(/\d+ files?/)
  })

  it('names a website by its own title first, then its folder, then "Website"', () => {
    expect(nameOfEntries([entry('mysite/index.html')], 'website', 'Holiday photos')).toBe('Holiday photos')
    expect(nameOfEntries([entry('index.html')], 'website', 'Holiday photos')).toBe('Holiday photos')
    expect(nameOfEntries([entry('index.html')], 'website', '')).toBe('Website')
  })
})
