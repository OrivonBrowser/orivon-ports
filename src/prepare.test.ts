import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declareBundle } from './declare.ts'
import { injectBridge, injectHint, injectIcon, injectOrivonHint, prepareApp } from './prepare.ts'
import { parseRecipe } from './recipe.ts'
import { portProblemUrl } from './report-url.ts'
import type { RecipeDirs } from './recipe.ts'

const HREF = '.well-known/orivon.json'
/** The attribute the hint tag carries for the report link: the form address for the app "Demo", escaped as an attribute. */
const REPORT = ` data-report-url="${portProblemUrl('Demo').replaceAll('&', '&amp;')}"`
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

describe('injectIcon', () => {
  const HREF_ICON = 'orivon/demo-icon.png'
  const LINK = '<link rel="icon" type="image/png" href="orivon/demo-icon.png">'

  it('adds the link before the end of head when the page names none', () => {
    expect(injectIcon('<html><head><title>x</title></head><body></body></html>', HREF_ICON, 'image/png'))
      .toBe(`<html><head><title>x</title>  ${LINK}\n</head><body></body></html>`)
  })

  it('keeps the doctype first when the document has no head tag', () => {
    const html = injectIcon('<!doctype html><html><body>x</body></html>', HREF_ICON, 'image/png')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain(LINK)
  })

  // A page that names a root-absolute `/favicon.ico` the build never emitted
  // (and that escapes a gateway's mount) must end up with the recipe's icon
  // only: two icon links is a browser choosing between them.
  it('replaces the link the page has, in its place, whatever order its attributes come in', () => {
    const html = injectIcon('<head>\n    <meta charset="utf-8" />\n    <link href="/favicon.ico" rel="icon" />\n    <title>x</title>\n</head>', HREF_ICON, 'image/png')
    expect(html).toBe(`<head>\n    <meta charset="utf-8" />\n    ${LINK}\n    <title>x</title>\n</head>`)
  })

  it('treats a shortcut icon as an icon, and a touch icon or a data attribute as something else', () => {
    expect(injectIcon('<head><link rel="shortcut icon" href="a.ico"></head>', HREF_ICON, 'image/png')).toBe(`<head>${LINK}</head>`)
    const other = '<head><link rel="apple-touch-icon" href="t.png"><link data-rel="icon" href="d.png"><link rel="stylesheet" href="s.css"></head>'
    expect(injectIcon(other, HREF_ICON, 'image/png')).toBe(other.replace('</head>', `  ${LINK}\n</head>`))
  })

  it('leaves exactly one icon link when the page names several', () => {
    const html = injectIcon('<head>\n  <link rel="icon" href="a.png">\n  <link rel="icon" href="b.png" sizes="32x32">\n</head>', HREF_ICON, 'image/png')
    expect(html).toBe(`<head>\n  ${LINK}\n</head>`)
  })

  it('is not fooled by a ">" inside an attribute value', () => {
    const html = injectIcon('<head><link title="a>b" rel="icon" href="a.png"></head>', HREF_ICON, 'image/png')
    expect(html).toBe(`<head>${LINK}</head>`)
  })

  it('is idempotent, so re-preparing does not stack links', () => {
    const once = injectIcon('<head></head>', HREF_ICON, 'image/png')
    expect(injectIcon(once, HREF_ICON, 'image/png')).toBe(once)
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

describe('injectOrivonHint', () => {
  const SRC = 'orivon/hint/hint.js'
  const plain = { id: 'demo', name: 'Demo' }
  const tier2 = { ...plain, eth: 'demo.orivonstack.eth', hint: { tier: 2 as const, name: 'Demo', officialUrl: 'https://demo.example/get?a=1&b="2"' } }

  it('puts a deferred script before </head> for a tier 1 app, and for one with no hint field', () => {
    expect(injectOrivonHint('<html><head><title>x</title></head><body></body></html>', SRC, plain))
      .toContain(`<script src="orivon/hint/hint.js" data-tier="1" data-app="demo" data-name="Demo"${REPORT} defer></script>\n</head>`)
  })

  it('puts a tier 2 script first in head, synchronous, carrying the app\'s data escaped', () => {
    const html = injectOrivonHint('<html><head lang="en"><meta charset="utf-8"><title>x</title></head><body></body></html>', SRC, tier2)
    expect(html).toContain(`<head lang="en">\n    <script src="orivon/hint/hint.js" data-tier="2" data-app="demo" data-name="Demo" data-eth="demo.orivonstack.eth" data-official-url="https://demo.example/get?a=1&amp;b=&quot;2&quot;"${REPORT}></script><meta charset`)
    expect(html).not.toContain('defer')
  })

  it('goes in front of a bridge injected before it', () => {
    const html = injectOrivonHint(injectBridge('<head></head>', 'orivon/b.js'), SRC, tier2)
    expect(html.indexOf('hint/hint.js')).toBeLessThan(html.indexOf('orivon/b.js'))
  })

  it('keeps the doctype first when the document has no head tag', () => {
    for (const recipe of [plain, tier2]) {
      const html = injectOrivonHint('<!doctype html><html><body>x</body></html>', SRC, recipe)
      expect(html.startsWith('<!doctype html>')).toBe(true)
      expect(html).toContain('src="orivon/hint/hint.js"')
    }
  })

  it('is idempotent', () => {
    for (const recipe of [plain, tier2]) {
      const once = injectOrivonHint('<head></head>', SRC, recipe)
      expect(injectOrivonHint(once, SRC, recipe)).toBe(once)
    }
  })
})

// A relative URL written ahead of `<base>` resolves against the document, so a
// reload of `/tabs/a` under `<base href="/">` would ask for `/tabs/orivon/...`.
describe('injected URLs and <base>', () => {
  const SRC = 'orivon/hint/hint.js'
  const tier2 = { id: 'demo', name: 'Demo', hint: { tier: 2 as const, name: 'Demo' } }
  const tier1 = { id: 'demo', name: 'Demo' }
  const page = (base: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>x</title>${base}<script src="app.js"></script></head><body></body></html>`

  it.each([['<base href="/">'], ['<base href="./">'], ["<base href='/' target=_top>"], ['<BASE\n  HREF=/ >']])('puts a tier 2 hint right after %j, ahead of the app\'s scripts', (base) => {
    const html = injectOrivonHint(page(base), SRC, tier2)
    expect(html.indexOf(base)).toBeGreaterThan(-1)
    expect(html.indexOf(base) + base.length).toBe(html.indexOf('\n    <script src="orivon/hint/hint.js"'))
    expect(html.indexOf('hint/hint.js')).toBeLessThan(html.indexOf('app.js'))
  })

  it('keeps the tier 2 hint ahead of a bridge that is injected before it, both after the base', () => {
    const html = injectOrivonHint(injectBridge(page('<base href="/">'), 'orivon/b.js'), SRC, tier2)
    const order = [html.indexOf('<base'), html.indexOf('hint/hint.js'), html.indexOf('orivon/b.js'), html.indexOf('app.js')]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order[0]).toBeGreaterThan(-1)
  })

  it('puts the bridge after the base too', () => {
    const html = injectBridge(page('<base href="/">'), 'orivon/b.js')
    expect(html).toContain('<base href="/">\n    <script src="orivon/b.js"></script>')
  })

  it('leaves a page with no base exactly as before: first in head', () => {
    const html = injectOrivonHint(page(''), SRC, tier2)
    expect(html).toContain('<head>\n    <script src="orivon/hint/hint.js"')
  })

  it('ignores a base that has no href, one in a comment, and one in a script\'s text', () => {
    for (const base of ['<base target="_blank">', '<!-- <base href="/"> -->', '<script>var s = \'<base href="/">\'</script>']) {
      expect(injectOrivonHint(page(base), SRC, tier2)).toContain('<head>\n    <script src="orivon/hint/hint.js"')
    }
  })

  it('writes the URL the base would have given when the page has a script ahead of its base', () => {
    const early = '<head><meta charset="utf-8"><script src="early.js"></script><base href="/"><script src="app.js"></script></head>'
    const html = injectOrivonHint(early, SRC, tier2)
    expect(html).toContain('<head>\n    <script src="/orivon/hint/hint.js"')
    expect(injectBridge(early, 'orivon/b.js')).toContain('<script src="/orivon/b.js"></script>')
    expect(injectBridge(early.replace('"/"', '"/app/"'), 'orivon/b.js')).toContain('<script src="/app/orivon/b.js"></script>')
    expect(injectBridge(early.replace('"/"', '"./"'), 'orivon/b.js')).toContain('<script src="orivon/b.js"></script>')
    expect(injectOrivonHint(html, SRC, tier2)).toBe(html)
  })

  it('refuses a base it cannot reproduce ahead of a script, by name', () => {
    expect(() => injectBridge('<head><script src="a.js"></script><base href="https://cdn.example/"></head>', 'orivon/b.js')).toThrow(/cdn\.example/)
  })

  it('puts the deferred tier 1 hint, the manifest hint and the icon before </head>, after the base', () => {
    const html = injectIcon(injectHint(injectOrivonHint(page('<base href="/">'), SRC, tier1), HREF), 'icon.png', 'image/png')
    for (const needle of ['hint/hint.js', 'orivon-manifest', 'rel="icon"']) expect(html.indexOf(needle)).toBeGreaterThan(html.indexOf('<base'))
  })

  it('puts them after the base when a page has no </head>', () => {
    const html = injectHint('<html><base href="/"><body>x</body></html>', HREF)
    expect(html.indexOf('orivon-manifest')).toBeGreaterThan(html.indexOf('<base'))
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
  const SUPPORT = { issues: portProblemUrl('Demo') }

  it('copies the build verbatim and adds the manifest at .well-known', async () => {
    await prepareApp(recipeFor(), dirs, { orivonHint: false })
    expect(await read('js', 'app.js')).toBe('console.log(1)')
    expect(await manifest()).toEqual({ id: 'demo', entry: 'index.html', support: SUPPORT, assets: ['js/app.js'] })
    expect(await read('index.html')).toContain('rel="orivon-manifest"')
  })

  // Declared last, so the bridge and the injected entry document are in the
  // hash as served, and a check straight after finds nothing to change.
  it('declares the finished tree: every file an asset or the entry, and a ddoc over them', async () => {
    await prepareApp(recipeFor({ bridge: { file: 'bridge/b.js' } }), dirs)
    const hint = ['orivon/hint/hint.css', 'orivon/hint/hint.js', 'orivon/hint/logo.png']
    expect(await manifest()).toEqual({ id: 'demo', entry: 'index.html', support: SUPPORT, assets: ['js/app.js', 'orivon/b.js', ...hint] })
    const ddoc = JSON.parse(await read('.well-known', 'orivon-ddoc.json')) as { leaves: Record<string, string> }
    expect(Object.keys(ddoc.leaves)).toEqual(['/.well-known/orivon.json', '/index.html', '/js/app.js', '/orivon/b.js', ...hint.map((path) => `/${path}`)])
    await expect(declareBundle(dirs.static, { check: true })).resolves.toMatchObject({ files: 7 })
  })

  it('copies the bridge under orivon/ and injects it first', async () => {
    await prepareApp(recipeFor({ bridge: { file: 'bridge/b.js' } }), dirs)
    expect(await read('orivon', 'b.js')).toBe('window.demo = {}')
    const html = await read('index.html')
    expect(html.indexOf('orivon/b.js')).toBeLessThan(html.indexOf('js/app.js'))
  })

  it('omits the bridge entirely when the recipe declares none', async () => {
    await prepareApp(recipeFor(), dirs, { orivonHint: false })
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

  describe('the recipe icon', () => {
    const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

    beforeEach(async () => {
      await mkdir(join(dirs.source, 'resources'), { recursive: true })
      await writeFile(join(dirs.source, 'resources', 'mark.png'), PNG)
    })

    it('copies the clone\'s file to orivon/<id>-icon, names it from the entry document, and declares it', async () => {
      await prepareApp(recipeFor({ icon: 'resources/mark.png' }), dirs, { orivonHint: false })
      expect(await readFile(join(dirs.static, 'orivon', 'demo-icon.png'))).toEqual(PNG)
      expect(await read('index.html')).toContain('<link rel="icon" type="image/png" href="orivon/demo-icon.png">')
      expect((await manifest() as { assets: string[] }).assets).toContain('orivon/demo-icon.png')
    })

    it('replaces an icon link the build wrote, and does not run twice', async () => {
      await writeFile(join(dirs.source, 'dist', 'index.html'), '<html><head><link rel="icon" href="/favicon.ico" /></head><body></body></html>')
      await prepareApp(recipeFor({ icon: 'resources/mark.png' }), dirs, { orivonHint: false })
      const html = await read('index.html')
      expect(html.match(/rel="icon"/g)).toHaveLength(1)
      expect(html).not.toContain('favicon.ico')
    })

    it('walks back up to the root from a nested entry', async () => {
      await mkdir(join(dirs.source, 'dist', 'pages'), { recursive: true })
      await writeFile(join(dirs.source, 'dist', 'pages', 'app.html'), '<head></head>')
      await prepareApp(recipeFor({ entry: 'pages/app.html', icon: 'resources/mark.png' }), dirs, { orivonHint: false })
      expect(await read('pages', 'app.html')).toContain('href="../orivon/demo-icon.png"')
    })

    it('keeps the extension and the type of what the clone holds', async () => {
      await writeFile(join(dirs.source, 'resources', 'mark.ICO'), 'ico')
      await prepareApp(recipeFor({ icon: 'resources/mark.ICO' }), dirs, { orivonHint: false })
      expect(await read('orivon', 'demo-icon.ico')).toBe('ico')
      expect(await read('index.html')).toContain('<link rel="icon" type="image/x-icon" href="orivon/demo-icon.ico">')
    })

    it('says the file is not in the clone, naming the field', async () => {
      await expect(prepareApp(recipeFor({ icon: 'resources/missing.png' }), dirs)).rejects.toThrow(/icon "resources\/missing\.png" is not in the clone/)
    })

    it('adds nothing when the recipe has no icon', async () => {
      await prepareApp(recipeFor(), dirs, { orivonHint: false })
      expect(await read('index.html')).not.toContain('rel="icon"')
    })
  })

  it('serves a site from the app directory, with the manifest and hint added', async () => {
    await mkdir(join(dirs.recipe, 'site'), { recursive: true })
    await writeFile(join(dirs.recipe, 'site', 'index.html'), '<!doctype html><html><head><title>s</title></head><body></body></html>')
    await writeFile(join(dirs.recipe, 'site', 'app.js'), 'site()')
    const site = parseRecipe({ id: 'demo', name: 'Demo', port: 8890, site: 'site', manifest: 'orivon.json' }, 'recipe.json')
    await prepareApp(site, dirs, { orivonHint: false })
    expect(await read('app.js')).toBe('site()')
    expect(await manifest()).toEqual({ id: 'demo', entry: 'index.html', support: SUPPORT, assets: ['app.js'] })
    expect(await read('index.html')).toContain('rel="orivon-manifest"')
    await expect(readFile(join(dirs.recipe, 'site', 'index.html'), 'utf8')).resolves.not.toContain('orivon-manifest')
  })

  it('records the commit that built the tree in the manifest, after the generated assets, and declares it', async () => {
    const commit = '0123456789abcdef0123456789abcdef01234567'
    await prepareApp(recipeFor(), dirs, { orivonHint: false, portsCommit: commit })
    const written = await manifest() as Record<string, unknown>
    expect(written).toMatchObject({ id: 'demo', entry: 'index.html', source: { portsCommit: commit } })
    expect(Object.keys(written)).toEqual(['id', 'entry', 'assets', 'support', 'source'])
    await expect(declareBundle(dirs.static, { check: true })).resolves.toBeDefined()
  })

  it('names the problem form as support.issues, under the hint name when the recipe has one, and whether or not the hint is added', async () => {
    await prepareApp(recipeFor({ hint: { tier: 1, name: 'Upstream Demo', officialUrl: 'https://demo.example/' } }), dirs, { orivonHint: false })
    expect(await manifest()).toMatchObject({ support: { issues: portProblemUrl('Upstream Demo') } })
    await prepareApp(recipeFor({ hint: { tier: 1, name: 'Upstream Demo', officialUrl: 'https://demo.example/' } }), dirs)
    expect(await manifest()).toMatchObject({ support: { issues: portProblemUrl('Upstream Demo') } })
    expect(await read('index.html')).toContain(`data-report-url="${portProblemUrl('Upstream Demo').replaceAll('&', '&amp;')}"`)
  })

  it('writes no source field when there is no commit to name, so a tree never claims one it was not built at', async () => {
    await prepareApp(recipeFor(), dirs, { orivonHint: false, portsCommit: null })
    expect(await manifest()).not.toHaveProperty('source')
  })

  it('adds the Orivon hint by default: its three files, and a deferred script after the bridge', async () => {
    await prepareApp(recipeFor({ bridge: { file: 'bridge/b.js' }, hint: { tier: 1, name: 'Demo', officialUrl: 'https://demo.example/' } }), dirs)
    const source = join(import.meta.dirname, 'orivon-hint')
    for (const file of ['hint.js', 'hint.css']) {
      expect(await read('orivon', 'hint', file)).toBe(await readFile(join(source, file), 'utf8'))
    }
    expect(await readFile(join(dirs.static, 'orivon', 'hint', 'logo.png'))).toEqual(await readFile(join(source, 'logo.png')))
    const html = await read('index.html')
    expect(html).toContain(`<script src="orivon/hint/hint.js" data-tier="1" data-app="demo" data-name="Demo" data-official-url="https://demo.example/"${REPORT} defer></script>`)
    expect(html.indexOf('orivon/b.js')).toBeLessThan(html.indexOf('orivon/hint/hint.js'))
  })

  it('puts a tier 2 hint ahead of the bridge, so it runs before anything of the app\'s', async () => {
    await prepareApp(recipeFor({ bridge: { file: 'bridge/b.js' }, hint: { tier: 2, name: 'Demo', officialUrl: 'https://demo.example/' } }), dirs)
    const html = await read('index.html')
    expect(html.indexOf('orivon/hint/hint.js')).toBeLessThan(html.indexOf('orivon/b.js'))
    expect(html.indexOf('orivon/b.js')).toBeLessThan(html.indexOf('/js/app.js'))
  })

  it('adds it to a site as well', async () => {
    await mkdir(join(dirs.recipe, 'site'), { recursive: true })
    await writeFile(join(dirs.recipe, 'site', 'index.html'), '<!doctype html><html><head></head><body></body></html>')
    await prepareApp(parseRecipe({ id: 'demo', name: 'Demo', port: 8890, site: 'site', manifest: 'orivon.json' }, 'recipe.json'), dirs)
    expect(await read('index.html')).toContain('src="orivon/hint/hint.js"')
  })

  it('resolves the hint from a nested entry', async () => {
    await mkdir(join(dirs.source, 'dist', 'pages'), { recursive: true })
    await writeFile(join(dirs.source, 'dist', 'pages', 'app.html'), '<head></head>')
    await prepareApp(recipeFor({ entry: 'pages/app.html' }), dirs)
    expect(await read('pages', 'app.html')).toContain('src="../orivon/hint/hint.js"')
  })

  it('leaves no trace of the hint when it is turned off', async () => {
    await prepareApp(recipeFor(), dirs, { orivonHint: false })
    expect(await read('index.html')).not.toContain('hint.js')
    await expect(read('orivon', 'hint', 'hint.js')).rejects.toThrow()
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
