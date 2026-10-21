import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { portProblemUrl } from '../report-url.ts'

// Runs the exact bytes served as orivon/hint/hint.js in a realm holding a
// fake page: only the DOM members the script touches exist, so a member it
// starts relying on fails here rather than in somebody's browser.

const SOURCE = readFileSync(join(import.meta.dirname, 'hint.js'), 'utf8')
const SCRIPT_URL = 'http://127.0.0.1:8875/orivon/hint/hint.js'
const KEY = 'orivon-hint:state'

class FakeNode {
  readonly children: FakeNode[] = []
  readonly attributes: Record<string, string> = {}
  readonly listeners: Record<string, Array<(event: unknown) => void>> = {}
  parent: FakeNode | null = null
  shadow: FakeNode | null = null
  textContent = ''
  focused = false
  readonly tagName: string
  [prop: string]: unknown

  constructor (tagName: string) { this.tagName = tagName }

  append (...nodes: Array<FakeNode | string>): void {
    for (const node of nodes) {
      if (typeof node === 'string') { this.textContent += node; continue }
      node.parent = this
      this.children.push(node)
    }
  }

  remove (): void {
    if (this.parent === null) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }

  setAttribute (name: string, value: string): void { this.attributes[name] = value }
  addEventListener (type: string, listener: (event: unknown) => void): void { (this.listeners[type] ??= []).push(listener) }
  fire (type: string, event: unknown = {}): void { for (const listener of this.listeners[type] ?? []) listener(event) }
  focus (): void { this.focused = true }

  attachShadow (): FakeNode {
    this.shadow = new FakeNode('#shadow-root')
    return this.shadow
  }

  all (): FakeNode[] { return this.children.flatMap((child) => [child, ...child.all()]) }
  text (): string { return this.textContent + this.children.map((child) => child.text()).join('') }
}

interface Page {
  html: FakeNode
  head: FakeNode
  stored: Record<string, string>
  window: Record<string, unknown>
  stops: number
  written: string[]
  doc: Record<string, unknown>
  contentLoaded: Array<() => void>
  plaintext: FakeNode | null
  reloads: number
  keydown: Array<(event: unknown) => void>
}

interface PageOptions {
  data?: Record<string, string>
  orivon?: unknown
  subframe?: boolean
  stored?: Record<string, string>
  storageThrows?: boolean
  scriptUrl?: string
  noStop?: boolean
  noWrite?: boolean
  source?: string
}

const TIER2 = { tier: '2', app: 'the-lounge', name: 'The Lounge', eth: 'thelounge.orivonstack.eth', officialUrl: 'https://thelounge.chat/', reportUrl: portProblemUrl('The Lounge') }
const TIER1 = { tier: '1', app: 'status', name: 'Orivon Status', reportUrl: portProblemUrl('Orivon Status') }

function load (options: PageOptions = {}): Page {
  const html = new FakeNode('html')
  const head = new FakeNode('head')
  html.append(head)
  const stored = { ...options.stored }
  const storage = {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => { stored[key] = value },
    removeItem: (key: string) => { delete stored[key] }
  }
  const page: Page = { html, head, stored, window: {}, stops: 0, written: [], doc: {}, contentLoaded: [], plaintext: null, reloads: 0, keydown: [] }
  const window: Record<string, unknown> = {
    document: {
      currentScript: { src: options.scriptUrl ?? SCRIPT_URL, dataset: options.data ?? TIER1 },
      baseURI: 'http://127.0.0.1:8875/',
      documentElement: html,
      head,
      createElement: (tag: string) => new FakeNode(tag),
      title: '',
      write: (text: string) => {
        if (options.noWrite === true) throw new Error('TrustedTypes')
        page.written.push(text)
        // What the parser does with it: the rest of the document becomes one element of text.
        page.plaintext = new FakeNode('plaintext')
        html.append(page.plaintext)
      },
      querySelector: (selector: string) => selector === 'plaintext' ? page.plaintext : null,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === 'keydown') page.keydown.push(listener)
        if (type === 'DOMContentLoaded') page.contentLoaded.push(listener as () => void)
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => { page.keydown = page.keydown.filter((one) => one !== listener) }
    },
    URL,
    location: { reload: () => { page.reloads += 1 } },
    stop: () => { if (options.noStop === true) throw new Error('no stop'); page.stops += 1 }
  }
  window.window = window
  window.self = window
  window.top = options.subframe === true ? {} : window
  Object.defineProperty(window, 'sessionStorage', {
    get: () => { if (options.storageThrows === true) throw new Error('SecurityError'); return storage }
  })
  if (options.orivon !== undefined) window.orivon = options.orivon
  page.window = window
  page.doc = window.document as Record<string, unknown>
  vm.runInContext(options.source ?? SOURCE, vm.createContext(window))
  return page
}

function host (page: Page): FakeNode | undefined {
  return page.html.children.find((child) => child.tagName === 'orivon-hint')
}

/** What a visitor sees: mounted, its stylesheet loaded. */
function shown (options: PageOptions = {}): { page: Page, root: FakeNode, nodes: FakeNode[] } {
  const page = load(options)
  const root = host(page)?.shadow
  if (root === null || root === undefined) throw new Error('nothing was mounted')
  root.children[0]?.fire('load')
  return { page, root, nodes: root.all() }
}

const linkTexts = (nodes: FakeNode[]): string[] => nodes.filter((node) => node.tagName === 'a').map((node) => node.text())
const buttonTexts = (nodes: FakeNode[]): string[] => nodes.filter((node) => node.tagName === 'button').map((node) => node.attributes['aria-label'] ?? node.text())
const hrefOf = (nodes: FakeNode[], text: string): unknown => nodes.find((node) => node.tagName === 'a' && node.text() === text)?.href
const modeOf = (page: Page): string | undefined => host(page)?.attributes['data-mode']

describe('what shows', () => {
  it.each([
    ['tier 2 outside Orivon', { data: TIER2 }, 'landing'],
    ['tier 1 outside Orivon', { data: TIER1 }, 'pill'],
    ['a recipe with no hint data', { data: {} }, 'pill'],
    ['tier 2 after Continue anyway', { data: TIER2, stored: { [KEY]: 'continue' } }, 'pill'],
    ['tier 2 after the pill was closed', { data: TIER2, stored: { [KEY]: 'closed' } }, undefined],
    ['tier 1 after the pill was closed', { data: TIER1, stored: { [KEY]: 'closed' } }, undefined],
    ['tier 2 inside Orivon', { data: TIER2, orivon: { version: 0 } }, undefined],
    ['tier 1 inside Orivon', { data: TIER1, orivon: { version: 0 } }, undefined],
    ['tier 2 in a subframe', { data: TIER2, subframe: true }, undefined],
    ['tier 1 in a subframe', { data: TIER1, subframe: true }, undefined],
    ['tier 2 with storage that throws', { data: TIER2, storageThrows: true }, 'landing'],
    ['tier 1 with storage that throws', { data: TIER1, storageThrows: true }, 'pill'],
    ['a window.orivon that is not the API', { data: TIER2, orivon: { app: {} } }, 'landing'],
    ['a notice inside Orivon', { data: { ...TIER2, notice: 'No secure storage.' }, orivon: { version: 0 } }, 'notice'],
    ['a notice inside Orivon, once closed', { data: { ...TIER2, notice: 'No secure storage.' }, orivon: { version: 0 }, stored: { [KEY]: 'closed' } }, undefined],
    ['a notice outside Orivon', { data: { ...TIER1, notice: 'No secure storage.' } }, 'pill']
  ] as Array<[string, PageOptions, string | undefined]>)('%s: %s', (_name, options, expected) => {
    expect(modeOf(load(options))).toBe(expected)
  })

  it('mounts on <html> and renders nothing until its stylesheet has loaded', () => {
    const page = load({ data: TIER2 })
    const root = host(page)?.shadow
    expect(root?.children.map((child) => child.tagName)).toEqual(['link'])
    expect(root?.children[0]?.href).toBe('http://127.0.0.1:8875/orivon/hint/hint.css')
  })

  it('resolves its files from its own URL, under an IPFS path gateway too', () => {
    const { root } = shown({ data: TIER2, scriptUrl: 'https://ipfs.io/ipfs/bafybeigdyrzt/orivon/hint/hint.js' })
    expect(root.children[0]?.href).toBe('https://ipfs.io/ipfs/bafybeigdyrzt/orivon/hint/hint.css')
    expect(root.all().find((node) => node.tagName === 'img')?.src).toBe('https://ipfs.io/ipfs/bafybeigdyrzt/orivon/hint/logo.png')
  })

  it('puts nothing on window', () => {
    const before = Object.keys(load({ data: TIER2, orivon: { version: 0 } }).window)
    expect(Object.keys(load({ data: TIER2 }).window)).toEqual(before.filter((key) => key !== 'orivon'))
  })
})

describe('the tier 2 landing', () => {
  it('has the parser read the rest of the page as text, and takes that text away once the document is done', () => {
    const page = load({ data: TIER2 })
    expect(page.written).toEqual(['<plaintext>'])
    expect(page.html.children).toContain(page.plaintext)
    for (const listener of page.contentLoaded) listener()
    expect(page.html.children).not.toContain(page.plaintext)
  })

  it('sets its own title and viewport, since the app\'s were never parsed', () => {
    const page = load({ data: TIER2 })
    expect(page.doc.title).toBe('The Lounge')
    expect(page.head.children.find((child) => child.tagName === 'meta')).toMatchObject({ name: 'viewport', content: 'width=device-width, initial-scale=1' })
  })

  it('stops the page instead when the browser refuses document.write, and still shows', () => {
    const page = load({ data: TIER2, noWrite: true })
    expect(page.stops).toBe(1)
    expect(modeOf(page)).toBe('landing')
    expect(modeOf(load({ data: TIER2, noWrite: true, noStop: true }))).toBe('landing')
  })

  it('does not hold back a page it will not replace', () => {
    for (const options of [{ data: TIER1 }, { data: TIER2, orivon: { version: 0 } }, { data: TIER2, stored: { [KEY]: 'continue' } }]) {
      const page = load(options)
      expect(page.written).toEqual([])
      expect(page.stops).toBe(0)
      expect(page.head.children).toEqual([])
    }
  })

  it('says what the app is, who built it and where to go', () => {
    const { root, nodes } = shown({ data: TIER2 })
    expect(root.text()).toContain('The Lounge runs inside Orivon, an open-source browser that provides the desktop parts this app needs.')
    expect(root.text()).toContain('A community build by Orivon, not the official The Lounge.')
    expect(linkTexts(nodes)).toEqual(['Get Orivon', 'Official The Lounge downloads', 'Report a problem with this build'])
    expect(hrefOf(nodes, 'Get Orivon')).toBe('https://download.orivonstack.eth.limo/?app=the-lounge')
    expect(hrefOf(nodes, 'Official The Lounge downloads')).toBe('https://thelounge.chat/')
    expect(hrefOf(nodes, 'Report a problem with this build')).toBe(
      'https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=The%20Lounge&title=Problem%20with%20the%20Orivon%20community%20build%20of%20The%20Lounge')
  })

  it('opens external links in a new tab without a referrer', () => {
    const { nodes } = shown({ data: TIER2 })
    for (const link of nodes.filter((node) => node.tagName === 'a')) {
      expect(link).toMatchObject({ target: '_blank', rel: 'noopener noreferrer' })
    }
  })

  it('builds no Open in Orivon button while the constant is off, and never claims to in its words', () => {
    const { root, nodes } = shown({ data: TIER2 })
    expect(linkTexts(nodes)).not.toContain('Open in Orivon')
    expect(SOURCE).toContain('const OPEN_IN_ORIVON = false')
    expect(root.text()).not.toMatch(/unsupported|permissionless|fork|coming soon/i)
  })

  it('builds the Open in Orivon link from the app\'s name once the constant is on', () => {
    const { nodes } = shown({ data: TIER2, source: SOURCE.replace('const OPEN_IN_ORIVON = false', 'const OPEN_IN_ORIVON = true') })
    expect(hrefOf(nodes, 'Open in Orivon')).toBe('orivon:open?u=thelounge.orivonstack.eth')
  })

  it('shows the app\'s own extra line, and omits the official link and community line for a site', () => {
    const { root, nodes } = shown({ data: { tier: '2', app: 'demo', name: 'Demo', text: 'A reason.', reportUrl: portProblemUrl('Demo') } })
    expect(root.text()).toContain('A reason.')
    expect(root.text()).not.toContain('community build')
    expect(linkTexts(nodes)).toEqual(['Get Orivon', 'Report a problem with this build'])
  })

  it('ignores an official URL that is not https', () => {
    const { nodes } = shown({ data: { ...TIER2, officialUrl: 'javascript:alert(1)' } })
    expect(linkTexts(nodes)).toEqual(['Get Orivon', 'Report a problem with this build'])
  })

  it('has real buttons, a labelled close, and focus on the first link', () => {
    const { root, nodes } = shown({ data: TIER2 })
    expect(buttonTexts(nodes)).toEqual(['Continue anyway', 'Close'])
    expect(nodes.filter((node) => node.tagName === 'button').every((node) => node.type === 'button')).toBe(true)
    expect(nodes.find((node) => node.tagName === 'main')?.attributes['aria-labelledby']).toBe('title')
    expect(nodes.find((node) => node.tagName === 'h1')?.text()).toBe('The Lounge')
    expect(nodes.find((node) => node.focused)?.text()).toBe('Get Orivon')
    expect(root.text()).toContain('The app may not work without Orivon.')
  })

  it('shows unstyled rather than leave a blank page when its stylesheet fails', () => {
    const page = load({ data: TIER2 })
    const root = host(page)?.shadow
    root?.children[0]?.fire('error')
    expect(root?.all().some((node) => node.tagName === 'main')).toBe(true)
  })

  it('goes on to the app on Continue anyway, by remembering it and reloading', () => {
    const { page, nodes } = shown({ data: TIER2 })
    nodes.find((node) => node.text() === 'Continue anyway')?.fire('click')
    expect(page.stored[KEY]).toBe('continue')
    expect(page.reloads).toBe(1)
  })

  it('goes on by the close control and by Escape too, and ignores other keys', () => {
    const closeFirst = shown({ data: TIER2 })
    closeFirst.nodes.find((node) => node.attributes['aria-label'] === 'Close')?.fire('click')
    expect(closeFirst.page.stored[KEY]).toBe('continue')

    const escape = shown({ data: TIER2 })
    for (const listener of escape.page.keydown) listener({ key: 'a' })
    expect(escape.page.reloads).toBe(0)
    for (const listener of escape.page.keydown) listener({ key: 'Escape' })
    expect(escape.page.stored[KEY]).toBe('continue')
    expect(escape.page.reloads).toBe(1)
  })

  it('offers no way on when the choice could not be remembered, because a reload would show it again', () => {
    const { page, nodes } = shown({ data: TIER2, storageThrows: true })
    expect(buttonTexts(nodes)).toEqual([])
    for (const listener of page.keydown) listener({ key: 'Escape' })
    expect(page.reloads).toBe(0)
    expect(linkTexts(nodes)).toContain('Get Orivon')
  })
})

describe('the report link', () => {
  it('is the address prepare wrote on the tag, and is left out when none was written or it is not https', () => {
    expect(linkTexts(shown({ data: { ...TIER1, reportUrl: '' } }).nodes)).toEqual(['Get Orivon'])
    expect(linkTexts(shown({ data: { ...TIER1, reportUrl: 'javascript:alert(1)' } }).nodes)).toEqual(['Get Orivon'])
    expect(hrefOf(shown({ data: TIER1 }).nodes, 'Report a problem with this build')).toBe(portProblemUrl('Orivon Status'))
  })
})

describe('the pill', () => {
  it('tier 1: says it works here, links Get Orivon and the report form, and has no official link', () => {
    const { root, nodes } = shown({ data: TIER1 })
    expect(root.text()).toContain('Orivon Status works in this browser. It also runs inside Orivon, an open-source browser.')
    expect(linkTexts(nodes)).toEqual(['Get Orivon', 'Report a problem with this build'])
    expect(hrefOf(nodes, 'Get Orivon')).toBe('https://download.orivonstack.eth.limo/?app=status')
    expect(buttonTexts(nodes)).toEqual(['Close'])
    expect(root.text()).not.toContain('community build')
  })

  it('names the community build when the app is a port', () => {
    const { root } = shown({ data: { ...TIER1, officialUrl: 'https://element.io/download', name: 'Element', app: 'element', reportUrl: portProblemUrl('Element') } })
    expect(root.text()).toContain('A community build by Orivon, not the official Element.')
  })

  it('tier 2, after Continue anyway: says it may not work', () => {
    const { root } = shown({ data: TIER2, stored: { [KEY]: 'continue' } })
    expect(root.text()).toContain('The Lounge may not work in this browser. It runs inside Orivon, an open-source browser.')
  })

  it('the close button removes it and keeps it closed for the session', () => {
    const { page, nodes } = shown({ data: TIER1 })
    nodes.find((node) => node.tagName === 'button')?.fire('click')
    expect(host(page)).toBeUndefined()
    expect(page.stored[KEY]).toBe('closed')
    expect(page.keydown).toEqual([])
  })

  it('Escape closes it', () => {
    const { page } = shown({ data: TIER1 })
    for (const listener of page.keydown) listener({ key: 'Escape' })
    expect(host(page)).toBeUndefined()
    expect(page.stored[KEY]).toBe('closed')
  })

  it('closes for this load when storage is unavailable', () => {
    const { page, nodes } = shown({ data: TIER1, storageThrows: true })
    nodes.find((node) => node.tagName === 'button')?.fire('click')
    expect(host(page)).toBeUndefined()
  })

  it('does not take focus from the page', () => {
    expect(shown({ data: TIER1 }).nodes.some((node) => node.focused)).toBe(false)
  })
})

describe('the notice inside Orivon', () => {
  const options = { data: { ...TIER2, notice: 'This build has no secure storage.' }, orivon: { version: 0 } }

  it('shows the app\'s line and the report link, and offers no download', () => {
    const { root, nodes } = shown(options)
    expect(root.text()).toContain('This build has no secure storage.')
    expect(linkTexts(nodes)).toEqual(['Report a problem with this build'])
    expect(load(options).stops).toBe(0)
  })

  it('closes for the session', () => {
    const { page: loaded, nodes } = shown(options)
    nodes.find((node) => node.tagName === 'button')?.fire('click')
    expect(host(loaded)).toBeUndefined()
    expect(loaded.stored[KEY]).toBe('closed')
  })
})
