// webview-turnstile.js against a fake page and a fake <webview>: the sitekey check, the page it serves (the
// path, the headers, the nonce), the view it shows and when, every way a call ends and the text it ends with, and
// the clean-up. The widget's page itself runs in a small realm with a stand-in for Cloudflare's script. What
// Cloudflare answers to a real page is the end-to-end run's business, not this file's.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('./webview-turnstile.js', import.meta.url), 'utf8')

const PORT = 50219
const SITEKEY = '0x4AAAAAAFScwbbNFZtx0XVP'
const PAGE_URL = `http://localhost:${String(PORT)}/forge-turnstile?sitekey=${SITEKEY}`

type Listener = (event: Record<string, unknown>) => void

class FakeElement {
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  readonly listeners = new Map<string, Array<{ listener: Listener, once: boolean }>>()
  textContent = ''
  removed = false
  readonly name: string

  constructor (name: string) { this.name = name }

  setAttribute (name: string, value: string) { this.attributes.set(name, value) }
  removeAttribute (name: string) { this.attributes.delete(name) }
  appendChild (child: FakeElement) { this.children.push(child) }
  remove () { this.removed = true }
  addEventListener (type: string, listener: Listener, options?: { once?: boolean }) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), { listener, once: options?.once === true }])
  }

  emit (type: string, event: Record<string, unknown> = {}) {
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      if (entry.once) this.listeners.set(type, (this.listeners.get(type) ?? []).filter((other) => other !== entry))
      entry.listener(event)
    }
  }
}

interface Deferred<T> { promise: Promise<T>, resolve: (value: T) => void, reject: (error: Error) => void }
function deferred<T> (): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

interface Scenario {
  /** The view never fires did-finish-load: the shell never attached it. */
  neverAttaches?: boolean
  /** `loadURL` rejects with this and the page never gets ready. */
  loadError?: string
  /** The page is shown but never ready. */
  neverReady?: boolean
  /** The widget's page does not answer the interaction read. */
  interactionFails?: boolean
}

class FakeView extends FakeElement {
  readonly loaded: string[] = []
  readonly runs: string[] = []
  muted = false
  readonly result = deferred<unknown>()
  readonly interaction = deferred<unknown>()
  private readonly scenario: Scenario

  constructor (scenario: Scenario) { super('webview'); this.scenario = scenario }

  setAudioMuted (muted: boolean) { this.muted = muted }

  loadURL (url: string) {
    this.loaded.push(url)
    if (this.scenario.loadError !== undefined) return Promise.reject(new Error(this.scenario.loadError))
    if (this.scenario.neverReady !== true) queueMicrotask(() => { this.emit('dom-ready') })
    return new Promise<void>(() => {})
  }

  executeJavaScript (code: string) {
    this.runs.push(code)
    if (code === 'window.turnstileResult') return this.result.promise
    if (this.scenario.interactionFails === true) return Promise.reject(new Error('Script failed to execute'))
    return this.interaction.promise
  }
}

interface FakeSocket { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, close: () => Promise<void> }

/** A connection that sends `request` at once, or nothing (null), or the pieces given, each after its own pause in milliseconds. */
function socketFor (request: string | null | Array<[number, string]>) {
  const written: Uint8Array[] = []
  const state = { closed: false }
  const readable = new ReadableStream<Uint8Array>({
    async start (controller) {
      if (request === null) return
      const pieces: Array<[number, string]> = typeof request === 'string' ? [[0, request]] : request
      for (const [pause, text] of pieces) {
        if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause))
        controller.enqueue(new TextEncoder().encode(text))
      }
    }
  })
  const writable = new WritableStream<Uint8Array>({ write (chunk) { written.push(chunk) } })
  const socket: FakeSocket = { readable, writable, close: async () => { state.closed = true } }
  return { socket, state, text: () => Buffer.concat(written).toString('utf8') }
}

interface Answer { status: number, headers: Record<string, string>, body: string, raw: string }

function parse (raw: string): Answer {
  const [head = '', ...rest] = raw.split('\r\n\r\n')
  const [statusLine = '', ...lines] = head.split('\r\n')
  return {
    status: Number(/^HTTP\/1\.1 (\d+) /.exec(statusLine)?.[1]),
    headers: Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()])),
    body: rest.join('\r\n\r\n'),
    raw
  }
}

interface Options extends Scenario {
  /** `orivon.net.listen` rejects with this. */
  listenFails?: boolean
  /** The page has no `orivon.net`. */
  noNet?: boolean
  /** A closing listener holds its port this many milliseconds: `listen` on it fails until then, as the OS refuses a port still bound. */
  closeTakes?: number
}

function load (options: Options = {}) {
  const views: FakeView[] = []
  const boxes: FakeElement[] = []
  const bodyChildren: FakeElement[] = []
  const incoming: { push: (socket: FakeSocket) => void } = { push: () => {} }
  const servers: Array<{ close: ReturnType<typeof vi.fn> }> = []
  let portFreeAt = 0
  const listen = vi.fn(async (_options: { port: number, scope: string }) => {
    if (options.listenFails === true || Date.now() < portFreeAt) throw new Error('address in use')
    const server = {
      connections: new ReadableStream<FakeSocket>({ start (controller) { incoming.push = (socket) => { controller.enqueue(socket) } } }),
      close: vi.fn(async () => {
        portFreeAt = Date.now() + (options.closeTakes ?? 0)
        if (options.closeTakes !== undefined) await new Promise((resolve) => setTimeout(resolve, options.closeTakes))
      })
    }
    servers.push(server)
    return server
  })
  const window: Record<string, unknown> = { orivon: options.noNet === true ? {} : { net: { listen } } }
  const document = {
    createElement: (name: string) => {
      if (name === 'webview') { const view = new FakeView(options); views.push(view); return view }
      const element = new FakeElement(name)
      if (name === 'div' && boxes.length === views.length) boxes.push(element)
      return element
    },
    body: {
      appendChild: (box: FakeElement) => {
        bodyChildren.push(box)
        const view = box.children.find((child) => child instanceof FakeView)
        if (options.neverAttaches !== true) queueMicrotask(() => { view?.emit('did-finish-load') })
      }
    }
  }
  const sandbox = {
    window, document, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, Uint8Array, ReadableStream, WritableStream, Number, String,
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer) }
  }
  vm.runInNewContext(source, sandbox)
  const turnstile = window['orivonForgeTurnstile'] as { getToken: (sitekey: unknown, options?: { port?: number }) => Promise<string> }

  /** One call, with its outcome watched so a rejection is never unhandled. */
  function ask (...args: [unknown?, { port?: number }?]) {
    const outcome: { token?: string, error?: Error } = {}
    const done = turnstile.getToken(args.length === 0 ? SITEKEY : args[0], args[1] ?? { port: PORT }).then((token) => { outcome.token = token }, (error: Error) => { outcome.error = error })
    return { outcome, done }
  }

  async function flush (ms = 0) { await vi.advanceTimersByTimeAsync(ms) }

  /** A request to the page's listener, from outside, as a browser or another program would make it. */
  async function request (raw: string | null | ReturnType<typeof socketFor>, wait = 50): Promise<{ answer: Answer, closed: boolean }> {
    const connection = typeof raw === 'string' || raw === null ? socketFor(raw) : raw
    incoming.push(connection.socket)
    await flush(wait)
    return { answer: parse(connection.text()), closed: connection.state.closed }
  }

  return { views, boxes, bodyChildren, servers, listen, ask, flush, request, window, turnstile }
}

const GET = `GET /forge-turnstile?sitekey=${SITEKEY} HTTP/1.1\r\nHost: localhost:${String(PORT)}\r\n\r\n`

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the sitekey', () => {
  it.each(['', 'has space', 'x'.repeat(101), 'semi;colon', 'a/b', 'é', 'ok\n'])('is refused when it is %j, before anything is opened', async (sitekey) => {
    const page = load()
    const { outcome, done } = page.ask(sitekey)
    await done
    expect(outcome.error?.message).toBe('Invalid Turnstile sitekey')
    expect(page.listen).not.toHaveBeenCalled()
    expect(page.views).toHaveLength(0)
  })

  it.each([undefined, null, 5, {}])('is refused when it is not a string (%j)', async (sitekey) => {
    const page = load()
    const { outcome, done } = page.ask(sitekey)
    await done
    expect(outcome.error?.message).toBe('Invalid Turnstile sitekey')
  })

  it.each(['a', 'A_b-9', '0x4AAAAAAFScwbbNFZtx0XVP', 'x'.repeat(100), '1x00000000000000000000AA'])('is taken when it is %j', async (sitekey) => {
    const page = load()
    const { outcome, done } = page.ask(sitekey)
    await page.flush()
    page.views[0]?.result.resolve({ token: 'T' })
    await done
    expect(outcome.token).toBe('T')
    expect(page.views[0]?.loaded).toEqual([`http://localhost:${String(PORT)}/forge-turnstile?sitekey=${sitekey}`])
  })

  it('is refused with no port to serve the page on', async () => {
    const page = load()
    const { outcome, done } = page.ask(SITEKEY, {})
    await done
    expect(outcome.error?.message).toBe('Turnstile page failed to load: no port to serve it on')
    expect(page.listen).not.toHaveBeenCalled()
  })
})

describe('a token', () => {
  it('is the token the widget\'s page answers, from a view nobody sees that loads the page on http://localhost', async () => {
    const page = load()
    const { outcome, done } = page.ask()
    await page.flush()
    const [view] = page.views
    expect(view?.attributes.get('src')).toBe('about:blank')
    expect(view?.loaded).toEqual([PAGE_URL])
    expect(view?.muted).toBe(true)
    expect(page.bodyChildren).toHaveLength(1)
    expect(page.bodyChildren[0]?.attributes.get('style')).toMatch(/opacity:0;pointer-events:none;z-index:-1/)
    expect(page.bodyChildren[0]?.attributes.get('aria-hidden')).toBe('true')
    expect(outcome).toEqual({})
    view?.result.resolve({ token: 'token-1' })
    await done
    expect(outcome).toEqual({ token: 'token-1' })
  })

  it('is read with executeJavaScript, and the view is removed when the call ends', async () => {
    const page = load()
    const { done } = page.ask()
    await page.flush()
    const [view] = page.views
    expect(view?.runs).toEqual(['window.turnstileInteraction', 'window.turnstileResult'])
    expect(page.bodyChildren[0]?.removed).toBe(false)
    view?.result.resolve({ token: 'token-1' })
    await done
    expect(page.bodyChildren[0]?.removed).toBe(true)
  })

  it.each([
    [{ error: 'Turnstile error 600010' }, 'Turnstile error 600010'],
    [{ error: 'Turnstile token expired' }, 'Turnstile token expired'],
    [{ token: '' }, 'Turnstile returned no token'],
    [{}, 'Turnstile returned no token'],
    [null, 'Turnstile returned no token'],
    [{ token: 5 }, 'Turnstile returned no token'],
    [{ error: 7 }, 'Turnstile returned no token']
  ])('is refused as the desktop refuses it: %j rejects with "%s"', async (answer, text) => {
    const page = load()
    const { outcome, done } = page.ask()
    await page.flush()
    page.views[0]?.result.resolve(answer)
    await done
    expect(outcome.error?.message).toBe(text)
    expect(page.bodyChildren[0]?.removed).toBe(true)
  })
})

describe('the view', () => {
  it('stays hidden while Turnstile solves by itself', async () => {
    const page = load()
    const { done } = page.ask()
    await page.flush(5000)
    expect(page.bodyChildren[0]?.attributes.get('style')).toMatch(/opacity:0/)
    page.views[0]?.result.resolve({ token: 'T' })
    await done
  })

  it('is shown at the desktop window\'s size, in the middle, with a title and a close button, when Cloudflare asks for the person\'s action', async () => {
    const page = load()
    const { done } = page.ask()
    await page.flush()
    const [view] = page.views
    const [box] = page.bodyChildren
    view?.interaction.resolve(undefined)
    await page.flush()
    const style = box?.attributes.get('style') ?? ''
    expect(style).toMatch(/position:fixed/)
    expect(style).toMatch(/left:calc\(50% - 170px\)/)
    expect(style).toMatch(/width:340px/)
    expect(style).toMatch(/z-index:2147483647/)
    expect(style).not.toMatch(/opacity:0|pointer-events:none/)
    expect(box?.attributes.has('aria-hidden')).toBe(false)
    expect(view?.attributes.get('style')).toMatch(/width:340px;height:120px/)
    const bar = box?.children[0]
    expect(bar?.children[0]?.textContent).toBe('Forge Images')
    expect(bar?.children[1]?.attributes.get('aria-label')).toBe('Close')
    view?.result.resolve({ token: 'T' })
    await done
  })

  it('stays hidden when the page does not answer the interaction read, and the token still comes', async () => {
    const page = load({ interactionFails: true })
    const { outcome, done } = page.ask()
    await page.flush()
    expect(page.bodyChildren[0]?.attributes.get('style')).toMatch(/opacity:0/)
    page.views[0]?.result.resolve({ token: 'T' })
    await done
    expect(outcome.token).toBe('T')
  })

  it('is closed by the person with the close button: the call ends with the desktop\'s text', async () => {
    const page = load()
    const { outcome, done } = page.ask()
    await page.flush()
    page.views[0]?.interaction.resolve(undefined)
    await page.flush()
    page.bodyChildren[0]?.children[0]?.children[1]?.emit('click')
    await done
    expect(outcome.error?.message).toBe('Turnstile check was closed')
    expect(page.bodyChildren[0]?.removed).toBe(true)
  })

  it.each([
    ['is reloaded', 'did-start-navigation', { isMainFrame: true, isInPlace: false }, 'Turnstile check was reloaded'],
    ['crashes', 'render-process-gone', {}, 'Turnstile check crashed'],
    ['is closed by the shell', 'destroyed', {}, 'Turnstile check was closed'],
    ['fails to load', 'did-fail-load', { isMainFrame: true, errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED' }, 'Turnstile page failed to load: -102 ERR_CONNECTION_REFUSED']
  ])('ends the call when the page %s, with the desktop\'s text', async (_name, event, detail, text) => {
    const page = load()
    const { outcome, done } = page.ask()
    await page.flush()
    page.views[0]?.emit(event, detail)
    await done
    expect(outcome.error?.message).toBe(text)
    expect(page.bodyChildren[0]?.removed).toBe(true)
  })

  it.each([
    ['a navigation inside the page', 'did-start-navigation', { isMainFrame: true, isInPlace: true }],
    ['a navigation of a frame inside it', 'did-start-navigation', { isMainFrame: false, isInPlace: false }],
    ['a frame that fails to load', 'did-fail-load', { isMainFrame: false, errorCode: -3, errorDescription: 'ERR_ABORTED' }]
  ])('does not end the call for %s', async (_name, event, detail) => {
    const page = load()
    const { outcome, done } = page.ask()
    await page.flush()
    page.views[0]?.emit(event, detail)
    await page.flush()
    expect(outcome).toEqual({})
    page.views[0]?.result.resolve({ token: 'T' })
    await done
    expect(outcome.token).toBe('T')
  })
})

describe('a call that does not work', () => {
  it('rejects with the reason when the page cannot be loaded, and removes the view', async () => {
    const page = load({ loadError: "ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:50219/forge-turnstile'" })
    const { outcome, done } = page.ask()
    await done
    expect(outcome.error?.message).toBe("Turnstile page failed to load: ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:50219/forge-turnstile'")
    expect(page.bodyChildren[0]?.removed).toBe(true)
  })

  it('rejects when the shell never attaches the view, after 30 seconds', async () => {
    const page = load({ neverAttaches: true })
    const { outcome, done } = page.ask()
    await page.flush(29_000)
    expect(outcome).toEqual({})
    await page.flush(2000)
    await done
    expect(outcome.error?.message).toBe('Turnstile page failed to load: the page could not be shown')
    expect(page.bodyChildren[0]?.removed).toBe(true)
  })

  it('gives up on a page that never answers at 180 seconds, as the desktop\'s window does', async () => {
    const page = load()
    const { outcome, done } = page.ask()
    await page.flush(179_000)
    expect(outcome).toEqual({})
    await page.flush(2000)
    await done
    expect(outcome.error?.message).toBe('Turnstile check timed out')
    expect(page.bodyChildren[0]?.removed).toBe(true)
  })

  it('gives up on a page that never becomes ready at 180 seconds too', async () => {
    const page = load({ neverReady: true })
    const { outcome, done } = page.ask()
    await page.flush(181_000)
    await done
    expect(outcome.error?.message).toBe('Turnstile check timed out')
  })
})

describe('the listener', () => {
  it('is opened on the granted port, for this computer only, and closed ten seconds after the call ends', async () => {
    const page = load()
    const { done } = page.ask()
    await page.flush()
    expect(page.listen).toHaveBeenCalledWith({ port: PORT, scope: 'local' })
    expect(page.servers[0]?.close).not.toHaveBeenCalled()
    page.views[0]?.result.resolve({ token: 'T' })
    await done
    await page.flush(9000)
    expect(page.servers[0]?.close).not.toHaveBeenCalled()
    await page.flush(1500)
    expect(page.servers[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('is one for calls at the same time, and closed after the last of them ends', async () => {
    const page = load()
    const first = page.ask()
    const second = page.ask()
    await page.flush()
    expect(page.listen).toHaveBeenCalledTimes(1)
    expect(page.views).toHaveLength(2)
    page.views[0]?.result.resolve({ token: 'one' })
    await first.done
    await page.flush(20_000)
    expect(page.servers[0]?.close).not.toHaveBeenCalled()
    page.views[1]?.result.resolve({ token: 'two' })
    await second.done
    await page.flush(11_000)
    expect(page.servers[0]?.close).toHaveBeenCalledTimes(1)
    expect([first.outcome.token, second.outcome.token]).toEqual(['one', 'two'])
  })

  it('is kept for a call that follows soon, which reuses it and keeps it open', async () => {
    const page = load()
    const first = page.ask()
    await page.flush()
    page.views[0]?.result.resolve({ token: 'one' })
    await first.done
    await page.flush(8000)
    const second = page.ask()
    await page.flush(5000)
    expect(page.listen).toHaveBeenCalledTimes(1)
    expect(page.servers[0]?.close).not.toHaveBeenCalled()
    page.views[1]?.result.resolve({ token: 'two' })
    await second.done
    expect(second.outcome.token).toBe('two')
    await page.flush(11_000)
    expect(page.servers[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('is opened again for a call that comes after it closed', async () => {
    const page = load()
    const first = page.ask()
    await page.flush()
    page.views[0]?.result.resolve({ token: 'one' })
    await first.done
    await page.flush(11_000)
    const second = page.ask()
    await page.flush()
    expect(page.listen).toHaveBeenCalledTimes(2)
    page.views[1]?.result.resolve({ token: 'two' })
    await second.done
  })

  it('waits for a listener that is closing before it opens the port again, so the port is never refused for being held a moment longer', async () => {
    const page = load({ closeTakes: 3000 })
    const first = page.ask()
    await page.flush()
    page.views[0]?.result.resolve({ token: 'one' })
    await first.done
    await page.flush(10_500)
    expect(page.servers[0]?.close).toHaveBeenCalledTimes(1)
    const second = page.ask()
    await page.flush(500)
    expect(page.views).toHaveLength(2)
    expect(page.views[1]?.loaded).toEqual([])
    await page.flush(3000)
    expect(page.listen).toHaveBeenCalledTimes(2)
    expect(page.servers).toHaveLength(2)
    expect(page.views[1]?.loaded).toEqual([PAGE_URL])
    page.views[1]?.result.resolve({ token: 'two' })
    await second.done
    expect(second.outcome.token).toBe('two')
  })

  it('is not needed when the port is held by another page of the app: the call goes on and loads the page', async () => {
    const page = load({ listenFails: true })
    const { outcome, done } = page.ask()
    await page.flush()
    expect(page.views[0]?.loaded).toEqual([PAGE_URL])
    page.views[0]?.result.resolve({ token: 'T' })
    await done
    expect(outcome.token).toBe('T')
  })

  it('is not possible without orivon.net, and the load then fails with its own reason', async () => {
    const page = load({ noNet: true, loadError: 'ERR_CONNECTION_REFUSED (-102)' })
    const { outcome, done } = page.ask()
    await done
    expect(page.listen).not.toHaveBeenCalled()
    expect(outcome.error?.message).toBe('Turnstile page failed to load: ERR_CONNECTION_REFUSED (-102)')
  })
})

describe('the page the listener serves', () => {
  async function served (raw: string | null = GET, wait = 50) {
    const page = load()
    const { done } = page.ask()
    await page.flush()
    const reply = await page.request(raw, wait)
    page.views[0]?.result.resolve({ token: 'T' })
    await done
    return { ...reply, page }
  }

  it('answers a GET of /forge-turnstile with the widget\'s page and the headers a page needs', async () => {
    const { answer, closed } = await served()
    expect(answer.status).toBe(200)
    expect(answer.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(Number(answer.headers['content-length'])).toBe(Buffer.byteLength(answer.body))
    expect(answer.headers['cache-control']).toBe('no-store')
    expect(answer.headers['x-content-type-options']).toBe('nosniff')
    expect(answer.headers['connection']).toBe('close')
    expect(answer.body).toMatch(/^<!doctype html>/)
    expect(answer.body).toContain('<div id="widget"></div>')
    expect(answer.body).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
    expect(closed).toBe(true)
  })

  it('names the sitekey nowhere in the page: the page reads it from its own address', async () => {
    const { answer } = await served()
    expect(answer.body).not.toContain(SITEKEY)
    expect(answer.body).toContain("new URLSearchParams(location.search).get('sitekey')")
  })

  it('admits its one inline script by a nonce made for the response, and Cloudflare\'s origin and nothing else', async () => {
    const { answer } = await served()
    const nonce = /<script nonce="([^"]+)">/.exec(answer.body)?.[1]
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    const policy = answer.headers['content-security-policy'] ?? ''
    expect(policy).toContain(`script-src 'nonce-${String(nonce)}' https://challenges.cloudflare.com`)
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain('frame-src https://challenges.cloudflare.com')
    expect(policy).not.toMatch(/'unsafe-eval'|script-src[^;]*'unsafe-inline'|\*/)
  })

  it('makes a new nonce for every response', async () => {
    const page = load()
    const { done } = page.ask()
    await page.flush()
    const nonces = new Set<string>()
    for (let index = 0; index < 5; index++) nonces.add(/nonce="([^"]+)"/.exec((await page.request(GET)).answer.body)?.[1] ?? '')
    expect(nonces.size).toBe(5)
    page.views[0]?.result.resolve({ token: 'T' })
    await done
  })

  it('answers the same page to a HEAD, without the body', async () => {
    const { answer } = await served(`HEAD /forge-turnstile?sitekey=${SITEKEY} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
    expect(answer.status).toBe(200)
    expect(answer.body).toBe('')
    expect(Number(answer.headers['content-length'])).toBeGreaterThan(1000)
  })

  it.each(['/', '/forge-turnstile/', '/forge-turnstile.js', '/index.html', '/%66orge-turnstile', '/../forge-turnstile', '//forge-turnstile'])('answers 404 for %s, as the desktop does for every path but its page', async (path) => {
    const { answer } = await served(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
    expect(answer.status).toBe(404)
    expect(answer.body).toBe('')
    expect(answer.headers['content-length']).toBe('0')
    expect(answer.headers['content-security-policy']).toBeUndefined()
  })

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])('answers 405 to a %s of the page', async (method) => {
    const { answer } = await served(`${method} /forge-turnstile HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n`)
    expect(answer.status).toBe(405)
    expect(answer.headers['allow']).toBe('GET, HEAD')
  })

  it('answers 404 to a request that is not HTTP', async () => {
    const { answer } = await served('hello\r\n\r\n')
    expect(answer.status).toBe(404)
  })

  it('reads a request that arrives in pieces', async () => {
    const page = load()
    const { done } = page.ask()
    await page.flush()
    const connection = socketFor([[0, 'GET /forge-turn'], [100, `stile?sitekey=${SITEKEY} HTTP/1.1\r\nHo`], [100, 'st: localhost\r\n\r\n']])
    const { answer } = await page.request(connection, 500)
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('<div id="widget"></div>')
    page.views[0]?.result.resolve({ token: 'T' })
    await done
  })

  it('closes a connection that sends nothing after 5 seconds, and answers one that sends too much', async () => {
    const page = load()
    const { done } = page.ask()
    await page.flush()
    const idle = socketFor(null)
    await page.request(idle, 4000)
    expect(idle.state.closed).toBe(false)
    await page.flush(1500)
    expect(idle.state.closed).toBe(true)
    expect(idle.text()).toBe('')
    const flood = await page.request('A'.repeat(20_000), 50)
    expect(flood.answer.status).toBe(404)
    expect(flood.closed).toBe(true)
    page.views[0]?.result.resolve({ token: 'T' })
    await done
  })

  it('closes a connection at once when sixteen are open, and takes the next once one is done', async () => {
    const page = load()
    const { done } = page.ask()
    await page.flush()
    const idle = Array.from({ length: 16 }, () => socketFor(null))
    for (const connection of idle) await page.request(connection, 10)
    const refused = socketFor(GET)
    await page.request(refused, 50)
    expect(refused.state.closed).toBe(true)
    expect(refused.text()).toBe('')
    await page.flush(6000)
    expect(idle.every((connection) => connection.state.closed)).toBe(true)
    const later = await page.request(GET)
    expect(later.answer.status).toBe(200)
    page.views[0]?.result.resolve({ token: 'T' })
    await done
  })
})

describe('the page in the shown view', () => {
  interface FakeScript { src?: string, onload?: () => void, onerror?: () => void }

  /** The inline script of the page the listener serves, run in a realm of its own with a stand-in for Cloudflare's script. */
  async function widget (search = `?sitekey=${SITEKEY}`) {
    const page = load()
    const { done } = page.ask()
    await page.flush()
    const html = (await page.request(GET)).answer.body
    page.views[0]?.result.resolve({ token: 'T' })
    await done
    const inline = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)?.[1]
    if (inline === undefined) throw new Error('the page has no inline script')
    const added: FakeScript[] = []
    const guestWindow: Record<string, unknown> = {}
    const rendered: Array<{ container: string, options: Record<string, unknown> }> = []
    const context = {
      window: guestWindow,
      document: { createElement: () => ({} as FakeScript), head: { appendChild: (script: FakeScript) => { added.push(script) } } },
      location: { search },
      URLSearchParams,
      String,
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer) }
    }
    vm.runInNewContext(inline, context)
    const result = guestWindow['turnstileResult'] as Promise<{ token?: string, error?: string }>
    const interaction = guestWindow['turnstileInteraction'] as Promise<undefined>
    const watched: { result?: { token?: string, error?: string }, interactive: boolean } = { interactive: false }
    void result.then((answer) => { watched.result = answer })
    void interaction.then(() => { watched.interactive = true })
    const loadScript = (): void => {
      guestWindow['turnstile'] = { render: (container: string, options: Record<string, unknown>) => { rendered.push({ container, options }) } }
      added[0]?.onload?.()
    }
    const callbacks = (): Record<string, (...args: unknown[]) => unknown> => rendered[0]?.options as unknown as Record<string, (...args: unknown[]) => unknown>
    return { added, rendered, watched, loadScript, callbacks, guestWindow }
  }

  it('loads Cloudflare\'s script with an explicit render, and renders the widget as the desktop\'s page does', async () => {
    const guest = await widget()
    expect(guest.added).toHaveLength(1)
    expect(guest.added[0]?.src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
    guest.loadScript()
    expect(guest.rendered).toHaveLength(1)
    expect(guest.rendered[0]?.container).toBe('#widget')
    expect(guest.rendered[0]?.options).toMatchObject({
      sitekey: SITEKEY, appearance: 'interaction-only', retry: 'never', 'refresh-expired': 'never', 'response-field': false
    })
  })

  it('answers { token } when Turnstile calls back with one, and { error } when it calls back with none', async () => {
    const guest = await widget()
    guest.loadScript()
    guest.callbacks()['callback']?.('the-token')
    await vi.advanceTimersByTimeAsync(0)
    expect(guest.watched.result).toEqual({ token: 'the-token' })
    const empty = await widget()
    empty.loadScript()
    empty.callbacks()['callback']?.('')
    await vi.advanceTimersByTimeAsync(0)
    expect(empty.watched.result).toEqual({ error: 'Turnstile returned an empty token' })
  })

  it.each([
    ['error-callback', ['300030'], 'Turnstile error 300030'],
    ['expired-callback', [], 'Turnstile token expired'],
    ['timeout-callback', [], 'Turnstile challenge timed out'],
    ['unsupported-callback', [], 'Turnstile is not supported by this browser']
  ])('answers { error } with the desktop\'s text on %s', async (name, args, text) => {
    const guest = await widget()
    guest.loadScript()
    guest.callbacks()[name]?.(...args)
    await vi.advanceTimersByTimeAsync(0)
    expect(guest.watched.result).toEqual({ error: text })
  })

  it('answers true from the error callback, so Turnstile does not retry', async () => {
    const guest = await widget()
    guest.loadScript()
    expect(guest.callbacks()['error-callback']?.('300030')).toBe(true)
  })

  it('answers the first result only', async () => {
    const guest = await widget()
    guest.loadScript()
    guest.callbacks()['callback']?.('first')
    guest.callbacks()['error-callback']?.('1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(guest.watched.result).toEqual({ token: 'first' })
  })

  it('answers { error } when the script fails to load', async () => {
    const guest = await widget()
    guest.added[0]?.onerror?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(guest.watched.result).toEqual({ error: 'Turnstile script failed to load' })
  })

  it('answers { error } when the script does not load in 15 seconds', async () => {
    const guest = await widget()
    await vi.advanceTimersByTimeAsync(14_000)
    expect(guest.watched.result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1500)
    expect(guest.watched.result).toEqual({ error: 'Turnstile script load timed out' })
  })

  it('answers { error } when no token comes in 30 seconds of the script loading', async () => {
    const guest = await widget()
    await vi.advanceTimersByTimeAsync(10_000)
    guest.loadScript()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(guest.watched.result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1500)
    expect(guest.watched.result).toEqual({ error: 'Turnstile check timed out' })
  })

  it('announces the interaction and gives the person 120 seconds, not 30, once Cloudflare asks', async () => {
    const guest = await widget()
    guest.loadScript()
    await vi.advanceTimersByTimeAsync(20_000)
    guest.callbacks()['before-interactive-callback']?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(guest.watched.interactive).toBe(true)
    await vi.advanceTimersByTimeAsync(119_000)
    expect(guest.watched.result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1500)
    expect(guest.watched.result).toEqual({ error: 'Turnstile check timed out' })
  })

  it('answers { error } with the exception\'s message when the render throws, and when the API is missing', async () => {
    const guest = await widget()
    guest.guestWindow['turnstile'] = { render: () => { throw new Error('Invalid sitekey') } }
    guest.added[0]?.onload?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(guest.watched.result).toEqual({ error: 'Invalid sitekey' })
    const missing = await widget()
    missing.added[0]?.onload?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(missing.watched.result?.error).toBe("Cannot read properties of undefined (reading 'render')")
  })

  it('reads the sitekey from its own address', async () => {
    const guest = await widget('?sitekey=1x00000000000000000000AA&other=1')
    guest.loadScript()
    expect(guest.rendered[0]?.options['sitekey']).toBe('1x00000000000000000000AA')
  })
})
