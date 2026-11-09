// `window.api` and `window.lld`: Ledger Wallet's preload (src/preloader/), which
// exposes the typed bridge of src/bridge/contract.ts (v7, bootstrap v2), with the
// ipcMain side it talks to (src/main/) rebuilt over the page and orivon.fs. The
// README has the table of every member and why each is answered the way it is;
// this file is spliced into the composed bridge, so it is not a module: it
// declares `appMembers`, called with the kit.

function appMembers (kit) {
  const { BridgeError, getOrivon } = kit
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const noop = () => {}
  const clone = (value) => (value === undefined ? undefined : structuredClone(value))
  const refusal = (member, reason, detail) => new BridgeError(member, reason, detail, 'lld')
  const fs = () => getOrivon()?.fs ?? (() => { throw new BridgeError('storage', 'not-built', 'no fs grant', 'lld') })()
  const deepFreeze = (value) => { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze) } return value }

  // ---- storage: src/main/db/index.ts, userData/app.json ----
  // The file shape is upstream's, `{"data": {...}}`, and the three password
  // protected paths hold the same base64 blob upstream writes, so a locked
  // app.json stays locked and opens with the same password.
  const VIRTUAL_ROOT = '/orivon/app'
  const APP_FILE = 'userData/app.json'
  const APP_KEYS = [
    'accounts', 'countervalues', 'postOnboarding', 'settings', 'trustchain', 'wallet', 'market', 'marketBanner',
    'largeScreenUpsellModal', 'payCard', 'knownDevices', 'cryptoAssets', 'identities', 'featureFlags',
    'coinConfigOverrides', 'discover', 'ptx', 'history', 'PLAYWRIGHT_RUN'
  ]
  // A legacy key is kept until its replacement is written.
  const LEGACY_KEYS = { user: 'identities' }
  const TOP_KEYS = [...APP_KEYS, ...Object.keys(LEGACY_KEYS)]
  const ENCRYPTED_PATHS = ['accounts', 'trustchain', 'wallet']
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
  let memory = null
  let keys = {}
  let loading = null
  const pick = (object, names) => Object.fromEntries(names.filter((name) => object?.[name] !== undefined).map((name) => [name, object[name]]))

  // lodash get/set on a dotted path, which is how upstream addresses a key.
  const toPath = (keyPath) => [...String(keyPath).matchAll(/[^.[\]]+|\[(?:(-?\d+)|(["'])(.*?)\2)\]/g)].map((m) => m[1] ?? m[3] ?? m[0])
  function getPath (object, keyPath, fallback) {
    let value = object
    for (const part of toPath(keyPath)) {
      if (value === null || value === undefined) return fallback
      value = value[part]
    }
    return value === undefined ? fallback : value
  }
  function setSegments (object, parts, value) {
    let target = object
    parts.forEach((part, i) => {
      if (i === parts.length - 1) { target[part] = value; return }
      if (target[part] === null || typeof target[part] !== 'object') target[part] = /^\d+$/.test(parts[i + 1]) ? [] : {}
      target = target[part]
    })
  }
  const setPath = (object, keyPath, value) => setSegments(object, toPath(keyPath), value)

  // ---- encryption: src/main/db/crypto.ts, aes-256-cbc over PBKDF2 ----
  // /!\ these presets are upstream's file format; changing them locks users out.
  // In slices: a spread of a whole blob overflows the call stack once accounts are large.
  const b64 = (bytes) => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text) }
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  async function deriveKey (password, iv) {
    // Upstream salts with `iv.toString()`: the IV's bytes read as UTF-8, invalid
    // sequences becoming U+FFFD, then written out as UTF-8 again.
    const salt = enc.encode(dec.decode(iv))
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: 10000 }, base, 256)
    return crypto.subtle.importKey('raw', bits, 'AES-CBC', false, ['encrypt', 'decrypt'])
  }
  async function encryptBytes (text, password) {
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, await deriveKey(password, iv), enc.encode(text)))
    const out = new Uint8Array(17 + body.length)
    out.set(iv)
    out[16] = 0x3a
    out.set(body, 17)
    return out
  }
  async function decryptBytes (data, password) {
    if (data[16] !== 0x3a) {
      // Pre-IV blobs came from Node's removed createDecipher (an MD5 key schedule).
      throw new Error('this data was encrypted by a Ledger Live release from before 2020 and cannot be opened here')
    }
    const iv = data.slice(0, 16)
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await deriveKey(password, iv), data.slice(17)))
  }
  const encryptData = async (text, password) => b64(await encryptBytes(text, password))
  const decryptData = (raw, password) => decryptBytes(unb64(raw), password)
  function wrongPassword () {
    const error = new Error('DBWrongPassword')
    error.name = 'DBWrongPassword'
    return error
  }

  async function persist () {
    const payload = pick(memory, APP_KEYS)
    for (const [legacy, replacedBy] of Object.entries(LEGACY_KEYS)) {
      if (payload[replacedBy] === undefined && memory[legacy] !== undefined) payload[legacy] = memory[legacy]
    }
    const copy = clone(payload)
    for (const keyPath of ENCRYPTED_PATHS) {
      if (!keys[keyPath]) continue
      const value = getPath(copy, keyPath)
      const plain = value ?? ENCRYPTION_DEFAULTS[keyPath]
      if (value === undefined || value === null) setPath(memory, keyPath, plain)
      setPath(copy, keyPath, await encryptData(JSON.stringify(plain), keys[keyPath]))
    }
    await fs().mkdir('userData', { recursive: true })
    await fs().writeFile(APP_FILE, enc.encode(JSON.stringify({ data: copy })))
  }
  async function load () {
    let bytes
    try {
      bytes = await fs().readFile(APP_FILE)
    } catch (error) {
      if (error?.code !== 'notFound') throw error
      memory = {}
      await persist()
      return
    }
    memory = pick(JSON.parse(dec.decode(bytes)).data, TOP_KEYS)
  }
  function ensureLoaded () {
    if (memory) return Promise.resolve()
    return (loading ??= load().finally(() => { loading = null }))
  }

  // Upstream debounces by 500 ms; a page that goes away flushes what is pending.
  let pending
  let waiters = []
  function writeNow () {
    clearTimeout(pending)
    pending = undefined
    const settled = waiters
    waiters = []
    return persist().then(() => settled.forEach(([ok]) => ok()), (error) => settled.forEach(([, fail]) => fail(error)))
  }
  function save () {
    return new Promise((resolve, reject) => {
      waiters.push([resolve, reject])
      clearTimeout(pending)
      pending = setTimeout(writeNow, 500)
    })
  }
  function flushPending () { if (pending !== undefined) writeNow().catch(noop) }

  async function decryptPath (encrypted, password) {
    const decrypted = JSON.parse(await decryptData(encrypted, password))
    return decrypted?.data ? decrypted.data : decrypted
  }
  const ensureDefault = (keyPath) => { if (getPath(memory, keyPath) == null) setPath(memory, keyPath, ENCRYPTION_DEFAULTS[keyPath]) }
  const hasKey = () => !!keys.accounts
  const keyIsCorrect = (key) => typeof keys.accounts === 'string' && keys.accounts !== '' && keys.accounts === key
  // The db stays decrypted after an auto-lock: replacing or removing the held
  // key without it would change the password without knowing it.
  function assertHeldKey (current) {
    if (!hasKey()) return false
    if (!keyIsCorrect(current)) throw wrongPassword()
    return true
  }

  // src/main/db/keyAttemptThrottle.ts: five free tries, then 1 s doubling to 30 s, one at a time.
  let failures = 0
  let lastAttempt = Promise.resolve()
  function throttled (attempt, outcome) {
    const run = lastAttempt.catch(noop).then(async () => {
      const wait = failures < 5 ? 0 : Math.min(1000 * 2 ** (failures - 5), 30000)
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
      try {
        const result = await attempt()
        const checked = outcome(result)
        if (checked === 'correct') failures = 0
        else if (checked === 'wrong') failures += 1
        return result
      } catch (error) { failures += 1; throw error }
    })
    lastAttempt = run
    return run
  }
  const checkedOutcome = (checked) => (checked ? 'correct' : 'unchecked')
  const onlyApp = (ns) => { if (ns !== 'app') throw new Error(`Database namespace not allowed from the renderer: ${String(ns)}`) }

  const db = {
    async getKey (ns, keyPath, defaultValue) {
      onlyApp(ns)
      await ensureLoaded()
      return clone(keyPath ? getPath(memory, keyPath, defaultValue) : memory ?? defaultValue)
    },
    async setKey (ns, keyPath, value) {
      onlyApp(ns)
      const top = String(keyPath).split('.')[0]
      if (!TOP_KEYS.includes(top)) throw new Error(`[db] setKey("app", …): unknown key path "${String(keyPath)}" (top-level "${top}")`)
      await ensureLoaded()
      setPath(memory, keyPath, clone(value))
      return save()
    },
    hasEncryptionKey: async () => hasKey(),
    setEncryptionKey: (encryptionKey, currentEncryptionKey) => throttled(async () => {
      if (typeof encryptionKey !== 'string' || !encryptionKey) throw wrongPassword()
      const replacesHeldKey = assertHeldKey(currentEncryptionKey)
      await ensureLoaded()
      const decrypted = []
      for (const keyPath of ENCRYPTED_PATHS) {
        const value = getPath(memory, keyPath, null)
        if (typeof value !== 'string') continue
        try { decrypted.push([keyPath, await decryptPath(value, encryptionKey)]) } catch { throw wrongPassword() }
      }
      // Nothing changes until every path decrypts: a partial unlock would leave
      // plaintext that the next save writes out unencrypted.
      for (const keyPath of ENCRYPTED_PATHS) keys[keyPath] = encryptionKey
      for (const [keyPath, value] of decrypted) setPath(memory, keyPath, value)
      for (const keyPath of ENCRYPTED_PATHS) ensureDefault(keyPath)
      await save()
      return replacesHeldKey || decrypted.length > 0
    }, checkedOutcome).then(noop),
    removeEncryptionKey: (currentEncryptionKey) => throttled(async () => {
      const removesHeldKey = assertHeldKey(currentEncryptionKey)
      await ensureLoaded()
      for (const keyPath of ENCRYPTED_PATHS) {
        const value = getPath(memory, keyPath)
        if (keys[keyPath] && typeof value === 'string') setPath(memory, keyPath, await decryptPath(value, keys[keyPath]))
        ensureDefault(keyPath)
        delete keys[keyPath]
      }
      await save()
      return removesHeldKey
    }, checkedOutcome).then(noop),
    isEncryptionKeyCorrect: (encryptionKey) => throttled(() => keyIsCorrect(encryptionKey), (correct) => (correct ? 'correct' : 'wrong')),
    async hasBeenDecrypted () {
      await ensureLoaded()
      const value = getPath(memory, 'accounts')
      if (typeof value !== 'string') return true
      try { JSON.parse(value); return true } catch { return false }
    },
    async cleanCache () { await db.setKey('app', 'countervalues', null); await save() },
    async resetAll () {
      memory = null
      keys = {}
      try { await fs().rm(APP_FILE) } catch (error) { if (error?.code !== 'notFound') throw error }
    },
    async reload () { memory = null; keys = {} }
  }

  // ---- bootstrap and store: src/main/bootstrap.ts ----
  // The renderer reads both while its bundle loads. `store` is electron-store's
  // `lld.json` (the same obfuscation as the db, a fixed password), read before
  // the renderer script is added to the page.
  const STORE_FILE = 'lld.json'
  const STORE_PASSWORD = 'this_only_obfuscates'
  let storeData = {}
  let storeTimer
  const bootstrap = {
    version: 2,
    env: {},
    // Linux on every host, as process.platform is in an Orivon tab: the app draws
    // its own title bar and window buttons for darwin and win32.
    os: { type: 'Linux', release: (/Chrome\/([\d.]+)/.exec(globalThis.navigator?.userAgent ?? '') ?? [])[1] ?? '', platform: 'linux', hostname: globalThis.location?.hostname ?? '' },
    paths: { userData: VIRTUAL_ROOT, home: VIRTUAL_ROOT },
    distributionChannel: 'direct',
    store: {}
  }
  async function readStore () {
    try { return JSON.parse(await decryptBytes(await fs().readFile(STORE_FILE), STORE_PASSWORD)) } catch { return {} }
  }
  async function writeStore () {
    storeTimer = undefined
    await fs().writeFile(STORE_FILE, await encryptBytes(JSON.stringify(storeData), STORE_PASSWORD))
  }
  function flushStore () { if (storeTimer !== undefined) { clearTimeout(storeTimer); writeStore().catch(noop) } }
  function scheduleStore () { clearTimeout(storeTimer); storeTimer = setTimeout(() => { writeStore().catch(noop) }, 300) }
  // electron-store's dot-prop paths: `\.` is a literal dot, as src/renderer/store.ts reads them.
  function storeSegments (key) {
    const parts = String(key).split('.')
    const segments = []
    for (let i = 0; i < parts.length;) {
      let segment = parts[i++]
      while (segment.endsWith('\\') && i < parts.length) segment = `${segment.slice(0, -1)}.${parts[i++]}`
      segments.push(segment)
    }
    return segments.some((segment) => ['__proto__', 'prototype', 'constructor'].includes(segment)) ? [] : segments
  }
  const store = {
    set (key, value) {
      const segments = storeSegments(key)
      if (segments.length === 0) return
      storeData = clone(storeData)
      setSegments(storeData, segments, clone(value))
      scheduleStore()
    },
    clear () { storeData = {}; scheduleStore() }
  }
  if (typeof window.addEventListener === 'function') window.addEventListener('pagehide', () => { flushPending(); flushStore() })

  // ---- files: the save dialog is the browser's download ----
  // Upstream's main shows a native save dialog and writes the file itself; the
  // renderer only learns whether it was saved, so the bytes become a download.
  function download (options, type, parts) {
    const url = URL.createObjectURL(new Blob(parts, { type }))
    const link = document.createElement('a')
    link.href = url
    link.download = String(options?.defaultPath ?? 'download').split(/[\\/]/).pop()
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
    return 'saved'
  }
  const LOG_ORDER = ['logIndex', 'timestamp', 'pname', 'type', 'level', 'id', 'message', 'data', 'context']
  const orderedLogs = (logs) => JSON.stringify(logs, (_, value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries([...LOG_ORDER.filter((key) => key in value), ...Object.keys(value).filter((key) => !LOG_ORDER.includes(key))].map((key) => [key, value[key]]))
  }, 2)
  const EXPORT_MAX_LOGS = 5000
  function mergedLogs (rendererLogs) {
    const logs = rendererLogs.map((log) => ({ ...log, pname: 'electron-renderer' })).slice(-EXPORT_MAX_LOGS).map((log, logIndex) => ({ ...log, logIndex }))
    if (rendererLogs.length > EXPORT_MAX_LOGS) {
      logs.unshift({ message: `Exporting logs: Only the last ${EXPORT_MAX_LOGS} logs are saved.`, logIndex: 0, type: 'exportLogsMeta', pname: 'electron-main', timestamp: new Date(0).toISOString() })
    }
    return logs
  }
  const files = {
    async saveLogs (request, logsJson) {
      let rendererLogs
      try { rendererLogs = JSON.parse(logsJson).reverse() } catch { return 'failed' }
      return download(request?.options, 'text/plain', [orderedLogs(mergedLogs(rendererLogs))])
    },
    async exportOperations (request, csv) { return csv ? download(request?.options, 'text/csv', [csv]) : 'failed' },
    async savePng (options, base64) { return base64 ? download(options, 'image/png', [unb64(base64)]) : 'failed' },
    openUserDataDirectory: () => Promise.reject(refusal('files.openUserDataDirectory', 'shell-owned', 'a page is not given the host path of its data'))
  }

  // ---- the rest of the bridge ----
  const subscribers = (set) => (callback) => { set.add(callback); return () => { set.delete(callback) } }
  const awake = new Map()
  let nextAwakeId = 1
  const power = {
    async keepScreenAwake () {
      const id = nextAwakeId++
      try { awake.set(id, await navigator.wakeLock.request('screen')) } catch { /* denied or unsupported: the id is still handed back */ }
      return id
    },
    async release (id) { const held = awake.get(id); awake.delete(id); await held?.release() }
  }
  const deepLinks = new Set()
  const deeplink = {
    // Upstream's main hands a deep link the renderer raised back to the renderer.
    open: (url) => { for (const listener of [...deepLinks]) Promise.resolve().then(() => { if (deepLinks.has(listener)) listener(url) }) },
    onOpen: subscribers(deepLinks)
  }
  // There is no updater to tell and nothing to hear from: finding nothing keeps the app mounted.
  const updater = {
    init: noop,
    quitAndInstall: () => { throw refusal('updater.quitAndInstall', 'excluded', 'Orivon installs its own updates and no update is ever offered here') },
    onStatus: subscribers(new Set())
  }
  const app = {
    reload: () => { location.reload() },
    relaunch: () => { location.reload() },
    quit: () => { throw refusal('app.quit', 'shell-owned', 'a tab does not quit the browser') },
    show: noop
  }
  // src/renderer/clipboard.ts warns only on `false`; a read the browser has not already allowed is `null`, never a prompt.
  async function clipboardMatchesText (expected) {
    try {
      if ((await navigator.permissions.query({ name: 'clipboard-read' })).state !== 'granted') return null
      return (await navigator.clipboard.readText()) === expected
    } catch { return null }
  }
  // src/renderer/linking.ts checks the scheme first; this is main's own check again.
  const SAFE_SCHEMES = ['http:', 'https:', 'ledgerlive:', 'ledgerwallet:', 'mailto:']
  const shell = {
    openExternal (url) {
      let scheme
      try { scheme = new URL(url).protocol } catch { return }
      if (SAFE_SCHEMES.includes(scheme)) window.open(String(url), '_blank', 'noopener,noreferrer')
    }
  }
  const system = { clipboardMatchesText, setVisualZoomLevelLimits: noop, getResourceUsage: () => undefined }
  const ZCASH = 'the Zcash engine is a native addon the desktop app runs in a process of its own'
  const zcash = { invoke: (channel) => Promise.reject(refusal(`zcash.invoke("${String(channel)}")`, 'not-built', ZCASH)), subscribe: () => noop }
  const cardSession = { takeBootstrap: () => Promise.resolve(null) }

  // ---- Live Apps: src/main/webviewHandlers.ts ----
  // The guest page half of upstream's webview preload is the embed script: it
  // hands a message to the <webview> element as an `ipc-message`. Upstream's main
  // answers only the guest's main frame on an origin of the manifest's domains
  // (carried by the element's `webpreferences`), so this does too, failing closed.
  const EMBED_SCRIPT = "window.ElectronWebview = { postMessage: function (message) { orivonEmbed.sendToHost('webviewToParent', message) } }"
  const web = getOrivon()?.web
  if (typeof web?.setEmbedScript === 'function') web.setEmbedScript(EMBED_SCRIPT).catch(noop)
  // src/bridge/webviewAllowedOrigins.ts
  function allowedOrigins (preferences) {
    const value = String(preferences ?? '').split(',').map((part) => part.split('=')).find(([name]) => name === 'ledgerLiveAllowedOrigins')?.[1]
    if (value === 'unrestricted') return value
    try {
      const parsed = JSON.parse(decodeURIComponent(value))
      return Array.isArray(parsed) && parsed.every((origin) => typeof origin === 'string') ? parsed : undefined
    } catch { return undefined }
  }
  // @ledgerhq/live-common wallet-api/manifestDomainUtils.ts isUrlAllowedByManifestDomains
  function domainAllows (origin, domains) {
    const { protocol, host } = new URL(origin)
    return domains.some((pattern) => {
      const text = String(pattern ?? '').trim()
      if (text === '') return false
      if (text === origin || text === `${protocol}//` || text === `${protocol}//*`) return true
      return text.startsWith(`${protocol}//*.`) && host.endsWith(`.${text.slice(protocol.length + 4)}`)
    })
  }
  // wallet-api/bridgeSession.ts isBridgeSenderAllowed, for a main frame
  function senderAllowed (url, domains) {
    let origin
    try { const parsed = new URL(url); origin = parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : undefined } catch { return false }
    if (origin === undefined || domains === undefined) return false
    return domains === 'unrestricted' || domainAllows(origin, domains)
  }
  const messageListeners = new Set()
  if (typeof document.addEventListener === 'function') {
    // `ipc-message` does not bubble, but the capture phase passes every ancestor.
    document.addEventListener('ipc-message', (event) => {
      const element = event.target
      if (element?.localName !== 'webview' || !['webviewToParent', 'dappToParent'].includes(event.channel)) return
      let guestId, origin
      try { guestId = element.getWebContentsId(); origin = new URL(element.getURL()).origin } catch { return }
      if (!senderAllowed(origin, allowedOrigins(element.getAttribute('webpreferences')))) {
        console.warn('Dropped a Live App bridge message from a disallowed frame', { origin })
        return
      }
      for (const listener of [...messageListeners]) listener({ guestId, origin, channel: event.channel, message: event.args?.[0] })
    }, true)
  }
  const webview = { onDomainCheckViolation: subscribers(new Set()), onMessage: subscribers(messageListeners) }

  // ---- window.api: src/preloader/index.ts ----
  function appLoaded () {
    const [root, loader] = ['react-root', 'loader-container'].map((id) => document.getElementById(id))
    if (!root || !loader) return
    root.style.visibility = 'visible'
    loader.classList.add('fade-out')
    setTimeout(() => loader.remove(), 500)
  }
  // index.html declares `var parcelRequire` in an inline script (a bundler
  // workaround), which a tab's content policy refuses; the declaration is all it does.
  if (!('parcelRequire' in window)) window.parcelRequire = undefined

  // ---- the renderer gate ----
  // hooks.mjs takes the renderer's <script> out of index.html. The renderer needs
  // the grants an app tab has (storage, the device), which Orivon gives after the
  // person allows the app, and only then defines `process`. This script, which
  // runs first, adds the renderer once the store is read; before that it says
  // what is missing, and the page still parses to `DOMContentLoaded` with the
  // `orivon-manifest` link, which is how Orivon discovers the app and asks.
  const WAITING = 'Ledger Wallet is waiting for Orivon. Allow it when Orivon asks. If Orivon does not ask, update Orivon to the latest version, then reload.'
  function showWaiting () {
    const note = document.createElement('div')
    note.textContent = WAITING
    note.style.cssText = 'position:fixed;inset:0;z-index:10100;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center;background:#131214;color:#fff;font:16px/1.5 Inter,system-ui,sans-serif'
    document.body.appendChild(note)
  }
  function addRenderer () {
    const script = document.createElement('script')
    script.src = './renderer.bundle.js'
    ;(document.body ?? document.documentElement).appendChild(script)
  }
  const ready = typeof process === 'undefined'
    ? Promise.resolve(false)
    : readStore().then((data) => { storeData = data; bootstrap.store = clone(data); deepFreeze(bootstrap); return true })
  ready.then((appTab) => {
    if (appTab) addRenderer()
    else if (document.body) showWaiting()
    else document.addEventListener('DOMContentLoaded', showWaiting, { once: true })
  })
  kit.expose('db', db)
  kit.expose('flushPending', flushPending)
  kit.expose('crypto', { encryptData, decryptData })
  kit.expose('ready', ready)

  return {
    api: { appDirname: '', appLoaded, reloadRenderer: () => { location.reload(); return Promise.resolve() } },
    lld: { version: 7, bootstrap, db, updater, deeplink, webview, app, files, power, store, shell, system, zcash, cardSession }
  }
}
