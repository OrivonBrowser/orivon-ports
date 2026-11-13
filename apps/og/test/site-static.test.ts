import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { RELAY } from '../site/relay.js'
import { ROUTES } from '../site/router.js'

const manifest = JSON.parse(await readFile(new URL('../orivon.json', import.meta.url), 'utf8'))
const recipe = JSON.parse(await readFile(new URL('../recipe.json', import.meta.url), 'utf8'))
const SITE = new URL('../site/', import.meta.url)
const listed = (await readdir(SITE, { recursive: true })).filter((name) => !name.startsWith('resolver'))
const files = listed.filter((name) => name.endsWith('.js'))
const read = async (name: string) => await readFile(new URL(name, SITE), 'utf8')
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** The one URL a page may spell out that is not an address to reach: the namespace SVG elements are made in. */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

describe('the manifest', () => {
  it('names the same origin as the recipe, asks for the Ethereum standards, the one host of the optional private send and the grant its mark needs', () => {
    expect(manifest.domain).toBe(recipe.eth)
    expect(manifest.entry).toBe('index.html')
    expect(manifest.standards).toEqual(['ETH_NET_0_1_READONLY', 'ETH_NET_0_1', 'ETH_0_1'])
    expect(manifest.capabilities).toEqual({ net: { https: { connect: [RELAY.pattern] } }, trust: { score: true } })
  })
})

describe('the site files', () => {
  it('are plain, unminified modules under 500 lines', async () => {
    expect(files.length).toBeGreaterThan(10)
    for (const name of files) {
      const lines = (await read(name)).split('\n')
      expect(lines.length, name).toBeLessThan(500)
      expect(Math.max(...lines.map((line) => line.length)), name).toBeLessThan(200)
    }
  })

  it('reach no other origin, except the one optional send in relay.js: no fetch, request object, socket, eval or URL elsewhere', async () => {
    for (const name of files) {
      const source = code(await read(name)).replaceAll(SVG_NAMESPACE, '')
      const forbidden = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|\beval\s*\(|new Function|https?:\/\//
      if (name === 'relay.js') {
        expect(source.match(/https?:\/\/[^'"`\s]*/g), name).toEqual([RELAY.url])
        expect(source.match(/\bpost\(/g), name).toHaveLength(1)
      } else if (name === 'app.js') {
        // The census is a file of the bundle, read once from beside the resolver.
        const census = "fetch(new URL('resolver/census.json', import.meta.url))"
        expect(source.match(/\bfetch\s*\(/g), name).toHaveLength(1)
        expect(source, name).toContain(census)
        expect(source.replace(census, ''), name).not.toMatch(forbidden)
      } else expect(source, name).not.toMatch(forbidden)
    }
  })
})

describe('the page', () => {
  it('names the SVG namespace in icons.js and nowhere else', async () => {
    for (const name of files) expect((await read(name)).includes(SVG_NAMESPACE), name).toBe(name === 'icons.js')
  })

  it('writes no markup from a string: elements are built, and text is set as text', async () => {
    for (const name of files) expect(code(await read(name)), name).not.toMatch(/\.(?:inner|outer)HTML|insertAdjacentHTML|document\.write|\bsrcdoc\b|createContextualFragment|\.setHTML/)
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

  it('resolves every import to a file that is there', async () => {
    for (const name of files) {
      const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : ''
      for (const found of (await read(name)).matchAll(/from\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = new URL(found[1] ?? '', new URL(dir, SITE))
        await expect(readFile(target), `${name} imports ${found[1]}`).resolves.toBeDefined()
      }
    }
  })

  it('opens from index.html, the manifest\'s entry, with one module script that is a file and nothing inline', async () => {
    const html = await read('index.html')
    expect(listed).toContain(manifest.entry)
    expect(html.match(/<script\b[^>]*>/gi)).toEqual(['<script type="module" src="main.js">'])
    expect(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)?.[1]).toBe('')
    expect(html).not.toMatch(/\son[a-z]+\s*=|javascript:|\sstyle\s*=|<style\b|<iframe|<object|<embed|<form\b/i)
  })

  it('says in its footer and description that a wallet extension\'s own RPC provider reads for the page, not only the person\'s node', async () => {
    const html = await read('index.html')
    expect(html).toMatch(/In a wallet extension, the reads go through that extension's RPC provider/)
    expect(html).not.toMatch(/It reads Ethereum through your own node/)
    expect(html).toMatch(/content="[^"]*\. In Orivon, Ethereum is read through your own light client\./)
  })

  it('has one stylesheet and no address outside the bundle in the HTML, the stylesheet or an icon', async () => {
    const html = await read('index.html')
    expect(html.match(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)).toEqual(['<link rel="stylesheet" href="style.css">'])
    expect(listed.filter((name) => name.endsWith('.css'))).toEqual(['style.css'])
    for (const found of html.matchAll(/\b(?:href|src|action|poster|data|srcset)\s*=\s*"([^"]*)"/gi)) expect(found[1], 'index.html').toMatch(/^[A-Za-z0-9._-]+$/)
    expect(html).not.toMatch(/https?:|\/\/[a-z0-9.-]+\.[a-z]/i)
    const css = await read('style.css')
    expect(css).not.toMatch(/@import|https?:|\/\/[a-z0-9.-]+\.[a-z]/i)
    for (const found of css.matchAll(/url\(\s*['"]?([^'")]*)/gi)) expect(found[1], 'style.css').toMatch(/^assets\/(?:fonts|img)\/[A-Za-z0-9._-]+$/)
    for (const name of listed.filter((entry) => entry.endsWith('.svg'))) expect((await read(name)).replaceAll(SVG_NAMESPACE, ''), name).not.toMatch(/<script|\son[a-z]+\s*=|href|https?:|<image|<foreignObject/i)
  })

  it('ships exactly the fonts and pictures the page and the stylesheet name: its own files, and no other binary', async () => {
    const binaries = listed.filter((name) => /\.(?:woff2?|ttf|otf|png|jpe?g|gif|webp|ico)$/i.test(name)).map((name) => name.replaceAll('\\', '/')).sort()
    expect(binaries).toEqual([
      'assets/fonts/bricolage-grotesque-normal-200-800.woff2', 'assets/fonts/inter-normal-100-900.woff2', 'assets/fonts/jetbrains-mono-normal-100-800.woff2',
      'assets/img/meadow-art-1000.webp', 'assets/img/meadow-art-1600.webp'
    ])
    const assets = listed.map((name) => name.replaceAll('\\', '/')).filter((name) => /^assets\/(?:fonts|img)\/[A-Za-z0-9._-]+$/.test(name) && !name.endsWith('.txt'))
    let named = await read('style.css')
    for (const name of files) named += await read(name)
    // Every file under assets is named by the stylesheet or a script, and every name they spell is a file that is there.
    for (const name of assets) expect(named, name).toContain(name)
    for (const found of named.matchAll(/assets\/(?:fonts|img)\/[A-Za-z0-9._-]+/g)) expect(assets, found[0]).toContain(found[0])
    // Each font file has a line in the licence note that says whose it is and under what licence.
    const licences = await readFile(new URL('assets/fonts/README.txt', SITE), 'utf8')
    for (const name of binaries.filter((entry) => entry.endsWith('.woff2'))) {
      expect(licences, name).toMatch(new RegExp(`^${name.split('/').pop()}\\s+\\S.*\\bby\\b.*SIL Open Font License 1\\.1$`, 'm'))
    }
  })

  it('carries the licence of every font and the source of every picture it ships, as text beside them', async () => {
    const ofl = await read('assets/fonts/OFL.txt')
    // The copyright line of each font is the one in its file's name table.
    for (const line of [
      'Copyright 2022 The Bricolage Grotesque Project Authors (https://github.com/ateliertriay/bricolage)',
      'Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)',
      'Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)'
    ]) expect(ofl, line).toContain(line)
    for (const heading of ['SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007', 'PREAMBLE', 'DEFINITIONS', 'PERMISSION & CONDITIONS', 'TERMINATION', 'DISCLAIMER']) {
      expect(ofl, heading).toContain(heading)
    }
    for (const name of listed.map((entry) => entry.replaceAll('\\', '/')).filter((entry) => entry.endsWith('.woff2'))) expect(ofl, name).toContain(name.split('/').pop())
    const pictures = await read('assets/img/README.txt')
    expect(pictures).toMatch(/orivon-site/)
    expect(pictures).toMatch(/Apache License 2\.0/)
    expect(pictures).toContain('LICENSE-2.0.txt')
    const apache = await read('assets/img/LICENSE-2.0.txt')
    for (const line of ['Apache License', 'Version 2.0, January 2004', 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION']) {
      expect(apache, line).toContain(line)
    }
    for (const name of listed.map((entry) => entry.replaceAll('\\', '/')).filter((entry) => /^assets\/img\/[^/]+\.(?:svg|webp)$/.test(entry))) expect(pictures, name).toContain(name.split('/').pop())
  })

  it('has one dark theme for every system setting: it asks for dark, answers a narrow screen and keyboard focus, and falls back to the system fonts', async () => {
    const css = await read('style.css')
    const html = await read('index.html')
    expect(css).toMatch(/system-ui/)
    expect(css).toMatch(/:root\s*\{\s*color-scheme:\s*dark;/)
    expect(css).not.toMatch(/prefers-color-scheme/)
    expect(html).toMatch(/<meta name="color-scheme" content="dark">/)
    expect(css).toMatch(/max-width:\s*5\d\dpx/)
    expect(css).toMatch(/:focus-visible/)
  })

  it('defines every class the views build, in the stylesheet', async () => {
    const css = await read('style.css')
    const used = new Set<string>()
    for (const name of files.filter((entry) => entry.startsWith('view-') || ['parts.js', 'header.js', 'main.js'].includes(entry))) {
      for (const found of code(await read(name)).matchAll(/class:\s*'([^'$]+)'/g)) for (const one of (found[1] ?? '').split(' ')) if (one !== '') used.add(one)
    }
    const missing = [...used].filter((one) => !new RegExp(`\\.${one}(?![\\w-])`).test(css))
    // `step-text` is a wrapper with no rule of its own.
    expect(missing.filter((one) => !['step-text'].includes(one))).toEqual([])
  })

  it('has a route for every page its header names, and the search is the first', () => {
    expect(ROUTES[0]).toMatchObject({ name: 'search', path: '/' })
  })
})

describe('typing', () => {
  it('asks the node nothing as the name is typed: the read waits for a pause, and is made by one function', async () => {
    const search = code(await read('view-search.js'))
    const typing = search.slice(search.indexOf("input.addEventListener('input'"), search.indexOf("form.addEventListener('submit'"))
    expect(typing).toMatch(/setTimeout\(\(\) => \{ void check\(\) \}, TYPING_PAUSE_MS\)/)
    expect(typing).not.toMatch(/lookupName|await /)
    expect(search.match(/lookupName\(/g)).toHaveLength(1)
  })

  it('reads a name only with the resolver\'s own functions, and never calls the registry or the resolver proxy itself', async () => {
    for (const name of files.filter((entry) => ['app.js', 'search-model.js', 'view-search.js'].includes(entry))) {
      expect(code(await read(name)), name).not.toMatch(/readContract|rawCall|encodeCall|getTextRecord|'owner\(bytes32\)'|nameToId/)
    }
    expect(await read('app.js')).toMatch(/inspectOg\(/)
  })
})
