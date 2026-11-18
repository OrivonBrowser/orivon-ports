// What electron/preload.mjs gives the page: four window values, the two members of
// window.electron and the eleven of window.electronApi. All thirteen members are here; none is
// refused by name. The values are set as a side effect of appMembers, so they exist before the
// bundle's first line runs. The node they point at (the RPC server on RPC_PORT, the gateway on
// GATEWAY_URL) is not part of this file: node-start.js starts it, and answers the page's calls to
// the desktop's kubo API port from its own socket.
//
// This file is spliced into the composed bridge, so it is not a module: it declares
// `appMembers`, which the installer calls with the kit.

// compose.ts splices this file inside a function of its own, so a `return` is legal here: outside Orivon nothing below runs and no bridge is installed.
if (typeof window.orivon !== 'object' || window.orivon === null || typeof window.orivon.version !== 'number') return

const RPC_PORT = 9148
const GATEWAY_URL = 'http://localhost:6483'
// The page the Forge Turnstile widget runs in is served on this port by the page itself (webview-turnstile.js).
const TURNSTILE_PORT = 50229
// The link seedit draws to the node's web UI, byte for byte as it renders it: the desktop's kubo API port, where nothing listens here.
const NODE_WEBUI_HREF = 'http://localhost:50019/webui/'
const NODE_DASHBOARD_PATH = 'orivon/node/index.html'
const HTTP_ROUTERS = ['https://peers.pleb.bot', 'https://routing.lol', 'https://peers.forumindex.com', 'https://peers.plebpubsub.xyz']

// The key the RPC server wants on every connection. The desktop keeps it in a file beside
// the node's data; a page keeps it where only this origin reads it, and a later process that
// starts the node reads it from the same place.
const RPC_AUTH_KEY_STORAGE = 'orivon.pkcRpcAuthKey'
const RPC_AUTH_KEY_LENGTH = 40
const RPC_AUTH_KEY_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const RPC_AUTH_KEY_SHAPE = /^[0-9A-Za-z]{40}$/

const CATBOX_API_URL = 'https://catbox.moe/user/api.php'
const CATBOX_FILE_HOST = 'https://files.catbox.moe/'
const CATBOX_UPLOAD_TIMEOUT_MS = 300_000
const REACHABILITY_TIMEOUT_MS = 5000
const MAX_GENERATED_UPLOAD_BYTES = 20 * 1024 * 1024
const IPC_CHANNELS = ['get-notification-permission-status', 'get-platform', 'test-notification-permission', 'copy-to-clipboard']

function newRpcAuthKey () {
  // Rejection sampling: 248 is the largest multiple of 62 a byte reaches, so no character is likelier than another.
  let key = ''
  while (key.length < RPC_AUTH_KEY_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(RPC_AUTH_KEY_LENGTH))) {
      if (byte < 248 && key.length < RPC_AUTH_KEY_LENGTH) key += RPC_AUTH_KEY_ALPHABET[byte % 62]
    }
  }
  return key
}

/** The stored key, or a new one stored for the next load. Storage that throws leaves a key for this load only. */
function readRpcAuthKey () {
  try {
    const stored = localStorage.getItem(RPC_AUTH_KEY_STORAGE)
    if (typeof stored === 'string' && RPC_AUTH_KEY_SHAPE.test(stored)) return stored
  } catch {}
  const key = newRpcAuthKey()
  try { localStorage.setItem(RPC_AUTH_KEY_STORAGE, key) } catch {}
  return key
}

/** The four contextBridge.exposeInMainWorld values of the preload, with the key in the RPC URL: the page has no main process to hand it over through. */
function installDesktopValues () {
  const authKey = readRpcAuthKey()
  window.isElectron = true
  window.defaultPkcOptions = {
    pkcRpcClientsOptions: [`ws://localhost:${RPC_PORT}/${authKey}`],
    httpRoutersOptions: [...HTTP_ROUTERS]
  }
  window.defaultMediaIpfsGatewayUrl = GATEWAY_URL
  window.pkcRpcAuthKey = authKey
}

/**
 * The page registers a service worker at start (src/index.tsx, registerSW). The desktop never
 * has one, because a file: page cannot register it, and a worker here would keep serving the
 * files of one release after Orivon has installed the next, the bridge among them. So the page
 * is left without the API, which the registration and the app's own checks both test for, and a
 * worker an earlier load registered is removed.
 */
function withoutServiceWorker () {
  try {
    const container = navigator.serviceWorker
    if (container === undefined) return
    container.getRegistrations().then((all) => { for (const registration of all) registration.unregister() }, () => {})
    const owner = Object.prototype.hasOwnProperty.call(navigator, 'serviceWorker') ? navigator : Object.getPrototypeOf(navigator)
    delete owner.serviceWorker
  } catch {}
}

/**
 * The desktop sends this one link to the system browser (main.js, will-navigate and the window
 * open handler). Here it opens the node's dashboard, a page served with the app, in a new tab.
 * Capture phase and stopImmediatePropagation, because the page's own listeners must not also
 * navigate to a loopback address.
 */
function sendNodeLinkToDashboard () {
  const open = (event) => {
    if (event.button !== 0 && event.button !== 1) return
    const link = event.target?.closest?.('a[href]')
    if (link === null || link === undefined || link.getAttribute('href') !== NODE_WEBUI_HREF) return
    event.preventDefault()
    event.stopImmediatePropagation()
    window.open(new URL(NODE_DASHBOARD_PATH, document.baseURI).href, '_blank')
  }
  document.addEventListener('click', open, true)
  document.addEventListener('auxclick', open, true)
}

async function copyToClipboard (text) {
  try {
    await navigator.clipboard.writeText(text)
    return { success: true }
  } catch (error) {
    return { success: false, error: typeof error?.message === 'string' ? error.message : String(error) }
  }
}

/**
 * Node's names for the platform and architecture (process.platform, process.arch), read from the browser, as the desktop's main process answers them
 * (an object). seedit's notification settings put the answer in a sentence ("check your system's (linux) notification settings") as if it were the
 * name, so the object prints as the name: a refusal reads "(linux)", not "([object Object])". Its fields stay what main answers.
 */
async function getPlatform () {
  const hints = navigator.userAgentData
  const label = `${hints?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase()
  const platform = label.includes('win') ? 'win32' : label.includes('mac') ? 'darwin' : 'linux'
  let architecture = ''
  try { architecture = (await hints?.getHighEntropyValues?.(['architecture']))?.architecture ?? '' } catch {}
  const answer = { platform, arch: architecture === 'arm' ? 'arm64' : 'x64', version: '' }
  Object.defineProperty(answer, 'toString', { value: () => platform })
  return answer
}

/**
 * electron/node-reachability.js: AutoNAT's verdict, 'unknown' for anything but a clear one, as it is until the node answers, and within the
 * five seconds the desktop gives it. The node's handle answers (node-start.js made it): it asks the Worker, or the page API for a node another page
 * started. When that has no verdict in five seconds, the last verdict the handle saw stands, so a busy node does not read as 'unknown'.
 */
async function getNodeReachability () {
  let timer
  let handle = null
  const lastKnown = () => {
    const verdict = String(handle?.snapshot?.().reachability ?? 'unknown').toLowerCase()
    return verdict === 'public' || verdict === 'private' ? verdict : 'unknown'
  }
  try {
    const asked = (async () => {
      handle = (await window.orivonBitsocialNode?.ready) ?? null
      return handle === null ? 'unknown' : await handle.reachability()
    })()
    const late = new Promise((resolve) => { timer = setTimeout(() => { resolve(lastKnown()) }, REACHABILITY_TIMEOUT_MS) })
    const verdict = String(await Promise.race([asked, late])).toLowerCase()
    return verdict === 'public' || verdict === 'private' ? verdict : 'unknown'
  } catch {
    return lastKnown()
  } finally {
    clearTimeout(timer)
  }
}

// main's get-notification-permission-status answers 'granted' wherever the operating system has no
// switch of its own for the app, and on macOS 'granted', 'denied' or 'not-determined' (the system
// has not been asked yet). The page's Notification API has 'granted', 'denied' and 'default'
// (nobody asked), so 'default' is 'not-determined': the settings page keeps its switch off for it
// and does not claim notifications are on. Orivon reads a site nobody has answered for as 'denied',
// like a blocked one, and asks only when the page calls requestPermission(): so a state that is not
// granted is asked about at the person's click on the switch, and when a notification is first shown.
const hasNotifications = () => typeof Notification === 'function'

function pageNotificationStatus () {
  if (Notification.permission === 'granted') return 'granted'
  return Notification.permission === 'denied' ? 'denied' : 'not-determined'
}

// One question at a time: a second call while the person is answering waits for that answer.
let pendingPermission
function askForPermission () {
  pendingPermission ??= (async () => {
    try { await Notification.requestPermission() } catch {}
  })().finally(() => { pendingPermission = undefined })
  return pendingPermission
}

// The preferences' notification switch is the one place seedit asks for the status in answer to the person: a checkbox whose
// handler calls getNotificationStatus before it does anything else. A trusted change of a checkbox just before the call is that switch,
// and the question is theirs to answer there; the page's other reads of the status (when the preferences open) never ask.
const SWITCH_TOGGLE_MS = 1000
let switchToggledAt = -Infinity

function watchSwitchToggles () {
  document.addEventListener('change', (event) => {
    if (event.isTrusted && event.target?.type === 'checkbox') switchToggledAt = Date.now()
  }, true)
}

async function getNotificationStatus () {
  if (!hasNotifications()) return 'not-supported'
  if (Notification.permission !== 'granted' && Date.now() - switchToggledAt < SWITCH_TOGGLE_MS) await askForPermission()
  return pageNotificationStatus()
}

/** True when a notification may be shown now: asks first when it is not allowed yet. */
async function mayNotify () {
  if (!hasNotifications()) return false
  if (Notification.permission !== 'granted') await askForPermission()
  return Notification.permission === 'granted'
}

async function testNotification () {
  if (!hasNotifications()) return { success: false, reason: 'not-supported' }
  try {
    if (!(await mayNotify())) return { success: false, reason: 'denied' }
    new Notification('Seedit Test', { body: 'Testing if notifications are allowed.' })
    return { success: true }
  } catch {
    return { success: false, reason: 'error' }
  }
}

/**
 * What a click on a notification opens. The desktop passes the notification's url to
 * shell.openExternal, and seedit's own url is a route of the page (`/#/p/<community>/<post>`),
 * which that call rejects: the click does nothing there. The route is the intent, so a route of
 * this page is opened in this tab, which is brought to the front; an https address opens in a new tab, as the
 * desktop's own link handling allows, and anything else is ignored.
 */
function openNotificationUrl (url) {
  let target
  try { target = new URL(url, document.baseURI) } catch { return }
  window.focus()
  if (target.origin === window.location.origin && target.hash.startsWith('#/')) window.location.hash = target.hash
  else if (target.protocol === 'https:') window.open(target.href, '_blank', 'noopener,noreferrer')
}

async function showNotification (notification) {
  if (!hasNotifications()) { console.warn('Notifications are not supported on this system.'); return }
  if (!(await mayNotify())) return
  try {
    const shown = new Notification(notification.title, { body: notification.body })
    if (notification.url) shown.onclick = () => { openNotificationUrl(notification.url) }
  } catch (error) {
    console.warn('A notification could not be shown:', error)
  }
}

// The desktop's preload turns a File into a host path and rejects when there is none. A page
// has no paths and holds the File itself, so a File counts as on disk: every one can be read.
const isFile = (file) => typeof File === 'function' && file instanceof File

/** The same request the renderer makes for its own catbox uploads: the form catbox's API takes, and only a file URL on catbox's file host is taken for the answer, since it is written into a public post. */
async function uploadToCatbox (file) {
  const form = new FormData()
  form.append('reqtype', 'fileupload')
  form.append('fileToUpload', file)
  const response = await fetch(CATBOX_API_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(CATBOX_UPLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Upload failed: ${String(response.status)} ${response.statusText}`)
  const text = (await response.text()).trim()
  if (!text.startsWith(CATBOX_FILE_HOST)) throw new Error(`Upload failed: unexpected response ${JSON.stringify(text.slice(0, 100))}`)
  return { url: text, provider: 'catbox' }
}

/** The script that drives imgur's and imgbb's upload pages (webview-upload.js), loaded after this one. Read at the call, so it is there by then. */
function webviewUpload () {
  const uploader = window.orivonWebviewUpload
  if (uploader === undefined) throw new Error('The page that uploads to imgur and imgbb did not load')
  return uploader
}

/** The script that gets a Turnstile token in a <webview> (webview-turnstile.js), loaded after this one. Read at the call, so it is there by then. */
async function getForgeTurnstileToken (sitekey) {
  const turnstile = window.orivonForgeTurnstile
  if (turnstile === undefined) throw new Error('The page that gets a Turnstile token did not load')
  return turnstile.getToken(sitekey, { port: TURNSTILE_PORT })
}

/** catbox is an HTTP upload. imgur and imgbb have no API the desktop uses: it drives their upload pages in a hidden window, which here is a <webview> nobody sees. */
async function uploadFile (provider, file, stripMetadataFirst) {
  if (provider === 'catbox') return uploadToCatbox(file)
  const uploader = webviewUpload()
  return uploader.upload(provider, stripMetadataFirst ? await uploader.stripMetadata(file) : file)
}

const isUploadProvider = (provider) => provider === 'catbox' || provider === 'imgur' || provider === 'imgbb'

// On this route the desktop's main process strips the file's metadata before the upload page sees it, because the bytes of a path never pass through the renderer.
async function automateUploadMedia (options) {
  const { provider, file } = options ?? {}
  if (!isFile(file)) throw new Error('File path unavailable')
  if (!isUploadProvider(provider)) throw new Error('automate-upload-media requires { provider, filePath }')
  return uploadFile(provider, file, true)
}

/** The name main gives the temporary file the bytes are written to: the last path segment, no `..`, and any character outside letters, digits, `.`, `_` and `-` replaced. */
function generatedFileName (fileName) {
  const given = typeof fileName === 'string' && fileName !== '' ? fileName : 'upload'
  const name = (given.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '').replace(/\.\./g, '').replace(/[^a-zA-Z0-9._-]/g, '_').trim()
  return name !== '' && name.length <= 255 ? name : 'upload'
}

// The renderer strips the bytes it makes itself before it sends them, so they go up as they are.
async function automateUploadGeneratedMedia (options) {
  const { provider, fileName, mimeType, bytes } = options ?? {}
  if (!isUploadProvider(provider)) throw new Error('automate-upload-generated-media requires a provider')
  if (!Array.isArray(bytes) || bytes.length === 0) throw new Error('Generated upload bytes are required')
  if (bytes.length > MAX_GENERATED_UPLOAD_BYTES) throw new Error('Generated upload is too large')
  if (!bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error('Generated upload bytes are invalid')
  return uploadFile(provider, new File([Uint8Array.from(bytes)], generatedFileName(fileName), { type: mimeType || 'application/octet-stream' }), false)
}

/** window.electron.invoke: the preload's four channels, and a synchronous throw, not a rejection, for any other. */
function invoke (channel, ...args) {
  if (!IPC_CHANNELS.includes(channel)) throw new Error(`Unauthorized IPC channel: ${String(channel)}`)
  if (channel === 'get-notification-permission-status') return getNotificationStatus()
  if (channel === 'get-platform') return getPlatform()
  if (channel === 'test-notification-permission') return testNotification()
  return copyToClipboard(args[0])
}

function appMembers (kit) {
  installDesktopValues()
  withoutServiceWorker()
  sendNodeLinkToDashboard()
  watchSwitchToggles()

  kit.expose('RPC_AUTH_KEY_STORAGE', RPC_AUTH_KEY_STORAGE)
  kit.expose('NODE_DASHBOARD_PATH', NODE_DASHBOARD_PATH)

  return {
    electron: {
      invoke,
      sendNotification: (notification) => { void showNotification(notification) }
    },
    electronApi: {
      isElectron: true,
      getNotificationStatus,
      getPlatform,
      getNodeReachability,
      testNotification,
      showNotification: (notification) => { void showNotification(notification) },
      copyToClipboard,
      automateUploadMedia,
      isFileOnDisk: isFile,
      automateUploadGeneratedMedia,
      getForgeTurnstileToken
    }
  }
}
