import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchApp } from './fetch.ts'
import { isSite, parseRecipe } from './recipe.ts'
import type { PortRecipe, RecipeDirs } from './recipe.ts'

let base: string
let dirs: RecipeDirs
let recipe: PortRecipe

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com'
}

function git (cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
}

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'orivon-fetch-'))
  const upstream = join(base, 'upstream')
  await mkdir(upstream)
  git(upstream, 'init', '-q')
  await writeFile(join(upstream, '.gitignore'), 'node_modules\ndist\n')
  await writeFile(join(upstream, 'tracked.txt'), 'pinned\n')
  git(upstream, 'add', '.')
  git(upstream, 'commit', '-q', '-m', 'one')
  const ref = git(upstream, 'rev-parse', 'HEAD')

  const parsed = parseRecipe({
    id: 'demo',
    name: 'Demo',
    port: 8890,
    upstream: { repo: 'https://example.com/x.git', ref, licence: 'MIT' },
    build: { command: 'true', output: 'dist' },
    manifest: 'orivon.json'
  }, 'recipe.json')
  if (isSite(parsed)) throw new Error('the test recipe is a port')
  // A local path stands in for the remote; the recipe parser accepts only https.
  recipe = { ...parsed, upstream: { ...parsed.upstream, repo: upstream } }
  dirs = { recipe: join(base, 'recipe'), source: join(base, 'out', 'demo', 'source'), static: join(base, 'out', 'demo', 'static') }
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

describe('fetchApp', () => {
  it('checks the pinned commit out', async () => {
    await fetchApp(recipe, dirs)
    expect(git(dirs.source, 'rev-parse', 'HEAD')).toBe(recipe.upstream.ref)
    expect(await readFile(join(dirs.source, 'tracked.txt'), 'utf8')).toBe('pinned\n')
  })

  // Git for Windows converts line endings on checkout unless told not to, and a tree that embeds source text
  // then differs from the one every other host builds. The host's config here asks for the conversion.
  it('checks text files out with the line endings they were committed with, whatever the host git config says', async () => {
    const config = join(base, 'host-gitconfig')
    await writeFile(config, '[core]\n\tautocrlf = true\n\teol = crlf\n')
    const saved = { global: process.env['GIT_CONFIG_GLOBAL'], system: process.env['GIT_CONFIG_NOSYSTEM'] }
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    process.env['GIT_CONFIG_GLOBAL'] = config
    process.env['GIT_CONFIG_NOSYSTEM'] = '1'
    try {
      await fetchApp(recipe, dirs)
    } finally {
      restore('GIT_CONFIG_GLOBAL', saved.global)
      restore('GIT_CONFIG_NOSYSTEM', saved.system)
    }
    expect(await readFile(join(dirs.source, 'tracked.txt'), 'utf8')).toBe('pinned\n')
  })

  // A forced fetch of a tree that was built before: the earlier build's
  // output, an untracked file and an ignored install must not survive into
  // the next build, or the published tree depends on what ran here before.
  it('removes untracked and ignored files a previous build left, and restores tracked ones', async () => {
    await fetchApp(recipe, dirs)
    await mkdir(join(dirs.source, 'dist'), { recursive: true })
    await mkdir(join(dirs.source, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(dirs.source, 'dist', 'leftover.css'), 'x')
    await writeFile(join(dirs.source, 'node_modules', 'dep', 'index.js'), 'x')
    await writeFile(join(dirs.source, 'untracked.txt'), 'x')
    await writeFile(join(dirs.source, 'tracked.txt'), 'edited\n')

    await fetchApp(recipe, dirs, { force: true })

    expect(await exists(join(dirs.source, 'dist'))).toBe(false)
    expect(await exists(join(dirs.source, 'node_modules'))).toBe(false)
    expect(await exists(join(dirs.source, 'untracked.txt'))).toBe(false)
    expect(await readFile(join(dirs.source, 'tracked.txt'), 'utf8')).toBe('pinned\n')
    expect(git(dirs.source, 'status', '--porcelain', '--ignored')).toBe('')
  })
})
