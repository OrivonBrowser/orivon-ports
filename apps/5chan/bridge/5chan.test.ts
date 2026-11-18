// What is 5chan's own about this bridge: the roster of window.electronApi, the four window values
// the preload sets, the answers it gives while no node is behind it, and the three document-level
// edits that are not members. The composed script runs below byte for byte as the browser is served.
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import type { LoadOptions } from '../../../src/testing/bridge-harness.ts'

const source = await bridgeSourceFor('5chan')

// Every key of the object electron/preload.mjs hands to contextBridge.exposeInMainWorld('electronApi', ...).
const MEMBERS = [
  'automateUploadGeneratedMedia', 'automateUploadMedia', 'copyToClipboard', 'downloadAndInstallUpdate', 'getForgeTurnstileToken',
  'getNodeReachability', 'getPathForFile', 'getPlatform', 'isElectron'
] as const

function memoryStorage (initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) }
  }
}

// What Orivon puts on every tab's window, whatever the page was granted: the bridge installs on it and on nothing else.
const IN_ORIVON = { version: 0 }

interface FreshOptions extends LoadOptions {
  readonly storage?: ReturnType<typeof memoryStorage> | 'throws'
}

function freshBridge (options: FreshOptions = {}) {
  const storage = options.storage ?? memoryStorage()
  const unavailable = () => { throw new Error('storage is blocked') }
  return runBridge(source, {
    ...options,
    orivon: options.orivon ?? IN_ORIVON,
    globals: {
      crypto: globalThis.crypto,
      File,
      FormData,
      AbortSignal,
      localStorage: storage === 'throws' ? { getItem: unavailable, setItem: unavailable } : storage,
      ...options.globals
    }
  })
}

type Refusal = Error & { reason: string, member: string, owner: string }

async function rejection (call: () => unknown): Promise<Refusal | undefined> {
  try { await call() } catch (error) { return error as Refusal }
  return undefined
}

describe('in a browser without Orivon', () => {
  /** The bytes the browser is served, run on a page whose window has no `orivon` (or the given one), with every global the bridge could touch watched. */
  function plainBrowser (orivon?: unknown) {
    const storage = memoryStorage()
    const reads = vi.fn(storage.getItem)
    const writes = vi.fn(storage.setItem)
    const getRegistrations = vi.fn(async () => [])
    const listeners: string[] = []
    const window: Record<string, unknown> = orivon === undefined ? {} : { orivon }
    const navigator = { language: 'en-US', serviceWorker: { getRegistrations } }
    const sandbox: Record<string, unknown> = {
      window,
      navigator,
      document: { baseURI: 'http://127.0.0.1/', readyState: 'complete', addEventListener: (type: string) => { listeners.push(type) } },
      localStorage: { getItem: reads, setItem: writes },
      crypto: globalThis.crypto,
      Uint8Array,
      URL,
      fetch: async () => { throw new Error('a plain page must not fetch from the bridge') }
    }
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox, { filename: 'orivon-bridge.js' })
    return { sandbox, window, navigator, reads, writes, getRegistrations, listeners }
  }

  const DESKTOP_VALUES = ['isElectron', 'electronApi', 'electron', 'defaultPkcOptions', 'defaultMediaIpfsGatewayUrl', 'pkcRpcAuthKey']

  it.each([
    ['no window.orivon', undefined],
    ['a null window.orivon', null],
    ['an orivon that is not an object', 'orivon'],
    ['an orivon with no numeric version', {}],
    ['an orivon whose version is text', { version: '0' }]
  ])('installs nothing on a page with %s: no desktop value, no electronApi, no key', (_name, orivon) => {
    const { sandbox, window } = plainBrowser(orivon)
    for (const name of DESKTOP_VALUES) {
      expect(name in window, `window.${name}`).toBe(false)
      expect(name in sandbox, `global ${name}`).toBe(false)
    }
    expect(sandbox['__orivonBridgeInternals']).toBeUndefined()
    expect(Object.keys(window).sort()).toEqual(orivon === undefined ? [] : ['orivon'])
  })

  it('leaves the page\'s service worker, its storage and its listeners alone', () => {
    const { navigator, reads, writes, getRegistrations, listeners } = plainBrowser()
    expect(getRegistrations).not.toHaveBeenCalled()
    expect('serviceWorker' in navigator).toBe(true)
    expect(reads).not.toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
    expect(listeners).toEqual([])
  })

  it('installs on a page that has the object Orivon puts on every tab, whatever else it was granted', () => {
    const { sandbox } = freshBridge({ orivon: { version: 0 } })
    expect(sandbox.window['isElectron']).toBe(true)
    expect(sandbox.window['electronApi']).toBeDefined()
  })
})

describe('the roster', () => {
  it('installs exactly the nine members the preload exposes, on window.electronApi', () => {
    const { bridge, sandbox } = freshBridge()
    expect(Object.keys(bridge).sort()).toEqual([...MEMBERS].sort())
    expect(sandbox.window['electronApi']).toBe(bridge)
    expect(bridge['isElectron']).toBe(true)
  })
})

describe('the window values the preload sets', () => {
  it('sets isElectron, the media gateway and the four HTTP routers the preload carries', () => {
    const { sandbox } = freshBridge()
    expect(sandbox.window['isElectron']).toBe(true)
    expect(sandbox.window['defaultMediaIpfsGatewayUrl']).toBe('http://localhost:6473')
    expect((sandbox.window['defaultPkcOptions'] as { httpRoutersOptions: string[] }).httpRoutersOptions).toEqual([
      'https://peers.pleb.bot', 'https://routing.lol', 'https://peers.forumindex.com', 'https://peers.plebpubsub.xyz'
    ])
  })

  it('points the RPC client at the node with a 40-character key in the path, and offers the same key as pkcRpcAuthKey', () => {
    const { sandbox } = freshBridge()
    const key = sandbox.window['pkcRpcAuthKey'] as string
    expect(key).toMatch(/^[0-9A-Za-z]{40}$/)
    expect((sandbox.window['defaultPkcOptions'] as { pkcRpcClientsOptions: string[] }).pkcRpcClientsOptions).toEqual([`ws://localhost:9138/${key}`])
  })

  it('keeps the key in localStorage, and a second load of the page reads it back', () => {
    const storage = memoryStorage()
    const first = freshBridge({ storage }).sandbox.window['pkcRpcAuthKey']
    expect(storage.items.get('orivon.pkcRpcAuthKey')).toBe(first)
    expect(freshBridge({ storage }).sandbox.window['pkcRpcAuthKey']).toBe(first)
  })

  it('replaces a stored value that is not a 40-character key', () => {
    const storage = memoryStorage({ 'orivon.pkcRpcAuthKey': 'short' })
    const key = freshBridge({ storage }).sandbox.window['pkcRpcAuthKey']
    expect(key).toMatch(/^[0-9A-Za-z]{40}$/)
    expect(storage.items.get('orivon.pkcRpcAuthKey')).toBe(key)
  })

  it('still gets a key when storage is blocked, and loads', () => {
    expect(freshBridge({ storage: 'throws' }).sandbox.window['pkcRpcAuthKey']).toMatch(/^[0-9A-Za-z]{40}$/)
  })

  it('draws a different key for every page that has none', () => {
    const keys = new Set(Array.from({ length: 20 }, () => freshBridge().sandbox.window['pkcRpcAuthKey']))
    expect(keys.size).toBe(20)
  })
})

describe('members answered from the page', () => {
  it('copies through the async clipboard and answers the shape the preload does', async () => {
    const writeText = vi.fn(async () => {})
    const { bridge } = freshBridge({ navigator: { clipboard: { writeText } } as never })
    expect(await bridge.copyToClipboard('hello')).toEqual({ success: true })
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('reports a failed copy as { success: false, error } instead of rejecting', async () => {
    const writeText = vi.fn(async () => { throw new Error('document is not focused') })
    const { bridge } = freshBridge({ navigator: { clipboard: { writeText } } as never })
    expect(await bridge.copyToClipboard('hello')).toEqual({ success: false, error: 'document is not focused' })
    expect(await freshBridge().bridge.copyToClipboard('hello')).toMatchObject({ success: false })
  })

  it('answers a platform no desktop installer matches, so the updater finds nothing newer', async () => {
    const { bridge } = freshBridge()
    expect(await bridge.getPlatform()).toEqual({ platform: 'orivon', arch: 'orivon', version: '' })
  })
})

describe('getNodeReachability', () => {
  const answer = (body: unknown, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body, text: async () => '' }))

  it.each([['public', 'public'], ['Private', 'private'], ['unknown', 'unknown'], ['something else', 'unknown']])('reads %s as %s', async (reported, expected) => {
    const fetch = answer({ reachability: reported })
    const { bridge } = freshBridge({ fetch: fetch as never })
    expect(await bridge.getNodeReachability()).toBe(expected)
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:50019/api/v0/swarm/addrs/autonat', expect.objectContaining({ method: 'POST' }))
  })

  it('is unknown when the node answers an error, answers no object, or is not there', async () => {
    expect(await freshBridge({ fetch: answer({}, false) as never }).bridge.getNodeReachability()).toBe('unknown')
    expect(await freshBridge({ fetch: answer(null) as never }).bridge.getNodeReachability()).toBe('unknown')
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    expect(await freshBridge({ fetch: offline as never }).bridge.getNodeReachability()).toBe('unknown')
  })
})

describe('uploads', () => {
  const catbox = (text = 'https://files.catbox.moe/abc.png') => vi.fn(async (_url: string, _init: { body: FormData }) => ({ ok: true, status: 200, statusText: 'OK', text: async () => `${text}\n` }))

  it('hands a File out as a token, and nothing else', () => {
    const { bridge } = freshBridge()
    const token = bridge.getPathForFile(new File(['x'], 'a.png'))
    expect(token).toMatch(/^orivon-file:\d+$/)
    expect(bridge.getPathForFile(new File(['x'], 'a.png'))).not.toBe(token)
    expect(bridge.getPathForFile({ name: 'a.png' })).toBeNull()
    expect(bridge.getPathForFile(null)).toBeNull()
  })

  it('uploads a File to catbox as the renderer does, with the form catbox takes, and answers { url, provider }', async () => {
    const fetch = catbox()
    const { bridge } = freshBridge({ fetch: fetch as never })
    const token = bridge.getPathForFile(new File(['pixels'], 'a.png'))
    expect(await bridge.automateUploadMedia({ provider: 'catbox', filePath: token })).toEqual({ url: 'https://files.catbox.moe/abc.png', provider: 'catbox' })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string, body: FormData }]
    expect(url).toBe('https://catbox.moe/user/api.php')
    expect(init.method).toBe('POST')
    expect(init.body.get('reqtype')).toBe('fileupload')
    expect((init.body.get('fileToUpload') as File).name).toBe('a.png')
  })

  it('rejects a catbox answer that is not ok with the renderer\'s own words', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' }))
    const { bridge } = freshBridge({ fetch: fetch as never })
    const token = bridge.getPathForFile(new File(['x'], 'a.png'))
    await expect(bridge.automateUploadMedia({ provider: 'catbox', filePath: token })).rejects.toThrow('Upload failed: 503 Service Unavailable')
  })

  /** The script webview-upload.js sets on the page, as a double: what the bridge asks of it is all these tests read. */
  function withUploader (fetch = catbox()) {
    const loaded = freshBridge({ fetch: fetch as never })
    const stripped = new File(['stripped'], 'a.png', { type: 'image/png' })
    const uploader = {
      upload: vi.fn(async (provider: string, _file?: File) => ({ url: `https://i.example/${provider}.png`, provider })),
      stripMetadata: vi.fn(async () => stripped)
    }
    loaded.sandbox.window['orivonWebviewUpload'] = uploader
    return { ...loaded, uploader, stripped, fetch }
  }

  it.each(['imgur', 'imgbb'])('uploads to %s through the upload page, with the file the page named by token and its metadata stripped first, and answers what that page answers', async (provider) => {
    const { bridge, uploader, stripped, fetch } = withUploader()
    const file = new File(['pixels'], 'a.png', { type: 'image/png' })
    const token = bridge.getPathForFile(file)
    expect(await bridge.automateUploadMedia({ provider, filePath: token })).toEqual({ url: `https://i.example/${provider}.png`, provider })
    expect(uploader.stripMetadata).toHaveBeenCalledWith(file)
    expect(uploader.upload).toHaveBeenCalledWith(provider, stripped)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uploads bytes the page made to imgur as they are: the page strips what it makes, as the desktop\'s main process does not for them', async () => {
    const { bridge, uploader } = withUploader()
    await bridge.automateUploadGeneratedMedia({ provider: 'imgur', fileName: 'drawing.png', mimeType: 'image/png', bytes: [137, 80, 78, 71] })
    expect(uploader.stripMetadata).not.toHaveBeenCalled()
    const sent = uploader.upload.mock.calls[0]?.[1] as unknown as File
    expect([uploader.upload.mock.calls[0]?.[0], sent.name, sent.type, sent.size]).toEqual(['imgur', 'drawing.png', 'image/png', 4])
  })

  it('rejects with what the upload page said when it fails, so the app moves on to its next provider', async () => {
    const { bridge, uploader } = withUploader()
    uploader.upload.mockRejectedValueOnce(new Error('Provider blocked: captcha, login, or challenge detected (imgur), selector: .captcha'))
    const token = bridge.getPathForFile(new File(['x'], 'a.png'))
    await expect(bridge.automateUploadMedia({ provider: 'imgur', filePath: token })).rejects.toThrow('Provider blocked: captcha')
  })

  it('says so, and sends nothing, when the page that uploads did not load', async () => {
    const fetch = catbox()
    const { bridge } = freshBridge({ fetch: fetch as never })
    const token = bridge.getPathForFile(new File(['x'], 'a.png'))
    await expect(bridge.automateUploadMedia({ provider: 'imgbb', filePath: token })).rejects.toThrow('The page that uploads to imgur and imgbb did not load')
    await expect(bridge.automateUploadGeneratedMedia({ provider: 'imgur', fileName: 'x.png', bytes: [1] })).rejects.toThrow('did not load')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('leaves catbox to its own request, whatever the upload page is', async () => {
    const { bridge, uploader } = withUploader()
    const token = bridge.getPathForFile(new File(['x'], 'a.png'))
    expect(await bridge.automateUploadMedia({ provider: 'catbox', filePath: token })).toMatchObject({ provider: 'catbox' })
    expect(uploader.upload).not.toHaveBeenCalled()
  })

  it('rejects, as the desktop handler throws, a call without a provider or a path, an unknown provider, and a token it never gave', async () => {
    const { bridge } = freshBridge({ fetch: catbox() as never })
    const token = bridge.getPathForFile(new File(['x'], 'a.png'))
    await expect(bridge.automateUploadMedia()).rejects.toThrow('automate-upload-media requires { provider, filePath }')
    await expect(bridge.automateUploadMedia({ provider: 'catbox' })).rejects.toThrow('automate-upload-media requires { provider, filePath }')
    await expect(bridge.automateUploadMedia({ provider: 'flickr', filePath: token })).rejects.toThrow('No automation recipe for provider: flickr')
    await expect(bridge.automateUploadMedia({ provider: 'catbox', filePath: '/etc/passwd' })).rejects.toThrow('File path unavailable')
  })

  it('uploads bytes the page made, under the same limits as the desktop handler', async () => {
    const fetch = catbox()
    const { bridge } = freshBridge({ fetch: fetch as never })
    expect(await bridge.automateUploadGeneratedMedia({ provider: 'catbox', fileName: 'drawing.png', mimeType: 'image/png', bytes: [137, 80, 78, 71] }))
      .toEqual({ url: 'https://files.catbox.moe/abc.png', provider: 'catbox' })
    const sent = (fetch.mock.calls[0] as unknown as [string, { body: FormData }])[1].body.get('fileToUpload') as File
    expect([sent.name, sent.type, sent.size]).toEqual(['drawing.png', 'image/png', 4])
    await expect(bridge.automateUploadGeneratedMedia({ fileName: 'x.png', bytes: [1] })).rejects.toThrow('automate-upload-generated-media requires a provider')
    await expect(bridge.automateUploadGeneratedMedia({ provider: 'catbox', bytes: [] })).rejects.toThrow('Generated upload bytes are required')
    await expect(bridge.automateUploadGeneratedMedia({ provider: 'catbox', bytes: [1, 256] })).rejects.toThrow('Generated upload bytes are invalid')
    await expect(bridge.automateUploadGeneratedMedia({ provider: 'catbox', bytes: new Array(20 * 1024 * 1024 + 1).fill(0) })).rejects.toThrow('Generated upload is too large')
  })
})

describe('refused by name', () => {
  // The preload's versions return promises, so a refusal rejects: a call site outside an async function has no try to catch a throw.
  it('downloadAndInstallUpdate rejects with OrivonBridgeError, reason shell-owned, and names the global', async () => {
    const { bridge } = freshBridge()
    let returned: unknown
    expect(() => { returned = bridge['downloadAndInstallUpdate']() }).not.toThrow()
    const error = await rejection(() => returned)
    expect(error).toMatchObject({ name: 'OrivonBridgeError', reason: 'shell-owned', member: 'downloadAndInstallUpdate', owner: 'electronApi' })
    expect(error?.message).toContain('electronApi.downloadAndInstallUpdate is unavailable')
  })
})

describe('the Forge Turnstile token', () => {
  const SITEKEY = '0x4AAAAAAFScwbbNFZtx0XVP'

  /** The script webview-turnstile.js sets on the page, as a double: what the bridge asks of it is all these tests read. */
  function withTurnstile (getToken = vi.fn(async (_sitekey: string, _options: { port: number }) => 'token-1')) {
    const loaded = freshBridge()
    loaded.sandbox.window['orivonForgeTurnstile'] = { getToken }
    return { ...loaded, getToken }
  }

  it('asks the Turnstile script for the sitekey, with the port the manifest names for the page it serves, and answers the token', async () => {
    const { bridge, getToken } = withTurnstile()
    expect(await bridge.getForgeTurnstileToken(SITEKEY)).toBe('token-1')
    expect(getToken).toHaveBeenCalledWith(SITEKEY, { port: 50219 })
  })

  it('rejects with the text the script gives, as the preload throws the error main sends, and returns a promise either way', async () => {
    const { bridge } = withTurnstile(vi.fn(async () => { throw new Error('Turnstile error 600010') }))
    let returned: unknown
    expect(() => { returned = bridge.getForgeTurnstileToken(SITEKEY) }).not.toThrow()
    await expect(returned).rejects.toThrow('Turnstile error 600010')
  })

  it('rejects, and does not throw, when the page that gets the token did not load', async () => {
    const { bridge } = freshBridge()
    let returned: unknown
    expect(() => { returned = bridge.getForgeTurnstileToken(SITEKEY) }).not.toThrow()
    await expect(returned).rejects.toThrow('The page that gets a Turnstile token did not load')
  })
})

describe('the page without a service worker', () => {
  it('hides the API from the page and unregisters the workers an earlier load registered', async () => {
    const unregister = vi.fn()
    const navigator = { language: 'en-US', serviceWorker: { getRegistrations: async () => [{ unregister }, { unregister }] } }
    const { sandbox } = freshBridge({ navigator: navigator as never })
    await Promise.resolve()
    expect('serviceWorker' in sandbox.navigator).toBe(false)
    expect(unregister).toHaveBeenCalledTimes(2)
  })

  it('loads on a page that never had one', () => {
    expect(() => freshBridge()).not.toThrow()
  })
})

describe('the link to the node\'s web UI', () => {
  const NODE_LINK = 'http://localhost:50019/webui/'

  function pageWithLink (href: string, button = 0) {
    const listeners: Array<{ type: string, listener: (event: unknown) => void, capture: unknown }> = []
    const open = vi.fn()
    const link = { getAttribute: () => href }
    const event = { button, target: { closest: (selector: string) => (selector === 'a[href]' ? link : null) }, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }
    const { sandbox } = freshBridge({ document: { addEventListener: (type: string, listener: (event: unknown) => void, capture?: unknown) => { listeners.push({ type, listener, capture }) } } })
    sandbox.window['open'] = open
    return { listeners, open, event }
  }

  it('listens in the capture phase for clicks and middle clicks', () => {
    const { listeners } = pageWithLink(NODE_LINK)
    expect(listeners.map(({ type, capture }) => [type, capture])).toEqual([['click', true], ['auxclick', true]])
  })

  it('opens the dashboard served with the app in a new tab, and stops the navigation to the loopback address', () => {
    const { listeners, open, event } = pageWithLink(NODE_LINK)
    listeners[0]?.listener(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopImmediatePropagation).toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('http://127.0.0.1/orivon/node/index.html', '_blank')
  })

  it('does the same for a middle click, and leaves a right click and every other link alone', () => {
    const middle = pageWithLink(NODE_LINK, 1)
    middle.listeners[1]?.listener(middle.event)
    expect(middle.open).toHaveBeenCalledTimes(1)
    const right = pageWithLink(NODE_LINK, 2)
    right.listeners[0]?.listener(right.event)
    const other = pageWithLink('https://example.com/')
    other.listeners[0]?.listener(other.event)
    expect(right.open).not.toHaveBeenCalled()
    expect(other.open).not.toHaveBeenCalled()
    expect(other.event.preventDefault).not.toHaveBeenCalled()
  })
})
