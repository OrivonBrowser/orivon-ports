// `window.electron`: apps/desktop/src/preload.cts's channel forwarder, and
// every named ipcCall/seshat handler apps/desktop/src/*.ts answers, rebuilt
// with no Electron main process behind it. Element Desktop is byte-identical
// to the element-web build plus this object -- see ../README.md for what
// each answer stands in for, the pickle-key design note, and the table of
// every channel and call this file does and does not honour.
//
// Spliced into the composed bridge, so it is not a module: it declares
// `appMembers`, called with the kit (kit.BridgeError, kit.expose).

function appMembers (kit) {
  const { BridgeError } = kit

  // ---- preload.cts's allowlist, verbatim ----
  const CHANNELS = [
    'app_onAction', 'before-quit', 'check_updates', 'install_update', 'ipcCall', 'ipcReply',
    'loudNotification', 'preferences', 'seshat', 'seshatReply', 'setBadgeCount', 'update-downloaded',
    'userDownloadCompleted', 'userDownloadAction', 'openDesktopCapturerSourcePicker',
    'userAccessToken', 'homeserverUrl', 'serverSupportedVersions', 'showToast'
  ]

  // channel -> Set<listener>, mirroring ipcRenderer.on/send over a fixed
  // channel list. Listeners fire as (event, ...args), same as Electron's.
  const listenersByChannel = new Map()

  function on (channel, listener) {
    if (!CHANNELS.includes(channel)) { console.error(`Unknown IPC channel ${channel} ignored`); return }
    let set = listenersByChannel.get(channel)
    if (set === undefined) { set = new Set(); listenersByChannel.set(channel, set) }
    set.add(listener)
  }

  function emit (channel, ...args) {
    const set = listenersByChannel.get(channel)
    if (set === undefined) return
    const event = {}
    for (const listener of set) Promise.resolve().then(() => listener(event, ...args))
  }

  // A reply always goes out, and exactly once: apps/web/src/vector/platform/IPCManager.ts
  // keeps a pending-promise map with no timeout, so a call this bridge never
  // answers hangs the caller forever.
  function answer (replyChannel, id, fn) {
    Promise.resolve().then(async () => {
      try {
        const reply = await fn()
        emit(replyChannel, { id, reply })
      } catch (error) {
        emit(replyChannel, { id, error: { message: error instanceof Error ? error.message : String(error) } })
      }
    })
  }

  function refuseCall (name, reason, detail) {
    return () => { throw new BridgeError(name, reason, detail, 'electron') }
  }

  // ---- getAppVersion: VersionFilePlugin writes a plain "version" file next to index.html ----
  let versionPromise
  function getAppVersion () {
    if (versionPromise === undefined) {
      versionPromise = fetch('version')
        .then((response) => {
          if (!response.ok) throw new Error(`fetching version: HTTP ${response.status}`)
          return response.text()
        })
        .then((text) => text.trim())
    }
    return versionPromise
  }

  // ---- pickle key ----
  // apps/web/src/BasePlatform.ts and utils/tokens/pickling.ts, reproduced
  // exactly (same database, same AES-GCM parameters, same base64 encoding)
  // rather than routed through a real OS keyring, which Orivon has no
  // app-facing equivalent for -- see ../README.md's "Differs from Element
  // Desktop" section and the orivon-mvp hand-off it links. Matching the web
  // scheme, rather than inventing a different one, is what lets upstream's
  // own sw.js (registered in initialise, below) decrypt the access token it
  // reads out of the SAME database for authenticated media.
  function pickleAdditionalData (userId, deviceId) {
    const bytes = new Uint8Array(userId.length + deviceId.length + 1)
    for (let i = 0; i < userId.length; i++) bytes[i] = userId.charCodeAt(i)
    bytes[userId.length] = 124 // '|'
    for (let i = 0; i < deviceId.length; i++) bytes[userId.length + 1 + i] = deviceId.charCodeAt(i)
    return bytes
  }

  function openPickleDb () {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('matrix-react-sdk', 1)
      // Both stores, even though this file only ever touches "pickleKey":
      // Element's own code opens the same database expecting "account" to
      // exist too, and a second `open` never re-fires onupgradeneeded.
      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore('pickleKey')
        db.createObjectStore('account')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('opening matrix-react-sdk failed'))
    })
  }

  function idbGet (db, store, key) {
    return new Promise((resolve, reject) => {
      const req = db.transaction([store], 'readonly').objectStore(store).get(key)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error(`reading ${store} failed`))
    })
  }

  function idbPut (db, store, key, value) {
    return new Promise((resolve, reject) => {
      const req = db.transaction([store], 'readwrite').objectStore(store).put(value, key)
      req.onsuccess = () => resolve(undefined)
      req.onerror = () => reject(req.error ?? new Error(`writing ${store} failed`))
    })
  }

  function idbDrop (db, store, key) {
    return new Promise((resolve, reject) => {
      const req = db.transaction([store], 'readwrite').objectStore(store).delete(key)
      req.onsuccess = () => resolve(undefined)
      req.onerror = () => reject(req.error ?? new Error(`deleting from ${store} failed`))
    })
  }

  function base64Unpadded (bytes) {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/=+$/, '')
  }

  // BasePlatform.getPickleKey: null on ANY failure, never a thrown error --
  // the caller (ElectronPlatform) already wraps it in try/catch expecting
  // exactly that, and a rejection here would surface as a console error
  // instead of the "continuing without a pickle key" path upstream expects.
  async function getPickleKey (userId, deviceId) {
    try {
      const db = await openPickleDb()
      const record = await idbGet(db, 'pickleKey', [userId, deviceId])
      if (record === undefined || record.encrypted === undefined || record.iv === undefined || record.cryptoKey === undefined) return null
      const additionalData = pickleAdditionalData(userId, deviceId)
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData }, record.cryptoKey, record.encrypted)
      return base64Unpadded(new Uint8Array(decrypted))
    } catch {
      return null
    }
  }

  async function createPickleKey (userId, deviceId) {
    try {
      if (crypto?.subtle === undefined) return null
      const secret = new Uint8Array(32)
      crypto.getRandomValues(secret)
      const cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      const iv = new Uint8Array(32)
      crypto.getRandomValues(iv)
      const additionalData = pickleAdditionalData(userId, deviceId)
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, cryptoKey, secret)
      const db = await openPickleDb()
      await idbPut(db, 'pickleKey', [userId, deviceId], { encrypted, iv, cryptoKey })
      return base64Unpadded(secret)
    } catch {
      return null
    }
  }

  async function destroyPickleKey (userId, deviceId) {
    try {
      const db = await openPickleDb()
      await idbDrop(db, 'pickleKey', [userId, deviceId])
    } catch {
      // BasePlatform.destroyPickleKey swallows this too: there is nothing a
      // caller can do differently once the key is already unreadable.
    }
  }

  // ---- ipcCall: apps/desktop/src/ipc.ts, one entry per handled name ----
  const IPC_CALLS = {
    getAppVersion: () => getAppVersion(),
    getUpdateFeedUrl: async () => '', // empty feed URL -> ElectronPlatform.canSelfUpdate() is false
    setLanguage: async () => undefined, // menus are the browser's; nothing here reads a language
    focusWindow: async () => { window.focus() },
    navigateBack: async () => { history.back() },
    navigateForward: async () => { history.forward() },
    getSpellCheckEnabled: async () => false,
    getSpellCheckLanguages: async () => [],
    getAvailableSpellCheckLanguages: async () => [],
    setSpellCheckEnabled: refuseCall('setSpellCheckEnabled', 'shell-owned', 'spellcheck belongs to the browser, not the app'),
    setSpellCheckLanguages: refuseCall('setSpellCheckLanguages', 'shell-owned', 'spellcheck belongs to the browser, not the app'),
    // main's own answer when its capturer lookup finds nothing to offer, so
    // the legacy screen-share picker opens empty rather than throwing.
    getDesktopCapturerSources: async () => [],
    callDisplayMediaCallback: async () => null,
    clearStorage: async () => null, // Lifecycle clears its own IndexedDB state; nothing extra lives here
    breadcrumbs: async () => undefined, // macOS TouchBar; there is no TouchBar
    getPickleKey: async (userId, deviceId) => getPickleKey(userId, deviceId),
    createPickleKey: async (userId, deviceId) => createPickleKey(userId, deviceId),
    destroyPickleKey: async (userId, deviceId) => { await destroyPickleKey(userId, deviceId) }
  }

  // ---- seshat: apps/desktop/src/seshat.ts's answers for a build with no
  // Seshat installed (seshatSupported === false), reproduced so the client
  // behaves exactly as Element Desktop does without the native module --
  // Seshat itself is excluded (Rule 8: no native dependencies). Answering
  // these with a thrown refusal, rather than these constants, breaks every
  // fresh login: Lifecycle.clearStorage() awaits deleteEventIndex()
  // unconditionally whenever an event index manager exists, which it always
  // does under ElectronPlatform.
  const SESHAT_CALLS = {
    supportsEventIndexing: async () => false,
    isRoomIndexed: async () => false,
    addHistoricEvents: async () => false,
    addCrawlerCheckpoint: async () => false,
    removeCrawlerCheckpoint: async () => false,
    closeEventIndex: async () => undefined,
    deleteEventIndex: async () => undefined,
    addEventToIndex: async () => undefined,
    deleteEvent: async () => undefined,
    commitLiveEvents: async () => undefined,
    searchEventIndex: async () => undefined,
    setUserVersion: async () => undefined,
    isEventIndexEmpty: async () => true,
    getStats: async () => 0,
    getUserVersion: async () => 0,
    loadFileEvents: async () => [],
    loadCheckpoints: async () => [],
    initEventIndex: refuseCall('initEventIndex', 'excluded', 'Seshat is a native Rust module; search falls back to the server')
  }

  function dispatchNamed (calls, replyChannel, payload) {
    const { id, name, args } = payload
    answer(replyChannel, id, () => {
      const fn = calls[name]
      if (fn === undefined) throw new Error(`Unknown IPC Call: ${name}`)
      return fn(...(args ?? []))
    })
  }

  // apps/desktop/src/ipc.ts's own powerSaveBlocker: hold a screen wake lock
  // for the duration of a call, exactly mirroring its start/stop guard.
  let callWakeLock = null
  async function onCallState (state) {
    try {
      if (state === 'connected' && callWakeLock === null && navigator.wakeLock !== undefined) {
        callWakeLock = await navigator.wakeLock.request('screen')
      } else if (state === 'ended' && callWakeLock !== null) {
        const lock = callWakeLock
        callWakeLock = null
        await lock.release()
      }
    } catch {
      // No wake lock support, or the OS refused one: the call still works,
      // it just risks the screen sleeping mid-call, same as a laptop lid.
    }
  }

  function send (channel, ...args) {
    if (!CHANNELS.includes(channel)) { console.error(`Unknown IPC channel ${channel} ignored`); return }
    switch (channel) {
      case 'ipcCall': dispatchNamed(IPC_CALLS, 'ipcReply', args[0]); return
      case 'seshat': dispatchNamed(SESHAT_CALLS, 'seshatReply', args[0]); return
      case 'app_onAction':
        if (args[0]?.action === 'call_state') void onCallState(args[0].state)
        return
      case 'check_updates':
        // No self-update feed (getUpdateFeedUrl above): report none available.
        emit('check_updates', false)
        return
      default:
        // Recognised by the preload's own allowlist but nothing here acts on
        // it: setBadgeCount, loudNotification, install_update,
        // userDownloadAction and preferences are all shell chrome this port
        // does not build, and upstream's own "showToast" push is unreachable
        // even from a real Electron main process (../README.md notes why).
    }
  }

  // ---- initialise(): apps/desktop/src/preload.cts's getProtocol + getConfig
  // + getSupportedSettings, folded into one call, plus the two things a real
  // main process would otherwise do for the page: hand back media-auth
  // material through the app's own service worker instead of through
  // `session.webRequest`, and keep two tabs of one account from sharing a
  // crypto store the way Element's own multi-tab lock would (ElectronPlatform
  // turns that lock off, since Electron never had two windows on one profile). ----
  const CONFIG_DEFAULTS = { brand: 'Element', help_url: 'https://element.io/help', web_base_url: 'https://app.element.io/' }
  const SESSION_LOCK_NAME = 'orivon-element-session'

  function withConfigDefaults (config) {
    const filled = { ...config }
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
      if (filled[key] === undefined || filled[key] === '') filled[key] = CONFIG_DEFAULTS[key]
    }
    return filled
  }

  function waitForSessionLock () {
    if (navigator.locks === undefined) {
      return Promise.reject(new Error('navigator.locks is unavailable, so a second Element tab could corrupt the crypto store -- refusing to start'))
    }
    return new Promise((resolve, reject) => {
      let notice
      const timer = setTimeout(() => {
        notice = document.createElement('div')
        notice.textContent = 'Element is open in another tab. Waiting for it to close…'
        notice.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#fff;font:16px sans-serif;z-index:2147483647'
        document.body?.appendChild(notice)
      }, 1000)
      navigator.locks.request(SESSION_LOCK_NAME, { mode: 'exclusive' }, () => {
        clearTimeout(timer)
        notice?.remove()
        resolve()
        // Held until the tab itself goes away: the callback's own promise
        // only settles on unload, which is what keeps the lock exclusive
        // for the tab's whole lifetime rather than releasing it right away.
        return new Promise((release) => { window.addEventListener('pagehide', () => release(undefined), { once: true }) })
      }).catch(reject)
    })
  }

  async function registerMediaAuthServiceWorker () {
    if (navigator.serviceWorker === undefined) return
    try {
      await navigator.serviceWorker.register('sw.js')
    } catch {
      // Authenticated media (MSC3916 servers) will 401 without it; every
      // other feature still works, so this must not fail initialise().
    }
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type !== 'userinfo' || event.data?.responseKey === undefined) return
      event.source?.postMessage({
        responseKey: event.data.responseKey,
        userId: localStorage.getItem('mx_user_id'),
        deviceId: localStorage.getItem('mx_device_id'),
        homeserver: localStorage.getItem('mx_hs_url')
      })
    })
  }

  let initialisePromise
  function initialise () {
    if (initialisePromise === undefined) {
      initialisePromise = (async () => {
        await waitForSessionLock()
        await registerMediaAuthServiceWorker()
        const response = await fetch('orivon/element-config.json')
        if (!response.ok) throw new Error(`fetching orivon/element-config.json: HTTP ${response.status}`)
        const config = withConfigDefaults(JSON.parse(await response.text()))
        window.addEventListener('pagehide', () => { emit('before-quit') }, { once: true })
        return {
          protocol: location.protocol.replace(/:$/, ''),
          sessionId: crypto.randomUUID(),
          config,
          supportedSettings: {
            'Electron.autoLaunch': false,
            'Electron.warnBeforeExit': false,
            'Electron.alwaysShowMenuBar': false,
            'Electron.showTrayIcon': false,
            'Electron.enableHardwareAcceleration': false,
            'Electron.enableContentProtection': false
          },
          supportsBadgeOverlay: false
        }
      })()
    }
    return initialisePromise
  }

  kit.expose('pickling', { getPickleKey, createPickleKey, destroyPickleKey, pickleAdditionalData })
  return { on, send, initialise }
}
