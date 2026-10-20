import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mvpCandidate } from '../compat-tables.ts'
import { prepareApp } from '../prepare.ts'
import { parseRecipe } from '../recipe.ts'
import { startServer } from '../serve.ts'

// The hint in a real Chromium, over trees `prepareApp` really wrote: the
// claim that a tier 2 app has not started when its landing shows can only be
// checked against a browser's own parser. The browser is the one the
// orivon-mvp checkout already carries (Playwright); a machine without that
// checkout skips this file, and src/orivon-hint/README.md says how to run it.

interface PageLike {
  goto: (url: string) => Promise<unknown>
  evaluate: <T>(expression: string) => Promise<T>
  reload: () => Promise<unknown>
  keyboard: { press: (key: string) => Promise<void> }
  locator: (selector: string) => LocatorLike
  getByRole: (role: string, options?: { name?: string }) => LocatorLike
  on: (event: 'request', listener: (request: { url: () => string }) => void) => void
  addInitScript: (script: string) => Promise<void>
  addStyleTag: (options: { content: string }) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
  screenshot: (options: { path: string }) => Promise<unknown>
}
interface LocatorLike {
  click: () => Promise<void>
  count: () => Promise<number>
  isVisible: () => Promise<boolean>
  getAttribute: (name: string) => Promise<string | null>
  textContent: () => Promise<string | null>
  waitFor: (options?: { state?: string, timeout?: number }) => Promise<void>
}
interface BrowserLike {
  newContext: (options?: object) => Promise<{ newPage: () => Promise<PageLike>, close: () => Promise<void> }>
  close: () => Promise<void>
}

function findChromium (): { launch: (options: object) => Promise<BrowserLike>, executablePath: () => string } | undefined {
  try {
    const require = createRequire(import.meta.url)
    const { chromium } = require(join(mvpCandidate().path, 'node_modules', 'playwright-core')) as { chromium: { launch: (options: object) => Promise<BrowserLike>, executablePath: () => string } }
    return existsSync(chromium.executablePath()) ? chromium : undefined
  } catch {
    return undefined
  }
}

const chromium = findChromium()

// What an app's page looks like to the hint: scripts of every kind that start
// an app, each leaving a mark in window.__ran when it runs.
const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Demo app</title>
<style>*, *::before, *::after { box-sizing: border-box !important } a { display: none !important } button { visibility: hidden !important } orivon-hint { display: none !important; opacity: 0 !important; position: static !important }</style>
<link rel="modulepreload" href="mod.js">
<script defer src="deferred.js"></script>
<script async src="async.js"></script>
<script type="module" src="mod.js"></script>
<script src="app.js"></script>
</head>
<body style="margin:0;background:#fdd"><div id="root">THE APP IS RUNNING</div>
<!-- a comment, which ends a <!-- swallowed comment early --> <script src="late.js"></script>
<script>window.__ran = (window.__ran || []).concat('inline')</script></body>
</html>
`

// The same page as Angular's history routing serves it: a `<base href="/">`
// after the title and a client-side route (`/tabs/tab-secrets`) the server
// answers with this document.
const BASED_HTML = APP_HTML.replace('<title>Demo app</title>', '<title>Demo app</title>\n<base href="/">')
const DEEP_ROUTE = 'tabs/tab-secrets'

const MARKS = ['app', 'late', 'inline', 'deferred', 'async', 'mod', 'bridge']
const mark = (name: string): string => `window.__ran = (window.__ran || []).concat('${name}'); var r = document.getElementById('root'); if (r) r.dataset.ran = window.__ran.join(',')`

describe.skipIf(chromium === undefined)('the Orivon hint in Chromium', () => {
  let base = ''
  let browser: BrowserLike
  const servers: Server[] = []
  const urls: Record<string, string> = {}

  async function serveTree (name: string, hint: object, html = APP_HTML): Promise<void> {
    const dirs = { recipe: join(base, name, 'recipe'), source: join(base, name, 'source'), static: join(base, name, 'static') }
    await mkdir(join(dirs.source, 'dist'), { recursive: true })
    await mkdir(join(dirs.recipe, 'bridge'), { recursive: true })
    await writeFile(join(dirs.source, 'dist', 'index.html'), html)
    for (const file of ['app', 'late', 'deferred', 'async', 'mod']) await writeFile(join(dirs.source, 'dist', `${file}.js`), mark(file))
    await writeFile(join(dirs.recipe, 'bridge', 'b.js'), mark('bridge'))
    await writeFile(join(dirs.recipe, 'orivon.json'), '{"id":"demo","entry":"index.html"}')
    const recipe = parseRecipe({
      id: name,
      name: 'Demo',
      port: 8890,
      eth: 'demo.orivonstack.eth',
      upstream: { repo: 'https://example.com/x.git', ref: 'a'.repeat(40), licence: 'MIT' },
      build: { command: 'true', output: 'dist' },
      manifest: 'orivon.json',
      bridge: { file: 'bridge/b.js' },
      hint
    }, 'recipe.json')
    await prepareApp(recipe, dirs)
    const server = await startServer({ root: dirs.static, port: 0, label: name })
    servers.push(server)
    urls[name] = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
  }

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'orivon-hint-browser-'))
    await serveTree('tier2', { tier: 2, name: 'Demo', officialUrl: 'https://demo.example/download' })
    await serveTree('tier1', { tier: 1, name: 'Demo', officialUrl: 'https://demo.example/download' })
    await serveTree('based2', { tier: 2, name: 'Demo', officialUrl: 'https://demo.example/download' }, BASED_HTML)
    await serveTree('based1', { tier: 1, name: 'Demo', officialUrl: 'https://demo.example/download' }, BASED_HTML)
    browser = await (chromium as NonNullable<typeof chromium>).launch({ headless: true, args: ['--mute-audio'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    for (const server of servers) server.close()
    await rm(base, { recursive: true, force: true })
  })

  async function open (name: string, init?: string, route = ''): Promise<{ page: PageLike, close: () => Promise<void>, requested: string[] }> {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
    const page = await context.newPage()
    const requested: string[] = []
    page.on('request', (request) => { requested.push(new URL(request.url()).pathname) })
    if (init !== undefined) await page.addInitScript(init)
    await page.goto((urls[name] as string) + route)
    return { page, close: () => context.close(), requested }
  }

  const ran = (page: PageLike): Promise<string[]> => page.evaluate('window.__ran ?? []')

  it('tier 2 outside Orivon: the landing replaces the app and not one of its scripts ran', async () => {
    const { page, close } = await open('tier2')
    await page.getByRole('link', { name: 'Get Orivon' }).waitFor()
    // Long enough for every deferred, async and module script to have run had it been let through.
    await page.waitForTimeout(500)
    expect(await ran(page)).toEqual([])
    expect(await page.locator('#root').count()).toBe(0)
    expect(await page.locator('plaintext').count()).toBe(0)
    expect(await page.evaluate<string>('document.body.innerText')).not.toContain('THE APP IS RUNNING')
    expect(await page.evaluate<string>('document.title')).toBe('Demo')
    expect(await page.getByRole('link', { name: 'Get Orivon' }).getAttribute('href')).toBe('https://download.orivonstack.eth.limo/?app=tier2')
    expect(await page.getByRole('link', { name: 'Official Demo downloads' }).getAttribute('href')).toBe('https://demo.example/download')
    expect(await page.getByRole('link', { name: 'Report a problem with this build' }).getAttribute('href'))
      .toBe('https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=Demo&title=Problem%20with%20the%20Orivon%20community%20build%20of%20Demo')
    expect(await page.getByRole('link', { name: 'Open in Orivon' }).count()).toBe(0)
    expect(await page.locator('text=A community build by Orivon, not the official Demo.').isVisible()).toBe(true)
    expect(await page.locator('text=Demo runs inside Orivon, an open-source browser that provides the desktop parts this app needs.').isVisible()).toBe(true)
    // The page's own CSS hides every link and button and the hint's own element, and cannot reach the landing.
    expect(await page.getByRole('link', { name: 'Get Orivon' }).isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: 'Continue anyway' }).isVisible()).toBe(true)
    await close()
  }, 30_000)

  it('tier 2: the first Tab stop is the primary link, and the order follows the page', async () => {
    const { page, close } = await open('tier2')
    await page.getByRole('link', { name: 'Get Orivon' }).waitFor()
    const focused = (): Promise<string> => page.evaluate(`(() => {
      const inner = document.querySelector('orivon-hint')?.shadowRoot?.activeElement
      return inner ? (inner.getAttribute('aria-label') ?? inner.textContent ?? '') : 'none'
    })()`)
    expect(await focused()).toBe('Get Orivon')
    const order: string[] = []
    for (let step = 0; step < 4; step += 1) { await page.keyboard.press('Tab'); order.push(await focused()) }
    expect(order).toEqual(['Official Demo downloads', 'Report a problem with this build', 'Continue anyway', 'Close'])
    await close()
  }, 30_000)

  it('tier 2: Continue anyway starts the app on a reload, with a pill that can be closed for the session', async () => {
    const { page, close } = await open('tier2')
    await page.getByRole('button', { name: 'Continue anyway' }).click()
    await page.locator('#root').waitFor()
    await page.waitForTimeout(300)
    expect((await ran(page)).sort()).toEqual([...MARKS].sort())
    expect(await page.locator('text=Demo may not work in this browser.').isVisible()).toBe(true)
    await page.getByRole('button', { name: 'Close' }).click()
    await page.reload()
    await page.locator('#root').waitFor()
    expect(await page.locator('orivon-hint').count()).toBe(0)
    await close()
  }, 30_000)

  it('tier 2: Escape goes on to the app as well', async () => {
    const { page, close } = await open('tier2')
    await page.getByRole('link', { name: 'Get Orivon' }).waitFor()
    await page.keyboard.press('Escape')
    await page.locator('#root').waitFor()
    expect((await ran(page)).length).toBeGreaterThan(0)
    await close()
  }, 30_000)

  it('tier 2 inside Orivon: the app runs and nothing shows', async () => {
    const { page, close } = await open('tier2', 'window.orivon = { version: 0 }')
    await page.locator('#root').waitFor()
    await page.waitForTimeout(300)
    expect((await ran(page)).sort()).toEqual([...MARKS].sort())
    expect(await page.locator('orivon-hint').count()).toBe(0)
    await close()
  }, 30_000)

  it('tier 1: the app runs, a pill shows, and closing it keeps it closed for the session', async () => {
    const { page, close } = await open('tier1')
    await page.locator('#root').waitFor()
    await page.locator('text=Demo works in this browser.').waitFor()
    expect((await ran(page)).sort()).toEqual([...MARKS].sort())
    expect(await page.getByRole('link', { name: 'Get Orivon' }).getAttribute('href')).toBe('https://download.orivonstack.eth.limo/?app=tier1')
    expect(await page.getByRole('link', { name: 'Get Orivon' }).isVisible()).toBe(true)
    await page.getByRole('button', { name: 'Close' }).click()
    expect(await page.locator('orivon-hint').count()).toBe(0)
    await page.reload()
    await page.locator('#root').waitFor()
    await page.waitForTimeout(300)
    expect(await page.locator('orivon-hint').count()).toBe(0)
    await close()
  }, 30_000)

  it('tier 1 inside Orivon: nothing shows', async () => {
    const { page, close } = await open('tier1', 'window.orivon = { version: 0 }')
    await page.locator('#root').waitFor()
    await page.waitForTimeout(300)
    expect(await page.locator('orivon-hint').count()).toBe(0)
    await close()
  }, 30_000)
  // The page puts `<base href="/">` ahead of its scripts and the hint's tag
  // goes right after it: before the base a relative URL resolves against the
  // document, so a reload of a client-side route asked for
  // /tabs/tab-secrets/orivon/hint/hint.js (a 404, so no landing and no pill).
  describe('a page with <base href="/"> on a client-side route', () => {
    it('tier 2 outside Orivon: the landing shows on a deep reload, from a hint script that loaded', async () => {
      const { page, close, requested } = await open('based2', undefined, DEEP_ROUTE)
      await page.getByRole('link', { name: 'Get Orivon' }).waitFor()
      await page.reload()
      await page.getByRole('link', { name: 'Get Orivon' }).waitFor()
      await page.waitForTimeout(500)
      expect(await ran(page)).toEqual([])
      expect(await page.locator('#root').count()).toBe(0)
      expect(requested).toContain('/orivon/hint/hint.js')
      expect(requested).toContain('/orivon/hint/hint.css')
      expect(requested.filter((path) => path.includes(`${DEEP_ROUTE}/`))).toEqual([])
      await close()
    }, 30_000)

    it('tier 2 inside Orivon: the app runs on the deep route and nothing shows', async () => {
      const { page, close, requested } = await open('based2', 'window.orivon = { version: 0 }', DEEP_ROUTE)
      await page.locator('#root').waitFor()
      await page.reload()
      await page.locator('#root').waitFor()
      await page.waitForTimeout(300)
      expect((await ran(page)).sort()).toEqual([...MARKS].sort())
      expect(await page.locator('orivon-hint').count()).toBe(0)
      expect(requested).toContain('/orivon/hint/hint.js')
      expect(requested.filter((path) => path.includes(`${DEEP_ROUTE}/`))).toEqual([])
      await close()
    }, 30_000)

    it('tier 1 outside Orivon: the app runs and the pill shows on a deep reload', async () => {
      const { page, close, requested } = await open('based1', undefined, DEEP_ROUTE)
      await page.reload()
      await page.locator('#root').waitFor()
      await page.locator('text=Demo works in this browser.').waitFor()
      expect((await ran(page)).sort()).toEqual([...MARKS].sort())
      expect(requested).toContain('/orivon/hint/hint.js')
      expect(requested.filter((path) => path.includes(`${DEEP_ROUTE}/`))).toEqual([])
      await close()
    }, 30_000)
  })
})
