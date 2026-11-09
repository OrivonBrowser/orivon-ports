// The service worker kit's gates, each handed the manifest shape or clone that must be refused: a quiet
// pass here is a timestamp left to the clock, which makes every rebuild of a pin other bytes.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commitTimeMs, pinNgswTimestamp, withTimestamp } from './ngsw-kit.mjs'

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
