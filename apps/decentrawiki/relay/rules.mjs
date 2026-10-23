// What the free pinning relay accepts: one published DecentraWiki wiki, as the editor uploads it to a
// Kubo-compatible `/api/v0/add`. Pure, so the server and the tests share it. Anything else is refused
// with the status and words the editor shows: the relay pins wikis, not files. What it forwards is
// rebuilt from the checked files (canonicalUpload), never the bytes it was sent, so the pinning
// service cannot read a body differently from how it was checked.

import { buildMultipart } from '../page/src/publish/multipart.js'

const decoder = new TextDecoder()
const strict = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

/** The TiddlyWiki cores a published wiki may load, by file name, and the SHA-256 of their bytes. */
export const KNOWN_CORES = {
  'tiddlywikicore-5.4.1.js': 'c14181be79d004d8a5b5f21aac588f4aaac006a9e59dca3cd9ce1f27a5172923'
}

/** The same cores' file CIDs (`ipfs add --cid-version=1`), so a wiki read from a node is checked before its core is fetched. */
export const CORE_CIDS = {
  'tiddlywikicore-5.4.1.js': 'bafybeidor3a6ixkqcyibt7f3xpfhavx42acmbhl2gvszdd5zxjwlg7acw4'
}

/** The names a published wiki's folder may hold. */
export const ALLOWED_NAMES = new Set(['index.html', 'favicon.ico', ...Object.keys(KNOWN_CORES)])

export const LIMITS = {
  /** The whole upload. Caddy refuses a larger body before the relay sees it. */
  bodyBytes: 12 * 1024 * 1024,
  pageBytes: 9 * 1024 * 1024,
  iconBytes: 256 * 1024
}

const STORE = '<script class="tiddlywiki-tiddler-store" type="application/json">'
const PLUGIN = '"$:/plugins/orivon/decentrawiki"'

/** The first bytes of the icon formats the editor publishes as favicon.ico. */
const ICON_MAGIC = [[0, 0, 1, 0], [0x89, 0x50, 0x4e, 0x47], [0x47, 0x49, 0x46, 0x38], [0xff, 0xd8, 0xff], [0x52, 0x49, 0x46, 0x46]]

export class Refusal extends Error {
  /** @param {number} status @param {string} message */
  constructor (status, message) {
    super(message)
    this.name = 'Refusal'
    this.status = status
  }
}

/** @param {Uint8Array} haystack @param {Uint8Array} needle @param {number} from */
function indexOf (haystack, needle, from) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** The boundary a multipart Content-Type names, or null. @param {string | undefined} contentType */
export function boundaryOf (contentType) {
  const match = /^multipart\/form-data;\s*boundary=("?)([A-Za-z0-9'()+_,./:=?-]{1,70})\1\s*$/i.exec(contentType ?? '')
  return match === null ? null : match[2] ?? null
}

/**
 * The parts of a multipart body: each one's headers, lower-cased, and its bytes.
 * @param {Uint8Array} body @param {string} boundary
 * @returns {{ headers: Record<string, string>, bytes: Uint8Array }[]}
 */
export function parseMultipart (body, boundary) {
  const delimiter = encoder.encode(`--${boundary}`)
  const parts = []
  let at = indexOf(body, delimiter, 0)
  if (at !== 0) throw new Refusal(400, 'The upload is not a form this relay reads.')
  for (;;) {
    at += delimiter.length
    if (body[at] === 0x2d && body[at + 1] === 0x2d) return parts
    if (body[at] !== 0x0d || body[at + 1] !== 0x0a) throw new Refusal(400, 'The upload is not a form this relay reads.')
    const headEnd = indexOf(body, encoder.encode('\r\n\r\n'), at + 2)
    if (headEnd < 0) throw new Refusal(400, 'The upload is cut short.')
    /** @type {Record<string, string>} */
    const headers = {}
    for (const line of decoder.decode(body.subarray(at + 2, headEnd)).split('\r\n')) {
      const colon = line.indexOf(':')
      // A folded line, a line with no name and a header sent twice are each read differently by
      // different parsers; none comes from the editor.
      if (colon <= 0 || /^[ \t]/.test(line)) throw new Refusal(400, 'The upload is not a form this relay reads.')
      const name = line.slice(0, colon).trim().toLowerCase()
      if (name in headers) throw new Refusal(400, 'The upload is not a form this relay reads.')
      headers[name] = line.slice(colon + 1).trim()
    }
    const next = indexOf(body, encoder.encode(`\r\n--${boundary}`), headEnd + 4)
    if (next < 0) throw new Refusal(400, 'The upload is cut short.')
    parts.push({ headers, bytes: body.subarray(headEnd + 4, next) })
    if (parts.length > 16) throw new Refusal(400, 'A wiki has a page, its core and its icon, nothing more.')
    at = next + 2
  }
}

/** The filename a part carries. @param {Record<string, string>} headers */
function filenameOf (headers) {
  const match = /^form-data; name="file"; filename="([^"]*)"$/.exec(headers['content-disposition'] ?? '')
  if (match === null) return null
  try {
    return decodeURIComponent((match[1] ?? '').replace(/%22/g, '"'))
  } catch {
    return null
  }
}

/** @param {Uint8Array} bytes */
async function sha256Hex (bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Checks an upload is one published DecentraWiki wiki: a folder holding its `index.html`, a
 * TiddlyWiki core this relay knows byte for byte, and at most a `favicon.ico`.
 * @param {{ headers: Record<string, string>, bytes: Uint8Array }[]} parts
 * @returns {Promise<{ rootName: string, files: { path: string, bytes: Uint8Array }[] }>}
 */
export async function checkUpload (parts) {
  const directories = parts.filter((part) => (part.headers['content-type'] ?? '') === 'application/x-directory')
  if (directories.length !== 1) throw new Refusal(400, 'A wiki is one folder of files.')
  if (parts.some((part) => part !== directories[0] && part.headers['content-type'] !== 'application/octet-stream')) {
    throw new Refusal(400, 'A wiki is one folder of files.')
  }
  const rootName = filenameOf(directories[0]?.headers ?? {})
  if (rootName === null || !/^[A-Za-z0-9._-]{1,64}$/.test(rootName)) throw new Refusal(400, 'The wiki\'s folder has no usable name.')
  /** @type {Map<string, Uint8Array>} */
  const files = new Map()
  for (const part of parts) {
    if (part === directories[0]) continue
    const name = filenameOf(part.headers)
    if (name === null || !name.startsWith(`${rootName}/`)) throw new Refusal(400, 'Every file of a wiki is in its folder.')
    const path = name.slice(rootName.length + 1)
    if (files.has(path)) throw new Refusal(400, `${path} is sent twice.`)
    files.set(path, part.bytes)
  }
  return { rootName, files: await checkFiles(files) }
}

/**
 * Checks the files of one published wiki, however they arrived: its `index.html`, a TiddlyWiki core
 * this relay knows byte for byte, and at most a `favicon.ico` that is an image.
 * @param {Map<string, Uint8Array>} files
 * @returns {Promise<{ path: string, bytes: Uint8Array }[]>}
 */
export async function checkFiles (files) {
  const cores = [...files.keys()].filter((path) => path in KNOWN_CORES)
  for (const path of files.keys()) {
    if (!ALLOWED_NAMES.has(path)) throw new Refusal(400, `${path} is not part of a DecentraWiki wiki, so this relay does not pin it.`)
  }
  const page = files.get('index.html')
  if (page === undefined) throw new Refusal(400, 'A wiki has an index.html.')
  if (page.length > LIMITS.pageBytes) throw new Refusal(413, 'This wiki is too large for free pinning. Pin it with your own node or service.')
  const icon = files.get('favicon.ico')
  if (icon !== undefined && icon.length > LIMITS.iconBytes) throw new Refusal(413, 'The wiki\'s icon is too large.')
  if (icon !== undefined && !ICON_MAGIC.some((magic) => magic.every((byte, i) => icon[i] === byte))) {
    throw new Refusal(400, 'The wiki\'s icon is not an image.')
  }
  if (cores.length !== 1) throw new Refusal(400, 'A wiki loads one TiddlyWiki core this relay knows.')
  const core = /** @type {string} */ (cores[0])
  if (await sha256Hex(/** @type {Uint8Array} */ (files.get(core))) !== KNOWN_CORES[/** @type {keyof typeof KNOWN_CORES} */ (core)]) {
    throw new Refusal(400, `${core} is not the TiddlyWiki core it names.`)
  }
  let html
  try {
    html = strict.decode(page)
  } catch {
    throw new Refusal(400, 'This is not a page the DecentraWiki editor published.')
  }
  const scripts = html.match(/<script\b/gi) ?? []
  if (!/^\s*<!doctype html>/i.test(html) || html.includes('\u0000') || !html.includes(PLUGIN) ||
      html.split(STORE).length !== 2 || html.split(`<script src="${core}"`).length !== 2 || scripts.length !== 2) {
    // A wiki whose page carries scripts of its own (TiddlyWiki's raw markup) is published, but not here.
    throw new Refusal(400, 'This is not a page the DecentraWiki editor published, or it carries scripts of its own in the page. Publish it with your own node or a pinning service.')
  }
  return [...files].map(([path, bytes]) => ({ path, bytes }))
}

/**
 * The upload the relay forwards: the checked files, in the form the editor itself sends.
 * @param {string} rootName @param {{ path: string, bytes: Uint8Array }[]} files
 */
export function canonicalUpload (rootName, files) {
  const empty = new Uint8Array(0)
  return buildMultipart([
    { name: 'file', filename: encodeURIComponent(rootName), contentType: 'application/x-directory', bytes: empty },
    ...files.map((file) => ({ name: 'file', filename: encodeURIComponent(`${rootName}/${file.path}`), contentType: 'application/octet-stream', bytes: file.bytes }))
  ])
}
