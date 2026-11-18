// What is seedit's own about this bridge: the roster of window.electron and window.electronApi, the
// four window values the preload sets, the notification members over the page's Notification API, and
// the answers it gives while no node is behind it. The composed script runs below byte for byte as the
// browser is served it.
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import type { LoadOptions } from '../../../src/testing/bridge-harness.ts'

const source = await bridgeSourceFor('seedit')

// Every key of the two objects electron/preload.mjs hands to contextBridge.exposeInMainWorld.
const ELECTRON = ['invoke', 'sendNotification']
const ELECTRON_API = [
  'automateUploadGeneratedMedia', 'automateUploadMedia', 'copyToClipboard', 'getForgeTurnstileToken', 'getNodeReachability',
  'getNotificationStatus', 'getPlatform', 'isElectron', 'isFileOnDisk', 'showNotification', 'testNotification'
]

function memoryStorage (initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) } }
}

class FakeNotification {
  static permission = 'granted'
  static requested = 0
  static grantOnRequest = true
  static grantWhenDenied = false
  static made: FakeNotification[] = []
  static failToConstruct = false
  onclick: (() => void) | null = null
  constructor (readonly title: string, readonly options: { body?: string }) {
    if (FakeNotification.failToConstruct) throw new Error('blocked')
    FakeNotification.made.push(this)
  }

  static async requestPermission () {
    FakeNotification.requested += 1
    if (FakeNotification.permission === 'default' || (FakeNotification.permission === 'denied' && FakeNotification.grantWhenDenied)) FakeNotification.permission = FakeNotification.grantOnRequest ? 'granted' : 'denied'
    return FakeNotification.permission
  }

  static reset (permission = 'granted') {
    Object.assign(FakeNotification, { permission, requested: 0, grantOnRequest: true, grantWhenDenied: false, made: [], failToConstruct: false })
  }
}

// What Orivon puts on every tab's window, whatever the page was granted: the bridge installs on it and on nothing else.
const IN_ORIVON = { version: 0 }

interface FreshOptions extends LoadOptions {
  readonly storage?: ReturnType<typeof memoryStorage> | 'throws'
  readonly notifications?: boolean
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
      console: { warn: () => {} },
      localStorage: storage === 'throws' ? { getItem: unavailable, setItem: unavailable } : storage,
      ...(options.notifications === false ? {} : { Notification: FakeNotification }),
      ...options.globals
    }
  })
}

const electronApi = (options?: FreshOptions) => freshBridge(options).globals['electronApi']?.bridge as Record<string, any>
const electron = (options?: FreshOptions) => freshBridge(options).globals['electron']?.bridge as Record<string, any>

const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

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
      Notification: FakeNotification,
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
  ])('installs nothing on a page with %s: no desktop value, no electron, no electronApi, no key', (_name, orivon) => {
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
    expect(sandbox.window['electron']).toBeDefined()
    expect(sandbox.window['electronApi']).toBeDefined()
  })
})

describe('the roster', () => {
  it('installs exactly the two members and the eleven the preload exposes, on window.electron and window.electronApi', () => {
    const { globals, sandbox } = freshBridge()
    expect(Object.keys(globals['electron']?.bridge ?? {}).sort()).toEqual(ELECTRON)
    expect(Object.keys(globals['electronApi']?.bridge ?? {}).sort()).toEqual(ELECTRON_API)
    expect(sandbox.window['electron']).toBe(globals['electron']?.bridge)
    expect(sandbox.window['electronApi']).toBe(globals['electronApi']?.bridge)
    expect(electronApi().isElectron).toBe(true)
  })
})

describe('the window values the preload sets', () => {
  it('sets isElectron, the media gateway and the four HTTP routers the preload carries', () => {
    const { sandbox } = freshBridge()
    expect(sandbox.window['isElectron']).toBe(true)
    expect(sandbox.window['defaultMediaIpfsGatewayUrl']).toBe('http://localhost:6483')
    expect((sandbox.window['defaultPkcOptions'] as { httpRoutersOptions: string[] }).httpRoutersOptions).toEqual([
      'https://peers.pleb.bot', 'https://routing.lol', 'https://peers.forumindex.com', 'https://peers.plebpubsub.xyz'
    ])
  })

  it('points the RPC client at the node with a 40-character key in the path, and offers the same key as pkcRpcAuthKey', () => {
    const { sandbox } = freshBridge()
    const key = sandbox.window['pkcRpcAuthKey'] as string
    expect(key).toMatch(/^[0-9A-Za-z]{40}$/)
    expect((sandbox.window['defaultPkcOptions'] as { pkcRpcClientsOptions: string[] }).pkcRpcClientsOptions).toEqual([`ws://localhost:9148/${key}`])
  })

  it('keeps the key in localStorage, reads it back on the next load, and replaces a stored value that is not a key', () => {
    const storage = memoryStorage()
    const first = freshBridge({ storage }).sandbox.window['pkcRpcAuthKey']
    expect(storage.items.get('orivon.pkcRpcAuthKey')).toBe(first)
    expect(freshBridge({ storage }).sandbox.window['pkcRpcAuthKey']).toBe(first)
    const broken = memoryStorage({ 'orivon.pkcRpcAuthKey': 'short' })
    const replaced = freshBridge({ storage: broken }).sandbox.window['pkcRpcAuthKey']
    expect(replaced).toMatch(/^[0-9A-Za-z]{40}$/)
    expect(broken.items.get('orivon.pkcRpcAuthKey')).toBe(replaced)
  })

  it('still gets a key when storage is blocked, and loads', () => {
    expect(freshBridge({ storage: 'throws' }).sandbox.window['pkcRpcAuthKey']).toMatch(/^[0-9A-Za-z]{40}$/)
  })
})

describe('window.electron.invoke', () => {
  it('answers the four channels the preload allows', async () => {
    FakeNotification.reset('denied')
    const writeText = vi.fn(async () => {})
    const { invoke } = electron({ navigator: { platform: 'MacIntel', clipboard: { writeText } } as never })
    expect(await invoke('get-notification-permission-status')).toBe('denied')
    expect(await invoke('get-platform')).toMatchObject({ platform: 'darwin' })
    expect(await invoke('test-notification-permission')).toEqual({ success: false, reason: 'denied' })
    expect(await invoke('copy-to-clipboard', 'hello')).toEqual({ success: true })
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('throws, as the preload does and not as a rejection, for any other channel', () => {
    const { invoke } = electron()
    expect(() => invoke('open-external', 'https://example.com')).toThrow('Unauthorized IPC channel: open-external')
  })
})

describe('members answered from the page', () => {
  it('copies through the async clipboard, and reports a failure as { success: false, error } instead of rejecting', async () => {
    const writeText = vi.fn(async () => { throw new Error('document is not focused') })
    expect(await electronApi({ navigator: { clipboard: { writeText } } as never }).copyToClipboard('hello')).toEqual({ success: false, error: 'document is not focused' })
    expect(await electronApi({ navigator: { clipboard: { writeText: async () => {} } } as never }).copyToClipboard('hello')).toEqual({ success: true })
    expect(await electronApi().copyToClipboard('hello')).toMatchObject({ success: false })
  })

  it.each([
    [{ platform: 'Win32' }, 'win32'],
    [{ platform: 'MacIntel' }, 'darwin'],
    [{ platform: 'Linux x86_64' }, 'linux'],
    [{ userAgentData: { platform: 'Windows' } }, 'win32'],
    [{}, 'linux']
  ])('names the platform of %j as %s, as process.platform does, the notification settings compare it with darwin', async (navigator, platform) => {
    expect(await electronApi({ navigator: navigator as never }).getPlatform()).toMatchObject({ platform, arch: 'x64', version: '' })
  })

  it.each([[{ platform: 'Win32' }, 'win32'], [{ platform: 'MacIntel' }, 'darwin'], [{}, 'linux']])('prints the platform of %j as its name where seedit puts it in a sentence, never as [object Object]', async (navigator, platform) => {
    const answer = await electronApi({ navigator: navigator as never }).getPlatform()
    expect(`Please check your system's (${String(answer)}) notification settings`).toBe(`Please check your system's (${platform}) notification settings`)
    expect(`${String(answer)}`).not.toContain('[object Object]')
    expect(Object.keys(answer as object)).toEqual(['platform', 'arch', 'version'])
    expect(JSON.stringify(answer)).toBe(JSON.stringify({ platform, arch: 'x64', version: '' }))
  })

  it('names an ARM machine arm64 when the browser says so', async () => {
    const userAgentData = { platform: 'macOS', getHighEntropyValues: async () => ({ architecture: 'arm' }) }
    expect(await electronApi({ navigator: { userAgentData } as never }).getPlatform()).toMatchObject({ platform: 'darwin', arch: 'arm64' })
  })
})

describe('getNodeReachability', () => {
  /** A bridge on a page whose node has answered: the handle node-start.js leaves in window.orivonBitsocialNode. */
  function withNode (ready: Promise<unknown>) {
    const { globals, sandbox } = freshBridge()
    sandbox.window['orivonBitsocialNode'] = { ready }
    return (globals['electronApi']?.bridge as Record<string, any>)['getNodeReachability'] as () => Promise<string>
  }

  it.each([['public', 'public'], ['Private', 'private'], ['unknown', 'unknown'], ['something else', 'unknown']])('reads %s as %s from the node\'s handle', async (reported, expected) => {
    const reachability = vi.fn(async () => reported)
    expect(await withNode(Promise.resolve({ reachability }))()).toBe(expected)
    expect(reachability).toHaveBeenCalledTimes(1)
  })

  it('is unknown when the node did not start, or the page has none, or the handle throws', async () => {
    expect(await withNode(Promise.resolve(null))()).toBe('unknown')
    expect(await electronApi().getNodeReachability()).toBe('unknown')
    expect(await withNode(Promise.resolve({ reachability: async () => { throw new Error('the Worker ended') } }))()).toBe('unknown')
    expect(await withNode(Promise.reject(new Error('no')))()).toBe('unknown')
  })

  it('does not ask the kubo API route, which the node can answer late', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ reachability: 'public' }), text: async () => '' }))
    expect(await electronApi({ fetch: fetch as never }).getNodeReachability()).toBe('unknown')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('gives up with unknown after the five seconds the desktop gives the node, when the handle has no last known value', async () => {
    vi.useFakeTimers()
    try {
      const answer = withNode(Promise.resolve({ reachability: () => new Promise(() => {}), snapshot: () => ({ reachability: 'unknown' }) }))()
      await vi.advanceTimersByTimeAsync(5000)
      expect(await answer).toBe('unknown')
    } finally { vi.useRealTimers() }
  })

  it('answers the last value the handle knows when the node is slower than five seconds, which the node\'s AutoNAT route can be', async () => {
    vi.useFakeTimers()
    try {
      const answer = withNode(Promise.resolve({ reachability: () => new Promise(() => {}), snapshot: () => ({ reachability: 'private' }) }))()
      await vi.advanceTimersByTimeAsync(5000)
      expect(await answer).toBe('private')
    } finally { vi.useRealTimers() }
  })

  it('answers the last known value when the handle throws', async () => {
    const answer = withNode(Promise.resolve({ reachability: async () => { throw new Error('the Worker ended') }, snapshot: () => ({ reachability: 'public' }) }))()
    expect(await answer).toBe('public')
  })
})

describe('notifications', () => {
  it('reports the page\'s own state, as main\'s answers map onto it: granted is granted, denied is denied, and default (nobody asked) is not-determined', async () => {
    for (const [permission, expected] of [['granted', 'granted'], ['default', 'not-determined'], ['denied', 'denied']] as const) {
      FakeNotification.reset(permission)
      expect(await electronApi().getNotificationStatus(), permission).toBe(expected)
      expect(await electron().invoke('get-notification-permission-status'), permission).toBe(expected)
    }
    expect(await electronApi({ notifications: false }).getNotificationStatus()).toBe('not-supported')
  })

  it('never reads a state nobody allowed as granted, and does not ask when it is only read', async () => {
    FakeNotification.reset('default')
    expect(await electronApi().getNotificationStatus()).toBe('not-determined')
    expect(FakeNotification.requested).toBe(0)
  })

  describe('the switch in the preferences', () => {
    /** The page with a trusted change of a checkbox at `at`, then the status asked for `later` ms after it. */
    async function statusAfterToggle (options: { permission: string, trusted?: boolean, target?: unknown, later?: number, grantOnRequest?: boolean, grantWhenDenied?: boolean }) {
      FakeNotification.reset(options.permission)
      FakeNotification.grantOnRequest = options.grantOnRequest ?? true
      FakeNotification.grantWhenDenied = options.grantWhenDenied ?? false
      const listeners: Array<{ type: string, listener: (event: unknown) => void, capture: unknown }> = []
      let clock = 1_000_000
      const loaded = freshBridge({ globals: { Date: { now: () => clock } }, document: { addEventListener: (type: string, listener: (event: unknown) => void, capture?: unknown) => { listeners.push({ type, listener, capture }) } } })
      listeners.find(({ type }) => type === 'change')?.listener({ isTrusted: options.trusted ?? true, target: options.target ?? { type: 'checkbox' } })
      clock += options.later ?? 5
      return { status: await (loaded.globals['electronApi']?.bridge as Record<string, any>).getNotificationStatus(), listeners }
    }

    it('listens in the capture phase for the change of a checkbox', async () => {
      expect((await statusAfterToggle({ permission: 'default' })).listeners.filter(({ type }) => type === 'change').map(({ capture }) => capture)).toEqual([true])
    })

    it('asks the person when the status is read straight after it, and answers the state they leave', async () => {
      expect((await statusAfterToggle({ permission: 'default' })).status).toBe('granted')
      expect(FakeNotification.requested).toBe(1)
      expect((await statusAfterToggle({ permission: 'default', grantOnRequest: false })).status).toBe('denied')
      expect((await statusAfterToggle({ permission: 'denied' })).status).toBe('denied')
      expect(FakeNotification.requested).toBe(1)
    })

    it('asks about a state Orivon reads as denied for a site nobody answered for, so the person can allow it, and leaves a refusal refused', async () => {
      expect((await statusAfterToggle({ permission: 'denied', grantWhenDenied: true })).status).toBe('granted')
      expect(FakeNotification.requested).toBe(1)
    })

    it.each([
      ['a change the page made itself', { permission: 'default', trusted: false }],
      ['the change of something that is not a checkbox', { permission: 'default', target: { type: 'text' } }],
      ['a change a second ago', { permission: 'default', later: 1500 }]
    ])('does not ask for %s', async (_name, options) => {
      expect((await statusAfterToggle(options)).status).toBe('not-determined')
      expect(FakeNotification.requested).toBe(0)
    })

    it('does not ask when the page already allows it', async () => {
      expect((await statusAfterToggle({ permission: 'granted' })).status).toBe('granted')
      expect(FakeNotification.requested).toBe(0)
    })

    it('shares one question between two reads while the person is answering', async () => {
      FakeNotification.reset('default')
      const listeners: Array<{ type: string, listener: (event: unknown) => void }> = []
      const loaded = freshBridge({ globals: { Date: { now: () => 1_000_000 } }, document: { addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.push({ type, listener }) } } })
      listeners.find(({ type }) => type === 'change')?.listener({ isTrusted: true, target: { type: 'checkbox' } })
      const api = loaded.globals['electronApi']?.bridge as Record<string, any>
      expect(await Promise.all([api.getNotificationStatus(), api.getNotificationStatus()])).toEqual(['granted', 'granted'])
      expect(FakeNotification.requested).toBe(1)
    })
  })

  it('tests the permission by showing one, and says why it could not', async () => {
    FakeNotification.reset('granted')
    expect(await electronApi().testNotification()).toEqual({ success: true })
    expect(FakeNotification.made[0]).toMatchObject({ title: 'Seedit Test', options: { body: 'Testing if notifications are allowed.' } })
    FakeNotification.reset('denied')
    expect(await electronApi().testNotification()).toEqual({ success: false, reason: 'denied' })
    FakeNotification.reset('granted')
    FakeNotification.failToConstruct = true
    expect(await electronApi().testNotification()).toEqual({ success: false, reason: 'error' })
    expect(await electronApi({ notifications: false }).testNotification()).toEqual({ success: false, reason: 'not-supported' })
  })

  it('asks first when the permission is not granted, and shows its notification only on a yes', async () => {
    FakeNotification.reset('default')
    expect(await electronApi().testNotification()).toEqual({ success: true })
    expect([FakeNotification.requested, FakeNotification.made.length]).toEqual([1, 1])
    FakeNotification.reset('default')
    FakeNotification.grantOnRequest = false
    expect(await electronApi().testNotification()).toEqual({ success: false, reason: 'denied' })
    expect([FakeNotification.requested, FakeNotification.made.length]).toEqual([1, 0])
    FakeNotification.reset('denied')
    FakeNotification.grantWhenDenied = true
    expect(await electronApi().testNotification()).toEqual({ success: true })
    FakeNotification.reset('denied')
    expect(await electronApi().testNotification()).toEqual({ success: false, reason: 'denied' })
    expect(FakeNotification.requested).toBe(1)
  })

  it('asks when nobody was asked, shows the notification on a yes and stays silent on a no', async () => {
    FakeNotification.reset('default')
    electronApi().showNotification({ title: 'New reply', body: 'hello' })
    await settle()
    expect(FakeNotification.requested).toBe(1)
    expect(FakeNotification.made.map(({ title }) => title)).toEqual(['New reply'])
    FakeNotification.reset('default')
    FakeNotification.grantOnRequest = false
    electronApi().showNotification({ title: 'New reply', body: 'hello' })
    await settle()
    expect(FakeNotification.made).toEqual([])
  })

  it('asks about a permission Orivon reads as denied for a site nobody answered for, and shows on a yes', async () => {
    FakeNotification.reset('denied')
    FakeNotification.grantWhenDenied = true
    electronApi().showNotification({ title: 'New reply', body: 'hello' })
    await settle()
    expect([FakeNotification.requested, FakeNotification.made.map(({ title }) => title)]).toEqual([1, ['New reply']])
  })

  it('keeps a notification the system refuses to construct from becoming an unhandled rejection', async () => {
    FakeNotification.reset('granted')
    FakeNotification.failToConstruct = true
    const warn = vi.fn()
    electronApi({ globals: { console: { warn } } }).showNotification({ title: 'A', body: 'b' })
    await settle()
    expect(warn).toHaveBeenCalled()
  })

  it('is the same member on window.electron, which the first-run code calls', async () => {
    FakeNotification.reset('granted')
    electron().sendNotification({ title: 'A', body: 'b' })
    await settle()
    expect(FakeNotification.made).toHaveLength(1)
  })

  it('says so on the console, and shows nothing, where there is no Notification API', async () => {
    const warn = vi.fn()
    electronApi({ notifications: false, globals: { console: { warn } } }).showNotification({ title: 'A', body: 'b' })
    await settle()
    expect(warn).toHaveBeenCalledWith('Notifications are not supported on this system.')
  })

  describe('a click on one', () => {
    async function clicked (url: string) {
      FakeNotification.reset('granted')
      const { sandbox, globals } = freshBridge()
      const focus = vi.fn()
      const open = vi.fn()
      Object.assign(sandbox.window, { focus, open, location: { origin: 'http://127.0.0.1', hash: '' } })
      ;(globals['electronApi']?.bridge as Record<string, any>).showNotification({ title: 'A', body: 'b', url })
      await settle()
      FakeNotification.made[0]?.onclick?.()
      return { focus, open, location: sandbox.window['location'] as { hash: string } }
    }

    it('goes to the post it names, in this tab, which is brought to the front', async () => {
      const { focus, open, location } = await clicked('/#/p/music.eth/abc')
      expect(focus).toHaveBeenCalled()
      expect(location.hash).toBe('#/p/music.eth/abc')
      expect(open).not.toHaveBeenCalled()
    })

    it('opens an https address in a new tab with no opener', async () => {
      const { open, location } = await clicked('https://example.com/post')
      expect(open).toHaveBeenCalledWith('https://example.com/post', '_blank', 'noopener,noreferrer')
      expect(location.hash).toBe('')
    })

    it.each(['http://example.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'http://'])('ignores %s', async (url) => {
      const { open, location } = await clicked(url)
      expect(open).not.toHaveBeenCalled()
      expect(location.hash).toBe('')
    })
  })
})

describe('files and uploads', () => {
  const catbox = (text = 'https://files.catbox.moe/abc.png') => vi.fn(async (_url: string, _init: { body: FormData }) => ({ ok: true, status: 200, statusText: 'OK', text: async () => `${text}\n` }))

  it('counts a File as on disk, because a page can read every File it holds, and nothing else', () => {
    const api = electronApi()
    expect(api.isFileOnDisk(new File(['x'], 'a.png'))).toBe(true)
    expect(api.isFileOnDisk({ name: 'a.png' })).toBe(false)
    expect(api.isFileOnDisk(null)).toBe(false)
  })

  it('uploads a File to catbox as the renderer does and answers { url, provider }', async () => {
    const fetch = catbox()
    const answer = await electronApi({ fetch: fetch as never }).automateUploadMedia({ provider: 'catbox', file: new File(['pixels'], 'a.png') })
    expect(answer).toEqual({ url: 'https://files.catbox.moe/abc.png', provider: 'catbox' })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string, body: FormData }]
    expect(url).toBe('https://catbox.moe/user/api.php')
    expect(init.method).toBe('POST')
    expect(init.body.get('reqtype')).toBe('fileupload')
    expect((init.body.get('fileToUpload') as File).name).toBe('a.png')
  })

  it('writes nothing into a public post that is not a catbox file address, and reports a failed upload in the renderer\'s words', async () => {
    const file = new File(['x'], 'a.png')
    await expect(electronApi({ fetch: catbox('<html>blocked</html>') as never }).automateUploadMedia({ provider: 'catbox', file })).rejects.toThrow('Upload failed: unexpected response')
    const failing = vi.fn(async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' }))
    await expect(electronApi({ fetch: failing as never }).automateUploadMedia({ provider: 'catbox', file })).rejects.toThrow('Upload failed: 503 Service Unavailable')
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
    return { api: loaded.globals['electronApi']?.bridge as Record<string, any>, uploader, stripped, fetch }
  }

  it.each(['imgur', 'imgbb'])('uploads the File to %s through the upload page, with its metadata stripped first, and answers what that page answers', async (provider) => {
    const { api, uploader, stripped, fetch } = withUploader()
    const file = new File(['pixels'], 'a.png', { type: 'image/png' })
    expect(await api.automateUploadMedia({ provider, file })).toEqual({ url: `https://i.example/${provider}.png`, provider })
    expect(uploader.stripMetadata).toHaveBeenCalledWith(file)
    expect(uploader.upload).toHaveBeenCalledWith(provider, stripped)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uploads bytes the page made to imgur as they are: the renderer strips what it makes, as main does not for them', async () => {
    const { api, uploader } = withUploader()
    await api.automateUploadGeneratedMedia({ provider: 'imgur', fileName: 'drawing.png', mimeType: 'image/png', bytes: [137, 80, 78, 71] })
    expect(uploader.stripMetadata).not.toHaveBeenCalled()
    const sent = uploader.upload.mock.calls[0]?.[1] as unknown as File
    expect([uploader.upload.mock.calls[0]?.[0], sent.name, sent.type, sent.size]).toEqual(['imgur', 'drawing.png', 'image/png', 4])
  })

  it.each([
    ['photo.png', 'photo.png'],
    ['my photo (1).jpg', 'my_photo__1_.jpg'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\pic.png', 'pic.png'],
    ['a..b.png', 'ab.png'],
    ['', 'upload'],
    [undefined, 'upload'],
    ['x'.repeat(256), 'upload']
  ])('names the file of generated bytes %j as main names its temporary file: %j', async (fileName, expected) => {
    const { api, uploader } = withUploader()
    await api.automateUploadGeneratedMedia({ provider: 'imgbb', fileName, bytes: [1] })
    expect((uploader.upload.mock.calls[0]?.[1] as unknown as File).name).toBe(expected)
  })

  it('gives the file of generated bytes the type the renderer sent, and a generic one when it sent none', async () => {
    const { api, uploader } = withUploader()
    await api.automateUploadGeneratedMedia({ provider: 'imgbb', fileName: 'a.bin', bytes: [1] })
    expect((uploader.upload.mock.calls[0]?.[1] as unknown as File).type).toBe('application/octet-stream')
  })

  it('rejects with what the upload page said when it fails, so the app moves on to its next provider', async () => {
    const { api, uploader } = withUploader()
    uploader.upload.mockRejectedValueOnce(new Error('Provider blocked: captcha, login, or challenge detected (imgur), selector: .captcha'))
    await expect(api.automateUploadMedia({ provider: 'imgur', file: new File(['x'], 'a.png') })).rejects.toThrow('Provider blocked: captcha')
  })

  it('says so, and sends nothing, when the page that uploads did not load', async () => {
    const fetch = catbox()
    const api = electronApi({ fetch: fetch as never })
    await expect(api.automateUploadMedia({ provider: 'imgbb', file: new File(['x'], 'a.png') })).rejects.toThrow('The page that uploads to imgur and imgbb did not load')
    await expect(api.automateUploadGeneratedMedia({ provider: 'imgur', fileName: 'x.png', bytes: [1] })).rejects.toThrow('did not load')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('leaves catbox to its own request, whatever the upload page is', async () => {
    const { api, uploader } = withUploader()
    expect(await api.automateUploadMedia({ provider: 'catbox', file: new File(['x'], 'a.png') })).toMatchObject({ provider: 'catbox' })
    expect(uploader.upload).not.toHaveBeenCalled()
  })

  it('has no recipe for Forge, which the renderer uploads itself, so main refuses it as unknown on both routes', async () => {
    const { api, uploader } = withUploader()
    await expect(api.automateUploadMedia({ provider: 'forge', file: new File(['x'], 'a.png') })).rejects.toThrow('automate-upload-media requires { provider, filePath }')
    await expect(api.automateUploadGeneratedMedia({ provider: 'forge', bytes: [1] })).rejects.toThrow('automate-upload-generated-media requires a provider')
    expect(uploader.upload).not.toHaveBeenCalled()
  })

  it('rejects a call without a File or with a provider it does not know, as the desktop handler does', async () => {
    const api = electronApi({ fetch: catbox() as never })
    await expect(api.automateUploadMedia()).rejects.toThrow('File path unavailable')
    await expect(api.automateUploadMedia({ provider: 'catbox', file: 'a.png' })).rejects.toThrow('File path unavailable')
    await expect(api.automateUploadMedia({ provider: 'flickr', file: new File(['x'], 'a.png') })).rejects.toThrow('automate-upload-media requires { provider, filePath }')
  })

  it('uploads bytes the page made under the same limits as the desktop handler', async () => {
    const fetch = catbox()
    const api = electronApi({ fetch: fetch as never })
    expect(await api.automateUploadGeneratedMedia({ provider: 'catbox', fileName: 'drawing.png', mimeType: 'image/png', bytes: [137, 80, 78, 71] }))
      .toEqual({ url: 'https://files.catbox.moe/abc.png', provider: 'catbox' })
    const sent = (fetch.mock.calls[0] as unknown as [string, { body: FormData }])[1].body.get('fileToUpload') as File
    expect([sent.name, sent.type, sent.size]).toEqual(['drawing.png', 'image/png', 4])
    await expect(api.automateUploadGeneratedMedia({ bytes: [1] })).rejects.toThrow('automate-upload-generated-media requires a provider')
    await expect(api.automateUploadGeneratedMedia({ provider: 'catbox', bytes: [] })).rejects.toThrow('Generated upload bytes are required')
    await expect(api.automateUploadGeneratedMedia({ provider: 'catbox', bytes: [1, 256] })).rejects.toThrow('Generated upload bytes are invalid')
    await expect(api.automateUploadGeneratedMedia({ provider: 'catbox', bytes: new Array(20 * 1024 * 1024 + 1) })).rejects.toThrow('Generated upload is too large')
  })
})

describe('the Forge Turnstile token', () => {
  const SITEKEY = '0x4AAAAAAFScwbbNFZtx0XVP'

  /** The script webview-turnstile.js sets on the page, as a double: what the bridge asks of it is all these tests read. */
  function withTurnstile (getToken = vi.fn(async (_sitekey: string, _options: { port: number }) => 'token-1')) {
    const loaded = freshBridge()
    loaded.sandbox.window['orivonForgeTurnstile'] = { getToken }
    return { api: loaded.globals['electronApi']?.bridge as Record<string, any>, getToken }
  }

  it('asks the Turnstile script for the sitekey, with the port the manifest names for the page it serves, and answers the token', async () => {
    const { api, getToken } = withTurnstile()
    expect(await api.getForgeTurnstileToken(SITEKEY)).toBe('token-1')
    expect(getToken).toHaveBeenCalledWith(SITEKEY, { port: 50229 })
  })

  it('rejects with the text the script gives, as the preload throws the error main sends, and returns a promise either way', async () => {
    const { api } = withTurnstile(vi.fn(async () => { throw new Error('Turnstile error 600010') }))
    let returned: unknown
    expect(() => { returned = api.getForgeTurnstileToken(SITEKEY) }).not.toThrow()
    await expect(returned).rejects.toThrow('Turnstile error 600010')
  })

  it('rejects, and does not throw, when the page that gets the token did not load', async () => {
    const api = electronApi()
    let returned: unknown
    expect(() => { returned = api.getForgeTurnstileToken(SITEKEY) }).not.toThrow()
    await expect(returned).rejects.toThrow('The page that gets a Turnstile token did not load')
  })

  it('refuses no member by name: every member of the preload is answered', () => {
    for (const name of ELECTRON_API) expect(typeof electronApi()[name], name).not.toBe('undefined')
    expect(source).not.toContain('$refused')
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
})

describe('the link to the node\'s web UI', () => {
  // seedit draws it at the desktop's own port, which nothing listens on: the bridge sends the click to the dashboard.
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
    expect(pageWithLink(NODE_LINK).listeners.map(({ type, capture }) => [type, capture])).toEqual([['click', true], ['auxclick', true], ['change', true]])
  })

  it('opens the dashboard served with the app in a new tab, and stops the navigation to the loopback address', () => {
    const { listeners, open, event } = pageWithLink(NODE_LINK)
    listeners[0]?.listener(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopImmediatePropagation).toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('http://127.0.0.1/orivon/node/index.html', '_blank')
  })

  it('leaves a right click and every other link alone', () => {
    const right = pageWithLink(NODE_LINK, 2)
    right.listeners[0]?.listener(right.event)
    const other = pageWithLink('https://example.com/')
    other.listeners[0]?.listener(other.event)
    expect(right.open).not.toHaveBeenCalled()
    expect(other.open).not.toHaveBeenCalled()
    expect(other.event.preventDefault).not.toHaveBeenCalled()
  })
})
