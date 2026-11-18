// What electron/preload.mjs gives the page: four window values and the nine members of
// window.electronApi. Eight members are here; the one refused by name is declared in
// ./members.json. The values are set as a side effect of appMembers, so they exist before
// the bundle's first line runs. The node they point at (the RPC server on RPC_PORT, the
// gateway on GATEWAY_URL, the API behind KUBO_API_URL) is not part of this file.
//
// This file is spliced into the composed bridge, so it is not a module: it declares
// `appMembers`, which the installer calls with the kit.

// compose.ts splices this file inside a function of its own, so a `return` is legal here: outside Orivon nothing below runs and no bridge is installed.
if (typeof window.orivon !== 'object' || window.orivon === null || typeof window.orivon.version !== 'number') return

const RPC_PORT = 9138
const KUBO_API_URL = 'http://127.0.0.1:50019/api/v0'
const GATEWAY_URL = 'http://localhost:6473'
// The page the Forge Turnstile widget runs in is served on this port by the page itself (webview-turnstile.js).
const TURNSTILE_PORT = 50219
// The link the page draws to the node's web UI, byte for byte as 5chan renders it.
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
const REACHABILITY_TIMEOUT_MS = 5000
const MAX_GENERATED_UPLOAD_BYTES = 20 * 1024 * 1024
const FILE_TOKENS_KEPT = 256

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
 * The page registers a service worker on every load (registerSW.js, a plain script). The desktop
 * never has one, because a file: page cannot register it, and a worker here would keep serving
 * the files of one release after Orivon has installed the next, the bridge among them. So the
 * page is left without the API, which the generated registration and the app's own checks both
 * test for, and a worker an earlier load registered is removed.
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
 * Read only by the updater, which picks a desktop installer out of a GitHub release's assets by
 * platform and architecture (app-update.ts, findMatchingElectronAsset). No installer is named
 * `orivon`, so the check ends with nothing newer: this build is replaced by a republish.
 */
async function getPlatform () {
  return { platform: 'orivon', arch: 'orivon', version: '' }
}

/** electron/node-reachability.js: a POST to the node's AutoNAT route, and 'unknown' for anything but a clear verdict, as it is until the node answers. */
async function getNodeReachability () {
  try {
    const response = await fetch(`${KUBO_API_URL}/swarm/addrs/autonat`, { method: 'POST', signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS) })
    if (!response.ok) return 'unknown'
    const reachability = (await response.json())?.reachability
    const verdict = typeof reachability === 'string' ? reachability.toLowerCase() : ''
    return verdict === 'public' || verdict === 'private' ? verdict : 'unknown'
  } catch {
    return 'unknown'
  }
}

// A page cannot give a File a host path, and the renderer only passes the string it gets back on
// to automateUploadMedia, so the string is a token for the File held here.
const filesByToken = new Map()
let lastFileToken = 0

function getPathForFile (file) {
  if (typeof File !== 'function' || !(file instanceof File)) return null
  const token = `orivon-file:${String(++lastFileToken)}`
  filesByToken.set(token, file)
  if (filesByToken.size > FILE_TOKENS_KEPT) filesByToken.delete(filesByToken.keys().next().value)
  return token
}

/** The same request the renderer makes for its own catbox uploads: the form catbox's API takes, the URL in the answer. */
async function uploadToCatbox (file) {
  const form = new FormData()
  form.append('reqtype', 'fileupload')
  form.append('fileToUpload', file)
  const response = await fetch(CATBOX_API_URL, { method: 'POST', body: form })
  if (!response.ok) throw new Error(`Upload failed: ${String(response.status)} ${response.statusText}`)
  return { url: (await response.text()).trim(), provider: 'catbox' }
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
  if (provider === 'imgur' || provider === 'imgbb') {
    const uploader = webviewUpload()
    return uploader.upload(provider, stripMetadataFirst ? await uploader.stripMetadata(file) : file)
  }
  throw new Error(`No automation recipe for provider: ${String(provider)}`)
}

// On this route the desktop's main process strips the file's metadata before the upload page sees it, because the bytes never pass through the renderer.
async function automateUploadMedia (options) {
  const { provider, filePath } = options ?? {}
  if (!provider || typeof filePath !== 'string') throw new Error('automate-upload-media requires { provider, filePath }')
  const file = filesByToken.get(filePath)
  if (file === undefined) throw new Error(`File path unavailable: ${filePath}`)
  return uploadFile(provider, file, true)
}

// The renderer strips the bytes it makes itself before it sends them, so they go up as they are.
async function automateUploadGeneratedMedia (options) {
  const { provider, fileName, mimeType, bytes } = options ?? {}
  if (!provider) throw new Error('automate-upload-generated-media requires a provider')
  if (!Array.isArray(bytes) || bytes.length === 0) throw new Error('Generated upload bytes are required')
  if (bytes.length > MAX_GENERATED_UPLOAD_BYTES) throw new Error('Generated upload is too large')
  if (!bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error('Generated upload bytes are invalid')
  const name = typeof fileName === 'string' && fileName !== '' ? fileName : 'tegaki.png'
  return uploadFile(provider, new File([Uint8Array.from(bytes)], name, { type: mimeType || 'application/octet-stream' }), false)
}

function appMembers (kit) {
  installDesktopValues()
  withoutServiceWorker()
  sendNodeLinkToDashboard()

  kit.expose('RPC_AUTH_KEY_STORAGE', RPC_AUTH_KEY_STORAGE)
  kit.expose('NODE_DASHBOARD_PATH', NODE_DASHBOARD_PATH)

  return {
    isElectron: true,
    copyToClipboard,
    getPlatform,
    getNodeReachability,
    getPathForFile,
    automateUploadMedia,
    automateUploadGeneratedMedia,
    getForgeTurnstileToken
  }
}
