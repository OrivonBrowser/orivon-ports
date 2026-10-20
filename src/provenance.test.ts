import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APPS_DIR } from './paths.ts'
import { isTracked, portsCommit, withSource } from './provenance.ts'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim()

describe('portsCommit', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orivon-commit-'))
    git(root, 'init', '-q')
    await writeFile(join(root, '.gitignore'), 'out/\n')
    await writeFile(join(root, 'a.txt'), 'a\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'one')
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('names the commit a clean checkout is at, whatever the ignored build output holds', async () => {
    await mkdir(join(root, 'out'))
    await writeFile(join(root, 'out', 'built.js'), 'ignored build output')
    expect(await portsCommit(root)).toBe(git(root, 'rev-parse', 'HEAD'))
  })

  it('names nothing once a file changed or appeared, since the tree is then not that commit', async () => {
    await writeFile(join(root, 'a.txt'), 'edited\n')
    expect(await portsCommit(root)).toBeUndefined()
    git(root, 'checkout', '--', 'a.txt')
    await writeFile(join(root, 'new.txt'), 'x\n')
    expect(await portsCommit(root)).toBeUndefined()
  })

  it('names nothing outside a git checkout', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'orivon-nogit-'))
    try {
      expect(await portsCommit(plain)).toBeUndefined()
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })
})

describe('isTracked', () => {
  it('is true for an app directory under apps/ and false for one kept elsewhere', () => {
    expect(isTracked(join(APPS_DIR, 'freetube'))).toBe(true)
    expect(isTracked(join(tmpdir(), 'elsewhere', 'freetube'))).toBe(false)
  })
})

describe('withSource', () => {
  const COMMIT = 'c'.repeat(40)

  it('adds source.portsCommit after the other keys, formatted as the manifest is written', () => {
    expect(withSource('{"id":"demo","entry":"index.html"}', COMMIT)).toBe(`{\n  "id": "demo",\n  "entry": "index.html",\n  "source": {\n    "portsCommit": "${COMMIT}"\n  }\n}\n`)
  })

  it('replaces a source the file already had', () => {
    const text = JSON.parse(withSource('{"source":{"portsCommit":"old","x":1},"id":"demo"}', COMMIT)) as { source: unknown }
    expect(text.source).toEqual({ portsCommit: COMMIT })
  })

  it('returns the text unchanged with no commit, or when it is not a JSON object', () => {
    expect(withSource('{"id":"demo"}', undefined)).toBe('{"id":"demo"}')
    expect(withSource('not json', COMMIT)).toBe('not json')
    expect(withSource('[1]', COMMIT)).toBe('[1]')
  })
})
