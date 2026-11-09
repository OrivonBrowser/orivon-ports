// The service worker kit's gates, each handed the manifest shape or clone that must be refused: a quiet
// pass here is a timestamp left to the clock, which makes every rebuild of a pin other bytes, or a hash left
// stale, which makes the worker refuse the app and never start it offline.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commitTimeMs, PORT_GROUP, pinNgswTimestamp, refreshNgswHashes, sha1Hex, withTimestamp } from './ngsw-kit.mjs'

const COMMITTED_AT = '2026-03-04T05:06:07Z'
const COMMITTED_AT_MS = Date.parse(COMMITTED_AT)

const manifest = (timestamp: number, appData = '{"version":"1.2.3"}'): string => [
  '{',
  '  "configVersion": 1,',
  `  "timestamp": ${String(timestamp)},`,
  `  "appData": ${appData},`,
  '  "index": "/index.html",',
  '  "hashTable": {',
  '    "/index.html": "5ba3c7f0c86a3d0a5c1f22d2e2f4a7a3b0f4a111"',
  '  }',
  '}'
].join('\n')

function clone (): string {
  const dir = mkdtempSync(join(tmpdir(), 'ngsw-kit-'))
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_COMMITTER_DATE: COMMITTED_AT
  }
  writeFileSync(join(dir, 'file'), 'x')
  for (const args of [['init', '-q'], ['add', 'file'], ['commit', '-q', '-m', 'pin']]) execFileSync('git', args, { cwd: dir, env })
  return dir
}

function output (dir: string, text: string): void {
  mkdirSync(join(dir, 'dist', 'browser'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'browser', 'ngsw.json'), text)
}

describe('commitTimeMs', () => {
  it('is the committer date of the checked-out commit, not its author date', () => {
    expect(commitTimeMs(clone())).toBe(COMMITTED_AT_MS)
  })

  it('refuses a directory that is not a clone', () => {
    expect(() => commitTimeMs(mkdtempSync(join(tmpdir(), 'ngsw-kit-bare-')))).toThrow(/not a git repository/)
  })

  it('refuses a folder inside another repository, whose date is not the clone\'s', () => {
    const inside = join(clone(), 'nested')
    mkdirSync(inside)
    expect(() => commitTimeMs(inside)).toThrow(/inside a repository/)
  })
})

describe('withTimestamp', () => {
  it('changes the timestamp and not one other byte', () => {
    const before = manifest(1_700_000_000_000)
    expect(withTimestamp(before, 42)).toBe(manifest(42))
  })

  it('gives two builds made at different times the same manifest', () => {
    expect(withTimestamp(manifest(1_700_000_000_000), 42)).toBe(withTimestamp(manifest(1_800_000_000_000), 42))
  })

  it('leaves a manifest already at the timestamp as it is', () => {
    expect(withTimestamp(manifest(42), 42)).toBe(manifest(42))
  })

  it('refuses text that is not JSON', () => {
    expect(() => withTimestamp('<html>', 42)).toThrow(/not JSON/)
  })

  it('refuses a manifest with no numeric timestamp', () => {
    expect(() => withTimestamp('{"configVersion":1}', 42)).toThrow(/no numeric timestamp/)
    expect(() => withTimestamp('{"timestamp":"1700000000000"}', 42)).toThrow(/no numeric timestamp/)
  })

  it('refuses a manifest that names the timestamp in two places', () => {
    expect(() => withTimestamp(manifest(1_700_000_000_000, '{"timestamp":1700000000000}'), 42)).toThrow(/2 places/)
  })

  it('edits the top-level field when an appData holds a timestamp of its own', () => {
    expect(withTimestamp(manifest(1_700_000_000_000, '{"timestamp":7}'), 42)).toBe(manifest(42, '{"timestamp":7}'))
  })
})

describe('pinNgswTimestamp', () => {
  it('writes the pinned commit date into the build output, the same for two builds made at different times', async () => {
    const [first, second] = [clone(), clone()]
    output(first, manifest(1_700_000_000_000))
    output(second, manifest(1_800_000_000_000))
    expect(await pinNgswTimestamp('dist/browser', { cwd: first })).toBe(COMMITTED_AT_MS)
    await pinNgswTimestamp('dist/browser', { cwd: second })
    const read = (dir: string): string => readFileSync(join(dir, 'dist', 'browser', 'ngsw.json'), 'utf8')
    expect(read(first)).toBe(manifest(COMMITTED_AT_MS))
    expect(read(second)).toBe(read(first))
  })

  it('says so when the build wrote no manifest, so a step whose service worker is gone is not left behind', async () => {
    const dir = clone()
    mkdirSync(join(dir, 'dist', 'browser'), { recursive: true })
    await expect(pinNgswTimestamp('dist/browser', { cwd: dir })).rejects.toThrow(/does not exist.*drop this build\.also step/s)
  })

  it('needs the output directory', async () => {
    await expect(pinNgswTimestamp(undefined as unknown as string, { cwd: clone() })).rejects.toThrow(/needs the build output directory/)
  })
})

const ABC_SHA1 = 'a9993e364706816aba3e25717850c26c9cd0d89d'
const STALE = 'c874aae271a41943afebbefc7b29bea2f3a28bce'

interface Manifest { hashTable: Record<string, string>, assetGroups: Array<{ name: string, installMode: string, updateMode: string, urls: string[], patterns: string[] }> }

/** A prepared tree: the files, and an `ngsw.json` that names each of them with the hash it is given (their own by default) in one prefetch group. */
function tree (files: Record<string, string>, hashes: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ngsw-tree-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  const table = Object.fromEntries(Object.keys(files).map((name) => [`/${name}`, hashes[`/${name}`] ?? sha1Hex(files[name]!)]))
  writeManifest(dir, { configVersion: 1, timestamp: 42, index: '/index.html', assetGroups: [{ name: 'app', installMode: 'prefetch', updateMode: 'prefetch', cacheQueryOptions: { ignoreVary: true }, urls: Object.keys(table), patterns: [] }], hashTable: table })
  return dir
}

const writeManifest = (dir: string, manifest: unknown): void => { writeFileSync(join(dir, 'ngsw.json'), JSON.stringify(manifest, null, 2)) }
const read = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, 'ngsw.json'), 'utf8')) as Manifest
const add = (dir: string, name: string, text: string): void => { mkdirSync(join(dir, name, '..'), { recursive: true }); writeFileSync(join(dir, name), text) }

describe('sha1Hex', () => {
  it('is the lower-case hex sha1 the worker compares with', () => {
    expect(sha1Hex(Buffer.from('abc'))).toBe(ABC_SHA1)
    expect(sha1Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(ABC_SHA1)
  })
})

describe('refreshNgswHashes: the hashes', () => {
  it('rewrites the hash of a file the port edited after the build, and leaves the others and every other field alone', async () => {
    const dir = tree({ 'index.html': '<html>as built</html>', 'main.js': 'main', 'orivon/bridge.js': 'bridge' })
    const before = read(dir)
    writeFileSync(join(dir, 'index.html'), "<html>as built, plus the port's tags</html>")
    expect(await refreshNgswHashes(dir)).toEqual({ rehashed: ['/index.html'], cached: [] })
    const after = read(dir)
    expect(after.hashTable['/index.html']).toBe(sha1Hex(Buffer.from("<html>as built, plus the port's tags</html>")))
    expect({ ...after.hashTable, '/index.html': '' }).toEqual({ ...before.hashTable, '/index.html': '' })
    expect({ ...after, hashTable: {} }).toEqual({ ...before, hashTable: {} })
  })

  it('keeps the builder\'s own formatting: two-space JSON, and the same bytes where nothing changed', async () => {
    const dir = tree({ 'index.html': 'one', 'main.js': 'two' }, { '/index.html': STALE })
    const before = readFileSync(join(dir, 'ngsw.json'), 'utf8')
    await refreshNgswHashes(dir)
    expect(readFileSync(join(dir, 'ngsw.json'), 'utf8')).toBe(before.replace(STALE, sha1Hex(Buffer.from('one'))))
  })

  it('has nothing to change on a second run, and does not touch the file', async () => {
    const dir = tree({ 'index.html': 'one', 'main.js': 'two' }, { '/index.html': STALE })
    await refreshNgswHashes(dir)
    const once = readFileSync(join(dir, 'ngsw.json'), 'utf8')
    expect(await refreshNgswHashes(dir)).toEqual({ rehashed: [], cached: [] })
    expect(readFileSync(join(dir, 'ngsw.json'), 'utf8')).toBe(once)
  })

  it('compares bytes, so a binary file is hashed as it is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ngsw-bin-'))
    const bytes = Buffer.from([0, 255, 128, 10, 13, 0xef, 0xbb, 0xbf])
    writeFileSync(join(dir, 'icon.png'), bytes)
    writeManifest(dir, { assetGroups: [], hashTable: { '/icon.png': STALE } })
    await refreshNgswHashes(dir)
    expect(read(dir).hashTable['/icon.png']).toBe(sha1Hex(bytes))
  })

  it('refuses a tree with no manifest, so a hook whose service worker is gone is not left behind', async () => {
    await expect(refreshNgswHashes(mkdtempSync(join(tmpdir(), 'ngsw-none-')))).rejects.toThrow(/does not exist.*drop the hook/s)
  })

  it('refuses a manifest that is not JSON, or has no hash table or no asset groups', async () => {
    const dir = tree({ 'index.html': 'x' })
    writeFileSync(join(dir, 'ngsw.json'), '<html>')
    await expect(refreshNgswHashes(dir)).rejects.toThrow(/not JSON/)
    writeManifest(dir, { assetGroups: [] })
    await expect(refreshNgswHashes(dir)).rejects.toThrow(/no hashTable/)
    writeManifest(dir, { assetGroups: [], hashTable: [] })
    await expect(refreshNgswHashes(dir)).rejects.toThrow(/no hashTable/)
    writeManifest(dir, { hashTable: {} })
    await expect(refreshNgswHashes(dir)).rejects.toThrow(/no assetGroups/)
  })

  it('refuses a table that lists a file the tree does not hold, because the worker would refuse that version too', async () => {
    const dir = tree({ 'index.html': 'x' })
    writeManifest(dir, { assetGroups: [], hashTable: { '/index.html': STALE, '/gone.js': STALE } })
    await expect(refreshNgswHashes(dir)).rejects.toThrow(/lists \/gone\.js but the tree holds no such file/)
  })

  it('refuses a key that is not a path from the site root, or that leaves the tree', async () => {
    const dir = tree({ 'index.html': 'x' })
    writeManifest(dir, { assetGroups: [], hashTable: { 'index.html': STALE } })
    await expect(refreshNgswHashes(dir)).rejects.toThrow(/not a path from the site root/)
    writeManifest(dir, { assetGroups: [], hashTable: { '/../outside.js': STALE } })
    await expect(refreshNgswHashes(dir)).rejects.toThrow(/leaves the served tree/)
  })
})

describe('refreshNgswHashes: the files the port adds', () => {
  it('puts every file of a folder the builder did not list into the table and one prefetch group', async () => {
    const dir = tree({ 'index.html': 'page', 'main.js': 'main' })
    add(dir, 'orivon/b.js', 'bridge')
    add(dir, 'orivon/hint/hint.js', 'hint')
    expect(await refreshNgswHashes(dir, { cacheFolders: ['orivon'] })).toEqual({ rehashed: [], cached: ['/orivon/b.js', '/orivon/hint/hint.js'] })
    const after = read(dir)
    expect(after.hashTable['/orivon/b.js']).toBe(sha1Hex(Buffer.from('bridge')))
    expect(after.hashTable['/orivon/hint/hint.js']).toBe(sha1Hex(Buffer.from('hint')))
    expect(after.assetGroups.map((group) => group.name)).toEqual([PORT_GROUP, 'app'])
    expect(after.assetGroups[0]).toMatchObject({ installMode: 'prefetch', updateMode: 'prefetch', urls: ['/orivon/b.js', '/orivon/hint/hint.js'], patterns: [] })
    expect(after.assetGroups[1]!.urls).toEqual(['/index.html', '/main.js'])
  })

  it('names a file once: the builder\'s own groups keep a file they already list, and a second run adds nothing', async () => {
    const dir = tree({ 'index.html': 'page', 'orivon/own.js': 'listed by the builder' })
    add(dir, 'orivon/b.js', 'bridge')
    expect((await refreshNgswHashes(dir, { cacheFolders: ['orivon'] })).cached).toEqual(['/orivon/b.js'])
    const once = readFileSync(join(dir, 'ngsw.json'), 'utf8')
    expect(await refreshNgswHashes(dir, { cacheFolders: ['orivon'] })).toEqual({ rehashed: [], cached: [] })
    expect(readFileSync(join(dir, 'ngsw.json'), 'utf8')).toBe(once)
    expect(read(dir).assetGroups[0]!.urls).toEqual(['/orivon/b.js'])
  })

  it('does its work in a fixed order, so the manifest is the same bytes however the folder was filled', async () => {
    const [first, second] = [tree({ 'index.html': 'page' }), tree({ 'index.html': 'page' })]
    for (const name of ['z.js', 'a.js', 'hint/m.js']) add(first, `orivon/${name}`, name)
    for (const name of ['hint/m.js', 'a.js', 'z.js']) add(second, `orivon/${name}`, name)
    await refreshNgswHashes(first, { cacheFolders: ['orivon'] })
    await refreshNgswHashes(second, { cacheFolders: ['orivon'] })
    expect(readFileSync(join(first, 'ngsw.json'), 'utf8')).toBe(readFileSync(join(second, 'ngsw.json'), 'utf8'))
  })

  it('refuses a folder the tree does not have', async () => {
    await expect(refreshNgswHashes(tree({ 'index.html': 'page' }), { cacheFolders: ['orivon'] })).rejects.toThrow(/no folder orivon/)
  })
})
