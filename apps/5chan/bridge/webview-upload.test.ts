// The upload runner of webview-upload.js against a fake <webview> whose page is a small table of
// selectors: each step the desktop's hidden window takes (load, settle, blocked check, file input,
// file, prepare script, submit, poll), its messages, its timeouts, and the clean-up. What a real page
// does with a file set from script is the end-to-end run's business, not this file's.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('./webview-upload.js', import.meta.url), 'utf8')

interface GuestElement {
  attributes?: Record<string, string>
  value?: string
  textContent?: string
  rects?: number
  click?: () => void
  files?: File[]
  events?: string[]
  onChange?: () => void
}

/** The page inside the element: a document that finds an element by the exact selector string, and nothing more of a DOM. */
class FakeGuest {
  readonly elements = new Map<string, GuestElement>()
  readonly window: Record<string, unknown> = {}
  readonly location = { pathname: '/upload' }
  readonly document = { querySelector: (selector: string) => this.wrap(selector) }
  private readonly context: object

  constructor () {
    class FakeEvent {
      readonly type: string
      constructor (type: string) { this.type = type }
    }
    class FakeTransfer {
      files: File[] = []
      items = { add: (file: File) => { this.files = [file] } }
    }
    this.context = vm.createContext({
      window: this.window, document: this.document, location: this.location, atob, File, Uint8Array, Event: FakeEvent, DataTransfer: FakeTransfer
    })
  }

  private wrap (selector: string): unknown {
    const element = this.elements.get(selector)
    if (element === undefined) return null
    return {
      textContent: element.textContent ?? '',
      value: element.value,
      getAttribute: (name: string) => element.attributes?.[name] ?? null,
      getClientRects: () => ({ length: element.rects ?? 1 }),
      click: () => { element.click?.() },
      dispatchEvent: (event: { type: string }) => { (element.events ??= []).push(event.type); if (event.type === 'change') element.onChange?.() },
      set files (value: File[]) { element.files = value }
    }
  }

  run (code: string): unknown { return vm.runInContext(code, this.context) }
}

interface ViewOptions { loadError?: string, neverLoads?: boolean, neverAttaches?: boolean, failRuns?: () => boolean }

class FakeView {
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Array<() => void>>()
  readonly loaded: string[] = []
  readonly runs: Array<{ code: string, gesture: unknown }> = []
  muted = false
  removed = false

  readonly guest: FakeGuest
  readonly options: ViewOptions

  constructor (guest: FakeGuest, options: ViewOptions = {}) {
    this.guest = guest
    this.options = options
  }

  setAttribute (name: string, value: string) { this.attributes.set(name, value) }
  addEventListener (type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  attach () { if (this.options.neverAttaches !== true) queueMicrotask(() => { for (const listener of this.listeners.get('did-finish-load') ?? []) listener() }) }
  loadURL (url: string) {
    this.loaded.push(url)
    if (this.options.neverLoads === true) return new Promise<void>(() => {})
    return this.options.loadError === undefined ? Promise.resolve() : Promise.reject(new Error(this.options.loadError))
  }

  setAudioMuted (muted: boolean) { this.muted = muted }
  remove () { this.removed = true }
  async executeJavaScript (code: string, gesture?: unknown) {
    this.runs.push({ code, gesture })
    if (this.options.failRuns?.() === true) throw new Error('Script failed to execute')
    return this.guest.run(code)
  }
}

interface Upload { upload: (provider: string, file: File) => Promise<{ url: string, provider: string }>, stripMetadata: (file: File) => Promise<File>, providers: string[] }

function load (guest: FakeGuest, options: ViewOptions = {}) {
  const view = new FakeView(guest, options)
  const created: string[] = []
  const window: Record<string, unknown> = {}
  const sandbox = {
    window,
    document: { createElement: (name: string) => { created.push(name); return view }, body: { appendChild: (child: FakeView) => { child.attach() } } },
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer) },
    Date: { now: () => Date.now() },
    console, btoa, atob, File, Uint8Array
  }
  vm.runInNewContext(source, sandbox)
  return { view, created, uploader: window['orivonWebviewUpload'] as Upload }
}

const PNG = new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])], 'pic.png', { type: 'image/png' })
const MEDIA_LINK = (url: string): GuestElement => ({ attributes: { href: url } })

/** Settles an upload that waits on timers: every pending timer fires, in order, until the promise answers. */
async function settled<T> (promise: Promise<T>, stepMs = 250, limitMs = 120_000): Promise<{ ok: T } | { error: Error }> {
  let result: { ok: T } | { error: Error } | undefined
  promise.then((ok) => { result = { ok } }, (error: Error) => { result = { error } })
  for (let waited = 0; result === undefined && waited < limitMs; waited += stepMs) await vi.advanceTimersByTimeAsync(stepMs)
  if (result === undefined) throw new Error('the upload never answered')
  return result
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** An imgur-like page: a file input, a submit button that makes the result appear. */
function imgurPage (guest = new FakeGuest(), result: GuestElement = MEDIA_LINK('https://i.imgur.com/abc123.png')) {
  guest.elements.set('input[type="file"]', {})
  guest.elements.set('button[type="submit"]', { click: () => { guest.elements.set('a[href*="i.imgur.com"]', result) } })
  return guest
}

describe('an upload that works', () => {
  it('shows the upload page in an element nobody sees, hands the file to the page\'s file input, clicks submit, and answers { url, provider }', async () => {
    const guest = imgurPage()
    const { view, created, uploader } = load(guest)
    const outcome = await settled(uploader.upload('imgur', PNG))
    expect(outcome).toEqual({ ok: { url: 'https://i.imgur.com/abc123.png', provider: 'imgur' } })
    expect(created).toEqual(['webview'])
    expect(view.attributes.get('src')).toBe('about:blank')
    expect(view.loaded).toEqual(['https://imgur.com/upload'])
    expect(view.attributes.get('style')).toMatch(/opacity:0;pointer-events:none/)
    expect(view.attributes.get('aria-hidden')).toBe('true')
    expect(view.muted).toBe(true)
    expect(view.removed).toBe(true)
  })

  it('sets the file on the input as a File with the name, type and bytes it had, and fires input and change', async () => {
    const guest = imgurPage()
    const { uploader } = load(guest)
    await settled(uploader.upload('imgur', PNG))
    const input = guest.elements.get('input[type="file"]')
    expect(input?.events).toEqual(['input', 'change'])
    const sent = input?.files?.[0]
    expect([sent?.name, sent?.type]).toEqual(['pic.png', 'image/png'])
    expect([...new Uint8Array(await sent!.arrayBuffer())]).toEqual([137, 80, 78, 71, 1, 2, 3, 4])
    expect(guest.window).toEqual({})
  })

  it('sends a large file in pieces of a mebibyte, and the page puts them together in order', async () => {
    const bytes = Uint8Array.from({ length: 2.5 * 1024 * 1024 }, (_unused, index) => (index * 7) % 251)
    const guest = imgurPage()
    const { view, uploader } = load(guest)
    await settled(uploader.upload('imgur', new File([bytes], 'big.png', { type: 'image/png' })))
    expect(view.runs.filter((run) => run.code.includes('window[key].push')).length).toBe(3)
    const sent = guest.elements.get('input[type="file"]')?.files?.[0]
    expect(sent?.size).toBe(bytes.length)
    expect(Buffer.from(await sent!.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true)
  })

  it('clicks with a user gesture, and only the click has one', async () => {
    const guest = imgurPage()
    const { view, uploader } = load(guest)
    await settled(uploader.upload('imgur', PNG))
    const gestures = view.runs.filter((run) => run.gesture === true)
    expect(gestures).toHaveLength(1)
    expect(gestures[0]?.code).toContain('element.click()')
  })

  it('waits for the result, and takes a link only when it is a direct media link', async () => {
    const guest = imgurPage(new FakeGuest(), MEDIA_LINK('https://imgur.com/gallery/abc'))
    const { uploader } = load(guest)
    let answer: { url: string } | undefined
    const done = uploader.upload('imgur', PNG).then((result) => { answer = result })
    await vi.advanceTimersByTimeAsync(5000)
    expect(answer).toBeUndefined()
    guest.elements.set('a[href*="i.imgur.com"]', MEDIA_LINK('//i.imgur.com/final.jpg?size=1'))
    await vi.advanceTimersByTimeAsync(1000)
    await done
    expect(answer).toEqual({ url: 'https://i.imgur.com/final.jpg?size=1', provider: 'imgur' })
  })

  it('reads the picture the page shows when none of the desktop\'s candidates answers, once the page has moved to the post', async () => {
    const guest = new FakeGuest()
    guest.elements.set('input[type="file"]', {})
    guest.elements.set('button[type="submit"]', { click: () => { guest.elements.set('img[src*="i.imgur.com"]', { attributes: { src: 'https://i.imgur.com/shown.png' } }) } })
    const { uploader } = load(guest)
    let answer: { url: string } | undefined
    const done = uploader.upload('imgur', PNG).then((result) => { answer = result })
    await vi.advanceTimersByTimeAsync(5000)
    expect(answer).toBeUndefined()
    guest.location.pathname = '/a/qffAzbp'
    await vi.advanceTimersByTimeAsync(1000)
    await done
    expect(answer).toEqual({ url: 'https://i.imgur.com/shown.png', provider: 'imgur' })
  })

  it('waits for the result of a page that uploads as soon as the file is chosen and has no submit button', async () => {
    const guest = new FakeGuest()
    guest.elements.set('input[type="file"]', { onChange: () => { guest.location.pathname = '/a/qffAzbp'; guest.elements.set('img[src*="i.imgur.com"]', { attributes: { src: 'https://i.imgur.com/auto.png' } }) } })
    const { uploader } = load(guest)
    expect(await settled(uploader.upload('imgur', PNG))).toEqual({ ok: { url: 'https://i.imgur.com/auto.png', provider: 'imgur' } })
  })

  it('prefers the desktop\'s candidates to the picture when both are on the page', async () => {
    const guest = imgurPage()
    guest.location.pathname = '/a/qffAzbp'
    guest.elements.set('img[src*="i.imgur.com"]', { attributes: { src: 'https://i.imgur.com/other.png' } })
    const { uploader } = load(guest)
    expect(await settled(uploader.upload('imgur', PNG))).toEqual({ ok: { url: 'https://i.imgur.com/abc123.png', provider: 'imgur' } })
  })

  it('goes on polling when a script in the shown page fails once', async () => {
    const guest = imgurPage()
    let polls = 0
    const { uploader } = load(guest, { failRuns: () => guest.elements.has('a[href*="i.imgur.com"]') && polls++ < 3 })
    expect(await settled(uploader.upload('imgur', PNG))).toMatchObject({ ok: { provider: 'imgur' } })
  })
})

describe('imgbb', () => {
  const EMBED_CODE = '<a href="https://ibb.co/x"><img src="https://i.ibb.co/Xyz1/pic.png" alt="pic" border="0"></a>'

  function imgbbPage () {
    const guest = new FakeGuest()
    guest.elements.set('input[type="file"]', {})
    guest.elements.set('button[data-action="upload"]', { click: () => { guest.elements.set('input[name="html-embed-medium"]', { value: EMBED_CODE }) } })
    return guest
  }

  it('runs its prepare script before the click and takes the media link out of the embed code it shows', async () => {
    const { view, uploader } = load(imgbbPage())
    expect(await settled(uploader.upload('imgbb', PNG))).toEqual({ ok: { url: 'https://i.ibb.co/Xyz1/pic.png', provider: 'imgbb' } })
    expect(view.loaded).toEqual(['https://imgbb.com/'])
    const prepare = view.runs.findIndex((run) => run.code.includes('upload-expiration'))
    const click = view.runs.findIndex((run) => run.gesture === true)
    expect(prepare).toBeGreaterThan(-1)
    expect(prepare).toBeLessThan(click)
  })

  it('gives up after 60 seconds, imgur after 45', async () => {
    const stuck = new FakeGuest()
    stuck.elements.set('input[type="file"]', {})
    stuck.elements.set('button[data-action="upload"]', {})
    const first = await settled(load(stuck).uploader.upload('imgbb', PNG))
    expect(first).toEqual({ error: expect.objectContaining({ message: expect.stringMatching(/^Upload timeout or no direct URL extracted for imgbb \(elapsed: \d+ms, timeout: 60000ms\)$/) }) })
    const second = await settled(load(imgurPageWithoutResult()).uploader.upload('imgur', PNG))
    expect(second).toEqual({ error: expect.objectContaining({ message: expect.stringMatching(/^Upload timeout or no direct URL extracted for imgur \(elapsed: \d+ms, timeout: 45000ms\)$/) }) })
  })
})

function imgurPageWithoutResult () {
  const guest = new FakeGuest()
  guest.elements.set('input[type="file"]', {})
  guest.elements.set('button[type="submit"]', {})
  return guest
}

describe('an upload that fails', () => {
  const message = async (guest: FakeGuest, options?: ViewOptions, provider = 'imgur') => {
    const { view, uploader } = load(guest, options)
    const outcome = await settled(uploader.upload(provider, PNG))
    expect(view.removed, 'the element is removed whatever happened').toBe(true)
    return 'error' in outcome ? outcome.error.message : 'resolved'
  }

  it('fails at once on a captcha or a login before it sends anything, with the selector it saw', async () => {
    const guest = imgurPage()
    guest.elements.set('.g-recaptcha', {})
    expect(await message(guest)).toBe('Provider blocked: captcha, login, or challenge detected (imgur), selector: .g-recaptcha')
    expect(guest.elements.get('input[type="file"]')?.files).toBeUndefined()
  })

  it('fails the moment one appears during the upload', async () => {
    const guest = imgurPage()
    guest.elements.get('button[type="submit"]')!.click = () => { guest.elements.set('.captcha', {}) }
    expect(await message(guest)).toBe('Provider blocked during upload: captcha or challenge (imgur), selector: .captcha')
  })

  it('names the selectors it tried when the page has no file input or no submit button', async () => {
    const noInput = new FakeGuest()
    expect(await message(noInput)).toBe('No file input found for imgur. Tried: input[type="file"], input[type=file], [data-file-input]')
    const noSubmit = new FakeGuest()
    noSubmit.elements.set('input[type="file"]', {})
    expect(await message(noSubmit, undefined, 'imgbb')).toBe('No submit button found for imgbb. Tried: button[data-action="upload"], button.btn.green, button[type="submit"], [data-action="upload"]')
  })

  it('says a submit button the page does not lay out cannot be clicked', async () => {
    const guest = imgurPage()
    guest.elements.get('button[type="submit"]')!.rects = 0
    expect(await message(guest)).toBe('Cannot click node: box model unavailable (element may be hidden or zero-size)')
  })

  it('says the page did not load, with what the element said, and gives up on a page that never finishes after 30 seconds', async () => {
    expect(await message(imgurPage(), { loadError: 'ERR_BLOCKED_BY_CLIENT (-20) loading \'https://imgur.com/upload\'' })).toBe('Page load failed: ERR_BLOCKED_BY_CLIENT (-20) loading \'https://imgur.com/upload\'')
    expect(await message(imgurPage(), { neverLoads: true })).toBe('Page load timed out after 30000ms for https://imgur.com/upload')
  })

  it('gives up the same way on an element the shell never attached, which fires nothing', async () => {
    expect(await message(imgurPage(), { neverAttaches: true })).toBe('Page load timed out after 30000ms for https://imgur.com/upload')
  })

  it('rejects a provider it has no recipe for, without opening anything', async () => {
    const { created, uploader } = load(new FakeGuest())
    expect(await settled(uploader.upload('catbox', PNG))).toEqual({ error: expect.objectContaining({ message: 'No automation recipe for provider: catbox' }) })
    expect(await settled(uploader.upload('constructor', PNG))).toEqual({ error: expect.objectContaining({ message: 'No automation recipe for provider: constructor' }) })
    expect(created).toEqual([])
  })

  it('writes why to the console, for a report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await message(new FakeGuest())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[orivon] upload to imgur failed: No file input found'))
    warn.mockRestore()
  })
})

describe('what it offers', () => {
  it('names the two providers it uploads to, and nothing it holds can be changed from the page', () => {
    const { uploader } = load(new FakeGuest())
    expect(uploader.providers).toEqual(['imgur', 'imgbb'])
    expect(Object.isFrozen(uploader)).toBe(true)
  })
})
