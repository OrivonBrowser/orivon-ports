// The composed bridge, byte for byte what the browser is served, in a fresh
// realm per test. What belongs here is this app's roster, its storage (including
// the password-protected file format, checked against Node's own crypto doing
// what Ledger Wallet's main process does), and every ipc channel's answer.
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeSourceFor, runBridge } from '../../../src/testing/bridge-harness.ts'
import type { LoadedBridge } from '../../../src/testing/bridge-harness.ts'

const source = await bridgeSourceFor('ledger-wallet')

const enc = new TextEncoder()
const dec = new TextDecoder()

// ---- what upstream's main process does to a password-protected value ----
function upstreamEncrypt (data: string, password: string): string {
  const iv = randomBytes(16)
  const key = pbkdf2Sync(password, iv.toString(), 10000, 32, 'sha512')
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([iv, Buffer.from(':'), cipher.update(data, 'utf8'), cipher.final()]).toString('base64')
}
function upstreamDecrypt (raw: string, password: string): string {
  const data = Buffer.from(raw, 'base64')
  const iv = data.subarray(0, 16)
  const key = pbkdf2Sync(password, iv.toString(), 10000, 32, 'sha512')
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(data.subarray(17)), decipher.final()]).toString('utf8')
}

// ---- a page and an orivon to run in ----
interface Downloaded { name: string, type: string, text: string }

function setup (files: Record<string, string> = {}) {
  const store = new Map<string, Uint8Array>(Object.entries(files).map(([k, v]) => [k, enc.encode(v)]))
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
  const clipboardWrites: string[] = []
  const blobs = new Map<string, Blob>()
  let created = 0
  const loader = { classList: { add: vi.fn() }, remove: vi.fn() }
  const root = { style: { visibility: 'hidden' } }
  const links: Array<Record<string, unknown>> = []
  const document = {
    title: 'Ledger Wallet',
    baseURI: 'http://127.0.0.1/',
    readyState: 'complete',
    getElementById: (id: string) => (id === 'react-root' ? root : id === 'loader-container' ? loader : null),
    addEventListener: () => {},
    documentElement: { style: {}, requestFullscreen: async () => {} },
    querySelector: () => null,
    body: { appendChild: (link: Record<string, unknown>) => { links.push(link) } },
    createElement: () => ({
      href: '',
      download: '',
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
  const opened: string[] = []
  const loaded: LoadedBridge = runBridge(source, {
    orivon,
    document,
    navigator: { clipboard: { writeText: async (text: string) => { clipboardWrites.push(text) } } } as never,
    globals: {
      crypto: webcrypto,
      structuredClone,
      atob,
      btoa,
      Blob,
      URL: url,
      location: { reload },
      console
    }
  })
  loaded.sandbox.window['open'] = (target: string) => { opened.push(target) }
  const { api, ledgerElectron } = loaded.globals as Record<string, { bridge: Record<string, any> }>
  const ipc = ledgerElectron!.bridge['ipcRenderer'] as { invoke: (c: string, ...a: unknown[]) => Promise<any>, send: (c: string, ...a: unknown[]) => void, on: (c: string, l: (...a: any[]) => void) => unknown, once: (c: string, l: (...a: any[]) => void) => unknown, removeListener: (c: string, l: (...a: any[]) => void) => unknown, removeAllListeners: (c?: string) => unknown }
  return { loaded, store, orivon, ipc, api: api!.bridge, electron: ledgerElectron!.bridge, downloads, settle: () => Promise.all(pending), reload, clipboardWrites, opened, loader, root }
}

const read = (store: Map<string, Uint8Array>, path: string): any => JSON.parse(dec.decode(store.get(path)))
/** Runs the 500 ms save debounce, and the crypto and file work behind it, until the call that waited on it settles. */
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
const errorOf = async (promise: Promise<unknown>): Promise<Error> => { try { await promise } catch (error) { return error as Error } throw new Error('expected a rejection') }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => { vi.useRealTimers() })

describe('the roster', () => {
  it('installs window.api exactly as the preloader does, and the electron stand-in', () => {
    const { loaded } = setup()
    expect(Object.keys(loaded.globals['api']!.bridge).sort()).toEqual(['appDirname', 'appLoaded', 'openWindow', 'reloadRenderer'])
    expect(Object.keys(loaded.globals['ledgerElectron']!.bridge).sort()).toEqual(['clipboard', 'ipcRenderer', 'shell', 'webFrame'])
    expect(loaded.sandbox.window['api']).toBe(loaded.globals['api']!.bridge)
    expect(loaded.sandbox.window['ledgerElectron']).toBe(loaded.globals['ledgerElectron']!.bridge)
  })

  it('appLoaded shows the app and fades the splash, as the preloader does', () => {
    const { api, loader, root } = setup()
    api['appLoaded']()
    expect(root.style.visibility).toBe('visible')
    expect(loader.classList.add).toHaveBeenCalledWith('fade-out')
    vi.advanceTimersByTime(500)
    expect(loader.remove).toHaveBeenCalled()
  })

  it('reloadRenderer and app-reload reload the page; openWindow tells nobody', async () => {
    const { api, ipc, reload } = setup()
    await api['reloadRenderer']()
    ipc.send('app-reload')
    expect(reload).toHaveBeenCalledTimes(2)
    expect(api['openWindow'](1, ['example.com'])).toBeUndefined()
  })
})

describe('storage', () => {
  it('answers a first run with the default and creates the namespace file, never rejecting', async () => {
    const { ipc, store } = setup()
    expect(await ipc.invoke('getKey', { ns: 'app', keyPath: 'settings', defaultValue: { theme: 'dark' } })).toEqual({ theme: 'dark' })
    expect(read(store, 'userData/app.json')).toEqual({ data: {} })
  })

  it('writes upstream\'s file shape after its debounce, and reads it back through a reload', async () => {
    const { ipc, store } = setup()
    await ipc.invoke('getKey', { ns: 'app', keyPath: 'settings' })
    const saved = ipc.invoke('setKey', { ns: 'app', keyPath: 'settings', value: { theme: 'light', counter: 1 } })
    expect(read(store, 'userData/app.json')).toEqual({ data: {} })
    await settled(saved)
    expect(read(store, 'userData/app.json')).toEqual({ data: { settings: { theme: 'light', counter: 1 } } })
    await ipc.invoke('reload')
    expect(await ipc.invoke('getKey', { ns: 'app', keyPath: 'settings.theme' })).toBe('light')
  })

  it('addresses nested and indexed key paths like lodash', async () => {
    const { ipc } = setup()
    await settled(Promise.all([
      ipc.invoke('setKey', { ns: 'app', keyPath: 'settings.a.b', value: 1 }),
      ipc.invoke('setKey', { ns: 'app', keyPath: 'history[1]'.replace('[1]', '.1'), value: 'x' })
    ]))
    expect(await ipc.invoke('getKey', { ns: 'app', keyPath: 'settings' })).toEqual({ a: { b: 1 } })
    expect(await ipc.invoke('getKey', { ns: 'app', keyPath: 'history' })).toEqual([undefined, 'x'])
    expect(await ipc.invoke('getKey', { ns: 'app', keyPath: 'settings.a.zzz', defaultValue: 7 })).toBe(7)
  })

  it('refuses a key upstream does not persist, and keeps one write per namespace pending', async () => {
    const { ipc, store } = setup()
    expect((await errorOf(ipc.invoke('setKey', { ns: 'app', keyPath: 'nonsense', value: 1 }))).message).toMatch(/unknown key path "nonsense"/)
    await settled(Promise.all([
      ipc.invoke('setKey', { ns: 'app', keyPath: 'settings', value: 1 }),
      ipc.invoke('setKey', { ns: 'other', keyPath: 'k', value: 2 })
    ]))
    expect(read(store, 'userData/app.json').data.settings).toBe(1)
    expect(read(store, 'userData/other.json').data.k).toBe(2)
  })

  it('drops keys upstream would not load, and returns copies the caller cannot use to edit state', async () => {
    const { ipc } = setup({ 'userData/app.json': JSON.stringify({ data: { settings: { x: 1 }, stranger: true } }) })
    const settings = await ipc.invoke('getKey', { ns: 'app', keyPath: 'settings' })
    settings.x = 99
    expect(await ipc.invoke('getKey', { ns: 'app', keyPath: 'settings.x' })).toBe(1)
    expect(await ipc.invoke('getKey', { ns: 'app', keyPath: 'stranger' })).toBeUndefined()
  })

  it('rejects a namespace that is not a plain name', async () => {
    const { ipc } = setup()
    expect((await errorOf(ipc.invoke('getKey', { ns: '../x', keyPath: 'a' }))).message).toMatch(/invalid namespace/)
  })

  it('cleanCache nulls the countervalues and resetAll removes the file', async () => {
    const { ipc, store } = setup({ 'userData/app.json': JSON.stringify({ data: { countervalues: { a: 1 } } }) })
    await settled(ipc.invoke('cleanCache'))
    expect(read(store, 'userData/app.json').data.countervalues).toBeNull()
    await ipc.invoke('resetAll')
    expect(store.has('userData/app.json')).toBe(false)
    await ipc.invoke('resetAll')
  })
})

describe('the password', () => {
  const accounts = [{ id: 'js:2:ethereum:0xabc:', name: 'Ethereum 1' }]
  const locked = (): Record<string, string> => ({
    'userData/app.json': JSON.stringify({ data: { accounts: upstreamEncrypt(JSON.stringify(accounts), 'hunter2'), settings: { theme: 'dark' } } })
  })

  it('opens a file written by upstream\'s main process, and says wrong passwords are wrong', async () => {
    const { ipc } = setup(locked())
    expect(await ipc.invoke('hasBeenDecrypted', {})).toBe(false)
    const wrong = await errorOf(ipc.invoke('setEncryptionKey', { encryptionKey: 'nope' }))
    expect(wrong.name).toBe('DBWrongPassword')
    expect(await ipc.invoke('hasBeenDecrypted', {})).toBe(false)
    await settled(ipc.invoke('setEncryptionKey', { encryptionKey: 'hunter2' }))
    expect(await ipc.invoke('getKey', { ns: 'app', keyPath: 'accounts' })).toEqual(accounts)
    expect(await ipc.invoke('hasBeenDecrypted', {})).toBe(true)
    expect(await ipc.invoke('hasEncryptionKey', {})).toBe(true)
    expect(await ipc.invoke('isEncryptionKeyCorrect', { encryptionKey: 'hunter2' })).toBe(true)
    expect(await ipc.invoke('isEncryptionKeyCorrect', { encryptionKey: 'nope' })).toBe(false)
  })

  it('writes the three protected paths in a form upstream\'s main process opens with the same password', async () => {
    const { ipc, store } = setup({ 'userData/app.json': JSON.stringify({ data: { accounts, settings: { theme: 'dark' } } }) })
    await settled(ipc.invoke('setEncryptionKey', { encryptionKey: 'correct horse' }))
    const file = read(store, 'userData/app.json').data
    expect(file.settings).toEqual({ theme: 'dark' })
    expect(JSON.parse(upstreamDecrypt(file.accounts, 'correct horse'))).toEqual(accounts)
    expect(JSON.parse(upstreamDecrypt(file.trustchain, 'correct horse'))).toEqual({ trustchain: null, memberCredentials: null })
    expect(JSON.parse(upstreamDecrypt(file.wallet, 'correct horse')).contacts[0].isMe).toBe(true)
  })

  it('removes the password by writing the data back in the clear', async () => {
    const { ipc, store } = setup(locked())
    await settled(ipc.invoke('setEncryptionKey', { encryptionKey: 'hunter2' }))
    await settled(ipc.invoke('removeEncryptionKey', {}))
    expect(read(store, 'userData/app.json').data.accounts).toEqual(accounts)
    expect(await ipc.invoke('hasEncryptionKey', {})).toBe(false)
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

  it('says plainly that pre-IV data cannot be opened here', async () => {
    const { loaded } = setup()
    const legacy = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')
    expect((await errorOf(loaded.app['crypto'].decryptData(legacy, 'pw'))).message).toMatch(/before 2020/)
  })
})

describe('exports, which are the browser\'s downloads', () => {
  it('turns the save dialog into a file name and export-operations into a CSV download', async () => {
    const { ipc, downloads, settle } = setup()
    const path = await ipc.invoke('show-save-dialog', { defaultPath: 'ledgerwallet-operations-2026.csv' })
    expect(path).toEqual({ canceled: false, filePath: 'ledgerwallet-operations-2026.csv' })
    expect(await ipc.invoke('export-operations', path, 'a,b\n1,2')).toBe(true)
    await settle()
    expect(downloads).toEqual([{ name: 'ledgerwallet-operations-2026.csv', type: 'text/csv', text: 'a,b\n1,2' }])
    expect(await ipc.invoke('export-operations', { canceled: true, filePath: 'x' }, 'a')).toBe(false)
    expect(await ipc.invoke('export-operations', path, '')).toBe(false)
  })

  it('saves renderer logs in upstream\'s order, chronological, indexed and keyed', async () => {
    const { ipc, downloads, settle } = setup()
    const path = await ipc.invoke('show-save-dialog', { defaultPath: 'logs.txt' })
    const logs = [{ timestamp: '2026-01-02', message: 'newest', id: 'b', type: 'x' }, { timestamp: '2026-01-01', message: 'oldest', id: 'a', type: 'x' }]
    await ipc.invoke('save-logs', path, JSON.stringify(logs))
    await settle()
    const saved = JSON.parse(downloads[0]!.text)
    expect(saved.map((log: { message: string }) => log.message)).toEqual(['oldest', 'newest'])
    expect(saved.map((log: { logIndex: number }) => log.logIndex)).toEqual([0, 1])
    expect(saved[0].pname).toBe('electron-renderer')
    expect(Object.keys(saved[0]).slice(0, 4)).toEqual(['logIndex', 'timestamp', 'pname', 'type'])
    await ipc.invoke('save-logs', path, 'not json')
    await ipc.invoke('save-logs', { canceled: true }, '[]')
    await settle()
    expect(downloads).toHaveLength(1)
  })

  it('saves a PNG from its base64', async () => {
    const { ipc, downloads, settle } = setup()
    expect(await ipc.invoke('save-png', { defaultPath: '/x/ledger-request-ETH.png' }, Buffer.from('png!').toString('base64'))).toBe(true)
    expect(await ipc.invoke('save-png', {}, '')).toBe(false)
    await settle()
    expect(downloads).toEqual([{ name: 'ledger-request-ETH.png', type: 'image/png', text: 'png!' }])
  })
})

describe('the channels that are inert, refused or equivalent', () => {
  it('refuses by name what a tab cannot honour, with the reason', async () => {
    const { ipc } = setup()
    for (const [channel, reason] of [['openUserDataDirectory', 'shell-owned'], ['show-open-dialog', 'not-built'], ['transport:open', 'not-built'], ['transport:exchange', 'not-built'], ['transport:close', 'not-built'], ['transport:listen', 'not-built'], ['transport:listen:unsubscribe', 'not-built']] as const) {
      const error = await errorOf(ipc.invoke(channel)) as Error & { reason?: string }
      expect(error.name, channel).toBe('OrivonBridgeError')
      expect(error.reason, channel).toBe(reason)
      expect(error.message, channel).toContain(channel)
    }
    for (const [channel, args, reason] of [['app-quit', [], 'shell-owned'], ['internalCrashTest', [], 'excluded'], ['updater', ['quit-and-install'], 'excluded']] as const) {
      try { ipc.send(channel, ...args) } catch (error) { expect((error as { reason: string }).reason, channel).toBe(reason); continue }
      throw new Error(`${channel} did not refuse`)
    }
  })

  it('lets the updater start and finds nothing, so the app mounts', () => {
    const { ipc } = setup()
    expect(() => ipc.send('updater', 'init')).not.toThrow()
  })

  it('answers the sends that have no second process to tell', () => {
    const { ipc } = setup()
    for (const channel of ['show-app', 'ready-to-show', 'set-background-color', 'setEnv', 'webview-dom-ready', 'never-heard-of-it']) {
      expect(() => ipc.send(channel, {})).not.toThrow()
    }
  })

  it('answers a path question with the root every Node-shaped path in a tab agrees on, never a host path', async () => {
    const { ipc } = setup()
    expect(await ipc.invoke('getPathUserData')).toBe('/orivon/app')
    expect(await ipc.invoke('getPathHome')).toBe('/orivon/app')
  })

  it('answers electron-store\'s synchronous question about where its file goes', () => {
    const { ipc } = setup()
    const sync = (ipc as unknown as { sendSync: (channel: string) => unknown }).sendSync
    expect(sync('electron-store-get-data')).toEqual({ defaultCwd: '/orivon/app', appVersion: '4.23.0' })
    expect(() => sync('nothing')).toThrow(/No handler registered/)
  })

  it('relaunch is a reload of the tab', () => {
    const { ipc, reload } = setup()
    ipc.send('app-relaunch')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('rejects an invoke nobody handles, as Electron does', async () => {
    const { ipc } = setup()
    expect((await errorOf(ipc.invoke('no-such-channel'))).message).toBe("No handler registered for 'no-such-channel'")
  })

  it('gives a deep link back to the listeners, the round trip upstream\'s main makes', async () => {
    const { ipc } = setup()
    const heard: string[] = []
    const once: string[] = []
    const listener = (_: unknown, url: string) => { heard.push(url) }
    ipc.on('deep-linking', listener)
    ipc.once('deep-linking', (_: unknown, url: string) => { once.push(url) })
    ipc.send('deep-linking', 'ledgerlive://a')
    ipc.send('deep-linking', 'ledgerlive://b')
    await Promise.resolve()
    await Promise.resolve()
    expect(heard).toEqual(['ledgerlive://a', 'ledgerlive://b'])
    expect(once).toEqual(['ledgerlive://a'])
    ipc.removeListener('deep-linking', listener)
    ipc.send('deep-linking', 'ledgerlive://c')
    await Promise.resolve()
    expect(heard).toHaveLength(2)
  })

  it('keeps the screen awake with a wake lock and hands back an id', async () => {
    const release = vi.fn(async () => {})
    const { ipc, loaded } = setup()
    ;(loaded.sandbox.navigator as unknown as Record<string, unknown>)['wakeLock'] = { request: async () => ({ release }) }
    const first = await ipc.invoke('activate-keep-screen-awake')
    const second = await ipc.invoke('activate-keep-screen-awake')
    expect(second).not.toBe(first)
    await ipc.invoke('deactivate-keep-screen-awake', first)
    expect(release).toHaveBeenCalledTimes(1)
    await ipc.invoke('deactivate-keep-screen-awake', 12345)
  })
})

describe('what the renderer imports from electron', () => {
  it('copies to the clipboard and answers a read with what was written', () => {
    const { electron, clipboardWrites } = setup()
    electron['clipboard'].writeText('0xabc')
    expect(clipboardWrites).toEqual(['0xabc'])
    expect(electron['clipboard'].readText()).toBe('0xabc')
  })

  it('opens an external link in a new tab, without an opener', async () => {
    const { electron, opened } = setup()
    await electron['shell'].openExternal('https://support.ledger.com')
    expect(opened).toEqual(['https://support.ledger.com'])
  })

  it('lets the zoom limits and the resource count be asked', () => {
    const { electron } = setup()
    expect(() => electron['webFrame'].setVisualZoomLevelLimits(1, 1)).not.toThrow()
    expect(electron['webFrame'].getResourceUsage()).toEqual({})
  })
})

describe('Live Apps', () => {
  it('installs the guest page half of upstream\'s webview preload as the embed script', () => {
    const { orivon } = setup()
    expect(orivon.web.setEmbedScript).toHaveBeenCalledTimes(1)
    const script = (orivon.web.setEmbedScript.mock.calls[0] as unknown as [string])[0]
    const sent: unknown[][] = []
    const guest: Record<string, any> = {}
    new Function('window', 'orivonEmbed', script)(guest, { sendToHost: (...args: unknown[]) => sent.push(args) })
    guest['ElectronWebview'].postMessage({ jsonrpc: '2.0' })
    expect(sent).toEqual([['webviewToParent', { jsonrpc: '2.0' }]])
  })

  it('still installs when the page has no web.embed grant', () => {
    expect(() => runBridge(source, { orivon: { fs: {} }, globals: { crypto: webcrypto, structuredClone, atob, btoa, Blob, location: {} } })).not.toThrow()
  })
})
