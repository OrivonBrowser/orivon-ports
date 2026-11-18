// What hooks.mjs makes of the built index.html: the two inline scripts moved to files, the `/#`
// redirect written so it keeps to the app's own root, the module entry held until the node answers,
// the node dashboard page, the helper scripts added to the head, and the two edits of the built code: the hook that reports the RPC connection, and the effect that follows a created community. The fixture is
// the shape of upstream's output, not a copy of it: a comment that itself says `<script>`, the module
// entry that is held, and the stylesheet the dashboard is drawn with.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEAD_SCRIPTS, HELD_TYPE, HELPER_SCRIPTS, helperScriptFile, INLINE_SCRIPT_COUNT, inlineScriptFile, NODE_CLIENT_FILE, NODE_DASHBOARD_FILE, NODE_DASHBOARD_MODULE, NODE_DASHBOARD_SCRIPT, NODE_THEME_SCRIPT, finishTree, CREATED_EFFECT_KEYED, keyCreatedEffect, RPC_STATE_SEEDED, seedRpcState, transformHtml } from '../hooks.mjs'

const REDIRECT_BODY = `
      // Redirect non-hash URLs to hash URLs on initial load
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
const SHELL_BODY = "(function () { document.body.classList.add('dark') })();"
const REDIRECT_AT = 0

const BUILT = [
  '<!doctype html><html><head>',
  '<!-- the inline <script> blocks below need unsafe-inline -->',
  `<script>${REDIRECT_BODY}</script>`,
  '<script type="module" crossorigin src="./assets/index-ABC.js"></script>',
  '<link rel="stylesheet" crossorigin href="./assets/src-DEF.css" data-seedit-app-preload disabled>',
  '</head><body><div id="root"></div>',
  `<script>${SHELL_BODY}</script>`,
  '</body></html>'
].join('\n')

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'seedit-hooks-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const run = (html: string) => transformHtml(html, { dirs: { static: dir } })

describe('the inline scripts', () => {
  it('move to files, and the page loads each in the place it stood', async () => {
    const html = await run(BUILT)
    expect(INLINE_SCRIPT_COUNT).toBe(2)
    const first = html.indexOf(`<script src="${inlineScriptFile(0)}"></script>`)
    const module = html.indexOf('<script type="orivon-held-module"')
    const second = html.indexOf(`<script src="${inlineScriptFile(1)}"></script>`)
    expect(first).toBeGreaterThan(-1)
    expect(first).toBeLessThan(module)
    expect(module).toBeLessThan(second)
    expect(html).not.toContain("classList.add('dark')")
    expect(html).not.toContain("window.location.replace('/#'")
  })

  it('are byte for byte except the redirect', async () => {
    await run(BUILT)
    expect(await readFile(join(dir, inlineScriptFile(1)), 'utf8')).toBe(SHELL_BODY)
  })

  it('leave a comment that mentions <script> as it was', async () => {
    const html = await run(BUILT)
    expect(html).toContain('<!-- the inline <script> blocks below need unsafe-inline -->')
  })

  it('are refused when there are not two with one redirect, which means upstream changed shape', async () => {
    await expect(run(`${BUILT}<script>var more = 1</script>`)).rejects.toThrow(/found 3 with 1/)
    await expect(run(BUILT.replace(`<script>${SHELL_BODY}</script>`, ''))).rejects.toThrow(/found 1 with 1/)
    await expect(run(BUILT.replace(`<script>${REDIRECT_BODY}</script>`, '<script>var other = 1</script>'))).rejects.toThrow(/found 2 with 0/)
  })

  it('come back unchanged when the page was already rewritten, so prepare may run twice', async () => {
    const once = await run(BUILT)
    expect(await run(once)).toBe(once)
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
    const replace = await redirected('https://seedit.orivonstack.eth/orivon/inline-script-1.js', { pathname: '/u/someone', search: '?lng=en' })
    expect(replace).toHaveBeenCalledWith('/#/u/someone?lng=en')
  })

  it('keeps to the folder the app is served from, so a path gateway does not lose it', async () => {
    const replace = await redirected('https://gateway.example/ipfs/bafyroot/orivon/inline-script-1.js', { pathname: '/ipfs/bafyroot/u/someone' })
    expect(replace).toHaveBeenCalledWith('/ipfs/bafyroot/#/u/someone')
  })

  it.each([
    ['the app\'s own root', '/'],
    ['the index page', '/index.html'],
    ['a path outside the app\'s folder', '/elsewhere/u']
  ])('leaves %s alone', async (_name, pathname) => {
    const root = pathname === '/elsewhere/u' ? 'https://h.example/ipfs/bafyroot/orivon/inline-script-1.js' : 'https://h.example/orivon/inline-script-1.js'
    expect(await redirected(root, { pathname })).not.toHaveBeenCalled()
  })

  it('leaves a path alone that already has a hash route, and a file: page', async () => {
    expect(await redirected('https://h.example/orivon/inline-script-1.js', { pathname: '/b', hash: '#/b' })).not.toHaveBeenCalled()
    expect(await redirected('file:///app/orivon/inline-script-1.js', { pathname: '/app/b', protocol: 'file:' })).not.toHaveBeenCalled()
  })
})

describe('the module entry', () => {
  it('keeps its address and attributes, and carries a type no browser runs, so it waits for the node', async () => {
    const html = await run(BUILT)
    expect(HELD_TYPE).toBe('orivon-held-module')
    expect(html).toContain('<script type="orivon-held-module" crossorigin src="./assets/index-ABC.js"></script>')
    expect(html).not.toContain('type="module"')
  })

  it('stays where it stood, between the two scripts that moved', async () => {
    const html = await run(BUILT)
    expect(html.indexOf(`<script src="${inlineScriptFile(0)}"></script>`)).toBeLessThan(html.indexOf('orivon-held-module'))
    expect(html.indexOf('orivon-held-module')).toBeLessThan(html.indexOf(`<script src="${inlineScriptFile(1)}"></script>`))
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

describe('the node dashboard', () => {
  it('is written beside the app in the app\'s own built stylesheet, with scripts from files and none inline', async () => {
    await run(BUILT)
    const page = await readFile(join(dir, NODE_DASHBOARD_FILE), 'utf8')
    expect(NODE_DASHBOARD_FILE).toBe('orivon/node/index.html')
    expect(page).toContain('<title>Node dashboard</title>')
    expect(page).toContain('<link rel="stylesheet" href="../../assets/src-DEF.css">')
    expect(page).not.toMatch(/<script>|<script(?![^>]*\ssrc=)|\son[a-z]+=/)
  })

  it('loads the script that sets its theme, then the node\'s page module and its dashboard module from the root of the tree, the script that starts the node, and its own script, in that order', async () => {
    await run(BUILT)
    const page = await readFile(join(dir, NODE_DASHBOARD_FILE), 'utf8')
    const sources = [...page.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1])
    expect(NODE_DASHBOARD_MODULE).toBe('node-dashboard.js')
    expect(sources).toEqual(['theme.js', `../../${NODE_CLIENT_FILE}`, '../node-start.js', `../../${NODE_DASHBOARD_MODULE}`, 'dashboard.js'])
    expect(new URL('../node-start.js', `https://h.example/${NODE_DASHBOARD_FILE}`).pathname).toBe(`/${helperScriptFile('node-start.js')}`)
  })

  it('has the one element its script mounts the dashboard module into, and names the sections this app offers in it', async () => {
    await run(BUILT)
    const page = await readFile(join(dir, NODE_DASHBOARD_FILE), 'utf8')
    const script = await readFile(new URL('./node-dashboard.js', import.meta.url), 'utf8')
    expect(script).toContain("document.getElementById('node-dashboard')")
    expect(page).toContain('<div id="node-dashboard"></div>')
    expect(script).toContain("term: 'community', features: ['listing-signature', 'name', 'challenges', 'seeding', 'reach']")
    expect(script).toContain("addressSetting: 'seedit\\'s Community Settings (the Address box)'")
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

describe('the node dashboard\'s theme', () => {
  it('is set by a script of the head that comes before the stylesheet, so nothing waits on the stylesheet and the class is on the body before the first frame', async () => {
    await run(BUILT)
    const page = await readFile(join(dir, NODE_DASHBOARD_FILE), 'utf8')
    const head = page.slice(0, page.indexOf('</head>'))
    expect(head).toContain('<script src="theme.js"></script>')
    expect(head.indexOf('<script src="theme.js"></script>')).toBeLessThan(head.indexOf('<link rel="stylesheet"'))
    expect(page.indexOf('<script src="theme.js"></script>')).toBeLessThan(page.indexOf('<body'))
  })

  it('is the dark class in the markup, which is what the page wears when the script cannot say', async () => {
    await run(BUILT)
    expect(await readFile(join(dir, NODE_DASHBOARD_FILE), 'utf8')).toContain('<body class="dark">')
  })

  it('has its script copied byte for byte from the bridge folder', async () => {
    await run(BUILT)
    expect(NODE_THEME_SCRIPT).toBe('orivon/node/theme.js')
    expect(await readFile(join(dir, NODE_THEME_SCRIPT), 'utf8')).toBe(await readFile(new URL('./node-theme.js', import.meta.url), 'utf8'))
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

// The shape of upstream's built hook, with the names its minifier gave, and two other places that use the same word.
const RPC_HOOK = 'let{accountName:t}=e??{},n=Z({accountName:t}),r=mt(n),i=bp(r),[o,s]=(0,p.useState)(),[c,l]=(0,p.useState)(`initializing`),[u,d]=(0,p.useState)([]);(0,p.useEffect)(()=>{if(!n||!r||!i)return;i.settings!=null&&s(i.settings);let e=i.state;e!=null&&e!==``&&l(e)},[n?.id,i,r]);'
const OTHER_USES = 'let l=s?`succeeded`:i?.state||`initializing`;let [q,w]=(0,p.useState)(`initializing`),[x,y]=(0,p.useState)(0);'
const SCRIPT = `export{a as b};function xp(e){${RPC_HOOK}return 1}function other(){${OTHER_USES}}`

/** The first state the hook's code gives, run against a connection in `clientState` (or none). */
function firstState (code: string, clientState: string | undefined): unknown {
  const run = vm.runInNewContext(`(function (e, Z, mt, bp, p) { ${code} return c })`) as (...args: unknown[]) => unknown
  const connection = clientState === undefined ? undefined : { state: clientState, settings: null, on: () => {} }
  return run(undefined, () => ({ id: 1 }), () => ({}), () => connection, { useState: (initial: unknown) => [initial, () => {}], useEffect: () => {} })
}

describe('the RPC connection state of the settings hook', () => {
  it('starts from the connection\'s own state, which is what its effect sets a moment later', () => {
    const { code, edits } = seedRpcState(RPC_HOOK)
    expect(edits).toBe(1)
    expect(firstState(RPC_HOOK, 'connected')).toBe('initializing')
    expect(firstState(code, 'connected')).toBe('connected')
    expect(firstState(code, 'stopped')).toBe('stopped')
  })

  it('stays `initializing` when there is no connection or it has no state yet', () => {
    const { code } = seedRpcState(RPC_HOOK)
    expect(firstState(code, undefined)).toBe('initializing')
    expect(firstState(code, '')).toBe('initializing')
  })

  it('changes nothing else in the script, and nothing at all when it already did', () => {
    const { code } = seedRpcState(SCRIPT)
    expect(code).toBe(SCRIPT.replace('(0,p.useState)(`initializing`),[u,d]', '(0,p.useState)(i?.state||`initializing`),[u,d]'))
    expect(RPC_STATE_SEEDED.test(SCRIPT)).toBe(false)
    expect(RPC_STATE_SEEDED.test(code)).toBe(true)
    expect(seedRpcState(code)).toEqual({ code, edits: 0 })
  })
})

// The shape of the effect upstream's create page runs once a community exists (community-settings.tsx), with the names its minifier gave.
const CREATED_EFFECT = '(0,j.useEffect)(()=>{$&&(console.log(`createdCommunity`,$),alert(`community created, address: ${g($.address||``)}`),G&&$.address&&Pe(),ve(),$.address&&q(f($.address)))},[$,q,ve,G,Pe]);'
const CREATED_PAGE = `let a=1;${CREATED_EFFECT}let Fe=(0,j.useRef)(void 0);(0,j.useEffect)(()=>{J&&ve()},[J,be,ve,ye,G,ie]);`

/** What the page does in each render of one component that holds the effect: React runs an effect again when a value of its list is not the one it had. */
function renderCreated (code: string, renders: ReadonlyArray<{ created: { address: string } | undefined, subscribe: () => void, account: object }>) {
  const calls = { alert: 0, subscribe: 0, reset: 0, navigate: 0 }
  let held: unknown[] | undefined
  const react = { useEffect: (effect: () => void, deps: unknown[]) => { if (held === undefined || deps.length !== held.length || deps.some((one, at) => !Object.is(one, held?.[at]))) { held = deps; effect() } }, useRef: () => ({}) }
  const reset = () => { calls.reset += 1 }
  const navigate = () => { calls.navigate += 1 }
  for (const render of renders) {
    const subscribe = () => { calls.subscribe += 1; render.subscribe() }
    vm.runInNewContext(`(function () { ${code} })()`, { j: react, $: render.created, G: render.account, Pe: subscribe, ve: reset, q: navigate, f: (address: string) => `/s/${address}`, g: (address: string) => address, alert: () => { calls.alert += 1 }, console: { log: () => {} }, J: false, be: 0, ye: 0, ie: 0 })
  }
  return calls
}

describe('the effect that follows a created community', () => {
  const account = {}
  const made = { address: '12D3Koo' }
  /** A render after the community was made: `subscribe` is a new function, as the hook's is whenever its list of errors or its flag changes. */
  const rerender = { created: made, subscribe: () => {}, account }

  it('runs once for a community, not again when `subscribe` is a new function in the next render (upstream\'s hook makes a new one for each error it keeps, and the call throws "already subscribed")', () => {
    const renders = [{ created: undefined, subscribe: () => {}, account }, rerender, rerender, rerender]
    expect(renderCreated(CREATED_EFFECT, renders)).toEqual({ alert: 4 - 1, subscribe: 4 - 1, reset: 4 - 1, navigate: 4 - 1 })
    const { code, edits } = keyCreatedEffect(CREATED_EFFECT)
    expect(edits).toBe(1)
    expect(renderCreated(code, renders)).toEqual({ alert: 1, subscribe: 1, reset: 1, navigate: 1 })
  })

  it('still runs for a second community, with that community\'s address', () => {
    const { code } = keyCreatedEffect(CREATED_EFFECT)
    expect(renderCreated(code, [rerender, { ...rerender, created: { address: '12D3Kon' } }])).toEqual({ alert: 2, subscribe: 2, reset: 2, navigate: 2 })
  })

  it('changes nothing else in the script, and nothing at all when it already did', () => {
    const { code } = keyCreatedEffect(CREATED_PAGE)
    expect(code).toBe(CREATED_PAGE.replace('[$,q,ve,G,Pe]', '[$]'))
    expect(CREATED_EFFECT_KEYED.test(CREATED_PAGE)).toBe(false)
    expect(CREATED_EFFECT_KEYED.test(code)).toBe(true)
    expect(keyCreatedEffect(code)).toEqual({ code, edits: 0 })
  })
})

describe('finishTree', () => {
  const asset = async (name: string, code: string) => {
    await mkdir(join(dir, 'assets'), { recursive: true })
    await writeFile(join(dir, 'assets', name), code)
  }
  const read = (name: string) => readFile(join(dir, 'assets', name), 'utf8')

  it('edits the script that holds each place and leaves the others as they were', async () => {
    await asset('dist-A.js', SCRIPT)
    await asset('community-settings-D.js', CREATED_PAGE)
    await asset('app-B.js', 'const a = 1')
    await finishTree({ dirs: { static: dir } })
    expect(RPC_STATE_SEEDED.test(await read('dist-A.js'))).toBe(true)
    expect(CREATED_EFFECT_KEYED.test(await read('community-settings-D.js'))).toBe(true)
    expect(await read('app-B.js')).toBe('const a = 1')
  })

  it('may run twice on the same tree', async () => {
    await asset('dist-A.js', SCRIPT)
    await asset('community-settings-D.js', CREATED_PAGE)
    await finishTree({ dirs: { static: dir } })
    const once = [await read('dist-A.js'), await read('community-settings-D.js')]
    await finishTree({ dirs: { static: dir } })
    expect([await read('dist-A.js'), await read('community-settings-D.js')]).toEqual(once)
  })

  it('is refused when no script holds the hook, or two do, which means upstream changed shape', async () => {
    await asset('app-B.js', 'const a = `initializing`')
    await expect(finishTree({ dirs: { static: dir } })).rejects.toThrow(/expected one usePkcRpcSettings hook/)
    await asset('dist-A.js', SCRIPT)
    await asset('dist-C.js', SCRIPT)
    await expect(finishTree({ dirs: { static: dir } })).rejects.toThrow(/edited 2/)
  })

  it('is refused when no script holds the effect of a created community, or two do, which means upstream changed shape', async () => {
    await asset('dist-A.js', SCRIPT)
    await expect(finishTree({ dirs: { static: dir } })).rejects.toThrow(/expected one effect of a created community/)
    await asset('community-settings-D.js', CREATED_PAGE)
    await asset('community-settings-E.js', CREATED_PAGE)
    await expect(finishTree({ dirs: { static: dir } })).rejects.toThrow(/edited 2/)
  })
})
