import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchApp } from './fetch.ts'
import { isSite, parseRecipe } from './recipe.ts'
import { resolveRef, withRefOverride } from './ref-override.ts'
import { selectApps } from './selection.ts'
import type { PortRecipe } from './recipe.ts'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim()

let base: string
let upstream: string
let first: string
let second: string
let recipe: PortRecipe

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'orivon-ref-'))
  upstream = join(base, 'upstream')
  await mkdir(upstream)
  git(upstream, 'init', '-q')
  await writeFile(join(upstream, 'version.txt'), 'one\n')
  git(upstream, 'add', '.')
  git(upstream, 'commit', '-q', '-m', 'one')
  first = git(upstream, 'rev-parse', 'HEAD')
  git(upstream, 'tag', 'v1')
  await writeFile(join(upstream, 'version.txt'), 'two\n')
  git(upstream, 'commit', '-q', '-am', 'two')
  second = git(upstream, 'rev-parse', 'HEAD')
  git(upstream, 'tag', '-a', 'v2', '-m', 'release two')
  const parsed = parseRecipe({
    id: 'demo', name: 'Demo', port: 8890, manifest: 'orivon.json',
    upstream: { repo: 'https://example.com/x.git', ref: first, licence: 'MIT' },
    build: { command: 'true', output: 'dist' }
  }, 'recipe.json')
  if (isSite(parsed)) throw new Error('a port')
  recipe = { ...parsed, upstream: { ...parsed.upstream, repo: upstream } }
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

describe('resolveRef', () => {
  it('takes a full sha as it is, without asking the remote', async () => {
    const never = async (): Promise<string> => { throw new Error('asked') }
    expect(await resolveRef('r', second.toUpperCase(), never)).toBe(second)
  })

  it('resolves a lightweight tag and peels an annotated one to its commit', async () => {
    expect(await resolveRef(upstream, 'v1')).toBe(first)
    expect(git(upstream, 'rev-parse', 'v2')).not.toBe(second)
    expect(await resolveRef(upstream, 'v2')).toBe(second)
  })

  it('refuses a branch name, an abbreviated sha and a flag-shaped value', async () => {
    const branch = git(upstream, 'rev-parse', '--abbrev-ref', 'HEAD')
    await expect(resolveRef(upstream, branch)).rejects.toThrow(/no such tag/)
    await expect(resolveRef(upstream, first.slice(0, 8))).rejects.toThrow(/no such tag/)
    await expect(resolveRef(upstream, '--upload-pack=x')).rejects.toThrow(/neither a full/)
  })
})

describe('--ref', () => {
  it('builds from the named commit while the recipe still pins another', async () => {
    const moved = await withRefOverride(recipe, 'v2')
    expect(moved.upstream.ref).toBe(second)
    expect(recipe.upstream.ref).toBe(first)
    const dirs = { recipe: join(base, 'recipe'), source: join(base, 'out', 'demo', 'source'), static: join(base, 'out', 'demo', 'static') }
    await fetchApp(moved, dirs)
    expect(git(dirs.source, 'rev-parse', 'HEAD')).toBe(second)
    expect(git(dirs.source, 'show', 'HEAD:version.txt')).toBe('two')
  })

  it('refuses an app written here, which has no upstream', async () => {
    const site = parseRecipe({ id: 'demo', name: 'Demo', port: 8890, site: 'site', manifest: 'orivon.json' }, 'recipe.json')
    await expect(withRefOverride(site, 'v1')).rejects.toThrow(/no upstream ref/)
  })

  it('is a flag with a value, so its value is never taken for an app id', () => {
    expect(selectApps(['build', 'demo', '--ref', 'v2'], ['demo'])).toEqual(['demo'])
  })
})
