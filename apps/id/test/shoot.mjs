// Headless screenshots of every view of the Orivon ID site, for a person to read: each scene at 360 and 1280 px wide,
// light and dark, against the fake `orivon` of support/browser-orivon.ts. A test-side tool, never served.
//
//   node apps/id/test/shoot.mjs [--out <dir>] [scene-name-part ...]       QUICK=1: 360 px, light only
//
// A scene with `fold` also leaves `<scene>-fold.png`, the window as the person sees it before scrolling.
//
// It needs `esbuild` and `playwright` with a headless Chromium. They are read from `MODULES` (a node_modules folder)
// first, then from this checkout's node_modules; it stops and says so when neither has them. The output goes to
// `--out`, else `SHOTS`, else `out/id-shots` at the repository root (which git ignores). It prints a JSON list of the
// problems it saw (another origin reached, a console error, a scene that did not settle, a rule a scene checks).

import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TEST = dirname(fileURLToPath(import.meta.url))
const SITE = join(TEST, '..', 'site')
const REPO = resolve(TEST, '..', '..', '..')
const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const OUT = resolve(outAt === -1 ? process.env['SHOTS'] ?? join(REPO, 'out', 'id-shots') : args[outAt + 1] ?? '')
const wanted = args.filter((one, at) => !one.startsWith('--') && args[at - 1] !== '--out')

async function load (name, entry) {
  const roots = [process.env['MODULES'], join(REPO, 'node_modules')].filter((root) => root !== undefined && root !== '')
  for (const root of roots) {
    const path = join(root, name, entry)
    if (existsSync(path)) return await import(pathToFileURL(path).href)
  }
  throw new Error(`${name} was not found in ${roots.join(' or ')}. Set MODULES to a node_modules folder that has esbuild and playwright.`)
}
const esbuild = await load('esbuild', 'lib/main.js')
const { chromium } = await load('playwright', 'index.mjs')
const support = (name) => import(pathToFileURL(join(TEST, 'support', name)).href)
const { PRIVATE_KEY, SIGNER } = await support('signin-world.ts')
const { signDigest, recoverAddress } = await support('secp256k1.ts')
const { hashMessage } = await import(pathToFileURL(join(SITE, 'sdk', 'siwe.js')).href)
const { toHex, fromHex } = await import(pathToFileURL(join(SITE, 'sdk', 'bytes.js')).href)
const { price } = await import(pathToFileURL(join(SITE, 'sdk', 'orivonid.js')).href)
const { makeCommitment } = await import(pathToFileURL(join(SITE, 'register-tx.js')).href)
const { fakeMarket } = await support('fake-market.ts')

const bundle = await esbuild.build({
  stdin: {
    contents: `import { installFakeOrivon } from ${JSON.stringify(join(TEST, 'support', 'browser-orivon.ts'))}; globalThis.OrivonFake = { installFakeOrivon }`,
    resolveDir: REPO, loader: 'ts'
  },
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false
})
const FAKE = bundle.outputFiles[0].text

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.md': 'text/markdown' }
const escapeAttribute = (text) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/__frame') {
    // A page that frames the site, to see what a framed sign-in request is shown.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset="utf-8"><title>A page that frames the site</title><body style="margin:0"><iframe style="width:100%;height:900px;border:0" src="/index.html${escapeAttribute(url.searchParams.get('h') ?? '')}"></iframe>`)
    return
  }
  try {
    const body = await readFile(join(SITE, url.pathname === '/' ? 'index.html' : url.pathname))
    res.writeHead(200, { 'content-type': `${TYPES[extname(url.pathname)] ?? 'application/octet-stream'}; charset=utf-8` })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

const KEY = '0x037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978'
const AUDIENCE = 'https://app.example.org'
const connectHash = (extra = '', ret = `${AUDIENCE}/signed-in`) => `#/connect?v=1&return=${encodeURIComponent(ret)}&nonce=k3Jf92LmQp0xZ7aT${extra}`
const RICH = {
  names: ['alice', 'bob-1'], unsetNames: ['carol'], taken: ['orivonfan'],
  texts: { alice: { url: 'https://alice.example', description: 'Builds things on Ethereum.', 'com.github': 'alice-dev' } },
  contenthash: { alice: '0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f' }
}
const NOT_BEFORE = 'eth.orivonstack.id.not-before'
/** A record that ends every sign-in for a while ahead of the page's clock, whenever the scene runs. */
const ENDS_LATER = String(Math.floor(Date.now() / 1000) + 3600)
/** The buttons that answer the request are in the window as it opens, and the wallet's warning is whole in the window, directly above them. */
const inView = async (page, expect, viewport) => {
  for (const name of ['Sign in', 'Cancel']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox()
    expect(box !== null && box.y >= 0 && box.y + box.height <= viewport.h, `${name} ends at ${box === null ? 'nowhere' : Math.round(box.y + box.height)}, below the ${viewport.h} px of the window`)
  }
  const warning = page.locator('.wallet-warning')
  expect(await warning.textContent().then((text) => text.startsWith('Your wallet will warn you')), 'the consent does not say the wallet will warn')
  const words = await warning.boundingBox()
  expect(words !== null && words.y >= 0 && words.y + words.height <= viewport.h, `the wallet's warning ends at ${words === null ? 'nowhere' : Math.round(words.y + words.height)}, below the ${viewport.h} px of the window`)
  expect(await page.locator('.wallet-warning + .actions').count() === 1, 'the wallet\'s warning is not directly above the Sign in bar')
}
const LONG_HOST = 'long-subdomain.another-long-label.example-hosting.org'
if (`https://${LONG_HOST}`.length > 64) throw new Error('the long audience of the connect-long scene is over the 64 characters a request may carry')
const DISCARDED = {
  v: 1, label: 'alice', owner: SIGNER, resolver: SIGNER, resolverMode: 'deploy', secret: `0x${'11'.repeat(32)}`, commitment: `0x${'22'.repeat(32)}`,
  price: '1', private: false, texts: {}, pending: null, hashes: {}
}

/** A registration that was stored by an earlier visit and whose commitment is mined, as a reload in the middle of the wait finds them. */
const RESUMED_SECRET = `0x${'33'.repeat(32)}`
const resumedRecord = () => {
  const resolver = fakeMarket({ account: SIGNER }).predicted
  return {
    v: 1, label: 'bobby', owner: SIGNER, resolver, resolverMode: 'deploy', secret: RESUMED_SECRET, commitment: makeCommitment('bobby', SIGNER, resolver, RESUMED_SECRET),
    price: String(price('bobby')), private: false, texts: {}, pending: null, hashes: { commit: `0x${'01'.repeat(32)}` }
  }
}
/** What stands in for a wallet extension: it knows the chain's id and the account, and cannot answer any other question. */
const EXTENSION = `window.ethereum = { request: async ({ method }) => {
  if (method === 'eth_chainId') return '0x1'
  if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [${JSON.stringify(SIGNER)}]
  throw Object.assign(new Error('The wallet extension does not answer this question here.'), { code: -32601 })
} }`
const strip = (page) => page.locator('.reading').evaluate((node) => ({ text: node.textContent, shield: node.querySelector('svg path')?.getAttribute('d')?.startsWith('M12 3l7 3') === true }))

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const status = (page, text) => page.waitForFunction((t) => document.querySelector('.panel-status')?.textContent?.includes(t), text, { timeout: 15000 })
const settled = (page, text) => page.waitForFunction((t) => document.querySelector('#verdict')?.textContent?.includes(t), text, { timeout: 15000 })
const checkName = async (page, name, verdict) => {
  await page.locator('#name').fill(name)
  await page.getByRole('button', { name: 'Check availability' }).click()
  if (verdict !== undefined) await settled(page, verdict)
}
const register = async (page, name) => {
  await checkName(page, name, 'is available')
  await status(page, 'Ready to register')
}
const payButton = (page) => page.getByRole('button', { name: /^Register for/ })
/** The panel's heading is in the window as it opens, above the bar that sticks to the foot of it. */
const headingClear = async (page, expect) => {
  const heading = await page.locator('.panel h2').first().boundingBox()
  const bar = await page.locator('.panel-foot').boundingBox()
  expect(heading !== null && bar !== null && heading.y + heading.height <= bar.y, `the panel heading ends at ${heading === null ? 'nowhere' : Math.round(heading.y + heading.height)}, under the bar that starts at ${bar === null ? 'nowhere' : Math.round(bar.y)}`)
}
const ownerReads = (page) => page.evaluate(() => window.__fake.ownerReads)
const START = { scenario: { dai: 1000, rate: 0 }, hash: '#/' }
const GIFTED = {
  scenario: {
    notHeld: ['dave'], rate: 0, texts: { dave: { url: 'https://dave.example', description: 'Given away, and now mine.', 'com.github': 'dave-dev' } },
    contenthash: { dave: RICH.contenthash.alice }
  },
  hash: '#/me', waitFor: '.id-card .record-list'
}
const MOVE_BUTTON = 'Move to your own resolver'
const openMove = async (page) => {
  await page.getByRole('button', { name: MOVE_BUTTON }).click()
  await page.waitForSelector('.move .steps', { timeout: 15000 })
}
const startMove = async (page) => { await page.locator('.move').getByRole('button', { name: MOVE_BUTTON }).click() }

/**
 * A scene: `scenario` is the fake wallet and chain, `hash` the address, `referer` the page the person came from (a page
 * of the audience for a connect scene unless it says otherwise; '' for none), `frame` loads the address in a frame,
 * `storage` is written to localStorage first, `waitFor` a selector, `run` the steps, with `expect(condition, words)`, and
 * `after` more steps once the picture is taken.
 */
const SCENES = {
  'search-empty': { hash: '#/' },
  'search-invalid': { hash: '#/', run: async (page) => { await page.locator('#name').fill('ab'); await settled(page, 'at least 3') } },
  'search-reserved': { hash: '#/', run: async (page) => { await page.locator('#name').fill('Orivon'); await settled(page, 'kept by Orivon') } },
  'search-taken': { scenario: RICH, hash: '#/', run: async (page) => { await checkName(page, 'orivonfan', 'is taken') } },
  'search-available': { scenario: { dai: 100 }, hash: '#/', run: async (page) => { await checkName(page, 'bobby', 'is available') } },
  'search-closed': { scenario: { salesClosed: true }, hash: '#/', run: async (page) => { await checkName(page, 'bobby', 'cannot be bought') } },
  'search-nowallet': { noOrivon: true, hash: '#/' },
  'header-refused': {
    scenario: { readRefused: true }, hash: '#/', run: async (page, expect) => {
      await page.waitForFunction(() => document.querySelector('.sales')?.textContent?.includes('Could not check whether sales are open') === true, null, { timeout: 15000 })
      const bar = await strip(page)
      expect(!bar.shield && bar.text.includes('Orivon is not letting this page read Ethereum') && bar.text.includes('close every tab of this site'), `the strip of a refused read says: ${bar.text}`)
      expect(await page.locator('.sales').textContent().then((text) => text.includes('Could not check whether sales are open')), 'a refused read is not shown as a sales line')
    }
  },
  'header-extension': {
    noOrivon: true, extension: true, hash: '#/', run: async (page, expect) => {
      const bar = await strip(page)
      expect(!bar.shield && bar.text.includes('wallet extension'), `the strip of an extension wallet says: ${bar.text}`)
    }
  },
  'header-nowallet': {
    noOrivon: true, hash: '#/', run: async (page, expect) => {
      const bar = await strip(page)
      expect(!bar.shield && bar.text.startsWith('No wallet is available'), `the strip with no wallet says: ${bar.text}`)
    }
  },
  'search-sales-unknown': {
    scenario: { salesReadFails: true }, hash: '#/', run: async (page, expect) => {
      await page.waitForFunction(() => document.querySelector('.sales')?.textContent?.includes('Could not check whether sales are open') === true, null, { timeout: 15000 })
      expect(await page.getByRole('button', { name: 'Check again' }).isVisible(), 'a sales read that failed offers no way to ask again')
      expect(!(await page.locator('.sales').textContent()).includes('Checking whether'), 'the sales line still says it is checking')
    },
    after: async (page, expect) => {
      await page.evaluate(() => { window.__fake.failSales = false })
      await page.getByRole('button', { name: 'Check again' }).click()
      await page.waitForFunction(() => document.querySelector('.sales')?.textContent?.includes('Sales are open.') === true, null, { timeout: 15000 })
      expect(await page.getByRole('button', { name: 'Check again' }).isHidden(), 'the retry button stays after the sales read answered')
    }
  },
  'search-privacy': {
    scenario: { dai: 1000, rate: 0 }, hash: '#/', run: async (page, expect) => {
      await page.locator('#name').pressSequentially('abc', { delay: 120 })
      await sleep(1200)
      expect(await ownerReads(page) === 0, 'typing a 3-letter name asked the node who holds a name')
      await settled(page, 'costs 800 DAI')
    },
    after: async (page, expect) => {
      await page.getByRole('button', { name: 'Check availability' }).click()
      await settled(page, 'is available')
      expect(await ownerReads(page) === 8, 'the check of a 3-letter name did not ask about it among 7 others')
    }
  },
  'register-ready': {
    ...START, fold: true, run: async (page, expect, viewport) => {
      await register(page, 'bobby')
      await page.evaluate(() => window.scrollTo(0, 0))
      await sleep(200)
      const box = await payButton(page).boundingBox()
      expect(box !== null && box.y >= 0 && box.y + box.height <= viewport.h, `the Register button ends at ${box === null ? 'nowhere' : Math.round(box.y + box.height)}, below the ${viewport.h} px of the window`)
      await headingClear(page, expect)
    }
  },
  'register-ready-short': {
    ...START, fold: true, run: async (page, expect) => { await register(page, 'abc'); await page.evaluate(() => window.scrollTo(0, 0)); await sleep(200); await headingClear(page, expect) }
  },
  'register-resumed-steps': {
    scenario: { dai: 1000, rate: 0, committed: { label: 'bobby', secret: RESUMED_SECRET }, holdWallet: true }, hash: '#/',
    storage: { [`orivonid.registration.v1.${SIGNER.toLowerCase()}`]: JSON.stringify(resumedRecord()) },
    run: async (page, expect) => {
      await status(page, 'approving DAI')
      const titles = await page.locator('.steps .step-title').evaluateAll((all) => all.map((one) => one.firstChild?.textContent))
      expect(titles.join('|') === 'Commit|Approve DAI|Create your resolver|Register|Set your records', `a registration picked up after a reload lists ${titles.join(', ')}`)
    }
  },
  'register-relay-not-allowed': {
    scenario: { dai: 1000, rate: 0, grantRefused: true }, hash: '#/', run: async (page, expect) => {
      await register(page, 'abc'); await page.locator('label.switch').click()
      await page.waitForFunction(() => document.querySelector('#private-note')?.textContent?.includes('Orivon has not let this page') === true, null, { timeout: 15000 })
      const note = await page.locator('#private-note').textContent()
      expect(note.includes('press the key in the address bar') && note.includes('Connect to rpc.flashbots.net'), `the note of a refused grant says: ${note}`)
      expect(!(await page.locator('#private-switch').isChecked()), 'the switch is on though Orivon did not allow the host')
    }
  },
  'register-ready-private': { ...START, run: async (page) => { await register(page, 'abc'); await page.locator('label.switch').click(); await sleep(300) } },
  'register-signing': {
    ...START, run: async (page) => {
      await register(page, 'bobby')
      await page.evaluate(() => window.__fake.hold())
      await payButton(page).click(); await status(page, 'Waiting for your wallet to sign')
    }
  },
  'register-maturing': {
    ...START, run: async (page) => {
      await register(page, 'bobby'); await payButton(page).click()
      await page.waitForSelector('.timer', { timeout: 20000 }); await sleep(1500)
    }
  },
  'register-approving': {
    ...START, run: async (page) => {
      await register(page, 'bobby')
      await page.evaluate(() => { window.__fake.holdOn = window.__fake.calls + 1 })
      await payButton(page).click()
      await status(page, 'approving DAI'); await sleep(500)
    }
  },
  'register-done': {
    ...START, run: async (page) => {
      await register(page, 'bobby'); await payButton(page).click()
      await page.waitForSelector('.timer', { timeout: 20000 })
      await page.evaluate(() => window.__fake.advance(70)); await status(page, 'is yours')
    }
  },
  'register-failed-relay': {
    scenario: { dai: 1000, allowance: 800, relayRefuses: true, rate: 0 }, hash: '#/', run: async (page) => {
      await register(page, 'abc'); await page.locator('label.switch').click(); await sleep(300)
      await payButton(page).click(); await page.waitForSelector('.timer', { timeout: 20000 })
      await page.evaluate(() => window.__fake.advance(70)); await page.waitForSelector('.notice.bad', { timeout: 20000 })
    }
  },
  'register-failed-dai': { scenario: { dai: 3 }, hash: '#/', run: async (page) => { await checkName(page, 'bobby'); await page.waitForSelector('.notice.bad') } },
  'register-discarded': {
    scenario: { dai: 1000 }, hash: '#/', storage: { [`orivonid.registration.v1.${SIGNER.toLowerCase()}`]: JSON.stringify(DISCARDED) }, waitFor: '.panel .notice.bad',
    run: async (page, expect) => {
      expect(await page.getByRole('button', { name: 'Start again' }).count() === 1, 'a discarded registration does not offer to start again')
      expect((await page.locator('.panel').textContent())?.includes('did not match in the price') === true, 'the mismatch is not named')
    }
  },
  'me-empty': { hash: '#/me', waitFor: '.notice' },
  'me-ids': {
    scenario: RICH, hash: '#/me', waitFor: '.id-card',
    run: async (page, expect) => {
      await page.waitForFunction(() => document.querySelectorAll('article.id-card').length === 3 && document.querySelectorAll('article.id-card .record-list').length === 3, null, { timeout: 30000 })
      expect(await page.locator('article.id-card .notice').count() === 0, 'a card of My IDs shows a notice after the three were read in turn')
    }
  },
  'me-edit': {
    scenario: RICH, hash: '#/me', waitFor: '.id-card .record-list', run: async (page) => {
      await page.getByRole('button', { name: 'Edit records' }).first().click(); await page.waitForSelector('.edit')
    }
  },
  'me-end': {
    scenario: RICH, hash: '#/me', waitFor: '.id-card .record-list', run: async (page) => {
      await page.getByRole('button', { name: 'End all sign-ins' }).first().click(); await page.waitForSelector('.confirm')
    }
  },
  'me-ended': {
    scenario: RICH, hash: '#/me', waitFor: '.id-card .record-list', run: async (page) => {
      await page.getByRole('button', { name: 'End all sign-ins' }).first().click(); await page.waitForSelector('.confirm')
      await page.locator('.confirm').getByRole('button', { name: 'End all sign-ins' }).click(); await page.waitForSelector('.notice.ok', { timeout: 20000 }); await sleep(800)
    }
  },
  'me-end-not-held': {
    scenario: { names: ['alice'], notHeld: ['dave'] }, hash: '#/me', waitFor: '.id-card .record-list', run: async (page, expect) => {
      await page.waitForFunction(() => [...document.querySelectorAll('.id-card')].some((card) => card.textContent.includes('cannot end its sign-ins')), null, { timeout: 15000 })
      const cards = await page.locator('.id-card').evaluateAll((all) => all.map((card) => ({ name: card.querySelector('.id-name')?.textContent, end: [...card.querySelectorAll('button')].some((one) => one.textContent === 'End all sign-ins') })))
      expect(cards.find((one) => one.name?.startsWith('dave'))?.end === false, 'End all sign-ins is offered for a name whose records the holder cannot write')
      expect(cards.find((one) => one.name?.startsWith('alice'))?.end === true, 'End all sign-ins is not offered for a name the holder can write')
    }
  },
  'me-move-offer': {
    ...GIFTED, run: async (page, expect) => {
      expect(await page.getByRole('button', { name: 'Edit records' }).count() === 0, 'Edit records is offered for a name whose records the holder cannot write')
      expect(await page.getByRole('button', { name: MOVE_BUTTON }).count() === 1, 'the move is not offered for a name on a resolver the holder cannot write')
      await openMove(page)
      const panel = await page.locator('.move').textContent()
      expect(panel?.includes('Moving ends every sign-in') === true, 'the panel does not say that moving ends every sign-in')
      expect(panel?.includes('keeps its copy of the records') === true, 'the panel does not say that the old resolver keeps its copy')
      expect(await page.locator('.move input[type=checkbox]').isChecked(), 'Copy the current records is not ticked by default')
      expect(await page.locator('.move .step').count() === 3, 'the move does not list three steps')
    }
  },
  'me-move-running': {
    ...GIFTED, run: async (page, expect) => {
      await openMove(page)
      await page.evaluate(() => { window.__fake.holdOn = window.__fake.calls + 1 })
      await startMove(page)
      await page.waitForFunction(() => document.querySelector('.move .working')?.textContent?.includes('Waiting for your wallet to sign') === true, null, { timeout: 15000 })
      await page.waitForFunction(() => document.querySelector('.move .step')?.getAttribute('data-state') === 'done', null, { timeout: 15000 })
      expect(await page.locator('.move .step[data-state=active]').count() === 1, 'the step waiting for the wallet is not marked active')
      expect(await page.locator('.move button').count() === 0, 'a button is offered while the move runs')
    }
  },
  'me-move-done': {
    ...GIFTED, run: async (page, expect) => {
      await openMove(page)
      await startMove(page)
      // The reads of the move and of the card after it go through the page's queue, which paces them under Orivon's limits however fast the fake answers.
      await page.waitForFunction(() => document.querySelector('.notice.ok')?.textContent?.includes('now points at your resolver') === true, null, { timeout: 90000 })
      await page.waitForFunction(() => document.querySelector('.id-card .record-list') !== null, null, { timeout: 60000 })
      expect((await page.locator('.id-card .badge').textContent())?.trim() === 'Can sign in', 'the moved ID is not shown as able to sign in')
      expect(await page.getByRole('button', { name: 'Edit records' }).count() === 1, 'Edit records is not offered once the holder can write the records')
      expect(await page.getByRole('button', { name: MOVE_BUTTON }).count() === 0, 'the move is still offered after it ran')
    }
  },
  'connect-key': { scenario: RICH, hash: connectHash(`&state=abc&delegate=${KEY}&ttl=2592000`), waitFor: '.terms', fold: true, run: inView },
  'connect-plain': { scenario: RICH, hash: connectHash(), waitFor: '.terms', fold: true, run: inView },
  'connect-usable': {
    scenario: { names: ['alice', 'bob-1'] }, hash: connectHash(), waitFor: '.terms', fold: true,
    run: async (page, expect, viewport) => {
      await inView(page, expect, viewport)
      expect(await page.locator('.not-offered').count() === 0, 'the screen of an address whose IDs can all sign in lists IDs that cannot')
    }
  },
  'connect-ended': {
    scenario: { names: ['alice', 'bob-1'], texts: { alice: { [NOT_BEFORE]: ENDS_LATER } } }, hash: connectHash(), waitFor: '.not-offered', fold: true,
    run: async (page, expect, viewport) => {
      await inView(page, expect, viewport)
      expect(await page.locator('.not-offered').textContent().then((text) => text.includes('alice.v1.orivonid.eth') && text.includes('was just ended')), 'the ID whose sign-ins were just ended is not listed apart with why')
      expect(await page.locator('.ids-pick input[type=checkbox]').count() === 1, 'an ID whose sign-ins were just ended can be ticked')
    }
  },
  'connect-ended-all': {
    scenario: { names: ['alice'], texts: { alice: { [NOT_BEFORE]: ENDS_LATER } } }, hash: connectHash(), waitFor: '.not-offered', fold: true,
    run: async (page, expect) => {
      expect(await page.locator('.notice.info').textContent().then((text) => text.includes('were just ended')), 'the screen with every ID just ended says so')
      expect(await page.getByRole('button', { name: 'Check again' }).count() === 1, 'no way to check again once the time has passed')
    }
  },
  'connect-noid': { scenario: { dai: 5 }, hash: connectHash(), waitFor: '.notice.info' },
  'connect-invalid': { hash: connectHash('&nonce=x'), waitFor: '.notice.bad' },
  'connect-invalid-noreturn': { hash: '#/connect?v=1&return=http%3A%2F%2Fapp.example.org%2F&nonce=k3Jf92LmQp0xZ7aT', waitFor: '.notice.bad' },
  'connect-long': { scenario: RICH, hash: connectHash(`&delegate=${KEY}&ttl=600`, `https://${LONG_HOST}/path`), referer: `https://${LONG_HOST}/`, waitFor: '.terms' },
  'connect-long-return': {
    scenario: RICH, waitFor: '.terms',
    hash: connectHash(`&delegate=${KEY}&ttl=2592000`, `${AUDIENCE}/account/sessions/signed-in/callback?session=7f3a9c1e5b&redirect=${encodeURIComponent('https://app.example.org/dashboard/settings')}`)
  },
  'connect-framed': { scenario: RICH, hash: connectHash(`&delegate=${KEY}&ttl=2592000`), frame: true, wait: (page) => page.frameLocator('iframe').locator('.notice.bad').waitFor() },
  'connect-wrong-origin': { scenario: RICH, hash: connectHash(`&delegate=${KEY}&ttl=2592000`), referer: 'https://evil.example/win-a-prize', waitFor: '.notice.bad' },
  'connect-unverified': { scenario: RICH, hash: connectHash(), referer: '', waitFor: '.terms' },
  'connect-not-offered': {
    scenario: { names: ['alice'], unsetNames: ['dave'], notHeld: ['carol'] }, hash: connectHash(), waitFor: '.not-offered', fold: true,
    run: async (page, expect, viewport) => {
      await inView(page, expect, viewport)
      expect(await page.locator('.not-offered li').count() === 2, 'the two IDs that cannot sign in are not listed apart')
      expect(await page.locator('.ids-pick input[type=checkbox]').count() === 1, 'an ID that cannot sign in can be ticked')
    }
  },
  developers: { hash: '#/developers' }
}

const VIEWPORTS = [{ w: 360, h: 780 }, { w: 1280, h: 800 }]
const SCHEMES = ['light', 'dark']
const quick = process.env['QUICK'] === '1'
const names = Object.keys(SCENES).filter((name) => wanted.length === 0 || wanted.some((part) => name.includes(part)))
await mkdir(OUT, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] })
const problems = []
let count = 0
for (const name of names) {
  const scene = SCENES[name]
  for (const viewport of quick ? VIEWPORTS.slice(0, 1) : VIEWPORTS) {
    for (const scheme of quick ? SCHEMES.slice(0, 1) : SCHEMES) {
      const context = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h }, colorScheme: scheme, deviceScaleFactor: 1 })
      const page = await context.newPage()
      const label = `${name}-${viewport.w}-${scheme}`
      const expect = (condition, words) => { if (!condition) problems.push(`${label}: ${words}`) }
      page.on('pageerror', (error) => problems.push(`${label}: pageerror ${error.message}`))
      page.on('console', (message) => { if (message.type() === 'error') problems.push(`${label}: console ${message.text()}`) })
      await page.route('**/*', (route) => {
        const url = route.request().url()
        if (url.startsWith(ORIGIN)) return route.continue()
        problems.push(`${label}: OTHER ORIGIN ${url}`)
        return route.abort()
      })
      await page.exposeFunction('__fakeSign', (hex) => `0x${toHex(signDigest(PRIVATE_KEY, hashMessage(new TextDecoder().decode(fromHex(hex)))))}`)
      await page.exposeFunction('__fakeRecover', (hex) => {
        const data = fromHex(hex)
        const who = recoverAddress(data.subarray(0, 32), Uint8Array.from([...data.subarray(64, 128), data[63] ?? 0]))
        return who === null ? '0x' : `0x${'00'.repeat(12)}${who.slice(2)}`
      })
      if (scene.storage !== undefined) {
        await page.addInitScript({ content: `for (const [key, value] of Object.entries(${JSON.stringify(scene.storage)})) localStorage.setItem(key, value)` })
      }
      if (scene.extension) await page.addInitScript({ content: EXTENSION })
      if (!scene.noOrivon) {
        await page.addInitScript({ content: `${FAKE}
          (() => {
            const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
            const bytes = (h) => Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16))
            OrivonFake.installFakeOrivon(${JSON.stringify(scene.scenario ?? {})}, {
              account: ${JSON.stringify(SIGNER)},
              sign: async (m) => bytes(await window.__fakeSign(hex(m))),
              recover: async (d) => bytes(await window.__fakeRecover(hex(d)))
            })
          })()` })
      }
      const hash = scene.hash ?? ''
      const referer = scene.referer ?? (hash.startsWith('#/connect') ? `${AUDIENCE}/` : '')
      await page.goto(scene.frame ? `${ORIGIN}/__frame?h=${encodeURIComponent(hash)}` : `${ORIGIN}/index.html${hash}`, referer === '' ? {} : { referer })
      if (scene.wait) await scene.wait(page).catch((error) => problems.push(`${label}: wait ${error.message.split('\n')[0]}`))
      else if (scene.waitFor) await page.waitForSelector(scene.waitFor, { timeout: 30000 }).catch((error) => problems.push(`${label}: waitFor ${scene.waitFor} ${error.message.split('\n')[0]}`))
      else await sleep(600)
      try { if (scene.run) await scene.run(page, expect, viewport) } catch (error) { problems.push(`${label}: run ${error.message.split('\n')[0]}`) }
      await sleep(500)
      if (scene.fold) await page.screenshot({ path: join(OUT, `${label}-fold.png`) })
      // The whole page, with a window as tall as the page, so a bar that sticks to the foot of the window stands where it ends.
      await page.setViewportSize({ width: viewport.w, height: Math.max(viewport.h, await page.evaluate(() => document.documentElement.scrollHeight)) })
      await sleep(150)
      await page.screenshot({ path: join(OUT, `${label}.png`), fullPage: true })
      await page.setViewportSize({ width: viewport.w, height: viewport.h })
      try { if (scene.after) await scene.after(page, expect) } catch (error) { problems.push(`${label}: after ${error.message.split('\n')[0]}`) }
      count++
      await context.close()
    }
  }
}
await browser.close()
server.close()
console.log(JSON.stringify({ shots: count, out: OUT, problems }, null, 2))
process.exitCode = problems.length === 0 ? 0 : 1
