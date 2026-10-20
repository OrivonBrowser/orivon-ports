import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from './build.ts'
import { isSite, parseRecipe } from './recipe.ts'
import type { PortRecipe, RecipeDirs } from './recipe.ts'

let base: string
let dirs: RecipeDirs

function recipeFor (build: Record<string, unknown>, extra: Record<string, unknown> = {}): PortRecipe {
  const recipe = parseRecipe({
    id: 'demo',
    name: 'Demo',
    port: 8890,
    upstream: { repo: 'https://example.com/x.git', ref: 'a'.repeat(40), licence: 'MIT' },
    build,
    manifest: 'orivon.json',
    ...extra
  }, 'recipe.json')
  if (isSite(recipe)) throw new Error('the test recipe is a port')
  return recipe
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'orivon-build-'))
  dirs = { recipe: join(base, 'recipe'), source: join(base, 'app', 'source'), static: join(base, 'app', 'static') }
  await mkdir(join(dirs.source, 'dist'), { recursive: true })
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

describe('buildApp', () => {
  // Whatever sits in the output directory is copied into the published tree,
  // so a file a previous build wrote there would be published with this one.
  it('starts from an empty output directory, so a file an earlier build left is not published', async () => {
    await writeFile(join(dirs.source, 'dist', 'stale.css'), 'old')
    await writeFile(join(dirs.source, 'dist', 'index.html'), 'old')
    await buildApp(recipeFor({ command: "mkdir -p dist && echo '<html></html>' > dist/index.html", output: 'dist' }), dirs)
    await expect(stat(join(dirs.source, 'dist', 'stale.css'))).rejects.toThrow(/ENOENT/)
    expect(await readFile(join(dirs.source, 'dist', 'index.html'), 'utf8')).toBe('<html></html>\n')
  })

  it('clears the output before the install, which may write there too', async () => {
    await writeFile(join(dirs.source, 'dist', 'stale.css'), 'old')
    await buildApp(recipeFor(
      { command: 'test ! -e dist/stale.css && mkdir -p dist && echo ok > dist/index.html', output: 'dist' },
      { install: 'test ! -e dist/stale.css' }
    ), dirs)
    expect(await readFile(join(dirs.source, 'dist', 'index.html'), 'utf8')).toBe('ok\n')
  })

  it('does not touch the rest of the source tree', async () => {
    await writeFile(join(dirs.source, 'keep.txt'), 'kept')
    await buildApp(recipeFor({ command: 'mkdir -p dist && echo x > dist/index.html', output: 'dist' }), dirs)
    expect(await readFile(join(dirs.source, 'keep.txt'), 'utf8')).toBe('kept')
  })

  it('still refuses a build that writes no entry document', async () => {
    await expect(buildApp(recipeFor({ command: 'true', output: 'dist' }), dirs)).rejects.toThrow(/produced no index\.html/)
  })
})
