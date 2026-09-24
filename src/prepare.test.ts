import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declareBundle } from './declare.ts'
import { injectBridge, injectHint, prepareApp } from './prepare.ts'
import { parseRecipe } from './recipe.ts'
import type { RecipeDirs } from './recipe.ts'

const HREF = '.well-known/orivon.json'
const MANIFEST = '{"id":"demo","entry":"index.html"}'

describe('injectHint', () => {
  it('puts the hint inside head', () => {
    expect(injectHint('<html><head><title>x</title></head><body></body></html>', HREF))
      .toContain('<link rel="orivon-manifest" href=".well-known/orivon.json">\n</head>')
  })

  it('falls back to the top of a document with no head', () => {
    expect(injectHint('<body>x</body>', HREF).startsWith('<link rel="orivon-manifest"')).toBe(true)
  })

  // A `<head>` tag is OPTIONAL in HTML, and html-webpack-plugin's
  // `minify.removeOptionalTags` drops it. Prepending then moved the hint in
  // front of the doctype, and a doctype that is not first is quirks mode --
  // a port whose layout is quietly wrong, with nothing logged anywhere.
  it('keeps the doctype first when the document has no head tag', () => {
    const html = injectHint('<!doctype html><html><body>x</body></html>', HREF)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('rel="orivon-manifest"')
  })

  // Only the MISSING-tag case is this function's problem: `</head>` is present
  // in a document whose opening tag carries attributes, so the hint already
  // lands correctly there.
  it('still lands inside a head whose opening tag carries attributes', () => {
    const html = injectHint('<!doctype html><html><head lang="en"><title>x</title></head><body></body></html>', HREF)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('rel="orivon-manifest"')
    expect(html.indexOf('orivon-manifest')).toBeLessThan(html.indexOf('</head>'))
  })

  it('is idempotent, so re-preparing does not stack hints', () => {
    const once = injectHint('<head></head>', HREF)
    expect(injectHint(once, HREF)).toBe(once)
  })
})

describe('injectBridge', () => {
  // The app's own bundle calls bridge members at module top level, so anything
  // later than "first script in head" is too late.
  it('puts the bridge before every other script in head', () => {
    const html = injectBridge('<head>\n<script src="app.js"></script>\n</head>', 'orivon/b.js')
    expect(html.indexOf('orivon/b.js')).toBeLessThan(html.indexOf('app.js'))
  })

  it('puts the bridge inside a head whose opening tag carries attributes', () => {
    const html = injectBridge('<!doctype html><html><head lang="en">\n<script src="app.js"></script>\n</head>', 'orivon/b.js')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.indexOf('orivon/b.js')).toBeLessThan(html.indexOf('app.js'))
  })

  it('keeps the doctype first when the document has no head tag', () => {
    const html = injectBridge('<!doctype html><html><body><script src="app.js"></script></body></html>', 'orivon/b.js')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.indexOf('orivon/b.js')).toBeLessThan(html.indexOf('app.js'))
  })

  // `<header>` starts with `<head`. Matching it would put the bridge inside
  // the body, AFTER the app's own bundle -- which still runs, so nothing
  // errors, and the app fails with `undefined is not a function` deep inside
  // somebody else's code instead.
  it('is not fooled by a <header> element in the body', () => {
    const html = injectBridge('<!doctype html><html><body><header>x</header><script src="app.js"></script></body></html>', 'orivon/b.js')
    expect(html).not.toContain('<header>\n    <script src="orivon/b.js">')
    expect(html.indexOf('orivon/b.js')).toBeLessThan(html.indexOf('<header>'))
  })

  it('is idempotent', () => {
    const once = injectBridge('<head></head>', 'orivon/b.js')
    expect(injectBridge(once, 'orivon/b.js')).toBe(once)
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
    await writeFile(join(dirs.recipe, 'orivon.json'), MANIFEST)
    await writeFile(join(dirs.recipe, 'bridge', 'b.js'), 'window.demo = {}')
  })
  afterEach(async () => { await rm(base, { recursive: true, force: true }) })

  const read = async (...parts: string[]): Promise<string> => readFile(join(dirs.static, ...parts), 'utf8')
  const manifest = async (): Promise<unknown> => JSON.parse(await read('.well-known', 'orivon.json'))

  it('copies the build verbatim and adds the manifest at .well-known', async () => {
    await prepareApp(recipeFor(), dirs)
    expect(await read('js', 'app.js')).toBe('console.log(1)')
    expect(await manifest()).toEqual({ id: 'demo', entry: 'index.html', assets: ['js/app.js'] })
    expect(await read('index.html')).toContain('rel="orivon-manifest"')
  })

  // Declared last, so the bridge and the injected entry document are in the
  // hash as served, and a check straight after finds nothing to change.
  it('declares the finished tree: every file an asset or the entry, and a ddoc over them', async () => {
    await prepareApp(recipeFor({ bridge: { file: 'bridge/b.js' } }), dirs)
    expect(await manifest()).toEqual({ id: 'demo', entry: 'index.html', assets: ['js/app.js', 'orivon/b.js'] })
    const ddoc = JSON.parse(await read('.well-known', 'orivon-ddoc.json')) as { leaves: Record<string, string> }
    expect(Object.keys(ddoc.leaves)).toEqual(['/.well-known/orivon.json', '/index.html', '/js/app.js', '/orivon/b.js'])
    await expect(declareBundle(dirs.static, { check: true })).resolves.toMatchObject({ files: 4 })
  })

  it('copies the bridge under orivon/ and injects it first', async () => {
    await prepareApp(recipeFor({ bridge: { file: 'bridge/b.js' } }), dirs)
    expect(await read('orivon', 'b.js')).toBe('window.demo = {}')
    const html = await read('index.html')
    expect(html.indexOf('orivon/b.js')).toBeLessThan(html.indexOf('js/app.js'))
  })

  it('omits the bridge entirely when the recipe declares none', async () => {
    await prepareApp(recipeFor(), dirs)
    expect(await read('index.html')).not.toContain('orivon/')
  })

  // A root-absolute URL leaves the mount point behind, so the tree stops
  // working the moment it is served from anywhere but a host's root -- an
  // IPFS path gateway's /ipfs/<cid>/ being the case that matters.
  it('writes no root-absolute URL of its own into the document', async () => {
    await prepareApp(recipeFor({ bridge: { file: 'bridge/b.js' } }), dirs)
    const html = await read('index.html')
    expect(html).toContain('href=".well-known/orivon.json"')
    expect(html).toContain('src="orivon/b.js"')
  })

  // The entry need not sit at the root of the build, and both injected URLs
  // are relative to it, not to the tree.
  it('walks back up to the root when the entry is nested', async () => {
    await mkdir(join(dirs.source, 'dist', 'pages'), { recursive: true })
    await writeFile(join(dirs.source, 'dist', 'pages', 'app.html'), '<head></head>')
    await prepareApp(recipeFor({ entry: 'pages/app.html', bridge: { file: 'bridge/b.js' } }), dirs)
    const html = await read('pages', 'app.html')
    expect(html).toContain('href="../.well-known/orivon.json"')
    expect(html).toContain('src="../orivon/b.js"')
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

  it('serves a site from the app directory, with the manifest and hint added', async () => {
    await mkdir(join(dirs.recipe, 'site'), { recursive: true })
    await writeFile(join(dirs.recipe, 'site', 'index.html'), '<!doctype html><html><head><title>s</title></head><body></body></html>')
    await writeFile(join(dirs.recipe, 'site', 'app.js'), 'site()')
    const site = parseRecipe({ id: 'demo', name: 'Demo', port: 8890, site: 'site', manifest: 'orivon.json' }, 'recipe.json')
    await prepareApp(site, dirs)
    expect(await read('app.js')).toBe('site()')
    expect(await manifest()).toEqual({ id: 'demo', entry: 'index.html', assets: ['app.js'] })
    expect(await read('index.html')).toContain('rel="orivon-manifest"')
    await expect(readFile(join(dirs.recipe, 'site', 'index.html'), 'utf8')).resolves.not.toContain('orivon-manifest')
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
