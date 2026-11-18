// webview-embeds.js against a page of fake elements: which frames it takes for embeds, what the
// element beside each carries over, that the frame itself stays in the page (the app removes it
// itself), frames that appear later, and that anything else is left alone. A real page's layout and
// what a shown site does are the end-to-end run's business.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('./webview-embeds.js', import.meta.url), 'utf8')

class FakeView {
  readonly tagName = 'WEBVIEW'
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, (event: unknown) => void>()
  className = ''
  connected = true
  loadURL = () => Promise.resolve()
  setAttribute (name: string, value: string) { this.attributes.set(name, value) }
  addEventListener (type: string, listener: (event: unknown) => void) { this.listeners.set(type, listener) }
  remove () { this.connected = false }
}

class FakeFrame {
  readonly tagName = 'IFRAME'
  readonly nodeType = 1
  readonly style: Record<string, string> = {}
  isConnected = true
  after: (view: FakeView) => void = () => {}
  readonly attributes: Record<string, string>
  readonly className: string
  readonly title: string
  readonly referrerPolicy: string
  constructor (attributes: Record<string, string>, className = '', title = '', referrerPolicy = '') {
    this.attributes = attributes
    this.className = className
    this.title = title
    this.referrerPolicy = referrerPolicy
  }
  getAttribute (name: string) { return this.attributes[name] ?? null }
}

class FakeContainer {
  readonly tagName = 'DIV'
  readonly nodeType = 1
  readonly inside: FakeFrame[]
  constructor (inside: FakeFrame[]) { this.inside = inside }
  querySelectorAll () { return this.inside }
}

interface Page {
  readonly frames: FakeFrame[]
  readonly views: FakeView[]
  readonly beside: Map<FakeFrame, FakeView>
  readonly sheets: string[]
  readonly open: ReturnType<typeof vi.fn>
  readonly observed: { options: unknown } | undefined
  insert: (...nodes: Array<FakeFrame | FakeContainer>) => void
  change: (frame: FakeFrame) => void
}

function load (options: { live?: boolean, existing?: FakeFrame[] } = {}): Page {
  const frames: FakeFrame[] = [...(options.existing ?? [])]
  const views: FakeView[] = []
  const beside = new Map<FakeFrame, FakeView>()
  const sheets: string[] = []
  const open = vi.fn()
  let callback: ((records: unknown[]) => void) | undefined
  let observed: { options: unknown } | undefined
  const root = { nodeType: 1, tagName: 'HTML', querySelectorAll: () => frames.filter((frame) => frame.isConnected) }
  class FakeObserver {
    constructor (listener: (records: unknown[]) => void) { callback = listener }
    observe (_target: unknown, observeOptions: unknown) { observed = { options: observeOptions } }
  }
  class FakeSheet { replaceSync (text: string) { sheets.push(text) } }
  const document = {
    baseURI: 'http://127.0.0.1:8884/',
    documentElement: root,
    adoptedStyleSheets: [] as unknown[],
    createElement: () => { const view = new FakeView(); if (options.live === false) (view as { loadURL?: unknown }).loadURL = undefined; views.push(view); return view }
  }
  for (const frame of frames) frame.after = (view) => { beside.set(frame, view) }
  const sandbox = { document, window: { open }, location: { origin: 'http://127.0.0.1:8884' }, MutationObserver: FakeObserver, CSSStyleSheet: FakeSheet, URL, encodeURIComponent }
  vm.runInNewContext(source, sandbox)
  const wire = (frame: FakeFrame) => { frame.after = (view) => { beside.set(frame, view) } }
  return {
    frames, views, beside, sheets, open,
    get observed () { return observed },
    insert: (...added) => {
      for (const node of added) for (const frame of node instanceof FakeFrame ? [node] : node.inside) { wire(frame); frames.push(frame) }
      callback?.(added.map((node) => ({ type: 'childList', addedNodes: [node] })))
    },
    change: (frame) => { callback?.([{ type: 'attributes', target: frame }]) }
  }
}

const video = () => new FakeFrame({ src: 'https://www.youtube.com/embed/abc' }, 'videoEmbed', 'https://youtu.be/abc', 'origin')

describe('which frames it takes for embeds', () => {
  it.each([
    'https://www.youtube.com/embed/abc', 'https://www.youtube.com/embed/videoseries?list=PL1', 'https://player.twitch.tv/?video=1&parent=127.0.0.1', 'https://player.twitch.tv/?channel=a&parent=127.0.0.1',
    'https://odysee.com/$/embed/@a/b', 'https://www.bitchute.com/embed/abc/', 'https://streamable.com/e/abc', 'https://open.spotify.com/embed/track/1?theme=0',
    'https://w.soundcloud.com/player/?url=https://soundcloud.com/a/b',
    // the page a board's spam-blocker sends a poster to, which the app draws in a frame of its own challenge window
    'https://spamblocker.bitsocial.net/iframe/0b8e1c1c-4d0e-4e0e-9f7e-1a2b3c4d5e6f/lazy?theme=light#payload=AAAA'
  ])('a frame whose address is %s', (src) => {
    const page = load()
    const frame = new FakeFrame({ src })
    page.insert(frame)
    expect(page.beside.get(frame)?.attributes.get('src')).toBe(src)
  })

  it.each([
    ['X', 'https://platform.twitter.com/widgets.js'],
    ['reddit', 'https://embed.reddit.com/widgets.js'],
    ['tiktok', 'https://www.tiktok.com/embed.js'],
    ['instagram', 'https://www.instagram.com/embed.js']
  ])('a frame with inline content that loads the %s widget, shown from a data address that carries that content whole', (_name, widget) => {
    const page = load()
    const content = `<blockquote class="x"><a href="https://example.com/?a=1&b=2"></a></blockquote>\n<script async src="${widget}"></script>`
    const frame = new FakeFrame({ srcdoc: content })
    page.insert(frame)
    const address = page.beside.get(frame)?.attributes.get('src') ?? ''
    expect(address.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(address.slice('data:text/html;charset=utf-8,'.length))).toBe(content)
  })

  it('writes out the scheme of a protocol-relative widget address, which a data page has no host to borrow one from (seedit\'s Instagram embed)', () => {
    const page = load()
    const content = '<blockquote class="instagram-media"><a href="https://www.instagram.com/p/abc/"></a></blockquote>\n<script async src="//www.instagram.com/embed.js"></script>'
    const frame = new FakeFrame({ srcdoc: content })
    page.insert(frame)
    const address = page.beside.get(frame)?.attributes.get('src') ?? ''
    expect(decodeURIComponent(address.slice('data:text/html;charset=utf-8,'.length))).toBe(content.replace('src="//www', 'src="https://www'))
  })

  it('does not take a frame by an address of a site the app only reaches through a widget or never embeds: X\'s tweet page, Vimeo', () => {
    const page = load()
    page.insert(new FakeFrame({ src: 'https://platform.twitter.com/embed/Tweet.html?id=1' }), new FakeFrame({ src: 'https://player.vimeo.com/video/1' }))
    expect(page.views).toEqual([])
  })

  it('and no other: a frame of another site, one with inline content that loads nothing known, one with no address, an address that does not parse', () => {
    const page = load()
    const others = [new FakeFrame({ src: 'https://example.com/embed' }), new FakeFrame({ srcdoc: '<p>hi</p><script src="https://example.com/x.js"></script>' }), new FakeFrame({}), new FakeFrame({ src: 'http://[bad' }),
      new FakeFrame({ src: 'https://www.youtube.com.evil.example/embed/a' }), new FakeFrame({ src: 'http://www.youtube.com/embed/a' })]
    page.insert(...others)
    expect(page.views).toEqual([])
    expect(others.every((frame) => frame.style['display'] === undefined)).toBe(true)
  })
})

describe('the element beside a frame', () => {
  it('has the frame\'s class and title, so the app\'s own style gives it the frame\'s size, and a fallback size that no class loses to', () => {
    const page = load()
    const frame = video()
    page.insert(frame)
    const view = page.beside.get(frame)!
    expect(view.className).toBe('videoEmbed')
    expect(view.attributes.get('title')).toBe('https://youtu.be/abc')
    expect(view.attributes.has('data-orivon-embed')).toBe(true)
    expect(page.sheets).toEqual([':where(webview[data-orivon-embed]) { width: 100%; height: 100% }'])
  })

  it('carries the page\'s origin as the referrer when the frame sent its origin, and none when it sent none', () => {
    const page = load()
    const withOrigin = video()
    const without = new FakeFrame({ src: 'https://streamable.com/e/abc' }, '', '', 'no-referrer')
    page.insert(withOrigin, without)
    expect(page.beside.get(withOrigin)?.attributes.get('httpreferrer')).toBe('http://127.0.0.1:8884/')
    expect(page.beside.get(without)?.attributes.has('httpreferrer')).toBe(false)
  })

  it('opens the window its page asks for as a tab when the address is secure, and drops any other', () => {
    const page = load()
    const frame = video()
    page.insert(frame)
    const popup = page.beside.get(frame)!.listeners.get('orivon-popup')!
    popup({ detail: { url: 'https://www.youtube.com/watch?v=abc' } })
    popup({ detail: { url: 'http://www.youtube.com/watch?v=abc' } })
    popup({ detail: { url: 'javascript:alert(1)' } })
    popup({ detail: undefined })
    expect(page.open.mock.calls).toEqual([['https://www.youtube.com/watch?v=abc', '_blank', 'noopener,noreferrer']])
  })
})

describe('the frame', () => {
  it('stays in the page, hidden, with the element after it, so the app that put it there can still remove it', () => {
    const page = load()
    const frame = video()
    page.insert(frame)
    expect(frame.style['display']).toBe('none')
    expect(frame.isConnected).toBe(true)
    expect(page.beside.has(frame)).toBe(true)
  })

  it('takes its element away when the app removes it', () => {
    const page = load()
    const [kept, gone] = [video(), video()]
    page.insert(kept, gone)
    gone.isConnected = false
    page.insert(new FakeFrame({ src: 'https://example.com/other' }))
    expect(page.beside.get(gone)?.connected).toBe(false)
    expect(page.beside.get(kept)?.connected).toBe(true)
  })

  it('is shown once, however often the page reports it, and follows its address when the app changes it', () => {
    const page = load()
    const frame = video()
    page.insert(frame)
    page.change(frame)
    page.insert(frame)
    expect(page.beside.size).toBe(1)
    frame.attributes['src'] = 'https://www.youtube.com/embed/next'
    page.change(frame)
    expect(page.beside.size).toBe(1)
    expect(page.beside.get(frame)?.attributes.get('src')).toBe('https://www.youtube.com/embed/next')
  })

  it('is found inside a container the page adds, and when its address arrives after it', () => {
    const page = load()
    const inside = video()
    page.insert(new FakeContainer([inside]))
    expect(page.beside.get(inside)).toBeDefined()
    const late = new FakeFrame({})
    page.insert(late)
    expect(page.beside.size).toBe(1)
    late.attributes['src'] = 'https://streamable.com/e/abc'
    page.change(late)
    expect(page.beside.get(late)?.attributes.get('src')).toBe('https://streamable.com/e/abc')
  })

  it('is found at load, when the page already holds it', () => {
    const frame = video()
    const page = load({ existing: [frame] })
    expect(page.beside.get(frame)).toBeDefined()
  })
})

describe('outside Orivon', () => {
  it('leaves every frame as it is: a <webview> there is an unknown element', () => {
    const page = load({ live: false })
    const frame = video()
    page.insert(frame)
    expect(frame.style['display']).toBeUndefined()
    expect(page.beside.has(frame)).toBe(false)
    expect(page.sheets).toEqual([])
  })
})

describe('what it watches', () => {
  it('the whole document for added elements and for a change of a frame\'s source, and nothing else', () => {
    expect(load().observed?.options).toEqual({ childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcdoc'] })
  })
})
