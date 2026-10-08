// `window.api` (src/preloader/index.ts) and `window.ledgerElectron`, the object
// the build wrapper answers `import ... from "electron"` with. Together they
// stand in for Ledger Wallet's preload and for the ipcMain side of its main
// process (src/main/index.ts, setup.ts, db/), rebuilt over the page and
// orivon.fs. ../README.md has the table of every channel and why each is
// answered the way it is; this file is spliced into the composed bridge, so it
// is not a module: it declares `appMembers`, called with the kit.

function appMembers (kit) {
  const { BridgeError, getOrivon } = kit
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const clone = (value) => (value === undefined ? undefined : structuredClone(value))
  const refusal = (channel, reason, detail) => new BridgeError(channel, reason, detail, 'ledgerElectron')

  // ---- storage: src/main/db/index.ts, one JSON file per namespace ----
  // The file shape is upstream's, `{"data": {...}}`, and the three password
  // protected paths hold the same base64 blob upstream writes, so a locked
  // app.json stays locked and opens with the same password.
  const VIRTUAL_ROOT = '/orivon/app'
  const UPSTREAM_VERSION = '4.23.0'
  const DB_DIR = 'userData'
  const APP_KEYS = [
    'accounts', 'countervalues', 'postOnboarding', 'settings', 'trustchain', 'wallet', 'market', 'marketBanner',
    'largeScreenUpsellModal', 'payCard', 'knownDevices', 'cryptoAssets', 'identities', 'featureFlags',
    'coinConfigOverrides', 'discover', 'ptx', 'history', 'PLAYWRIGHT_RUN', 'user'
  ]
  const SETTABLE_APP_KEYS = new Set(APP_KEYS)
  const ENCRYPTED_PATHS = [['app', 'accounts'], ['app', 'trustchain'], ['app', 'wallet']]
  // What upstream encrypts for a path that holds nothing yet; evaluated from
  // upstream's own source at the pin (../UPSTREAM.md), never typed by hand.
  const ENCRYPTION_DEFAULTS = {
    accounts: [],
    trustchain: { trustchain: null, memberCredentials: null },
    wallet: {
      walletSyncState: { data: null, version: 0 },
      nonImportedAccountInfos: [],
      accountsData: { accountNames: [], starredAccountIds: [] },
      contacts: [{ id: 'contact-me', name: 'Me', addresses: [], isMe: true }],
      recentAddresses: {}
    }
  }
  let memory = {}
  let encryptionKeys = {}
  const loading = new Map()
  const timers = new Map()
  const fs = () => {
    const found = getOrivon()?.fs
    if (found === undefined) throw new BridgeError('storage', 'not-built', 'no fs grant', 'ledgerElectron')
    return found
  }
  const filePath = (ns) => {
    if (!/^[A-Za-z0-9_-]+$/.test(ns)) throw new Error(`invalid namespace "${String(ns)}"`)
    return `${DB_DIR}/${ns}.json`
  }

  // lodash get/set on a dotted path, which is how upstream addresses a key.
  function toPath (keyPath) {
    const parts = []
    String(keyPath).replace(/[^.[\]]+|\[(?:(-?\d+)|(["'])(.*?)\2)\]/g, (m, index, quote, quoted) => { parts.push(index ?? quoted ?? m) })
    return parts
  }
  function getPath (object, keyPath, fallback) {
    let value = object
    for (const part of toPath(keyPath)) {
      if (value === null || value === undefined) return fallback
      value = value[part]
    }
    return value === undefined ? fallback : value
  }
  function setPath (object, keyPath, value) {
    const parts = toPath(keyPath)
    let target = object
    parts.forEach((part, i) => {
      if (i === parts.length - 1) { target[part] = value; return }
      if (target[part] === null || typeof target[part] !== 'object') target[part] = /^\d+$/.test(parts[i + 1]) ? [] : {}
      target = target[part]
    })
  }
  const pick = (object, keys) => Object.fromEntries(keys.filter((key) => object?.[key] !== undefined).map((key) => [key, object[key]]))

  // ---- storage encryption: src/main/db/crypto.ts, aes-256-cbc over PBKDF2 ----
  // /!\ these presets are upstream's file format; changing them locks users out.
  const b64 = (bytes) => btoa(String.fromCharCode(...bytes))
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  async function deriveKey (password, iv) {
    // Upstream salts with `iv.toString()`: the IV's bytes read as UTF-8, invalid
    // sequences becoming U+FFFD, then written out as UTF-8 again.
    const salt = enc.encode(dec.decode(iv))
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: 10000 }, base, 256)
    return crypto.subtle.importKey('raw', bits, 'AES-CBC', false, ['encrypt', 'decrypt'])
  }
  async function encryptData (text, password) {
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, await deriveKey(password, iv), enc.encode(text)))
    return b64(Uint8Array.of(...iv, 0x3a, ...body))
  }
  async function decryptData (raw, password) {
    const data = unb64(raw)
    if (data[16] !== 0x3a) {
      // Pre-IV blobs came from Node's removed createDecipher (an MD5 key schedule).
      throw new Error('this data was encrypted by a Ledger Live release from before 2020 and cannot be opened here')
    }
    const iv = data.slice(0, 16)
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await deriveKey(password, iv), data.slice(17)))
  }
  function wrongPassword () {
    const error = new Error('DBWrongPassword')
    error.name = 'DBWrongPassword'
    return error
  }

  function ensureLoaded (ns) {
    if (memory[ns]) return Promise.resolve()
    if (!loading.has(ns)) loading.set(ns, load(ns).finally(() => loading.delete(ns)))
    return loading.get(ns)
  }
  async function load (ns) {
    let bytes
    try {
      bytes = await fs().readFile(filePath(ns))
    } catch (error) {
      if (error?.code !== 'notFound') throw error
      memory[ns] = {}
      await saveToDisk(ns)
      return
    }
    const data = JSON.parse(dec.decode(bytes)).data
    memory[ns] = ns === 'app' ? pick(data, APP_KEYS) : data ?? {}
  }
  async function saveToDisk (ns) {
    await ensureLoaded(ns)
    const copy = clone(ns === 'app' ? pick(memory[ns], APP_KEYS) : memory[ns])
    for (const [keyPath, password] of Object.entries(encryptionKeys[ns] ?? {})) {
      if (!password) continue
      const value = getPath(copy, keyPath)
      const payload = value ?? ENCRYPTION_DEFAULTS[keyPath]
      if (value === undefined || value === null) setPath(memory[ns], keyPath, payload)
      setPath(copy, keyPath, await encryptData(JSON.stringify(payload), password))
    }
    await fs().mkdir(DB_DIR, { recursive: true })
    await fs().writeFile(filePath(ns), enc.encode(JSON.stringify({ data: copy })))
  }
  // Upstream debounces by 500 ms; one timer per namespace here, so a write to
  // one never cancels the pending write of another.
  function save (ns) {
    return new Promise((resolve, reject) => {
      const pending = timers.get(ns)
      if (pending !== undefined) { clearTimeout(pending.timer); pending.waiters.push([resolve, reject]) }
      const waiters = pending?.waiters ?? [[resolve, reject]]
      const timer = setTimeout(() => {
        timers.delete(ns)
        saveToDisk(ns).then(() => waiters.forEach(([ok]) => ok()), (error) => waiters.forEach(([, fail]) => fail(error)))
      }, 500)
      timers.set(ns, { timer, waiters })
    })
  }
  function flushPending () {
    for (const [ns, { timer }] of timers) { clearTimeout(timer); timers.delete(ns); saveToDisk(ns).catch(() => {}) }
  }
  if (typeof window.addEventListener === 'function') window.addEventListener('pagehide', flushPending)

  function decryptInMemory (ns, keyPath, password) {
    const value = getPath(memory[ns], keyPath)
    if (typeof value !== 'string') return Promise.resolve()
    return decryptData(value, password).then((text) => {
      let decrypted = JSON.parse(text)
      if (decrypted?.data) decrypted = decrypted.data
      setPath(memory[ns], keyPath, decrypted)
    })
  }
  function ensureDefault (ns, keyPath) {
    if (getPath(memory[ns], keyPath) == null) setPath(memory[ns], keyPath, ENCRYPTION_DEFAULTS[keyPath])
  }
  const db = {
    async getKey ({ ns, keyPath, defaultValue }) {
      await ensureLoaded(ns)
      if (!keyPath) return clone(memory[ns] ?? defaultValue)
      return clone(getPath(memory[ns], keyPath, defaultValue))
    },
    async setKey ({ ns, keyPath, value }) {
      if (ns === 'app' && !SETTABLE_APP_KEYS.has(String(keyPath).split('.')[0])) {
        throw new Error(`[db] setKey("app", …): unknown key path "${String(keyPath)}"`)
      }
      await ensureLoaded(ns)
      setPath(memory[ns], keyPath, clone(value))
      return save(ns)
    },
    async setEncryptionKey ({ encryptionKey }) {
      for (const [ns, keyPath] of ENCRYPTED_PATHS) (encryptionKeys[ns] ??= {})[keyPath] = encryptionKey
      for (const [ns, keyPath] of ENCRYPTED_PATHS) {
        await ensureLoaded(ns)
        const value = getPath(memory[ns], keyPath, null)
        if (typeof value !== 'string' || value === '') { if (value == null) ensureDefault(ns, keyPath); continue }
        try { await decryptInMemory(ns, keyPath, encryptionKey) } catch { throw wrongPassword() }
      }
      await save('app')
    },
    async removeEncryptionKey () {
      for (const [ns, keyPath] of ENCRYPTED_PATHS) {
        await ensureLoaded(ns)
        const password = encryptionKeys[ns]?.[keyPath]
        if (password) await decryptInMemory(ns, keyPath, password)
        ensureDefault(ns, keyPath)
        delete encryptionKeys[ns]?.[keyPath]
      }
      await save('app')
    },
    async isEncryptionKeyCorrect ({ encryptionKey }) { return encryptionKeys.app?.accounts === encryptionKey },
    async hasEncryptionKey () { return !!encryptionKeys.app?.accounts },
    async hasBeenDecrypted () {
      const value = getPath(memory.app ?? (await ensureLoaded('app'), memory.app), 'accounts')
      if (typeof value !== 'string') return true
      try { JSON.parse(value); return true } catch { return false }
    },
    async cleanCache () { await db.setKey({ ns: 'app', keyPath: 'countervalues', value: null }); await save('app') },
    async resetAll () {
      memory.app = null
      encryptionKeys = {}
      try { await fs().rm(filePath('app')) } catch (error) { if (error?.code !== 'notFound') throw error }
    },
    async reload () { memory = {}; encryptionKeys = {} }
  }

  // ---- exports: the save dialog is the browser's download ----
  // Upstream's main shows a native save dialog, returns {canceled, filePath},
  // and the renderer hands that object straight back with the bytes
  // (export-operations, save-logs). The renderer only tests `filePath` for
  // truthiness, so it carries the file name and the bytes become a download.
  function download (name, type, parts) {
    const url = URL.createObjectURL(new Blob(parts, { type }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
  const fileName = (path) => String(path?.filePath ?? '').split(/[\\/]/).pop()
  const KEY_ORDER = ['logIndex', 'timestamp', 'pname', 'type', 'level', 'id', 'message', 'data', 'context']
  function orderedLogs (logs) {
    return JSON.stringify(logs, (_, value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
      const ordered = {}
      for (const key of KEY_ORDER) if (key in value) ordered[key] = value[key]
      for (const key of Object.keys(value)) if (!(key in ordered)) ordered[key] = value[key]
      return ordered
    }, 2)
  }
  const EXPORT_MAX_LOGS = 5000
  function mergedLogs (rendererLogs) {
    const logs = rendererLogs.map((log) => ({ ...log, pname: 'electron-renderer' })).slice(-EXPORT_MAX_LOGS).map((log, logIndex) => ({ ...log, logIndex }))
    if (rendererLogs.length > EXPORT_MAX_LOGS) {
      logs.unshift({ message: `Exporting logs: Only the last ${EXPORT_MAX_LOGS} logs are saved.`, logIndex: 0, type: 'exportLogsMeta', pname: 'electron-main', timestamp: new Date(0).toISOString() })
    }
    return logs
  }
  const awake = new Map()
  let nextAwakeId = 1

  // ---- ipcMain: one answer per channel; table and reasons in ../README.md ----
  const invokeChannels = {
    ...Object.fromEntries(Object.keys(db).map((name) => [name, (args) => db[name](args)])),
    'reloadRenderer': () => { location.reload() },
    'show-save-dialog': (options) => ({ canceled: false, filePath: String(options?.defaultPath ?? 'download') }),
    'export-operations': (path, csv) => {
      if (path?.canceled || !path?.filePath || !csv) return false
      download(fileName(path), 'text/csv', [csv])
      return true
    },
    'save-logs': (path, rendererLogsStr) => {
      if (path?.canceled || !path?.filePath) return
      let rendererLogs
      try { rendererLogs = JSON.parse(rendererLogsStr).reverse() } catch { return }
      download(fileName(path), 'text/plain', [orderedLogs(mergedLogs(rendererLogs))])
    },
    'save-png': (options, base64) => {
      if (!base64) return false
      download(String(options?.defaultPath ?? 'image.png').split(/[\\/]/).pop(), 'image/png', [unb64(base64)])
      return true
    },
    'activate-keep-screen-awake': async () => {
      const id = nextAwakeId++
      try { awake.set(id, await navigator.wakeLock.request('screen')) } catch { /* denied or unsupported: the id is still handed back */ }
      return id
    },
    'deactivate-keep-screen-awake': async (id) => { const held = awake.get(id); awake.delete(id); await held?.release() },
    'openUserDataDirectory': () => { throw refusal('openUserDataDirectory', 'shell-owned', 'a page is not given the host path of its data') },
    'getPathUserData': () => VIRTUAL_ROOT,
    'getPathHome': () => VIRTUAL_ROOT,
    'show-open-dialog': () => { throw refusal('show-open-dialog', 'not-built', 'returns host paths, which orivon.fs.userSelected never does') }
  }
  for (const name of ['open', 'exchange', 'close', 'listen', 'listen:unsubscribe']) {
    invokeChannels[`transport:${name}`] = () => { throw refusal(`transport:${name}`, 'not-built', 'devices are reached through WebHID in this port; these channels serve only Speculos and the HTTP proxy') }
  }
  const noop = () => {}
  // electron-store, which the renderer uses for a small obfuscated store, asks
  // the main process where to keep its file and which app version it belongs
  // to, synchronously. The answer is the root every Node-shaped path in an
  // Orivon tab agrees on, which orivon.fs maps onto the app's files.
  const syncChannels = {
    'electron-store-get-data': () => ({ defaultCwd: VIRTUAL_ROOT, appVersion: UPSTREAM_VERSION })
  }
  const sendChannels = {
    'show-app': noop,
    'ready-to-show': noop,
    'set-background-color': noop,
    'setEnv': noop,
    'webview-dom-ready': noop,
    'app-reload': () => { location.reload() },
    'app-relaunch': () => { location.reload() },
    'app-quit': () => { throw refusal('app-quit', 'shell-owned', 'a tab does not quit the browser') },
    'internalCrashTest': () => { throw refusal('internalCrashTest', 'excluded', 'crashes the Electron main process on purpose; there is none') },
    'deep-linking': (url) => emit('deep-linking', url),
    'updater': (type) => {
      if (type === 'quit-and-install') throw refusal('updater', 'excluded', 'Orivon installs its own updates and no update is ever offered here')
    }
  }

  // ---- ipcRenderer ----
  const listeners = new Map()
  const event = { senderId: null }
  function emit (channel, ...args) {
    for (const listener of [...(listeners.get(channel) ?? [])]) {
      Promise.resolve().then(() => { if (listeners.get(channel)?.has(listener)) listener(event, ...args) })
    }
  }
  const ipcRenderer = {
    invoke: async (channel, ...args) => {
      const handler = invokeChannels[channel]
      if (handler === undefined) throw new Error(`No handler registered for '${String(channel)}'`)
      return clone(await handler(...args))
    },
    send: (channel, ...args) => { sendChannels[channel]?.(...args) },
    sendSync: (channel, ...args) => {
      const handler = syncChannels[channel]
      if (handler === undefined) throw new Error(`No handler registered for '${String(channel)}'`)
      return clone(handler(...args))
    },
    on: (channel, listener) => { (listeners.get(channel) ?? listeners.set(channel, new Set()).get(channel)).add(listener); return ipcRenderer },
    once: (channel, listener) => {
      const wrapped = (...args) => { ipcRenderer.removeListener(channel, wrapped); listener(...args) }
      return ipcRenderer.on(channel, wrapped)
    },
    removeListener: (channel, listener) => { listeners.get(channel)?.delete(listener); return ipcRenderer },
    removeAllListeners: (channel) => { if (channel === undefined) listeners.clear(); else listeners.delete(channel); return ipcRenderer }
  }
  ipcRenderer.addListener = ipcRenderer.on
  ipcRenderer.off = ipcRenderer.removeListener

  // ---- the rest of what the renderer imports from 'electron' ----
  // readText answers what this page last wrote: the page cannot read the OS
  // clipboard synchronously, and the one caller only compares it with what it wrote.
  let lastWritten = ''
  const clipboard = {
    writeText: (text) => { lastWritten = String(text); navigator.clipboard?.writeText(lastWritten).catch(() => {}) },
    readText: () => lastWritten
  }
  const shell = {
    openExternal: async (url) => { window.open(String(url), '_blank', 'noopener,noreferrer') }
  }
  const webFrame = {
    getResourceUsage: () => ({}),
    setVisualZoomLevelLimits: noop
  }

  // ---- Live Apps: the guest page's half of upstream's webview preload ----
  // src/webviewPreloader/index.ts exposes ElectronWebview.postMessage to the
  // hosted page, which reaches the app's webview element as an ipc-message.
  const EMBED_SCRIPT = "window.ElectronWebview = { postMessage: function (message) { orivonEmbed.sendToHost('webviewToParent', message) } }"
  function installEmbedScript () {
    const web = getOrivon()?.web
    if (typeof web?.setEmbedScript === 'function') web.setEmbedScript(EMBED_SCRIPT).catch(() => {})
  }
  installEmbedScript()

  // ---- window.api: src/preloader/index.ts ----
  function appLoaded () {
    const root = document.getElementById('react-root')
    const loader = document.getElementById('loader-container')
    if (!root || !loader) return
    root.style.visibility = 'visible'
    loader.classList.add('fade-out')
    setTimeout(() => loader.remove(), 500)
  }
  // index.html declares `var parcelRequire` in an inline script (a bundler
  // workaround), which a tab's content policy refuses; the declaration is all it does.
  if (!('parcelRequire' in window)) window.parcelRequire = undefined

  // ---- the renderer gate ----
  // hooks.mjs takes the renderer's <script> out of index.html. Ledger's renderer
  // reads the global `process` while it loads, and Orivon installs that only in
  // an app tab, so without it the page would end on Ledger's own crash screen.
  // This script is parser-blocking and runs first, so writing the identical tag
  // here makes it a parser-inserted deferred script, as upstream's is. Without
  // `process` the page says what is missing instead. Only a document still
  // being parsed is touched: a write after that would replace the page.
  const RENDERER_TAG = '<script defer src="./renderer.bundle.js"></script>'
  const WAITING = 'Ledger Wallet is waiting for Orivon. Allow it when Orivon asks. If Orivon does not ask, update Orivon to the latest version, then reload.'
  function showWaiting () {
    const note = document.createElement('div')
    note.textContent = WAITING
    Object.assign(note.style, {
      position: 'fixed', inset: '0', zIndex: '10100', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px', boxSizing: 'border-box', textAlign: 'center', background: '#131214', color: '#fff',
      font: '16px/1.5 Inter, system-ui, sans-serif'
    })
    document.body.appendChild(note)
  }
  if (document.readyState === 'loading') {
    if (typeof process !== 'undefined') document.write(RENDERER_TAG)
    else if (document.body) showWaiting()
    else document.addEventListener('DOMContentLoaded', showWaiting, { once: true })
  }
  kit.expose('db', db)
  kit.expose('flushPending', flushPending)
  kit.expose('crypto', { encryptData, decryptData })

  return {
    api: { appDirname: '', appLoaded, reloadRenderer: () => ipcRenderer.invoke('reloadRenderer') },
    ledgerElectron: { ipcRenderer, clipboard, shell, webFrame }
  }
}
