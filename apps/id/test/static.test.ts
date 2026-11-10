import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { RELAY } from '../site/relay.js'

const manifest = JSON.parse(await readFile(new URL('../orivon.json', import.meta.url), 'utf8'))
const recipe = JSON.parse(await readFile(new URL('../recipe.json', import.meta.url), 'utf8'))
const SITE = new URL('../site/', import.meta.url)
const listed = await readdir(SITE, { recursive: true })
const files = listed.filter((name) => name.endsWith('.js'))
const read = async (name: string) => await readFile(new URL(name, SITE), 'utf8')

/** The one URL a page may spell out that is not an address to reach: the namespace SVG elements are made in. */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

describe('the manifest', () => {
  it('names the same origin as the recipe, and asks for the Ethereum standards and the one host of the optional private send', () => {
    expect(manifest.domain).toBe(recipe.eth)
    expect(manifest.id).toBe('eth.orivonstack.id')
    expect(manifest.entry).toBe('index.html')
    expect(manifest.consentGranularity).toBe('per-capability')
    expect(manifest.standards).toEqual(['ETH_NET_0_1_READONLY', 'ETH_NET_0_1', 'ETH_0_1'])
    expect(manifest.capabilities).toEqual({ net: { https: { connect: [RELAY.pattern] } } })
  })
})

describe('the site files', () => {
  it('are plain, unminified modules under 500 lines', async () => {
    expect(files.length).toBeGreaterThan(5)
    for (const name of files) {
      const lines = (await readFile(new URL(name, SITE), 'utf8')).split('\n')
      expect(lines.length, name).toBeLessThan(500)
      expect(Math.max(...lines.map((line) => line.length)), name).toBeLessThan(200)
    }
  })

  it('reach no other origin, except the one optional send in relay.js: no fetch, request object, socket, eval or URL elsewhere', async () => {
    for (const name of files) {
      const source = (await readFile(new URL(name, SITE), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replaceAll(SVG_NAMESPACE, '')
      const forbidden = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|\beval\s*\(|new Function|https?:\/\//
      if (name !== 'relay.js') {
        expect(source, name).not.toMatch(forbidden)
        continue
      }
      expect(source.match(/https?:\/\/[^'"`\s]*/g), name).toEqual([RELAY.url])
      expect(source, name).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|\beval\s*\(|new Function/)
      expect(source.match(/\bpost\(/g), name).toHaveLength(1)
    }
  })
})

describe('the page', () => {
  it('names the SVG namespace in icons.js and nowhere else', async () => {
    for (const name of files) expect((await read(name)).includes(SVG_NAMESPACE), name).toBe(name === 'icons.js')
  })

  it('writes no markup from a string: elements are built, and text is set as text', async () => {
    for (const name of files) {
      const source = (await read(name)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(source, name).not.toMatch(/\.(?:inner|outer)HTML|insertAdjacentHTML|document\.write|\bsrcdoc\b|createContextualFragment|\.setHTML/)
    }
  })

  it('imports only files of its own', async () => {
    for (const name of files) {
      const source = await read(name)
      const specifiers = [
        ...source.matchAll(/^(?:import|export)\s*(?:[\w*{][^'";]*?)?\bfrom\s*['"]([^'"]+)['"]/gm),
        ...source.matchAll(/^import\s*['"]([^'"]+)['"]/gm),
        ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)
      ]
      for (const found of specifiers) expect(found[1], name).toMatch(/^\.{1,2}\//)
    }
  })

  it('opens from index.html, the manifest\'s entry, with one module script that is a file and nothing inline', async () => {
    const html = await read('index.html')
    expect(listed).toContain(manifest.entry)
    expect(html.match(/<script\b[^>]*>/gi)).toEqual(['<script type="module" src="main.js">'])
    expect(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)?.[1]).toBe('')
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    expect(html).not.toMatch(/javascript:/i)
    expect(html).not.toMatch(/\sstyle\s*=/i)
    expect(html).not.toMatch(/<style\b/i)
    expect(html).not.toMatch(/<iframe|<object|<embed|<form\b/i)
  })

  it('has one stylesheet, a file of its own', async () => {
    const html = await read('index.html')
    expect(html.match(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)).toEqual(['<link rel="stylesheet" href="style.css">'])
    expect(listed.filter((name) => name.endsWith('.css'))).toEqual(['style.css'])
  })

  it('reaches no other origin from the HTML, the stylesheet or an icon: every address is a file beside it', async () => {
    const html = await read('index.html')
    for (const found of html.matchAll(/\b(?:href|src|action|poster|data|srcset)\s*=\s*"([^"]*)"/gi)) expect(found[1], 'index.html').toMatch(/^[A-Za-z0-9._-]+$/)
    expect(html).not.toMatch(/https?:|\/\/[a-z0-9.-]+\.[a-z]/i)
    const css = await read('style.css')
    expect(css).not.toMatch(/@import|https?:|\/\/[a-z0-9.-]+\.[a-z]/i)
    for (const found of css.matchAll(/url\(\s*['"]?([^'")]*)/gi)) expect(found[1], 'style.css').toMatch(/^(?:data:image\/svg\+xml|#)/)
    expect(css).not.toMatch(/@font-face/)
    for (const name of listed.filter((entry) => entry.endsWith('.svg'))) {
      const svg = (await read(name)).replaceAll(SVG_NAMESPACE, '')
      expect(svg, name).not.toMatch(/<script|\son[a-z]+\s*=|href|https?:|<image|<foreignObject/i)
    }
  })

  it('uses the system fonts, with no font file or font host', async () => {
    const css = await read('style.css')
    expect(css).toMatch(/system-ui/)
    expect(listed.filter((name) => /\.(?:woff2?|ttf|otf|png|jpe?g|gif|webp|ico)$/i.test(name))).toEqual([])
  })

  it('answers dark mode and a narrow screen in the stylesheet', async () => {
    const css = await read('style.css')
    expect(css).toMatch(/prefers-color-scheme:\s*dark/)
    expect(css).toMatch(/max-width:\s*5\d\dpx/)
    expect(css).toMatch(/:focus-visible/)
  })

  it('takes every way back to the requesting site from exitTarget, and the answer from signIn', async () => {
    const connect = await read('view-connect.js')
    expect(connect).not.toMatch(/cancelUrl|invalidRequestUrl|errorUrl|successUrl|returnUrl/)
    expect(connect).toMatch(/app\.leave\(exit\.url\)/)
    expect(connect).toMatch(/connectEntry\(\{ hash: route\.hash, referrer: document\.referrer, framed: window\.top !== window \}\)/)
    const leaves = [...connect.matchAll(/app\.leave\(([^)]*)\)/g)].map((found) => found[1])
    expect(leaves.sort()).toEqual(['exit.url', 'exit.url', 'url'])
  })

  it('asks the node about a name when the person presses the button, never as they type', async () => {
    const search = await read('view-search.js')
    expect(search).not.toMatch(/ownerOf|setTimeout|clearTimeout|TYPING_PAUSE|\bdebounce/i)
    const typing = search.slice(search.indexOf("input.addEventListener('input'"), search.indexOf("form.addEventListener('submit'"))
    expect(typing).not.toMatch(/\.check\(|askAboutName|salesStatus|connect\(|await /)
    expect(search).toContain('askAboutName')
    expect(search).toContain('SEARCH_WORDS')
  })

  it('ends sign-ins only after revokeAllCall has been asked for the holder, before the button is drawn', async () => {
    const card = await read('view-me-card.js')
    expect(card.match(/revokeAllCall\(/g)).toHaveLength(2)
    expect(card.match(/revokeAllCall\([^\n]*\{ holder: address \}\)/g)).toHaveLength(2)
    expect(card).toMatch(/end\?\.canEnd === true \? button\('End all sign-ins'/)
  })

  it('says that the wallet will warn in the bar of the Sign in button, directly above it, and keeps the bar at the foot of the window', async () => {
    const connect = await read('view-connect.js')
    const bar = connect.indexOf("class: 'sign-bar'")
    const warning = connect.indexOf("class: 'wallet-warning'")
    const actions = connect.indexOf("class: 'actions'", bar)
    expect(connect.match(/class: 'wallet-warning'/g)).toHaveLength(1)
    expect(bar).toBeGreaterThan(connect.indexOf("class: 'terms'"))
    expect(warning).toBeGreaterThan(bar)
    expect(actions).toBeGreaterThan(warning)
    expect(connect.indexOf("button('Sign in'", warning)).toBeGreaterThan(actions)
    expect(connect.slice(warning, actions).replace(/\s+/g, ' ')).toBe("class: 'wallet-warning', text: view.walletWarning }), el('div', { ")
    const style = await read('style.css')
    expect(style).toMatch(/\.connect-body > \.sign-bar \{[^}]*position: sticky; bottom: 0/)
    expect(style).toMatch(/\.connect-body \{ display: contents; \}/)
  })

  it('serves the protocol it links to', async () => {
    expect(listed).toContain('PROTOCOL.md')
    expect(await read('view-developers.js')).toContain("href: 'PROTOCOL.md'")
  })
})
