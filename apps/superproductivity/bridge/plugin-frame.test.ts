// A plugin's page in Orivon: the bridge rewrites the srcdoc of the plugin frame so that its inline scripts
// become inert text followed by `<script src>` of plugin-frame.js, and plugin-frame.js runs them. The three
// parts are tested apart: the rewrite (a pure string function, run as served), the property that applies it
// to the right frame only, and the runner, run in a realm with a fake document. That a real Chromium under the
// app's policy runs the result is the e2e drive's (README.md, Design notes).
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import { PLUGIN_FRAME_FILE } from '../hooks.mjs'

const source = await bridgeSourceFor('superproductivity')
const runnerSource = await readFile(new URL('./plugin-frame.js', import.meta.url), 'utf8')

const RUNNER = 'http://127.0.0.1:8883/orivon/plugin-frame.js'
const prepare = (html: string, url = RUNNER): string =>
  (runBridge(source, { orivon: {} }).app['preparePluginFrameHtml'] as (html: string, url: string) => string)(html, url)
const runnerTag = (kind: string, defer = ''): string => `<script src="${RUNNER}" data-orivon-run="${kind}"${defer}></script>`

describe('the rewrite of a plugin page', () => {
  it('holds a classic script inert and runs it by the runner that follows it, text unchanged', () => {
    const html = '<!doctype html><html><head><title>t</title></head><body><div id="a"></div><script>document.getElementById("a").textContent = "x < y"</script></body></html>'
    expect(prepare(html)).toBe(
      '<!doctype html><html><head><title>t</title></head><body><div id="a"></div>' +
      '<script type="text/plain" data-orivon-inline>document.getElementById("a").textContent = "x < y"</script>' + runnerTag('classic') + '</body></html>'
    )
  })

  it('does the same for a module, whose runner is deferred as a module is', () => {
    expect(prepare('<script type="module" crossorigin>var a = 1</script>')).toBe(
      '<script crossorigin type="text/plain" data-orivon-inline>var a = 1</script>' + runnerTag('module', ' defer')
    )
  })

  it('keeps the script\'s other attributes, in place, and drops only its type', () => {
    expect(prepare('<script id="cfg" type=\'text/javascript\' data-x="1">1</script>')).toBe(
      '<script id="cfg" data-x="1" type="text/plain" data-orivon-inline>1</script>' + runnerTag('classic')
    )
  })

  it('runs several scripts in the order they stand in, each with its own runner', () => {
    const out = prepare('<script>a()</script><p>x</p><script type="module">b()</script><script>c()</script>')
    expect(out.indexOf('a()')).toBeLessThan(out.indexOf('<p>x</p>'))
    expect(out.indexOf('<p>x</p>')).toBeLessThan(out.indexOf('b()'))
    expect(out.match(/data-orivon-run="/g)).toHaveLength(3)
    expect(out.match(/data-orivon-run="classic"/g)).toHaveLength(2)
  })

  it('leaves alone a script that has a src, one of another type, and one marked nomodule', () => {
    const html = '<script src="https://cdn.example/x.js"></script><script type="application/json">{"a":1}</script><script type="importmap">{}</script><script nomodule>old()</script>'
    expect(prepare(html)).toBe(html)
  })

  it('treats a script with an empty or upper-case type as what it is', () => {
    expect(prepare('<script type="">a</script>')).toContain('data-orivon-run="classic"')
    expect(prepare('<script type="TEXT/JavaScript">a</script>')).toContain('data-orivon-run="classic"')
    expect(prepare('<script type=" Module ">a</script>')).toContain('data-orivon-run="module"')
  })

  it('is idempotent: a page already rewritten comes back as it was', () => {
    const once = prepare('<head><script>a()</script></head><body><script type="module">b()</script></body>')
    expect(prepare(once)).toBe(once)
  })

  it('reads the document as the parser does: a comment, a style, a textarea and an attribute value that name a script hold none', () => {
    const html = [
      '<!-- <script>no()</script> -->',
      '<style>a::after { content: "<script>no()</script>" }</style>',
      '<textarea><script>no()</script></textarea>',
      '<div data-x="<script>no()</script>" title=\'a > b\'></div>',
      '<title><script>no()</script></title>'
    ].join('\n')
    expect(prepare(html)).toBe(html)
    expect(prepare(`${html}\n<script>yes()</script>`)).toContain('data-orivon-inline>yes()</script>')
  })

  it('ends a script where the parser does, not at the first </script> inside a comment-and-script string', () => {
    const body = 'var s = "<!-- <script>"; var t = "</script>"; var u = "-->"; end()'
    const out = prepare(`<script>${body}</script><p>after</p>`)
    expect(out).toBe(`<script type="text/plain" data-orivon-inline>${body}</script>${runnerTag('classic')}<p>after</p>`)
  })

  it('goes back to plain script text at -->, so the next </script> ends it', () => {
    const body = 'var s = "<!-- <script>"; var u = "-->"; end()'
    expect(prepare(`<script>${body}</script><p>after</p>`)).toBe(`<script type="text/plain" data-orivon-inline>${body}</script>${runnerTag('classic')}<p>after</p>`)
  })

  it('ends a script at an upper-case or spaced end tag', () => {
    expect(prepare('<SCRIPT>a()</SCRIPT ><p>x</p>')).toBe(`<SCRIPT type="text/plain" data-orivon-inline>a()</SCRIPT >${runnerTag('classic')}<p>x</p>`)
  })

  it('leaves an unterminated script alone, which the parser never runs', () => {
    const html = '<p>x</p><script>never()'
    expect(prepare(html)).toBe(html)
  })

  it('rewrites the shape the app builds: its own styles and API script first, then the plugin\'s page', () => {
    const html = '<!doctype html><html><head><style id="injected-fonts"></style><script>\n(function() { window.PluginAPI = {} })();\n</script><meta charset="utf-8"></head><body><script type="module">main()</script></body></html>'
    const out = prepare(html)
    expect(out).toContain('<script type="text/plain" data-orivon-inline>\n(function() { window.PluginAPI = {} })();\n</script>' + runnerTag('classic'))
    expect(out).toContain('<script type="text/plain" data-orivon-inline>main()</script>' + runnerTag('module', ' defer'))
    expect(out.startsWith('<!doctype html><html><head><style id="injected-fonts"></style>')).toBe(true)
  })

  it('keeps a quote in the runner address out of the attribute', () => {
    expect(prepare('<script>a</script>', 'http://h/a"b.js')).toContain('src="http://h/a%22b.js"')
  })
})

describe('which frame is rewritten', () => {
  type SrcdocHolder = { srcdoc: string, hasAttribute: (name: string) => boolean }
  function iframeClass () {
    const stored = new WeakMap<object, string>()
    class FakeIframe {
      readonly attributes: Set<string>
      constructor (attributes: string[]) { this.attributes = new Set(attributes) }
      hasAttribute (name: string) { return this.attributes.has(name) }
      get srcdoc () { return stored.get(this) ?? '' }
      set srcdoc (value: string) { stored.set(this, value) }
    }
    return FakeIframe
  }
  const frame = (Frame: ReturnType<typeof iframeClass>, ...attributes: string[]): SrcdocHolder => new Frame(attributes) as unknown as SrcdocHolder

  it('is the plugin frame, by the attribute the app\'s template gives it, with the runner named from the page\'s base', () => {
    const Frame = iframeClass()
    runBridge(source, { orivon: {}, document: { baseURI: 'http://127.0.0.1:8883/sub/' }, globals: { HTMLIFrameElement: Frame } })
    const plugin = frame(Frame, 'data-plugin-iframe')
    plugin.srcdoc = '<script>a()</script>'
    // The file hooks.mjs writes into the served tree, not a second spelling of it.
    expect(plugin.srcdoc).toBe(`<script type="text/plain" data-orivon-inline>a()</script><script src="http://127.0.0.1:8883/sub/${PLUGIN_FRAME_FILE}" data-orivon-run="classic"></script>`)
  })

  it('is no other frame', () => {
    const Frame = iframeClass()
    runBridge(source, { orivon: {}, globals: { HTMLIFrameElement: Frame } })
    const other = frame(Frame)
    other.srcdoc = '<script>a()</script>'
    expect(other.srcdoc).toBe('<script>a()</script>')
  })

  it('is nothing in another browser, where the page has no policy to meet', () => {
    const Frame = iframeClass()
    runBridge(source, { globals: { HTMLIFrameElement: Frame } })
    const plugin = frame(Frame, 'data-plugin-iframe')
    plugin.srcdoc = '<script>a()</script>'
    expect(plugin.srcdoc).toBe('<script>a()</script>')
  })

  it('does not stop the bridge from installing where the page has no iframe class', () => {
    expect(() => runBridge(source, { orivon: {} })).not.toThrow()
  })
})

describe('the runner', () => {
  class FakeElement {
    nodeType = 1
    localName = 'div'
    id = ''
    readonly attributes = new Map<string, string>()
    readonly listeners: Array<{ type: string, listener: (event: unknown) => void }> = []
    previousElementSibling: FakeElement | null = null
    textContent = ''
    constructor (init: { localName?: string, attributes?: Record<string, string>, text?: string } = {}) {
      this.localName = init.localName ?? 'div'
      for (const [name, value] of Object.entries(init.attributes ?? {})) this.attributes.set(name, value)
      this.textContent = init.text ?? ''
    }
    hasAttribute (name: string) { return this.attributes.has(name) }
    getAttribute (name: string) { return this.attributes.get(name) ?? null }
    removeAttribute (name: string) { this.attributes.delete(name) }
    addEventListener (type: string, listener: (event: unknown) => void) { this.listeners.push({ type, listener }) }
    matches (selector: string) { return selector.split(',').some((part) => this.attributes.has(part.slice(1, -1))) }
    querySelectorAll () { return [] as FakeElement[] }
    get form () { return null }
  }

  class FakeDocument {
    nodeType = 9
    current: FakeElement | null = null
    all: FakeElement[] = []
    get currentScript () { return this.current }
    createElement () { return Object.fromEntries(['onclick', 'onchange', 'onkeydown'].map((name) => [name, null])) }
    querySelectorAll (selector: string) { return this.all.filter((element) => element.matches(selector)) }
  }

  function realm () {
    const document = new FakeDocument()
    const windowListeners: Array<{ type: string, listener: (event: unknown) => void }> = []
    const observers: Array<{ callback: (records: unknown[]) => void, options: unknown }> = []
    const reportError = vi.fn()
    const sandbox: Record<string, unknown> = {
      document,
      onload: null,
      onerror: null,
      addEventListener: (type: string, listener: (event: unknown) => void) => { windowListeners.push({ type, listener }) },
      reportError,
      MutationObserver: class {
        constructor (readonly callback: (records: unknown[]) => void) {}
        observe (_target: unknown, options: unknown) { observers.push({ callback: this.callback, options }) }
      }
    }
    sandbox['window'] = sandbox
    vm.createContext(sandbox)
    return { sandbox, document, windowListeners, observers, reportError }
  }

  /** What the parser has just reached: the inert block, then the runner after it, which is the script that is running. */
  function parse (r: ReturnType<typeof realm>, kind: 'classic' | 'module', text: string) {
    const data = new FakeElement({ localName: 'script', attributes: { 'data-orivon-inline': '', id: 'plugin-code' }, text })
    const run = new FakeElement({ localName: 'script', attributes: { 'data-orivon-run': kind } })
    run.previousElementSibling = data
    r.document.current = run
    return { data, run, go: () => { vm.runInContext(runnerSource, r.sandbox, { filename: 'plugin-frame.js' }) } }
  }

  describe('a classic script', () => {
    it('declares var and functions on the frame\'s global object, as an inline script does', () => {
      const r = realm()
      parse(r, 'classic', 'var seen = 1; function handler () { return seen + 1 }').go()
      expect(vm.runInContext('handler() + seen', r.sandbox)).toBe(3)
      expect(r.sandbox['seen']).toBe(1)
    })

    it('sees the element that holds its text as document.currentScript, and the real one again afterwards', () => {
      const r = realm()
      const { data, run } = parse(r, 'classic', 'var current = document.currentScript')
      vm.runInContext(runnerSource, r.sandbox)
      expect(r.sandbox['current']).toBe(data)
      expect(r.document.currentScript).toBe(run)
    })

    it('lets what it throws leave the script, to be reported as an uncaught error', () => {
      const r = realm()
      const { go, run } = parse(r, 'classic', 'throw new Error("plugin broke")')
      expect(go).toThrow('plugin broke')
      expect(r.document.currentScript).toBe(run)
    })
  })

  describe('a module script', () => {
    it('runs in strict mode with no this, and its declarations stay its own', async () => {
      const r = realm()
      parse(r, 'module', 'const kept = typeof this; var leak = 1; window.out = kept').go()
      await Promise.resolve()
      expect(r.sandbox['out']).toBe('undefined')
      expect(r.sandbox['leak']).toBeUndefined()
      expect(r.reportError).not.toHaveBeenCalled()
    })

    it('may await at its top level', async () => {
      const r = realm()
      parse(r, 'module', 'window.out = await Promise.resolve(42)').go()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(r.sandbox['out']).toBe(42)
    })

    it('reports a throw as an uncaught error, which is what a module that throws is', async () => {
      const r = realm()
      parse(r, 'module', 'undeclared = 1').go()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(r.reportError).toHaveBeenCalledOnce()
      expect(String(r.reportError.mock.calls[0]?.[0])).toContain('undeclared')
    })

    it('has no document.currentScript, as a module has none', () => {
      const r = realm()
      parse(r, 'module', 'window.out = document.currentScript').go()
      expect(r.sandbox['out']).toBeNull()
    })
  })

  it('does nothing for a runner that follows no inert block, so a stray tag runs no text', () => {
    const r = realm()
    const run = new FakeElement({ localName: 'script', attributes: { 'data-orivon-run': 'classic' } })
    r.document.current = run
    expect(() => vm.runInContext(runnerSource, r.sandbox)).not.toThrow()
    expect(r.observers).toHaveLength(0)
  })

  describe('an inline event handler', () => {
    const click = (element: FakeElement, event: Record<string, unknown> = {}) => element.listeners.find((entry) => entry.type === 'click')?.listener(event)

    it('is taken off its element and called by the runner, with the element as this and the event as event', () => {
      const r = realm()
      r.sandbox['calls'] = [] as unknown[]
      const button = new FakeElement({ localName: 'button', attributes: { onclick: 'calls.push([this.localName, event.kind])' } })
      r.document.all.push(button)
      parse(r, 'classic', '').go()
      expect(button.attributes.has('onclick')).toBe(false)
      click(button, { kind: 'press' })
      expect(r.sandbox['calls']).toEqual([['button', 'press']])
    })

    it('finds a function the page script declared, by the global scope', () => {
      const r = realm()
      const button = new FakeElement({ localName: 'button', attributes: { onclick: 'pressed()' } })
      r.document.all.push(button)
      parse(r, 'classic', 'var count = 0; function pressed () { count += 1 }').go()
      click(button)
      click(button)
      expect(r.sandbox['count']).toBe(2)
    })

    it('cancels the event when the code returns false', () => {
      const r = realm()
      const link = new FakeElement({ localName: 'a', attributes: { onclick: 'return false' } })
      r.document.all.push(link)
      parse(r, 'classic', '').go()
      const preventDefault = vi.fn()
      click(link, { cancelable: true, preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
    })

    it('is set on the window for the events a body attribute stands for', () => {
      const r = realm()
      r.sandbox['started'] = 0
      const body = new FakeElement({ localName: 'body', attributes: { onload: 'started += 1' } })
      r.document.all.push(body)
      parse(r, 'classic', '').go()
      expect(body.listeners).toHaveLength(0)
      r.windowListeners.find((entry) => entry.type === 'load')?.listener({})
      expect(r.sandbox['started']).toBe(1)
    })

    it('is found on an element added later and on an attribute set later, by the observer the first run starts', () => {
      const r = realm()
      r.sandbox['calls'] = [] as unknown[]
      parse(r, 'classic', '').go()
      expect(r.observers).toHaveLength(1)
      const added = new FakeElement({ localName: 'button', attributes: { onclick: 'calls.push("added")' } })
      const changed = new FakeElement({ localName: 'span' })
      r.observers[0]?.callback([{ type: 'childList', addedNodes: [added] }])
      changed.attributes.set('onclick', 'calls.push("changed")')
      r.observers[0]?.callback([{ type: 'attributes', target: changed }])
      click(added)
      click(changed)
      expect(r.sandbox['calls']).toEqual(['added', 'changed'])
    })

    it('starts one observer however many scripts run', () => {
      const r = realm()
      parse(r, 'classic', '').go()
      parse(r, 'classic', '').go()
      parse(r, 'module', '').go()
      expect(r.observers).toHaveLength(1)
    })
  })
})
