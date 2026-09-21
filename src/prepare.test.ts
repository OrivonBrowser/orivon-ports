import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { injectBridge, injectHint, prepareApp } from './prepare.ts'
import { parseRecipe } from './recipe.ts'
import type { RecipeDirs } from './recipe.ts'

describe('injectHint', () => {
  it('puts the hint inside head', () => {
    expect(injectHint('<html><head><title>x</title></head><body></body></html>'))
      .toContain('<link rel="orivon-manifest" href="/.well-known/orivon.json">\n</head>')
  })

  it('falls back to the top of a document with no head', () => {
    expect(injectHint('<body>x</body>').startsWith('<link rel="orivon-manifest"')).toBe(true)
  })

  it('is idempotent, so re-preparing does not stack hints', () => {
    const once = injectHint('<head></head>')
    expect(injectHint(once)).toBe(once)
  })
})

describe('injectBridge', () => {
  // The app's own bundle calls bridge members at module top level, so anything
  // later than "first script in head" is too late.
  it('puts the bridge before every other script in head', () => {
    const html = injectBridge('<head>\n<script src="/app.js"></script>\n</head>', '/orivon/b.js')
    expect(html.indexOf('/orivon/b.js')).toBeLessThan(html.indexOf('/app.js'))
  })

  it('is idempotent', () => {
    const once = injectBridge('<head></head>', '/orivon/b.js')
    expect(injectBridge(once, '/orivon/b.js')).toBe(once)
  })
})

describe('prepareApp', () => {
  let base: string
  let dirs: RecipeDirs

  const recipeFor = (extra: Record<string, unknown> = {}): ReturnType<typeof parseRecipe> => parseRecipe({
    id: 'demo',
    name: 'Demo',
    port: 8890,
    upstream: { repo: 'https://example.com/x.git', ref: 'a'.repeat(40), licence: 'MIT' },
    build: { command: 'true', output: 'dist' },
    manifest: 'orivon.json',
    ...extra
  }, 'recipe.json')

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'orivon-prepare-'))
    dirs = { recipe: join(base, 'recipe'), source: join(base, 'source'), static: join(base, 'static') }
    await mkdir(join(dirs.source, 'dist', 'js'), { recursive: true })
    await mkdir(join(dirs.recipe, 'bridge'), { recursive: true })
    await writeFile(join(dirs.source, 'dist', 'index.html'), '<html><head><script src="/js/app.js"></script></head><body></body></html>')
    await writeFile(join(dirs.source, 'dist', 'js', 'app.js'), 'console.log(1)')
    await writeFile(join(dirs.recipe, 'orivon.json'), '{"id":"demo"}')
    await writeFile(join(dirs.recipe, 'bridge', 'b.js'), 'window.demo = {}')
  })
  afterEach(async () => { await rm(base, { recursive: true, force: true }) })

  const read = async (...parts: string[]): Promise<string> => readFile(join(dirs.static, ...parts), 'utf8')

  it('copies the build verbatim and adds the manifest at .well-known', async () => {
    await prepareApp(recipeFor(), dirs)
    expect(await read('js', 'app.js')).toBe('console.log(1)')
    expect(await read('.well-known', 'orivon.json')).toBe('{"id":"demo"}')
    expect(await read('index.html')).toContain('rel="orivon-manifest"')
  })

  it('copies the bridge under /orivon/ and injects it first', async () => {
    await prepareApp(recipeFor({ bridge: { file: 'bridge/b.js' } }), dirs)
    expect(await read('orivon', 'b.js')).toBe('window.demo = {}')
    const html = await read('index.html')
    expect(html.indexOf('/orivon/b.js')).toBeLessThan(html.indexOf('/js/app.js'))
  })

  it('omits the bridge entirely when the recipe declares none', async () => {
    await prepareApp(recipeFor(), dirs)
    expect(await read('index.html')).not.toContain('/orivon/')
  })

  it('runs a hook transform before the hint is injected', async () => {
    await writeFile(join(dirs.recipe, 'hooks.mjs'),
      'export function transformHtml (html) { return html.replace("</body>", "<iframe id=\\"sig\\"></iframe></body>") }')
    await prepareApp(recipeFor({ hooks: 'hooks.mjs' }), dirs)
    const html = await read('index.html')
    expect(html).toContain('id="sig"')
    expect(html).toContain('rel="orivon-manifest"')
  })

  it('copies extraFiles from the source tree', async () => {
    await writeFile(join(dirs.source, 'dist', 'guard.js'), 'guard')
    await prepareApp(recipeFor({ extraFiles: [{ from: 'dist/guard.js', to: 'orivon/guard.js' }] }), dirs)
    expect(await read('orivon', 'guard.js')).toBe('guard')
  })

  // Re-preparing must not leave an asset from the previous build behind: a
  // stale file that nothing regenerates is served as if it were current.
  it('clears the previous static tree', async () => {
    await prepareApp(recipeFor(), dirs)
    await writeFile(join(dirs.static, 'stale.js'), 'old')
    await prepareApp(recipeFor(), dirs)
    await expect(read('stale.js')).rejects.toThrow()
  })
})
