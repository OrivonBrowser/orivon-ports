import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APPS_DIR } from './paths.ts'
import { MANIFEST, WEBSITE_MANIFEST } from './declare.ts'
import { isTracked, portsCommit, preparedAtAnotherCommit, withSource } from './provenance.ts'

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

describe('preparedAtAnotherCommit', () => {
  const OTHER = 'd'.repeat(40)
  const tracked = join(APPS_DIR, 'demo')
  let base: string
  let checkout: string
  let tree: string
  let head: string

  async function prepared (manifestFile: string, source?: unknown): Promise<void> {
    await rm(tree, { recursive: true, force: true })
    await mkdir(join(tree, '.well-known'), { recursive: true })
    await writeFile(join(tree, manifestFile), JSON.stringify({ id: 'demo', entry: 'index.html', ...source === undefined ? {} : { source } }))
  }

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'orivon-prepared-'))
    checkout = join(base, 'checkout')
    tree = join(base, 'static')
    await mkdir(checkout)
    git(checkout, 'init', '-q')
    await writeFile(join(checkout, 'a.txt'), 'a\n')
    git(checkout, 'add', '.')
    git(checkout, 'commit', '-q', '-m', 'one')
    head = git(checkout, 'rev-parse', 'HEAD')
  })
  afterEach(async () => { await rm(base, { recursive: true, force: true }) })

  it('is true for a tree whose manifest names no commit while the checkout is at one: the branch build a merge then moved', async () => {
    await prepared(MANIFEST)
    expect(await preparedAtAnotherCommit(tracked, tree, checkout)).toBe(true)
  })

  it('is true for a tree whose manifest names a commit other than the checkout\'s', async () => {
    await prepared(MANIFEST, { portsCommit: OTHER })
    expect(await preparedAtAnotherCommit(tracked, tree, checkout)).toBe(true)
  })

  it('is false once the manifest names the commit the checkout is at', async () => {
    await prepared(MANIFEST, { portsCommit: head })
    expect(await preparedAtAnotherCommit(tracked, tree, checkout)).toBe(false)
  })

  it('is true when the checkout is not at a commit but the manifest names one, and false when it names none', async () => {
    await writeFile(join(checkout, 'a.txt'), 'edited\n')
    await prepared(MANIFEST, { portsCommit: head })
    expect(await preparedAtAnotherCommit(tracked, tree, checkout)).toBe(true)
    await prepared(MANIFEST)
    expect(await preparedAtAnotherCommit(tracked, tree, checkout)).toBe(false)
  })

  it('reads a website\'s manifest too', async () => {
    await prepared(WEBSITE_MANIFEST, { portsCommit: head })
    expect(await preparedAtAnotherCommit(tracked, tree, checkout)).toBe(false)
    await prepared(WEBSITE_MANIFEST)
    expect(await preparedAtAnotherCommit(tracked, tree, checkout)).toBe(true)
  })

  it('is true for a tree with no manifest, which prepare would have written', async () => {
    expect(await preparedAtAnotherCommit(tracked, tree, checkout)).toBe(true)
  })

  it('is false for an app kept outside apps/, which prepare writes no commit for', async () => {
    await prepared(MANIFEST)
    expect(await preparedAtAnotherCommit(join(tmpdir(), 'elsewhere', 'demo'), tree, checkout)).toBe(false)
  })
})
