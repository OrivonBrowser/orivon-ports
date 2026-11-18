// What hooks.mjs makes of the built index.html: the six inline scripts moved to files, the `/#`
// redirect written so it keeps to the app's own root, the module entry held until the node answers,
// the node dashboard page, and the helper scripts added to the head. The fixture is
// the shape of upstream's output, not a copy of it: a comment that itself says `<script>`, JSON data
// blocks that must stay, and the stylesheet the dashboard is drawn with.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEAD_SCRIPTS, HELD_TYPE, HELPER_SCRIPTS, helperScriptFile, INLINE_SCRIPT_COUNT, inlineScriptFile, NODE_CLIENT_FILE, NODE_DASHBOARD_FILE, NODE_DASHBOARD_MODULE, NODE_DASHBOARD_SCRIPT, transformHtml } from '../hooks.mjs'

const REDIRECT_BODY = `
      if (
        window.location.protocol !== 'file:' &&
        window.location.pathname &&
        window.location.pathname !== '/' &&
        !window.location.pathname.endsWith('/index.html') &&
        !window.location.hash
      ) {
        window.location.replace('/#' + window.location.pathname + window.location.search);
      }
    `
const BODIES = ["(function () { window.__prefetch = 1 })();", REDIRECT_BODY, "(function () { var t = 'translations' })();", "(function () { document.body.classList.add('yotsuba') })();", "(function () { var preload = 1 })();", "(function () { window.__shell = 1 })();"]
const REDIRECT_AT = 1

const BUILT = [
  '<!doctype html><html><head>',
  '<!-- the inline <script> blocks below need unsafe-inline -->',
  '<script type="application/json" id="fivechan-stats-prefetch">{"urls":[]}</script>',
  `<script>${BODIES[0]}</script>`,
  `<script>${BODIES[1]}</script>`,
  '<script type="application/ld+json">{"@type":"WebApplication"}</script>',
  `<script>${BODIES[2]}</script>`,
  '<script type="module" crossorigin src="./assets/index-ABC.js"></script>',
  '<link rel="stylesheet" crossorigin href="./assets/src-DEF.css" data-fivechan-app-preload disabled>',
  `<script>${BODIES[3]}</script>`,
  '<script id="vite-plugin-pwa:register-sw" src="./registerSW.js" defer></script>',
  '</head><body>',
  `<script>${BODIES[4]}</script>`,
  `<script>${BODIES[5]}</script>`,
  '</body></html>'
].join('\n')

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fivechan-hooks-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const run = (html: string) => transformHtml(html, { dirs: { static: dir } })

describe('the inline scripts', () => {
  it('move to files, and the page loads each in the place it stood', async () => {
    const html = await run(BUILT)
    expect(INLINE_SCRIPT_COUNT).toBe(6)
    const order = BODIES.map((_body, index) => html.indexOf(`<script src="${inlineScriptFile(index)}"></script>`))
    expect(order.every((at) => at !== -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).not.toContain('window.__prefetch')
    expect(html).not.toContain("window.location.replace('/#'")
  })

  it('are all byte for byte except the redirect', async () => {
    await run(BUILT)
    for (const [index, body] of BODIES.entries()) {
      if (index !== REDIRECT_AT) expect(await readFile(join(dir, inlineScriptFile(index)), 'utf8')).toBe(body)
    }
  })

  it('leave the JSON data blocks and the registration script, and a comment that mentions <script>, as they were', async () => {
    const html = await run(BUILT)
    for (const kept of [
      '<script type="application/json" id="fivechan-stats-prefetch">{"urls":[]}</script>',
      '<script type="application/ld+json">{"@type":"WebApplication"}</script>',
      '<script id="vite-plugin-pwa:register-sw" src="./registerSW.js" defer></script>',
      '<!-- the inline <script> blocks below need unsafe-inline -->'
    ]) expect(html).toContain(kept)
  })

  it('are refused when there are not six with one redirect, which means upstream changed shape', async () => {
    await expect(run(`${BUILT}<script>var more = 1</script>`)).rejects.toThrow(/found 7 with 1/)
    await expect(run(BUILT.replace(`<script>${BODIES[0]}</script>`, ''))).rejects.toThrow(/found 5 with 1/)
    await expect(run(BUILT.replace(`<script>${REDIRECT_BODY}</script>`, '<script>var other = 1</script>'))).rejects.toThrow(/found 6 with 0/)
  })

  it('come back unchanged when the page was already rewritten, so prepare may run twice', async () => {
    const once = await run(BUILT)
    expect(await run(once)).toBe(once)
  })
})

describe('the module entry', () => {
  it('keeps its address and attributes, and carries a type no browser runs, so it waits for the node', async () => {
    const html = await run(BUILT)
    expect(HELD_TYPE).toBe('orivon-held-module')
    expect(html).toContain('<script type="orivon-held-module" crossorigin src="./assets/index-ABC.js"></script>')
    expect(html).not.toContain('type="module"')
  })

  it('is held once, however often the page is prepared', async () => {
    const twice = await run(await run(BUILT))
    expect(twice.split('type="orivon-held-module"').length - 1).toBe(1)
  })

  it('is refused when the page has no entry or two, which means upstream changed shape', async () => {
    await expect(run(BUILT.replace('<script type="module" crossorigin src="./assets/index-ABC.js"></script>', ''))).rejects.toThrow(/found 0/)
    await expect(run(`${BUILT.replace('</head>', '<script type="module" crossorigin src="./assets/index-XYZ.js"></script></head>')}`)).rejects.toThrow(/found 2/)
  })
})

describe('the redirect from a path to a hash route', () => {
  async function redirected (src: string, location: Record<string, string>) {
    await run(BUILT)
    const replace = vi.fn()
    const sandbox = { window: { location: { protocol: 'https:', hash: '', search: '', ...location, replace } }, document: { currentScript: { src } }, URL }
    vm.runInNewContext(await readFile(join(dir, inlineScriptFile(REDIRECT_AT)), 'utf8'), sandbox)
    return replace
  }

  it('sends a deep link at the root of its host to the same route behind a hash, as upstream\'s does', async () => {
    const replace = await redirected('https://5chan.orivonstack.eth/orivon/inline-script-2.js', { pathname: '/b/catalog', search: '?s=cats' })
    expect(replace).toHaveBeenCalledWith('/#/b/catalog?s=cats')
  })

  it('keeps to the folder the app is served from, so a path gateway does not lose it', async () => {
    const replace = await redirected('https://gateway.example/ipfs/bafyroot/orivon/inline-script-2.js', { pathname: '/ipfs/bafyroot/b/catalog' })
    expect(replace).toHaveBeenCalledWith('/ipfs/bafyroot/#/b/catalog')
  })

  it.each([
    ['the app\'s own root', '/'],
    ['the index page', '/index.html'],
    ['a path outside the app\'s folder', '/elsewhere/b']
  ])('leaves %s alone', async (_name, pathname) => {
    const root = pathname === '/elsewhere/b' ? 'https://h.example/ipfs/bafyroot/orivon/inline-script-2.js' : 'https://h.example/orivon/inline-script-2.js'
    expect(await redirected(root, { pathname })).not.toHaveBeenCalled()
  })

  it('leaves a path alone that already has a hash route, and a file: page', async () => {
    expect(await redirected('https://h.example/orivon/inline-script-2.js', { pathname: '/b', hash: '#/b' })).not.toHaveBeenCalled()
    expect(await redirected('file:///app/orivon/inline-script-2.js', { pathname: '/app/b', protocol: 'file:' })).not.toHaveBeenCalled()
  })
})

describe('the node dashboard', () => {
  it('is written beside the app in the app\'s own built stylesheet, with scripts from files and none inline', async () => {
    await run(BUILT)
    const page = await readFile(join(dir, NODE_DASHBOARD_FILE), 'utf8')
    expect(NODE_DASHBOARD_FILE).toBe('orivon/node/index.html')
    expect(page).toContain('<title>Node dashboard</title>')
    expect(page).toContain('<link rel="stylesheet" href="../../assets/src-DEF.css">')
    expect(page).not.toMatch(/<script>|<script(?![^>]*\ssrc=)|\son[a-z]+=/)
  })

  it('loads the node\'s page module and its dashboard module from the root of the tree, the script that starts the node, and its own script, in that order', async () => {
    await run(BUILT)
    const page = await readFile(join(dir, NODE_DASHBOARD_FILE), 'utf8')
    const sources = [...page.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1])
    expect(NODE_DASHBOARD_MODULE).toBe('node-dashboard.js')
    expect(sources).toEqual([`../../${NODE_CLIENT_FILE}`, '../node-start.js', `../../${NODE_DASHBOARD_MODULE}`, 'dashboard.js'])
    expect(new URL('../node-start.js', `https://h.example/${NODE_DASHBOARD_FILE}`).pathname).toBe(`/${helperScriptFile('node-start.js')}`)
  })

  it('wears yotsuba, the theme 5chan\'s own pages that are not a board wear whatever style the person chose, so it reads no stored theme', async () => {
    await run(BUILT)
    const page = await readFile(join(dir, NODE_DASHBOARD_FILE), 'utf8')
    expect(page).toContain('<body class="yotsuba">')
    expect(page).not.toMatch(/5chan-themes|localStorage/)
  })

  it('has the one element its script mounts the dashboard module into, and names the sections this app offers in it', async () => {
    await run(BUILT)
    const page = await readFile(join(dir, NODE_DASHBOARD_FILE), 'utf8')
    const script = await readFile(new URL('./node-dashboard.js', import.meta.url), 'utf8')
    expect(script).toContain("document.getElementById('node-dashboard')")
    expect(page).toContain('<div id="node-dashboard"></div>')
    expect(script).toContain("term: 'board', features: ['board-manager', 'listing', 'name', 'challenges', 'seeding', 'reach']")
    expect(script).toContain('addressSetting: \'5chan\\\'s Board Settings (the "address" line)\'')
  })

  it('styles the module\'s own classes in the page, so the dashboard takes this app\'s look', async () => {
    await run(BUILT)
    const page = await readFile(join(dir, NODE_DASHBOARD_FILE), 'utf8')
    for (const name of ['nd-status', 'nd-board', 'nd-field', 'nd-label', 'nd-input', 'nd-button', 'nd-field-error', 'nd-challenge', 'nd-rule', 'nd-changes', 'nd-requirement', 'nd-request', 'nd-preview']) expect(page, name).toContain(`.${name}`)
    expect(page).toContain('[hidden] { display: none !important; }')
  })

  it('keeps a long choice and a long default inside the card that holds them', async () => {
    await run(BUILT)
    const page = await readFile(join(dir, NODE_DASHBOARD_FILE), 'utf8')
    expect(page).toMatch(/select\.nd-input \{[^}]*max-width: 100%/)
    expect(page).toMatch(/\.nd-hint \{[^}]*overflow-wrap: anywhere/)
  })

  it('has its script copied byte for byte from the bridge folder', async () => {
    await run(BUILT)
    expect(NODE_DASHBOARD_SCRIPT).toBe('orivon/node/dashboard.js')
    expect(await readFile(join(dir, NODE_DASHBOARD_SCRIPT), 'utf8')).toBe(await readFile(new URL('./node-dashboard.js', import.meta.url), 'utf8'))
  })

  it('is refused when the built page names no such stylesheet, which means upstream changed shape', async () => {
    await expect(run(BUILT.replace('src-DEF.css', 'other-DEF.css'))).rejects.toThrow(/assets\/src-\*\.css/)
  })
})

describe('the helper scripts', () => {
  const tag = (src: string) => `<script src="${src}"></script>`

  it('are the upload script, the Turnstile script, the embeds script and the script that starts the node, each served from orivon/', () => {
    expect(HELPER_SCRIPTS).toEqual(['webview-upload.js', 'webview-turnstile.js', 'webview-embeds.js', 'node-start.js'])
    expect(HELPER_SCRIPTS.map(helperScriptFile)).toEqual(['orivon/webview-upload.js', 'orivon/webview-turnstile.js', 'orivon/webview-embeds.js', 'orivon/node-start.js'])
  })

  it('are copied byte for byte from the bridge folder into the served tree', async () => {
    await run(BUILT)
    for (const name of HELPER_SCRIPTS) {
      expect(await readFile(join(dir, helperScriptFile(name)), 'utf8')).toBe(await readFile(new URL(`./${name}`, import.meta.url), 'utf8'))
    }
  })

  it('are loaded last in the head, as plain scripts that run before the body is read, the node\'s page module before the script that uses it', async () => {
    const html = await run(BUILT)
    const head = html.slice(0, html.indexOf('</head>'))
    expect(HEAD_SCRIPTS).toEqual(['orivon/webview-upload.js', 'orivon/webview-turnstile.js', 'orivon/webview-embeds.js', NODE_CLIENT_FILE, 'orivon/node-start.js'])
    expect(head.endsWith(`${HEAD_SCRIPTS.map(tag).join('\n')}\n`)).toBe(true)
  })

  it('are added once, however often the page is prepared', async () => {
    const twice = await run(await run(BUILT))
    for (const src of HEAD_SCRIPTS) expect(twice.split(tag(src)).length - 1).toBe(1)
  })

  it('are refused a page with no head to put them in, which means upstream changed shape', async () => {
    await expect(run(BUILT.replace('</head>', ''))).rejects.toThrow(/no <\/head>/)
  })
})
