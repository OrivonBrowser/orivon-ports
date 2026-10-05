import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

// Runs the exact bytes served as orivon/hint/hint.js in a realm holding a
// fake page: only the DOM members the script touches exist, so a member it
// starts relying on fails here rather than in somebody's browser.

const SOURCE = readFileSync(join(import.meta.dirname, 'hint.js'), 'utf8')
const SCRIPT_URL = 'http://127.0.0.1:8875/orivon/hint/hint.js'

class FakeNode {
  readonly children: FakeNode[] = []
  readonly attributes: Record<string, string> = {}
  readonly listeners: Record<string, Array<() => void>> = {}
  parent: FakeNode | null = null
  shadow: FakeNode | null = null
  textContent = ''
  readonly tagName: string
  [prop: string]: unknown

  constructor (tagName: string) { this.tagName = tagName }

  append (...nodes: FakeNode[]): void {
    for (const node of nodes) { node.parent = this; this.children.push(node) }
  }

  remove (): void {
    if (this.parent === null) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }

  setAttribute (name: string, value: string): void { this.attributes[name] = value }
  addEventListener (type: string, listener: () => void): void { (this.listeners[type] ??= []).push(listener) }
  fire (type: string): void { for (const listener of this.listeners[type] ?? []) listener() }

  attachShadow (): FakeNode {
    this.shadow = new FakeNode('#shadow-root')
    return this.shadow
  }

  all (): FakeNode[] { return this.children.flatMap((child) => [child, ...child.all()]) }
  text (): string { return this.textContent + this.children.map((child) => child.text()).join('') }
}

interface Page {
  html: FakeNode
  timers: Array<() => void>
  stored: Record<string, string>
  window: Record<string, unknown>
}

interface PageOptions {
  orivon?: unknown
  subframe?: boolean
  stored?: Record<string, string>
  storageThrows?: boolean
  scriptUrl?: string
}

function load (options: PageOptions = {}): Page {
  const html = new FakeNode('html')
  const timers: Array<() => void> = []
  const stored = { ...options.stored }
  const storage = {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => { stored[key] = value }
  }
  const window: Record<string, unknown> = {
    document: {
      currentScript: { src: options.scriptUrl ?? SCRIPT_URL },
      baseURI: 'http://127.0.0.1:8875/',
      documentElement: html,
      createElement: (tag: string) => new FakeNode(tag)
    },
    URL,
    setTimeout: (fn: () => void) => { timers.push(fn) }
  }
  window.window = window
  window.self = window
  window.top = options.subframe === true ? {} : window
  Object.defineProperty(window, 'sessionStorage', {
    get: () => { if (options.storageThrows === true) throw new Error('SecurityError'); return storage }
  })
  if (options.orivon !== undefined) window.orivon = options.orivon
  vm.runInContext(SOURCE, vm.createContext(window))
  return { html, timers, stored, window }
}

function host (page: Page): FakeNode | undefined {
  return page.html.children.find((child) => child.tagName === 'orivon-hint')
}

/** The panel as a visitor sees it: mounted, its stylesheet loaded. */
function shown (options: PageOptions = {}): { page: Page, root: FakeNode } {
  const page = load(options)
  const root = host(page)?.shadow
  if (root === null || root === undefined) throw new Error('no panel was mounted')
  root.children[0]?.fire('load')
  return { page, root }
}

describe('the Orivon hint', () => {
  it('shows nothing inside Orivon', () => {
    expect(load({ orivon: { version: 0 } }).html.children).toEqual([])
  })

  it('shows itself when window.orivon is not the Orivon API', () => {
    expect(host(load({ orivon: { app: {} } }))).toBeDefined()
  })

  it('shows nothing in a subframe', () => {
    expect(load({ subframe: true }).html.children).toEqual([])
  })

  it('shows nothing once Maybe later was chosen in this session', () => {
    expect(load({ stored: { 'orivon-hint:later': '1' } }).html.children).toEqual([])
  })

  it('still shows when storage is unavailable', () => {
    expect(host(load({ storageThrows: true }))).toBeDefined()
  })

  it('mounts on <html> and renders nothing until its stylesheet has loaded', () => {
    const page = load()
    const root = host(page)?.shadow
    expect(root?.children.map((child) => child.tagName)).toEqual(['link'])
    expect(root?.children[0]?.href).toBe('http://127.0.0.1:8875/orivon/hint/hint.css')
  })

  it('shows the logo, the message and the two buttons, and no close button', () => {
    const { root } = shown()
    const nodes = root.all()
    expect(nodes.find((node) => node.tagName === 'img')?.src).toBe('http://127.0.0.1:8875/orivon/hint/logo.png')
    expect(root.text()).toContain('You are using an unsupported browser, some components might not work. ' +
      'Open this website on Orivon Browser for full capabilities and permissionless access. download.orivonstack.eth.limo')
    expect(nodes.filter((node) => node.tagName === 'button').map((node) => node.text())).toEqual(['Maybe later'])
    const links = nodes.filter((node) => node.tagName === 'a')
    expect(links.map((node) => node.text())).toEqual(['download.orivonstack.eth.limo', 'Download Orivon'])
    for (const link of links) {
      expect(link).toMatchObject({ href: 'https://download.orivonstack.eth.limo', target: '_blank', rel: 'noopener noreferrer' })
    }
  })

  it('Maybe later closes it and keeps it closed for the session', () => {
    const { page, root } = shown()
    root.all().find((node) => node.tagName === 'button')?.fire('click')
    expect(host(page)).toBeUndefined()
    expect(page.stored).toEqual({ 'orivon-hint:later': '1' })
  })

  it('Download Orivon closes it after the click has opened the tab', () => {
    const { page, root } = shown()
    root.all().find((node) => node.text() === 'Download Orivon')?.fire('click')
    expect(host(page)).toBeDefined()
    for (const timer of page.timers) timer()
    expect(host(page)).toBeUndefined()
  })

  it('resolves its files from its own URL, under an IPFS path gateway too', () => {
    const { root } = shown({ scriptUrl: 'https://ipfs.io/ipfs/bafybeigdyrzt/orivon/hint/hint.js' })
    expect(root.children[0]?.href).toBe('https://ipfs.io/ipfs/bafybeigdyrzt/orivon/hint/hint.css')
    expect(root.all().find((node) => node.tagName === 'img')?.src).toBe('https://ipfs.io/ipfs/bafybeigdyrzt/orivon/hint/logo.png')
  })

  it('puts nothing on window', () => {
    const before = Object.keys(load({ orivon: { version: 0 } }).window)
    expect(Object.keys(load().window)).toEqual(before.filter((key) => key !== 'orivon'))
  })
})
