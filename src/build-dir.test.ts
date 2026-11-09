import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from './build.ts'
import { builtHere, claimBuildRoot, lockBuildDir, markBuilt } from './build-dir.ts'
import { BUILD_DIR_ENV, sourceDir } from './paths.ts'
import { isSite, parseRecipe } from './recipe.ts'
import type { PortRecipe, RecipeDirs } from './recipe.ts'
import { readState } from './state.ts'

let base: string
const posix = process.platform === 'win32' ? it.skip : it

beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'orivon-build-dir-')) })
afterEach(async () => {
  delete process.env[BUILD_DIR_ENV]
  await rm(base, { recursive: true, force: true })
})

describe('claimBuildRoot', () => {
  it('makes the folder private to this user', async () => {
    const root = join(base, 'deep', 'builds')
    expect(await claimBuildRoot(root)).toBe(root)
    expect((await stat(root)).isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect((await stat(root)).mode & 0o077).toBe(0)
  })

  it('takes a folder that is already there', async () => {
    const root = join(base, 'builds')
    await mkdir(root)
    await expect(claimBuildRoot(root)).resolves.toBe(root)
  })

  // The clone inside is cleaned with git clean -ffdx, so a link planted in /tmp must never be followed.
  posix('refuses a link, which another user could point at a folder of theirs to clean', async () => {
    const target = join(base, 'target')
    await mkdir(target)
    await symlink(target, join(base, 'builds'))
    await expect(claimBuildRoot(join(base, 'builds'))).rejects.toThrow(/is a link/)
  })

  posix('refuses a folder that belongs to another user', async () => {
    const root = join(base, 'builds')
    await mkdir(root)
    const mine = process.getuid?.() ?? 0
    await expect(claimBuildRoot(root, mine + 1)).rejects.toThrow(/belongs to another user/)
  })

  it('refuses a file', async () => {
    await writeFile(join(base, 'builds'), 'x')
    await expect(claimBuildRoot(join(base, 'builds'))).rejects.toThrow(/not a folder/)
  })
})

describe('lockBuildDir', () => {
  it('holds an app\'s folder against a second run, from this checkout or any other', async () => {
    process.env[BUILD_DIR_ENV] = join(base, 'builds')
    const release = await lockBuildDir('demo')
    await expect(lockBuildDir('demo')).rejects.toThrow(/locked by process/)
    await release()
    await (await lockBuildDir('demo'))()
  })

  it('lets two apps build at once', async () => {
    process.env[BUILD_DIR_ENV] = join(base, 'builds')
    const first = await lockBuildDir('one')
    const second = await lockBuildDir('two')
    await first()
    await second()
  })
})

describe('builtHere', () => {
  it('holds only for the build whose stamp the clone carries', async () => {
    const folder = join(base, 'demo')
    await mkdir(folder)
    expect(await builtHere(folder, '2026-01-01T00:00:00.000Z')).toBe(false)
    await markBuilt(folder, '2026-01-01T00:00:00.000Z')
    expect(await builtHere(folder, '2026-01-01T00:00:00.000Z')).toBe(true)
    expect(await builtHere(folder, '2026-01-02T00:00:00.000Z')).toBe(false)
    expect(await builtHere(folder, undefined)).toBe(false)
  })
})

describe('a build in the build folder', () => {
  function recipeFor (): PortRecipe {
    const recipe = parseRecipe({
      id: 'demo',
      name: 'Demo',
      port: 8890,
      upstream: { repo: 'https://example.com/x.git', ref: 'a'.repeat(40), licence: 'MIT' },
      // What a bundler does with the folder it runs in: writes it into its output.
      build: { command: 'mkdir -p dist && pwd > dist/index.html', output: 'dist' },
      manifest: 'orivon.json'
    }, 'recipe.json')
    if (isSite(recipe)) throw new Error('the test recipe is a port')
    return recipe
  }

  async function checkout (name: string): Promise<RecipeDirs> {
    process.env[BUILD_DIR_ENV] = join(base, 'builds')
    const source = sourceDir('demo')
    await mkdir(source, { recursive: true })
    return { recipe: join(base, name, 'apps', 'demo'), source, static: join(base, name, 'out', 'demo', 'static') }
  }

  it('writes the same bytes from two checkouts, because the folder it runs in is the same', async () => {
    const first = await checkout('checkout-a')
    await buildApp(recipeFor(), first)
    const one = await readFile(join(first.source, 'dist', 'index.html'), 'utf8')
    const second = await checkout('a-much-longer-checkout-name')
    await buildApp(recipeFor(), second)
    expect(await readFile(join(second.source, 'dist', 'index.html'), 'utf8')).toBe(one)
    expect(one).not.toContain('checkout')
  })

  it('records the build beside the built tree in the checkout, and its stamp beside the clone', async () => {
    const dirs = await checkout('checkout-a')
    await buildApp(recipeFor(), dirs)
    const state = await readState(join(dirs.static, '..'))
    expect(state.builtFromRef).toBe('a'.repeat(40))
    expect(await builtHere(join(dirs.source, '..'), state.builtAt)).toBe(true)
  })

  it('stops holding a build when another checkout builds in the same folder', async () => {
    const mine = await checkout('checkout-a')
    await buildApp(recipeFor(), mine)
    const recorded = (await readState(join(mine.static, '..'))).builtAt
    await new Promise((resolve) => setTimeout(resolve, 5))
    await buildApp(recipeFor(), await checkout('checkout-b'))
    expect(await builtHere(join(mine.source, '..'), recorded)).toBe(false)
  })
})
