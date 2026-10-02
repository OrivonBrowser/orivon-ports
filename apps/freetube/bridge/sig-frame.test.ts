// The sigFrame: upstream's n/sig decipher helper, an iframe whose script is
// inline in a data: URL. The shell's CSP admits no inline script, so this
// port serves that script from the app's own origin instead -- the build step
// writes it out, and the bridge points the frame at it. These tests cover
// both halves against a document shaped like upstream's own `index.ejs`
// output, and the wrapper's refusal to run anywhere but in that frame.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import { SIG_FRAME_FILE, transformHtml } from '../hooks.mjs'

const source = await bridgeSourceFor('freetube')

// A stand-in with the shape of upstream's decipher helper -- not its bytes,
// which are never tracked here: listen for a message, evaluate its code,
// answer the parent. What the hook carries over is whatever the data: URL holds.
const INLINE_SCRIPT = 'window.addEventListener("message",(event)=>{const request=JSON.parse(event.data);window.parent.postMessage(JSON.stringify({id:request.id,result:new Function(request.code)()}),"*")});'
const DATA_URL = `data:text/html,${encodeURIComponent(`<!doctype html><script>${INLINE_SCRIPT}</script>`)}`
const INLINE_CSP = "default-src 'none'; script-src 'sha512-abc/def+ghi==' 'unsafe-eval'"

function builtIndex (): string {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"/><title></title></head><body><div id="app"></div>' +
    `<iframe id="sigFrame" src="${DATA_URL}" csp="${INLINE_CSP}" sandbox="allow-scripts" height="1" width="1" style="display:none;pointer-events:none" tabindex="-1"></iframe>` +
    '</body></html>'
}

function frameTag (html: string): string {
  const match = html.match(/<iframe\b[^>]*\bid="sigFrame"[^>]*>/)
  if (match === null) throw new Error('no sigFrame in the html')
  return match[0]
}

describe('prepare-time rewrite (hooks.mjs)', () => {
  let dirs: { static: string }

  beforeEach(async () => {
    dirs = { static: await mkdtemp(join(tmpdir(), 'ft-sigframe-')) }
    await mkdir(join(dirs.static, 'orivon'), { recursive: true })
  })
  afterEach(async () => { await rm(dirs.static, { recursive: true, force: true }) })

  it('strips the frame\'s inline src and csp, and keeps its sandbox and everything else', async () => {
    const html = await transformHtml(builtIndex(), { dirs })
    const tag = frameTag(html)
    expect(tag).not.toMatch(/\bsrc=/)
    expect(tag).not.toMatch(/\bcsp=/)
    expect(tag).not.toContain('data:')
    expect(tag).toContain('sandbox="allow-scripts"')
    expect(tag).toContain('id="sigFrame"')
    expect(tag).toContain('style="display:none;pointer-events:none"')
    expect(html).not.toContain('<script>')
  })

  it('writes the script the data: URL held, unchanged, behind the wrapper\'s guard', async () => {
    await transformHtml(builtIndex(), { dirs })
    const served = await readFile(join(dirs.static, SIG_FRAME_FILE), 'utf8')
    expect(served).toContain(INLINE_SCRIPT)
    expect(served.endsWith(`${INLINE_SCRIPT}\n`)).toBe(true)
    expect(served.indexOf('throw')).toBeLessThan(served.indexOf(INLINE_SCRIPT))
  })

  it('is idempotent over its own output', async () => {
    const once = await transformHtml(builtIndex(), { dirs })
    expect(await transformHtml(once, { dirs })).toBe(once)
  })

  it('reads an HTML-escaped attribute the way a browser does', async () => {
    const escaped = builtIndex().replace(DATA_URL, DATA_URL.replace(/'/g, '&#39;').replace(/&/g, '&amp;'))
    await transformHtml(escaped, { dirs })
    expect(await readFile(join(dirs.static, SIG_FRAME_FILE), 'utf8')).toContain(INLINE_SCRIPT)
  })

  it('fails loudly when the document has no sigFrame, or its src is not the expected shape', async () => {
    await expect(transformHtml('<html><head></head><body></body></html>', { dirs })).rejects.toThrow(/sigFrame/)
    const odd = builtIndex().replace(DATA_URL, 'https://example.test/frame.html')
    await expect(transformHtml(odd, { dirs })).rejects.toThrow(/sigFrame/)
  })

  it('still adds the favicon link, as before', async () => {
    expect(await transformHtml(builtIndex(), { dirs })).toContain('rel="icon"')
  })
})

describe('the served wrapper (orivon/sig-frame.js)', () => {
  let served: string
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ft-sigframe-'))
    await mkdir(join(dir, 'orivon'), { recursive: true })
    await transformHtml(builtIndex(), { dirs: { static: dir } })
    served = await readFile(join(dir, SIG_FRAME_FILE), 'utf8')
    await rm(dir, { recursive: true, force: true })
  })

  interface Realm {
    listeners: Array<(event: { data: string }) => void>
    posted: string[]
    sandbox: Record<string, any>
  }

  function realm (origin: string, inChildFrame: boolean): Realm {
    const listeners: Realm['listeners'] = []
    const posted: string[] = []
    const parent = { postMessage: (message: string) => { posted.push(message) } }
    const self: Record<string, unknown> = { origin }
    self['parent'] = inChildFrame ? parent : self
    self['addEventListener'] = (_type: string, listener: Realm['listeners'][number]) => { listeners.push(listener) }
    const sandbox: Record<string, any> = { self, window: self, JSON, Function }
    vm.createContext(sandbox)
    return { listeners, posted, sandbox }
  }

  it('installs the decipher listener in an opaque-origin child frame', () => {
    const frame = realm('null', true)
    vm.runInContext(served, frame.sandbox)
    expect(frame.listeners).toHaveLength(1)
    frame.listeners[0]?.({ data: JSON.stringify({ id: 'probe', code: 'return 1 + 1' }) })
    expect(frame.posted.map((message) => JSON.parse(message))).toEqual([{ id: 'probe', result: 2 }])
  })

  it('installs nothing in a top-level document of the app origin, where an injected script would run as the page', () => {
    const top = realm('http://127.0.0.1:8875', false)
    expect(() => vm.runInContext(served, top.sandbox)).toThrow(/sig-frame/)
    expect(top.listeners).toHaveLength(0)
  })

  it('installs nothing in a same-origin child frame', () => {
    const sameOrigin = realm('http://127.0.0.1:8875', true)
    expect(() => vm.runInContext(served, sameOrigin.sandbox)).toThrow(/sig-frame/)
    expect(sameOrigin.listeners).toHaveLength(0)
  })

  it('installs nothing in an opaque-origin top-level document (a data: page opened as a tab)', () => {
    const opaqueTop = realm('null', false)
    expect(() => vm.runInContext(served, opaqueTop.sandbox)).toThrow(/sig-frame/)
    expect(opaqueTop.listeners).toHaveLength(0)
  })
})

describe('the bridge points the frame at the served script (ft-electron.js)', () => {
  interface FakeFrame {
    attributes: Record<string, string>
    setAttribute: (name: string, value: string) => void
    getAttribute: (name: string) => string | null
    removeAttribute: (name: string) => void
  }

  function frame (initial: Record<string, string>): FakeFrame {
    const attributes = { ...initial }
    return {
      attributes,
      setAttribute: (name, value) => { attributes[name] = value },
      getAttribute: (name) => attributes[name] ?? null,
      removeAttribute: (name) => { delete attributes[name] }
    }
  }

  function load (state: { readyState: string, baseURI: string, frame: FakeFrame | null }) {
    const listeners: Array<() => void> = []
    const document = {
      title: 'app',
      baseURI: state.baseURI,
      readyState: state.readyState,
      getElementById: (id: string) => (id === 'sigFrame' ? state.frame : null),
      addEventListener: (type: string, listener: () => void) => { if (type === 'DOMContentLoaded') listeners.push(listener) }
    }
    runBridge(source, { document })
    return { fire: () => { for (const listener of listeners) listener() }, listeners }
  }

  const sandboxed = { sandbox: 'allow-scripts', height: '1' }

  it('sets src and a narrowed csp at DOMContentLoaded, from the document\'s own origin, leaving sandbox alone', () => {
    const sigFrame = frame(sandboxed)
    const { fire } = load({ readyState: 'loading', baseURI: 'http://127.0.0.1:8875/#/watch/abc', frame: sigFrame })
    expect(sigFrame.attributes['src']).toBeUndefined()
    fire()
    const script = 'http://127.0.0.1:8875/orivon/sig-frame.js'
    expect(sigFrame.attributes['csp']).toBe(`default-src 'none'; script-src ${script} 'unsafe-eval'`)
    expect(sigFrame.attributes['src']).toBe(`data:text/html,${encodeURIComponent(`<!doctype html><script src="${script}"></script>`)}`)
    expect(sigFrame.attributes['sandbox']).toBe('allow-scripts')
    expect(sigFrame.attributes['height']).toBe('1')
  })

  it('writes csp before src, so the frame\'s first navigation already carries the policy', () => {
    const order: string[] = []
    const sigFrame = frame(sandboxed)
    const original = sigFrame.setAttribute
    sigFrame.setAttribute = (name, value) => { order.push(name); original(name, value) }
    load({ readyState: 'loading', baseURI: 'https://freetube.eth/', frame: sigFrame }).fire()
    expect(order).toEqual(['csp', 'src'])
    expect(sigFrame.attributes['csp']).toContain('https://freetube.eth/orivon/sig-frame.js')
  })

  it('resolves the script against the entry document, so a path prefix survives', () => {
    const sigFrame = frame(sandboxed)
    load({ readyState: 'loading', baseURI: 'https://gw.example/ipfs/bafy/index.html', frame: sigFrame }).fire()
    expect(sigFrame.attributes['csp']).toContain('https://gw.example/ipfs/bafy/orivon/sig-frame.js')
  })

  it('acts at once when the document has already been parsed', () => {
    const sigFrame = frame(sandboxed)
    const { listeners } = load({ readyState: 'interactive', baseURI: 'http://127.0.0.1:8875/', frame: sigFrame })
    expect(listeners).toHaveLength(0)
    expect(sigFrame.attributes['src']).toContain('data:text/html,')
  })

  it('does nothing when the document has no sigFrame', () => {
    expect(() => { load({ readyState: 'loading', baseURI: 'http://127.0.0.1:8875/', frame: null }).fire() }).not.toThrow()
  })
})
