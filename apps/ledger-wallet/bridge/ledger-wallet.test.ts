// The composed bridge, byte for byte what the browser is served, in a fresh
// realm per test. What belongs here is this app's roster (window.api and the
// whole of window.lld), its storage (including the password-protected file
// format, checked against Node's own crypto doing what Ledger Wallet's main
// process does), the obfuscated store, the exports, the refused members and the
// Live App message gate. The renderer gate has its own file.
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import type { LoadedBridge } from '../../../src/testing/bridge-harness.ts'

const source = await bridgeSourceFor('ledger-wallet')

const enc = new TextEncoder()
const dec = new TextDecoder()

// ---- what upstream's main process does to a password-protected value ----
function upstreamEncryptBytes (data: string, password: string): Buffer {
  const iv = randomBytes(16)
  const key = pbkdf2Sync(password, iv.toString(), 10000, 32, 'sha512')
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([iv, Buffer.from(':'), cipher.update(data, 'utf8'), cipher.final()])
}
function upstreamDecryptBytes (data: Uint8Array, password: string): string {
  const buffer = Buffer.from(data)
  const iv = buffer.subarray(0, 16)
  const key = pbkdf2Sync(password, iv.toString(), 10000, 32, 'sha512')
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(buffer.subarray(17)), decipher.final()]).toString('utf8')
}
const upstreamEncrypt = (data: string, password: string): string => upstreamEncryptBytes(data, password).toString('base64')
const upstreamDecrypt = (raw: string, password: string): string => upstreamDecryptBytes(Buffer.from(raw, 'base64'), password)

// ---- a page and an orivon to run in ----
interface Downloaded { name: string, type: string, text: string }
interface FakeNode { tag: string, [key: string]: unknown }
type Listeners = Map<string, Array<(event: unknown) => void>>

function setup (files: Record<string, string | Uint8Array> = {}, options: { appTab?: boolean } = {}) {
  const store = new Map<string, Uint8Array>(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v]))
  const notFound = () => Object.assign(new Error('not found'), { code: 'notFound' })
  const orivon = {
    fs: {
      readFile: async (path: string) => store.get(path) ?? (() => { throw notFound() })(),
      writeFile: async (path: string, data: Uint8Array) => { store.set(path, data) },
      mkdir: async () => {},
      rm: async (path: string) => { if (!store.delete(path)) throw notFound() }
    },
    web: { setEmbedScript: vi.fn(async () => {}) }
  }
  const downloads: Downloaded[] = []
  const pending: Promise<void>[] = []
  const reload = vi.fn()
  const blobs = new Map<string, Blob>()
  let created = 0
  const loader = { classList: { add: vi.fn() }, remove: vi.fn() }
  const root = { style: { visibility: 'hidden' } }
  const appended: FakeNode[] = []
  const documentListeners: Listeners = new Map()
  const windowListeners = new Map<string, Array<() => void>>()
  const opened: unknown[][] = []
  const document = {
    title: 'Ledger Wallet',
    baseURI: 'http://127.0.0.1/',
    readyState: 'complete',
    getElementById: (id: string) => (id === 'react-root' ? root : id === 'loader-container' ? loader : null),
    addEventListener: (type: string, listener: (event: unknown) => void) => { documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]) },
    documentElement: { style: {}, requestFullscreen: async () => {} },
    querySelector: () => null,
    body: { appendChild: (node: FakeNode) => { appended.push(node) } },
    createElement: (tag: string) => ({
      tag,
      href: '',
      download: '',
      style: {},
      click () {
        const blob = blobs.get(String(this.href))
        if (blob === undefined) throw new Error('download link has no blob')
        pending.push(blob.text().then((text) => { downloads.push({ name: String(this.download), type: blob.type, text }) }))
      },
      remove () {}
    })
  }
  const url = Object.assign(function (...args: ConstructorParameters<typeof URL>) { return new URL(...args) }, {
    createObjectURL: (blob: Blob) => { const id = `blob:${String(++created)}`; blobs.set(id, blob); return id },
    revokeObjectURL: () => {}
  })
  const window = {
    orivon,
    open: (...args: unknown[]) => { opened.push(args) },
    addEventListener: (type: string, listener: () => void) => { windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]) }
  }
  const loaded: LoadedBridge = runBridge(source, {
    document: document as never,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/150.0.7000.1 Safari/537.36' } as never,
    globals: {
      window,
      crypto: webcrypto,
      structuredClone,
      atob,
      btoa,
      Blob,
      URL: url,
      location: { reload, hostname: 'ledger.test' },
      console,
      ...(options.appTab === false ? {} : { process: { versions: {} } })
    }
  })
  const { api, lld } = loaded.globals as Record<string, { bridge: Record<string, any> }>
  return {
    loaded,
    store,
    orivon,
    api: api!.bridge,
    lld: lld!.bridge,
    db: lld!.bridge['db'] as Record<string, any>,
    navigator: loaded.sandbox.navigator as unknown as Record<string, unknown>,
    downloads,
    settle: () => Promise.all(pending),
    reload,
    opened,
    appended,
    loader,
    root,
    documentListeners,
    windowListeners,
    ready: loaded.app['ready'] as Promise<boolean>
  }
}

const read = (store: Map<string, Uint8Array>, path: string): any => JSON.parse(dec.decode(store.get(path)))
/** Runs the 500 ms save debounce, the throttle's waits and the crypto behind them, until the call that waited on them settles. */
async function settled<T> (promise: Promise<T>): Promise<T> {
  let done = false
  const result = promise.finally(() => { done = true })
  result.catch(() => {})
  while (!done) {
    await vi.advanceTimersByTimeAsync(600)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return await result
}
/** The crypto runs on real threads, so this waits in real time (a few seconds at most) while the fake clock moves. */
async function until (condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000
  while (!condition() && Date.now() < deadline) {
    await vi.advanceTimersByTimeAsync(100)
    await new Promise((resolve) => setImmediate(resolve))
  }
  if (!condition()) throw new Error('the condition never held')
}
const errorOf = async (promise: Promise<unknown>): Promise<Error & { reason?: string }> => { try { await promise } catch (error) { return error as Error } throw new Error('expected a rejection') }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => { vi.useRealTimers() })

describe('the roster', () => {
  it('installs window.api and window.lld exactly as the preload does', () => {
    const { loaded, lld, api } = setup()
    expect(Object.keys(api).sort()).toEqual(['appDirname', 'appLoaded', 'reloadRenderer'])
    expect(Object.keys(lld).sort()).toEqual(['app', 'bootstrap', 'cardSession', 'db', 'deeplink', 'files', 'power', 'shell', 'store', 'system', 'updater', 'version', 'webview', 'zcash'])
    expect(lld['version']).toBe(7)
    expect(loaded.sandbox.window['lld']).toBe(loaded.globals['lld']!.bridge)
    expect(Object.keys(lld['db']).sort()).toEqual(['cleanCache', 'getKey', 'hasBeenDecrypted', 'hasEncryptionKey', 'isEncryptionKeyCorrect', 'reload', 'removeEncryptionKey', 'resetAll', 'setEncryptionKey', 'setKey'])
  })

  it('appLoaded shows the app and fades the splash, as the preload does', () => {
    const { api, loader, root } = setup()
    api['appLoaded']()
    expect(root.style.visibility).toBe('visible')
    expect(loader.classList.add).toHaveBeenCalledWith('fade-out')
    vi.advanceTimersByTime(500)
    expect(loader.remove).toHaveBeenCalled()
  })

  it('reloadRenderer, app.reload and app.relaunch reload the page', async () => {
    const { api, lld, reload } = setup()
    await api['reloadRenderer']()
    lld['app'].reload()
    lld['app'].relaunch()
    expect(reload).toHaveBeenCalledTimes(3)
  })
})

describe('bootstrap and the obfuscated store', () => {
  it('answers what the renderer reads while its bundle loads, as Linux, with no host path and no environment', async () => {
    const { lld, ready } = setup()
    expect(await ready).toBe(true)
    const { bootstrap } = lld
    expect(bootstrap).toEqual({
      version: 2,
      env: {},
      os: { type: 'Linux', release: '150.0.7000.1', platform: 'linux', hostname: 'ledger.test' },
      paths: { userData: '/orivon/app', home: '/orivon/app' },
      distributionChannel: 'direct',
      store: {}
    })
    expect(Object.isFrozen(bootstrap)).toBe(true)
  })

  it('reads the store file upstream\'s electron-store wrote before the renderer starts', async () => {
    const written = upstreamEncryptBytes(JSON.stringify({ app: { language: 'fr' }, 'a.b': 1 }), 'this_only_obfuscates')
    const { lld, ready } = setup({ 'lld.json': written })
    await ready
    expect(lld['bootstrap'].store).toEqual({ app: { language: 'fr' }, 'a.b': 1 })
  })

  it('starts from nothing when the store file is not one', async () => {
    const { lld, ready } = setup({ 'lld.json': 'plain text' })
    await ready
    expect(lld['bootstrap'].store).toEqual({})
  })

  it('writes dot paths after its debounce, in a form electron-store reads back, with `\\.` as a literal dot', async () => {
    const { lld, store, ready } = setup()
    await ready
    const stored = (): any => JSON.parse(upstreamDecryptBytes(store.get('lld.json')!, 'this_only_obfuscates'))
    lld['store'].set('app.language', 'de')
    lld['store'].set('app.sidebar\\.collapsed', true)
    lld['store'].set('top', { n: 1 })
    expect(store.has('lld.json')).toBe(false)
    await until(() => store.has('lld.json'))
    expect(stored()).toEqual({ app: { language: 'de', 'sidebar.collapsed': true }, top: { n: 1 } })
    lld['store'].clear()
    await until(() => stored().top === undefined)
    expect(stored()).toEqual({})
  })

  it('refuses a path that would reach the prototype', async () => {
    const { lld, store } = setup()
    lld['store'].set('__proto__.polluted', true)
    lld['store'].set('a.constructor.b', true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.has('lld.json')).toBe(false)
  })

  it('writes what is pending when the page goes away', async () => {
    const { lld, db, store, windowListeners, ready } = setup()
    await ready
    lld['store'].set('k', 1)
    await db['getKey']('app', 'settings')
    void db['setKey']('app', 'settings', { n: 1 })
    await Promise.resolve()
    for (const listener of windowListeners.get('pagehide') ?? []) listener()
    await until(() => store.has('lld.json') && read(store, 'userData/app.json').data.settings !== undefined)
    expect(read(store, 'userData/app.json').data.settings).toEqual({ n: 1 })
    expect(JSON.parse(upstreamDecryptBytes(store.get('lld.json')!, 'this_only_obfuscates'))).toEqual({ k: 1 })
  })
})

describe('storage', () => {
  it('answers a first run with the default and creates the file, never rejecting', async () => {
    const { db, store } = setup()
    expect(await db['getKey']('app', 'settings', { theme: 'dark' })).toEqual({ theme: 'dark' })
    expect(read(store, 'userData/app.json')).toEqual({ data: {} })
  })

  it('writes upstream\'s file shape after its debounce, and reads it back through a reload', async () => {
    const { db, store } = setup()
    await db['getKey']('app', 'settings')
    const saved = db['setKey']('app', 'settings', { theme: 'light', counter: 1 })
    expect(read(store, 'userData/app.json')).toEqual({ data: {} })
    await settled(saved)
    expect(read(store, 'userData/app.json')).toEqual({ data: { settings: { theme: 'light', counter: 1 } } })
    await db['reload']()
    expect(await db['getKey']('app', 'settings.theme')).toBe('light')
  })

  it('addresses nested and indexed key paths like lodash', async () => {
    const { db } = setup()
    await settled(Promise.all([db['setKey']('app', 'settings.a.b', 1), db['setKey']('app', 'history.1', 'x'), db['setKey']('app', 'discover.list[1]', 2)]))
    expect(await db['getKey']('app', 'settings')).toEqual({ a: { b: 1 } })
    expect(await db['getKey']('app', 'history')).toEqual([undefined, 'x'])
    expect(await db['getKey']('app', 'discover')).toEqual({ list: [undefined, 2] })
    expect(await db['getKey']('app', 'discover.list[1]')).toBe(2)
    expect(await db['getKey']('app', 'settings.a.zzz', 7)).toBe(7)
    expect(await db['getKey']('app', '', 7)).toMatchObject({ settings: { a: { b: 1 } } })
  })

  it('refuses a key upstream does not persist', async () => {
    const { db } = setup()
    expect((await errorOf(db['setKey']('app', 'nonsense', 1))).message).toMatch(/unknown key path "nonsense"/)
    expect((await errorOf(db['setKey']('app', 'nonsense.deeper', 1))).message).toMatch(/top-level "nonsense"/)
  })

  it('serves only the app namespace to the renderer', async () => {
    const { db, store } = setup()
    for (const ns of ['windowParams', 'other', '../x']) {
      expect((await errorOf(db['getKey'](ns, 'a'))).message).toMatch(/namespace not allowed/)
      expect((await errorOf(db['setKey'](ns, 'a', 1))).message).toMatch(/namespace not allowed/)
    }
    expect([...store.keys()]).toEqual([])
  })

  it('drops keys upstream would not load, and returns copies the caller cannot use to edit state', async () => {
    const { db } = setup({ 'userData/app.json': JSON.stringify({ data: { settings: { x: 1 }, stranger: true } }) })
    const settings = await db['getKey']('app', 'settings')
    settings.x = 99
    expect(await db['getKey']('app', 'settings.x')).toBe(1)
    expect(await db['getKey']('app', 'stranger')).toBeUndefined()
  })

  it('keeps the legacy `user` key until `identities` is written', async () => {
    const { db, store } = setup({ 'userData/app.json': JSON.stringify({ data: { user: { id: 'u1' }, settings: { x: 1 } } }) })
    await settled(db['setKey']('app', 'settings', { x: 2 }))
    expect(read(store, 'userData/app.json').data).toEqual({ user: { id: 'u1' }, settings: { x: 2 } })
    await settled(db['setKey']('app', 'identities', { id: 'i1' }))
    expect(read(store, 'userData/app.json').data).toEqual({ identities: { id: 'i1' }, settings: { x: 2 } })
  })

  it('cleanCache nulls the countervalues and resetAll removes the file', async () => {
    const { db, store } = setup({ 'userData/app.json': JSON.stringify({ data: { countervalues: { a: 1 } } }) })
    await settled(db['cleanCache']())
    expect(read(store, 'userData/app.json').data.countervalues).toBeNull()
    await db['resetAll']()
    expect(store.has('userData/app.json')).toBe(false)
    await db['resetAll']()
  })
})

describe('the password', () => {
  const accounts = [{ id: 'js:2:ethereum:0xabc:', name: 'Ethereum 1' }]
  const locked = (): Record<string, string> => ({
    'userData/app.json': JSON.stringify({ data: { accounts: upstreamEncrypt(JSON.stringify(accounts), 'hunter2'), settings: { theme: 'dark' } } })
  })

  it('opens a file written by upstream\'s main process, and says wrong passwords are wrong', async () => {
    const { db } = setup(locked())
    expect(await db['hasBeenDecrypted']()).toBe(false)
    const wrong = await errorOf(settled(db['setEncryptionKey']('nope')))
    expect(wrong.name).toBe('DBWrongPassword')
    expect(await db['hasBeenDecrypted']()).toBe(false)
    expect(await db['hasEncryptionKey']('app', 'accounts')).toBe(false)
    await settled(db['setEncryptionKey']('hunter2'))
    expect(await db['getKey']('app', 'accounts')).toEqual(accounts)
    expect(await db['hasBeenDecrypted']()).toBe(true)
    expect(await db['hasEncryptionKey']('app', 'accounts')).toBe(true)
    expect(await settled(db['isEncryptionKeyCorrect']('hunter2'))).toBe(true)
    expect(await settled(db['isEncryptionKeyCorrect']('nope'))).toBe(false)
  })

  it('writes the three protected paths in a form upstream\'s main process opens with the same password', async () => {
    const { db, store } = setup({ 'userData/app.json': JSON.stringify({ data: { accounts, settings: { theme: 'dark' } } }) })
    await settled(db['setEncryptionKey']('correct horse'))
    const file = read(store, 'userData/app.json').data
    expect(file.settings).toEqual({ theme: 'dark' })
    expect(JSON.parse(upstreamDecrypt(file.accounts, 'correct horse'))).toEqual(accounts)
    expect(JSON.parse(upstreamDecrypt(file.trustchain, 'correct horse'))).toEqual({ trustchain: null, memberCredentials: null })
    expect(JSON.parse(upstreamDecrypt(file.wallet, 'correct horse')).contacts[0].isMe).toBe(true)
  })

  it('unlocks all three paths or none: one wrong blob leaves the file locked and the db without a key', async () => {
    const { db, store } = setup({
      'userData/app.json': JSON.stringify({ data: { accounts: upstreamEncrypt('[]', 'pw'), wallet: upstreamEncrypt('{}', 'other') } })
    })
    expect((await errorOf(settled(db['setEncryptionKey']('pw')))).name).toBe('DBWrongPassword')
    expect(await db['hasEncryptionKey']('app', 'accounts')).toBe(false)
    expect(typeof (await db['getKey']('app', 'accounts'))).toBe('string')
    expect(typeof read(store, 'userData/app.json').data.accounts).toBe('string')
  })

  it('changes or removes a held password only with the current one', async () => {
    const { db, store } = setup(locked())
    await settled(db['setEncryptionKey']('hunter2'))
    expect((await errorOf(settled(db['setEncryptionKey']('new')))).name).toBe('DBWrongPassword')
    expect((await errorOf(settled(db['setEncryptionKey']('new', 'wrong')))).name).toBe('DBWrongPassword')
    expect((await errorOf(settled(db['removeEncryptionKey']()))).name).toBe('DBWrongPassword')
    expect(JSON.parse(upstreamDecrypt(read(store, 'userData/app.json').data.accounts, 'hunter2'))).toEqual(accounts)
    await settled(db['setEncryptionKey']('new', 'hunter2'))
    expect(JSON.parse(upstreamDecrypt(read(store, 'userData/app.json').data.accounts, 'new'))).toEqual(accounts)
    await settled(db['removeEncryptionKey']('new'))
    expect(read(store, 'userData/app.json').data.accounts).toEqual(accounts)
    expect(await db['hasEncryptionKey']('app', 'accounts')).toBe(false)
  })

  it('makes the sixth wrong try wait a second, doubling, and forgets the wrongs after a right one', async () => {
    const { db } = setup(locked())
    for (let i = 0; i < 5; i++) expect(await db['isEncryptionKeyCorrect']('wrong')).toBe(false)
    let sixth = false
    const attempt = db['isEncryptionKeyCorrect']('wrong').then((value: boolean) => { sixth = true; return value })
    await vi.advanceTimersByTimeAsync(999)
    expect(sixth).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await attempt).toBe(false)
    let seventh = false
    const next = db['isEncryptionKeyCorrect']('wrong').then((value: boolean) => { seventh = true; return value })
    await vi.advanceTimersByTimeAsync(1999)
    expect(seventh).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await next
    await settled(db['setEncryptionKey']('hunter2'))
    expect(await db['isEncryptionKeyCorrect']('wrong')).toBe(false)
    expect(await db['isEncryptionKeyCorrect']('hunter2')).toBe(true)
  })

  it('decrypts what Node\'s crypto encrypts, with the IV bytes read as UTF-8 for the salt, for many IVs', async () => {
    const { loaded } = setup()
    const { decryptData, encryptData } = loaded.app['crypto']
    for (let i = 0; i < 40; i++) {
      const text = JSON.stringify({ i, wallet: 'ü' })
      expect(await decryptData(upstreamEncrypt(text, 'pw'), 'pw')).toBe(text)
      expect(upstreamDecrypt(await encryptData(text, 'pw'), 'pw')).toBe(text)
    }
  })

  it('encrypts a blob far larger than the call stack allows to spread', async () => {
    const { loaded } = setup()
    const { decryptData, encryptData } = loaded.app['crypto']
    const text = JSON.stringify({ filler: 'x'.repeat(600_000) })
    expect(upstreamDecrypt(await encryptData(text, 'pw'), 'pw')).toBe(text)
    expect(await decryptData(upstreamEncrypt(text, 'pw'), 'pw')).toBe(text)
  })

  it('says plainly that pre-IV data cannot be opened here', async () => {
    const { loaded } = setup()
    const legacy = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')
    expect((await errorOf(loaded.app['crypto'].decryptData(legacy, 'pw'))).message).toMatch(/before 2020/)
  })
})

describe('exports, which are the browser\'s downloads', () => {
  it('turns export-operations into a CSV download named by the save request', async () => {
    const { lld, downloads, settle } = setup()
    expect(await lld['files'].exportOperations({ options: { defaultPath: '/x/ledgerwallet-operations-2026.csv' } }, 'a,b\n1,2')).toBe('saved')
    await settle()
    expect(downloads).toEqual([{ name: 'ledgerwallet-operations-2026.csv', type: 'text/csv', text: 'a,b\n1,2' }])
    expect(await lld['files'].exportOperations({ options: {} }, '')).toBe('failed')
  })

  it('saves renderer logs in upstream\'s order, chronological, indexed and keyed', async () => {
    const { lld, downloads, settle } = setup()
    const logs = [{ timestamp: '2026-01-02', message: 'newest', id: 'b', type: 'x' }, { timestamp: '2026-01-01', message: 'oldest', id: 'a', type: 'x' }]
    expect(await lld['files'].saveLogs({ options: { defaultPath: 'logs.txt' } }, JSON.stringify(logs))).toBe('saved')
    await settle()
    const saved = JSON.parse(downloads[0]!.text)
    expect(saved.map((log: { message: string }) => log.message)).toEqual(['oldest', 'newest'])
    expect(saved.map((log: { logIndex: number }) => log.logIndex)).toEqual([0, 1])
    expect(saved[0].pname).toBe('electron-renderer')
    expect(Object.keys(saved[0]).slice(0, 4)).toEqual(['logIndex', 'timestamp', 'pname', 'type'])
    expect(await lld['files'].saveLogs({ options: {} }, 'not json')).toBe('failed')
    expect(downloads).toHaveLength(1)
  })

  it('keeps the last 5000 logs and says so in a first line', async () => {
    const { lld, downloads, settle } = setup()
    const logs = Array.from({ length: 5003 }, (_, i) => ({ timestamp: String(i), message: `m${String(5002 - i)}` }))
    await lld['files'].saveLogs({ options: {} }, JSON.stringify(logs))
    await settle()
    const saved = JSON.parse(downloads[0]!.text)
    expect(saved).toHaveLength(5001)
    expect(saved[0].type).toBe('exportLogsMeta')
  })

  it('saves a PNG from its base64', async () => {
    const { lld, downloads, settle } = setup()
    expect(await lld['files'].savePng({ defaultPath: '/x/ledger-request-ETH.png' }, Buffer.from('png!').toString('base64'))).toBe('saved')
    expect(await lld['files'].savePng({}, '')).toBe('failed')
    await settle()
    expect(downloads).toEqual([{ name: 'ledger-request-ETH.png', type: 'image/png', text: 'png!' }])
  })
})

describe('the members that are inert, refused or equivalent', () => {
  it('refuses by name what a tab cannot honour, with the reason', async () => {
    const { lld } = setup()
    const open = await errorOf(lld['files'].openUserDataDirectory())
    expect(open.name).toBe('OrivonBridgeError')
    expect(open.reason).toBe('shell-owned')
    const zcash = await errorOf(lld['zcash'].invoke('zcash:sync', {}))
    expect(zcash.reason).toBe('not-built')
    expect(zcash.message).toContain('zcash.invoke("zcash:sync")')
    expect(() => lld['app'].quit()).toThrow(/browser owns this/)
    expect(() => lld['updater'].quitAndInstall()).toThrow(/excluded from Orivon/)
  })

  it('lets the updater start and finds nothing, so the app mounts', () => {
    const { lld } = setup()
    const heard = vi.fn()
    expect(() => lld['updater'].init()).not.toThrow()
    lld['updater'].onStatus(heard)()
    expect(heard).not.toHaveBeenCalled()
    expect(() => lld['app'].show()).not.toThrow()
    expect(lld['zcash'].subscribe('zcash:event', () => {})).toBeTypeOf('function')
  })

  it('has no card session to hand over', async () => {
    const { lld } = setup()
    expect(await lld['cardSession'].takeBootstrap()).toBeNull()
  })

  it('answers the system members a page can answer', () => {
    const { lld } = setup()
    expect(() => lld['system'].setVisualZoomLevelLimits(1, 1)).not.toThrow()
    expect(lld['system'].getResourceUsage()).toBeUndefined()
  })

  it('gives a deep link back to the listeners, the round trip upstream\'s main makes', async () => {
    const { lld } = setup()
    const heard: string[] = []
    const stop = lld['deeplink'].onOpen((url: string) => { heard.push(url) })
    lld['deeplink'].open('ledgerlive://a')
    lld['deeplink'].open('ledgerlive://b')
    await Promise.resolve()
    await Promise.resolve()
    expect(heard).toEqual(['ledgerlive://a', 'ledgerlive://b'])
    stop()
    lld['deeplink'].open('ledgerlive://c')
    await Promise.resolve()
    expect(heard).toHaveLength(2)
  })

  it('keeps the screen awake with a wake lock and hands back an id', async () => {
    const release = vi.fn(async () => {})
    const { lld, navigator } = setup()
    navigator['wakeLock'] = { request: async () => ({ release }) }
    const first = await lld['power'].keepScreenAwake()
    const second = await lld['power'].keepScreenAwake()
    expect(second).not.toBe(first)
    await lld['power'].release(first)
    expect(release).toHaveBeenCalledTimes(1)
    await lld['power'].release(12345)
  })

  it('compares the clipboard only when the browser already lets the page read it', async () => {
    const { lld, navigator } = setup()
    expect(await lld['system'].clipboardMatchesText('0xabc')).toBeNull()
    navigator['permissions'] = { query: async () => ({ state: 'prompt' }) }
    navigator['clipboard'] = { readText: async () => '0xabc' }
    expect(await lld['system'].clipboardMatchesText('0xabc')).toBeNull()
    navigator['permissions'] = { query: async () => ({ state: 'granted' }) }
    expect(await lld['system'].clipboardMatchesText('0xabc')).toBe(true)
    expect(await lld['system'].clipboardMatchesText('0xdef')).toBe(false)
  })

  it('opens http, https, mailto and Ledger\'s own schemes in a new tab without an opener, and nothing else', () => {
    const { lld, opened } = setup()
    for (const url of ['https://support.ledger.com', 'mailto:a@b.c', 'ledgerlive://account', 'javascript:alert(1)', 'file:///etc/passwd', 'ms-word:x', 'not a url']) lld['shell'].openExternal(url)
    expect(opened).toEqual([
      ['https://support.ledger.com', '_blank', 'noopener,noreferrer'],
      ['mailto:a@b.c', '_blank', 'noopener,noreferrer'],
      ['ledgerlive://account', '_blank', 'noopener,noreferrer']
    ])
  })
})

describe('Live Apps', () => {
  const ORIGIN = 'https://app.example'
  const preferences = (origins: string[] | 'unrestricted' | null): string => (origins === null
    ? 'nativeWindowOpen=no'
    : `nativeWindowOpen=no,ledgerLiveAllowedOrigins=${origins === 'unrestricted' ? origins : encodeURIComponent(JSON.stringify(origins))}`)

  function guest (url: string, webpreferences: string, tag = 'webview') {
    return { localName: tag, getWebContentsId: () => 7, getURL: () => url, getAttribute: (name: string) => (name === 'webpreferences' ? webpreferences : null) }
  }
  function deliver (listeners: Listeners, element: unknown, channel = 'webviewToParent', message: unknown = '{"jsonrpc":"2.0"}') {
    for (const listener of listeners.get('ipc-message') ?? []) listener({ target: element, channel, args: [message] })
  }

  it('installs the guest page half of upstream\'s webview preload as the embed script', () => {
    const { orivon } = setup()
    expect(orivon.web.setEmbedScript).toHaveBeenCalledTimes(1)
    const script = (orivon.web.setEmbedScript.mock.calls[0] as unknown as [string])[0]
    const sent: unknown[][] = []
    const page: Record<string, any> = {}
    new Function('window', 'orivonEmbed', script)(page, { sendToHost: (...args: unknown[]) => sent.push(args) })
    page['ElectronWebview'].postMessage({ jsonrpc: '2.0' })
    expect(sent).toEqual([['webviewToParent', { jsonrpc: '2.0' }]])
  })

  it('still installs when the page has no web.embed grant', () => {
    expect(() => runBridge(source, { orivon: { fs: {} }, globals: { crypto: webcrypto, structuredClone, atob, btoa, Blob, location: {} } })).not.toThrow()
  })

  it('hands the embedder a message from the guest main frame on an origin the manifest named', () => {
    const { lld, documentListeners } = setup()
    const heard: unknown[] = []
    lld['webview'].onMessage((message: unknown) => heard.push(message))
    deliver(documentListeners, guest(`${ORIGIN}/live?x=1`, preferences([ORIGIN])))
    deliver(documentListeners, guest(`${ORIGIN}/live`, preferences([ORIGIN])), 'dappToParent', { id: 1 })
    expect(heard).toEqual([
      { guestId: 7, origin: ORIGIN, channel: 'webviewToParent', message: '{"jsonrpc":"2.0"}' },
      { guestId: 7, origin: ORIGIN, channel: 'dappToParent', message: { id: 1 } }
    ])
  })

  it('matches manifest domains as upstream does: exact origin, scheme-only, subdomain wildcard with the port', () => {
    const { lld, documentListeners } = setup()
    const heard: unknown[] = []
    lld['webview'].onMessage((message: unknown) => heard.push(message))
    const allowed = (url: string, domains: string[]): boolean => { heard.length = 0; deliver(documentListeners, guest(url, preferences(domains))); return heard.length === 1 }
    expect(allowed('https://a.b.example.com/x', ['https://*.example.com'])).toBe(true)
    expect(allowed('https://example.com/x', ['https://*.example.com'])).toBe(false)
    expect(allowed('https://evilexample.com/x', ['https://*.example.com'])).toBe(false)
    expect(allowed('https://x.example.com:8443/', ['https://*.example.com'])).toBe(false)
    expect(allowed('https://x.example.com:8443/', ['https://*.example.com:8443'])).toBe(true)
    expect(allowed('https://anything.test/', ['https://*'])).toBe(true)
    expect(allowed('http://anything.test/', ['https://*'])).toBe(false)
    expect(allowed('http://localhost:3000/', ['http://localhost:3000'])).toBe(true)
    expect(allowed('https://app.example/', [' '])).toBe(false)
    expect(allowed('https://app.example/', [])).toBe(false)
  })

  it('answers any http(s) origin when the manifest check is off, and nothing without allowed origins', () => {
    const { lld, documentListeners } = setup()
    const heard: unknown[] = []
    lld['webview'].onMessage((message: unknown) => heard.push(message))
    deliver(documentListeners, guest('https://whatever.test/', preferences('unrestricted')))
    expect(heard).toHaveLength(1)
    deliver(documentListeners, guest('https://whatever.test/', preferences(null)))
    deliver(documentListeners, guest('https://whatever.test/', 'ledgerLiveAllowedOrigins=%7Bnot-json'))
    deliver(documentListeners, guest('https://whatever.test/', `ledgerLiveAllowedOrigins=${encodeURIComponent('[1]')}`))
    deliver(documentListeners, guest('file:///etc/passwd', preferences('unrestricted')))
    deliver(documentListeners, guest('about:blank', preferences('unrestricted')))
    expect(heard).toHaveLength(1)
  })

  it('ignores another channel, another element, and a guest that cannot say who it is', () => {
    const { lld, documentListeners } = setup()
    const heard: unknown[] = []
    lld['webview'].onMessage((message: unknown) => heard.push(message))
    deliver(documentListeners, guest(ORIGIN, preferences([ORIGIN])), 'something-else')
    deliver(documentListeners, guest(ORIGIN, preferences([ORIGIN]), 'iframe'))
    deliver(documentListeners, { ...guest(ORIGIN, preferences([ORIGIN])), getWebContentsId: () => { throw new Error('not attached') } })
    expect(heard).toEqual([])
  })

  it('stops hearing after the unsubscribe, and never fires a domain violation by itself', () => {
    const { lld, documentListeners } = setup()
    const heard = vi.fn()
    const violations = vi.fn()
    lld['webview'].onDomainCheckViolation(violations)
    lld['webview'].onMessage(heard)()
    deliver(documentListeners, guest(ORIGIN, preferences([ORIGIN])))
    deliver(documentListeners, guest('https://other.test', preferences([ORIGIN])))
    expect(heard).not.toHaveBeenCalled()
    expect(violations).not.toHaveBeenCalled()
  })
})
