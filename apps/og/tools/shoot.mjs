// Headless screenshots of the .og site against a simulated chain, for a person to read: each scene at 360 and 1280 px wide. The site has one
// theme, a dark one, so the shots are dark; a system that asks for light must get the same page, and the tool checks that too. It also
// drives the views through a registration and through changes to a name (tools/shoot-scenes-manage.mjs), so a view that throws, a request
// to another origin or a console error shows up.
//
//   node apps/og/tools/shoot.mjs [--out <dir>] [scene-name-part ...]       QUICK=1: 360 px only
//
// Each scene is shot whole (`<scene>-<width>-dark.png`) and, where the registration panel is on show, as the first screen a person sees
// (`...-fold.png`: 360 by 740 and 1280 by 800), where nothing may sit over the first choices.
//
// Each scene is also read for contrast as a person sees it: its text (shoot-contrast.mjs) and the edge and focus ring of its controls (shoot-controls.mjs).
//
// It needs `esbuild` and `playwright-core` with a headless Chromium, read from `MODULES` (a node_modules folder) first, then from this
// checkout's node_modules. The output goes to `--out`, else `SHOTS`, else `out/og-shots` at the repository root (git ignores it). It
// prints a JSON list of the problems it saw. Nothing is shown on a screen: the browser is headless and the chain is a table.

import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { toChecksumAddress } from '../site/sdk/abi.js'
import { contrastProblems } from './shoot-contrast.mjs'
import { controlProblems } from './shoot-controls.mjs'
import { manageScenes } from './shoot-scenes-manage.mjs'

const TOOLS = dirname(fileURLToPath(import.meta.url))
const SITE = join(TOOLS, '..', 'site')
const REPO = resolve(TOOLS, '..', '..', '..')
const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const OUT = resolve(outAt === -1 ? process.env['SHOTS'] ?? join(REPO, 'out', 'og-shots') : args[outAt + 1] ?? '')
const wanted = args.filter((one, at) => !one.startsWith('--') && args[at - 1] !== '--out')

async function load (name, entry) {
  const roots = [process.env['MODULES'], join(REPO, 'node_modules')].filter((root) => root !== undefined && root !== '')
  for (const root of roots) {
    const path = join(root, name, entry)
    if (existsSync(path)) return await import(pathToFileURL(path).href)
  }
  throw new Error(`${name} was not found in ${roots.join(' or ')}. Set MODULES to a node_modules folder that has esbuild and playwright-core.`)
}
const esbuild = await load('esbuild', 'lib/main.js')
const { chromium } = await load('playwright-core', 'index.mjs')
const bundle = await esbuild.build({ entryPoints: [join(TOOLS, '..', 'test', 'support', 'shoot-browser.ts')], bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent' })
const browserSide = bundle.outputFiles[0].text

const ACCOUNT = toChecksumAddress(`0x${'a1'.repeat(20)}`)
const RIVAL = toChecksumAddress(`0x${'b2'.repeat(20)}`)
const WRAPPER = '0x2Cc8342d7c8BFf5A213eb2cdE39DE9a59b3461A7'
const hex = (text) => `0x${Buffer.from(text, 'utf8').toString('hex').padEnd(64, '0')}`
const KEY = hex('harbor')
const CID = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.webp': 'image/webp' }

const server = http.createServer(async (request, response) => {
  const path = join(SITE, new URL(request.url ?? '/', 'http://x').pathname.replace(/\/$/, '/index.html'))
  try {
    if (!path.startsWith(SITE)) throw new Error('outside')
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
    response.end(await readFile(path))
  } catch {
    response.writeHead(404).end()
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

const type = async (page, text) => { await page.fill('#name', text) }
const verdict = async (page, words) => { await page.waitForFunction((expected) => document.querySelector('#verdict')?.textContent?.includes(expected), words, { timeout: 15_000 }) }
const press = async (page, label) => { await page.getByRole('button', { name: label }).first().click() }

/** Each scene: the chain it starts as, what a person does, and what must be on the page at the end. */
const SCENES = [
  { name: 'free', state: {}, async run (page) { await type(page, 'harbor'); await verdict(page, 'is free'); await press(page, 'Connect your wallet'); await page.waitForSelector('text=What will be sent') }, expect: ['Register harbor.og', 'Wrapped', 'Support Orivon'] },
  { name: 'held-wrapped', state: { owner: { [KEY]: WRAPPER }, nameToId: { [KEY]: 70078 }, idToName: { 70078: KEY }, tokenOwner: { 70078: RIVAL }, texts: { [KEY]: { 'content.ipfs': CID } } }, async run (page) { await type(page, 'harbor'); await verdict(page, 'wrapped') }, expect: ['Does not count'] },
  { name: 'stranded', state: { owner: { [KEY]: WRAPPER }, waitForWrap: { [KEY]: ACCOUNT } }, async run (page) { await press(page, 'Connect'); await type(page, 'harbor'); await verdict(page, 'stuck in the wrapper'); await page.waitForSelector('text=Finish wrapping') }, expect: ['Finish wrapping'] },
  { name: 'held-unwrapped', state: { owner: { [KEY]: ACCOUNT }, controller: { [KEY]: ACCOUNT }, texts: { [KEY]: { 'content.ipfs': CID } } }, async run (page) { await press(page, 'Connect'); await type(page, 'harbor'); await page.waitForSelector('text=What will be sent') }, expect: ['Wrap it'] },
  { name: 'free-leftover', state: { controller: { [KEY]: RIVAL }, texts: { [KEY]: { 'content.ipfs': CID } } }, async run (page) { await type(page, 'harbor'); await verdict(page, 'previous holder') }, expect: ['Left on the resolver'] },
  { name: 'free-tip-changed', state: {}, async run (page) { await type(page, 'harbor'); await verdict(page, 'is free'); await press(page, 'Connect your wallet'); await page.waitForSelector('text=What will be sent'); await page.waitForSelector('text=points to'); await page.evaluate(() => { globalThis.__options.tip = `0x${'cc'.repeat(20)}` }); await press(page, 'Register'); await page.waitForSelector('text=now points to') }, expect: ['orivonstack.eth now points to', 'Register harbor.og'] },
  { name: 'problem', state: {}, async run (page) { await type(page, 'Harbor.x') }, expect: ['cannot be registered'] },
  { name: 'wrap-off', state: { wrapEnabled: false }, async run (page) { await press(page, 'Connect'); await type(page, 'harbor'); await page.waitForSelector('text=Switched off at the wrapper') }, expect: ['Switched off at the wrapper'] },
  { name: 'registered', state: {}, async run (page) { await press(page, 'Connect'); await type(page, 'harbor'); await page.waitForSelector('text=What will be sent'); await page.fill('input[id$="-site"]', CID); await press(page, 'Register'); await page.waitForSelector('text=is registered', { timeout: 30_000 }) }, expect: ['harbor.og is registered', 'Transaction'] },
  { name: 'series-mid', state: {}, hold: 2, async run (page) { await press(page, 'Connect'); await type(page, 'harbor'); await page.waitForSelector('text=What will be sent'); await press(page, 'Register'); await page.waitForFunction(() => document.querySelectorAll('.step[data-state="done"]').length >= 2 && document.querySelector('.step[data-state="active"]') !== null, null, { timeout: 30_000 }) }, expect: ['Registering harbor.og'] },
  { name: 'taken', state: {}, before: [{ index: 0, change: { owner: { [KEY]: RIVAL } } }], async run (page) { await press(page, 'Connect'); await type(page, 'harbor'); await page.waitForSelector('text=What will be sent'); await press(page, 'Register'); await page.waitForSelector('text=Someone else took', { timeout: 30_000 }) }, expect: ['Someone else took harbor.og first'] }
]
SCENES.push(...manageScenes())

await mkdir(OUT, { recursive: true })
const browser = await chromium.launch({ headless: true })
const problems = []
const widths = process.env['QUICK'] === '1' ? [360] : [360, 1280]
for (const [sceneAt, scene] of SCENES.filter((one) => wanted.length === 0 || wanted.some((part) => one.name.includes(part))).entries()) {
  for (const width of widths) {
    /** The first screen under the dark setting, which the same scene under a light setting must match to the pixel. @type {Buffer | null} */
    let darkFirst = null
    // The site has one theme: the first scene is opened a second time under a light system, and must look the same. Motion is off, so a frame is repeatable.
    for (const scheme of sceneAt === 0 ? ['dark', 'light'] : ['dark']) {
      const context = await browser.newContext({ viewport: { width, height: width === 1280 ? 800 : 740 }, colorScheme: scheme, reducedMotion: 'reduce' })
      const page = await context.newPage()
      const here = `${scene.name}@${width}/${scheme}`
      page.on('console', (message) => { if (message.type() === 'error') problems.push(`${here}: console error: ${message.text().slice(0, 300)}`) })
      page.on('pageerror', (error) => problems.push(`${here}: uncaught: ${error.message.slice(0, 300)}`))
      page.on('request', (request) => { if (!request.url().startsWith(ORIGIN) && !request.url().startsWith('data:')) problems.push(`${here}: request to another origin: ${request.url()}`) })
      await page.addInitScript((value) => {
        globalThis.__SCENE = value
        try { for (const [key, text] of Object.entries(value.storage ?? {})) localStorage.setItem(key, text) } catch { /* the page then starts with nothing remembered */ }
      }, { state: scene.state, before: scene.before, seed: scene.seed, storage: scene.storage })
      await page.addInitScript({ content: browserSide })
      // `hold: n` leaves the series standing after its n-th step, so the stepper can be read in the middle of a registration.
      if (scene.hold !== undefined) {
        await page.addInitScript((after) => {
          const use = globalThis.orivon.use.bind(globalThis.orivon)
          let sent = 0
          globalThis.orivon = { ...globalThis.orivon, async use (...args) {
            return (await use(...args)).map((handle) => handle === null || handle.sendRawTransaction === undefined ? handle : Object.freeze({
              ...handle, async sendRawTransaction (...more) { sent++; if (sent > after) await new Promise(() => {}); return await handle.sendRawTransaction(...more) }
            }))
          } }
        }, scene.hold)
      }
      try {
        await page.goto(`${ORIGIN}/index.html`)
        await scene.run(page)
        // A read that is still on its way (a name read again after a series) would be measured half drawn.
        await page.waitForFunction(() => !document.body.innerText.includes('Reading'), null, { timeout: 10_000 }).catch(() => undefined)
        await page.waitForTimeout(150)
        const first = await page.screenshot()
        if (scheme === 'light') {
          if (darkFirst === null || !first.equals(darkFirst)) problems.push(`${here}: the page looks different when the system asks for light`)
          await context.close()
          continue
        }
        darkFirst = first
        const text = await page.locator('body').innerText()
        for (const needed of scene.expect) if (!text.includes(needed)) problems.push(`${here}: the page does not say "${needed}"`)
        const wide = await page.evaluate(() => {
          const limit = document.documentElement.clientWidth + 1
          if (document.documentElement.scrollWidth <= limit) return null
          const names = [...document.body.querySelectorAll('*')].filter((one) => one.getBoundingClientRect().right > limit && ![...one.children].some((child) => child.getBoundingClientRect().right > limit))
          const label = (one) => `${one.tagName.toLowerCase()}${one.className === '' ? '' : `.${String(one.className).split(' ')[0]}`}`
          const chain = []
          if (names.length === 0) {
            const texts = []
            for (const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); walker.nextNode();) {
              const range = document.createRange()
              range.selectNodeContents(walker.currentNode)
              if (range.getBoundingClientRect().right > limit && walker.currentNode.parentElement.closest('.visually-hidden') === null) texts.push(`${label(walker.currentNode.parentElement)} "${String(walker.currentNode.textContent).trim().slice(0, 40)}"`)
            }
            return `only text reaches past the window (the page is ${document.documentElement.scrollWidth} wide): ${texts.slice(0, 3).join('; ')}`
          }
          for (let one = names[0]; one !== null && one !== document.body; one = one.parentElement) chain.push(`${label(one)} ${Math.round(one.getBoundingClientRect().width)}`)
          return `${names.slice(0, 4).map(label).join(', ')}; widths: ${chain.join(' < ')}`
        })
        if (wide !== null) problems.push(`${here}: the page scrolls sideways (${wide})`)
        problems.push(...await contrastProblems(page, here))
        // What a person sees before scrolling; only a scene with the registration panel has one.
        if (await page.locator('.panel').count() > 0) {
          await page.evaluate(() => window.scrollTo(0, 0))
          await page.screenshot({ path: join(OUT, `${scene.name}-${width}-${scheme}-fold.png`) })
        }
        await page.screenshot({ path: join(OUT, `${scene.name}-${width}-${scheme}.png`), fullPage: true })
        // Last, because it moves the keyboard focus and flips the switches, and puts both back.
        problems.push(...await controlProblems(page, here))
      } catch (error) {
        problems.push(`${here}: ${error.message.split('\n')[0].slice(0, 300)}`)
        await page.screenshot({ path: join(OUT, `${scene.name}-${width}-${scheme}-FAILED.png`), fullPage: true }).catch(() => undefined)
      }
      await context.close()
    }
  }
}
await browser.close()
server.close()
console.log(JSON.stringify({ out: OUT, problems }, null, 2))
process.exit(problems.length === 0 ? 0 : 1)
