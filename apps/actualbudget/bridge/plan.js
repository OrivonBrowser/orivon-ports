// The port's decisions, pure, so a test can drive each: where the backend's
// files live, what it is run with, how it reports a failure to start, and how
// a file name or a payload from the page becomes something the backend or a
// picked folder can use. backend-client.js does the fork and the files;
// esbuild.orivon.config.mjs uses the module-scope and install helpers.

/** The upstream release this bridge answers `Actual.ACTUAL_VERSION` for; the build compares it with the clone's `desktop-electron` package. */
export const ACTUAL_VERSION = '26.10.0'

/** Directories under the app's virtual root. The install tree is replaced by each build; the other three hold the person's data and the files handed to the backend. */
export const INSTALL_DIR = 'actual-install'
export const DATA_DIR = 'actual-data'
export const DOCUMENT_DIR = 'actual-documents'
export const IMPORT_DIR = 'actual-imports'

/** The file the backend's `rootPath` arithmetic expects its bundle to be named, two levels below the directory that holds `default-db.sqlite` and `migrations/`. */
export const BUNDLE_FILE = 'lib-dist/electron/bundle.desktop.js'

/** The name of the lock a page holds while it runs the backend: two backends on one budget would each hold the database open. */
export const BACKEND_LOCK = 'actualbudget-backend'

/** The message the backend sends when `initApp` has returned and its message listener is installed. */
export const READY_TYPE = 'orivon-ready'

/** Where the install tree for `stamp` is, relative to the virtual root. */
export function installDirFor (stamp) {
  return `${INSTALL_DIR}/${stamp}`
}

/** The directory a clone file reports as its own, and its file name; null for every file but the backend bundle. */
export function moduleLocation (file, bundleFile, installRoot) {
  if (file !== bundleFile) return null
  const filename = `${installRoot}/${BUNDLE_FILE}`
  return { dirname: filename.slice(0, filename.lastIndexOf('/')), filename }
}

/** The backend bundle with the names Node's CommonJS wrapper would give it, on its first line so a stack trace keeps its numbers. */
export function withModuleScope (contents, location) {
  if (location === null) return contents
  return `const __dirname = ${JSON.stringify(location.dirname)}, __filename = ${JSON.stringify(location.filename)}; ${contents}`
}

/** The environment the backend is forked with: the two directories upstream's Electron main sets, both inside the app's files. */
export function backendEnv (root) {
  return {
    ACTUAL_DATA_DIR: `${root}/${DATA_DIR}`,
    ACTUAL_DOCUMENT_DIR: `${root}/${DOCUMENT_DIR}`,
    NODE_ENV: 'production'
  }
}

/** The arguments Electron's main passes the backend: `--subprocess <version>`. */
export function backendArgs () {
  return ['--subprocess', ACTUAL_VERSION]
}

/** The directories the page makes before the backend starts: it creates `<documents>/Actual` itself, one level at a time. */
export function backendDirs () {
  return [DATA_DIR, DOCUMENT_DIR, IMPORT_DIR]
}

/**
 * What the renderer is told when the backend cannot start, in the shape
 * upstream's own `server.ts` reports (`app-init-failure`), so the renderer's
 * fatal-error screen handles it as it handles the desktop app's.
 */
export function failurePayload (error) {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  if (error !== null && typeof error === 'object' && error.type === 'DocumentDirError' && 'path' in error) {
    return { type: 'app-init-failure', DocumentDirFailure: true, path: String(error.path), code: error.code ? String(error.code) : undefined, message, stack }
  }
  return { type: 'app-init-failure', BackendInitFailure: true, message, stack }
}

/** The failure for a backend that ended without being asked to, as upstream's main reports it. */
export function exitFailure (code) {
  return { type: 'app-init-failure', BackendInitFailure: true, message: `The backend process exited unexpectedly (exit code ${String(code)})` }
}

/** The failure for a second page of the app: one backend at a time may hold the budget. */
export function busyFailure () {
  return { type: 'app-init-failure', BackendInitFailure: true, message: 'Actual Budget is already open in another tab of this app. Close that tab, then restart this one.' }
}

/** Whether a failed call to the app's files means the page does not hold the `fs` grant: it runs as an ordinary website, as on a first visit before the person answers. */
export function isDenial (error) {
  return error !== null && typeof error === 'object' && (error.code === 'denied' || /not granted to this origin|denied by capability grant/i.test(String(error.message)))
}

/** The failure for a page that holds no `fs` grant, so the renderer's fatal-error screen says why instead of a path error. */
export function deniedFailure () {
  return { type: 'app-init-failure', BackendInitFailure: true, message: 'This page has not been allowed to keep files on this device, which Actual Budget needs. Allow it from the key icon in the address bar (Review permissions), then reload.' }
}

/** A file name from the page or a picked file, made safe to use as one path segment: no separators, no leading dots, a bounded length, the extension kept. */
export function safeFileName (name, fallback = 'file') {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[^\p{L}\p{N}._ ()-]/gu, '_').replace(/^\.+/, '').trim()
  if (cleaned === '') return fallback
  if (cleaned.length <= 120) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : ''
  return `${cleaned.slice(0, 120 - extension.length)}${extension}`
}

/** The path under the app's files a picked file is copied to, and the absolute path the backend is told. Each pick has a directory of its own, so two files with one name never meet. */
export function importTarget (root, id, name) {
  const file = safeFileName(name, 'import')
  return { relative: `${IMPORT_DIR}/${id}/${file}`, absolute: `${root}/${IMPORT_DIR}/${id}/${file}`, directory: `${IMPORT_DIR}/${id}` }
}

/** The bytes of what `Actual.saveFile` is given: text, bytes, or a Buffer that crossed as JSON. */
export function bytesOf (contents) {
  if (typeof contents === 'string') return new TextEncoder().encode(contents)
  if (contents instanceof Uint8Array) return contents
  if (contents instanceof ArrayBuffer) return new Uint8Array(contents)
  if (ArrayBuffer.isView(contents)) return new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength)
  if (contents !== null && typeof contents === 'object' && contents.type === 'Buffer' && Array.isArray(contents.data)) return Uint8Array.from(contents.data)
  throw new TypeError('saveFile needs text or bytes')
}

/** Whether a picker failure means the page had no recent click or key press, which a fresh click on the page's own button fixes. */
export function needsActivation (error) {
  return error !== null && typeof error === 'object' && error.code === 'denied'
}

/** `install.json` as fetched, checked: a stamp, a list of relative file names none of which climbs out, and each file's size in the pack beside it. */
export function parseInstall (text) {
  const value = JSON.parse(text)
  if (typeof value?.stamp !== 'string' || !/^[0-9a-f]{8,64}$/.test(value.stamp) || !Array.isArray(value.files) || value.files.length === 0) {
    throw new Error('install.json has no stamp or no files')
  }
  for (const file of value.files) {
    if (typeof file !== 'string' || file === '' || file.startsWith('/') || file.split('/').includes('..')) {
      throw new Error(`install.json names a file outside the install tree: ${String(file)}`)
    }
  }
  if (!Array.isArray(value.sizes) || value.sizes.length !== value.files.length || !value.sizes.every((size) => Number.isInteger(size) && size >= 0)) {
    throw new Error('install.json has no size for each of its files')
  }
  return { stamp: value.stamp, files: value.files, sizes: value.sizes }
}

/** Whether the install tree must be written: none was, or it is another build's. */
export function installNeeded (served, stored) {
  return stored === null || stored.stamp !== served.stamp
}

/** Where each file of `install` lies in the pack: `{ name, offset, size }` in the order of `install.files`. */
export function layout (install) {
  let offset = 0
  return install.files.map((name, index) => {
    const entry = { name, offset, size: install.sizes[index] }
    offset += entry.size
    return entry
  })
}

/** Why a pack of `length` bytes is not the one `install` describes, or null. */
export function packProblem (install, length) {
  const expected = install.sizes.reduce((sum, size) => sum + size, 0)
  return expected === length ? null : `install/pack.bin is ${String(length)} bytes, but install.json describes ${String(expected)}: the app's files are from two different builds`
}

/** How many install files are written in flight at once, and the broker calls a second and the burst the page allows itself (the broker's own limit per origin is a 200-call bucket refilled at 100 a second). */
export const INSTALL_LANES = 8
export const WRITES_PER_SECOND = 80
export const WRITES_BURST = 100

/** Runs `work(item)` over `items`, at most `limit` at a time; the first failure stops handing out items and rejects. */
export async function forEachLimited (items, limit, work) {
  let next = 0
  let failed = false
  const lane = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]
      try {
        await work(item)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}

/** A function to await before each broker call: it resolves at once while the burst is not spent, then after the time that keeps `perSecond` a second (the burst counts calls made close together). `now` and `sleep` are the clock, so a test can drive it. */
export function createPacer (perSecond, burst = 1, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const gap = 1000 / perSecond
  let due = 0
  return async () => {
    const at = now()
    due = Math.max(due, at) + gap
    const wait = due - burst * gap - at
    if (wait > 0) await sleep(wait)
  }
}

/** The directory of `file` relative to the tree, '' at the top. */
export function parentOf (file) {
  return file.split('/').slice(0, -1).join('/')
}

/** The entries of the install parent directory that are not the current tree. */
export function staleInstalls (names, stamp) {
  return names.filter((name) => name !== stamp)
}
