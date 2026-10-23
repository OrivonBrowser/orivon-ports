// What the free pinning relay accepts: one published DecentraWiki wiki, as the editor uploads it to a
// Kubo-compatible `/api/v0/add`. Pure, so the server and the tests share it. Anything else is refused
// with the status and words the editor shows: the relay pins wikis, not files.

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** The TiddlyWiki cores a published wiki may load, by file name, and the SHA-256 of their bytes. */
export const KNOWN_CORES = {
  'tiddlywikicore-5.4.1.js': 'c14181be79d004d8a5b5f21aac588f4aaac006a9e59dca3cd9ce1f27a5172923'
}

export const LIMITS = {
  /** The whole upload. Caddy refuses a larger body before the relay sees it. */
  bodyBytes: 12 * 1024 * 1024,
  pageBytes: 9 * 1024 * 1024,
  iconBytes: 256 * 1024
}

const STORE = '<script class="tiddlywiki-tiddler-store" type="application/json">'
const PLUGIN = '"$:/plugins/orivon/decentrawiki"'

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
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
    }
    const next = indexOf(body, encoder.encode(`\r\n--${boundary}`), headEnd + 4)
    if (next < 0) throw new Refusal(400, 'The upload is cut short.')
    parts.push({ headers, bytes: body.subarray(headEnd + 4, next) })
    if (parts.length > 16) throw new Refusal(400, 'A wiki has a page, its core and its icon, nothing more.')
    at = next + 2
  }
}

/** The filename a part carries, decoded as Kubo decodes it. @param {Record<string, string>} headers */
function filenameOf (headers) {
  const match = /;\s*filename="([^"]*)"/.exec(headers['content-disposition'] ?? '')
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
  const cores = [...files.keys()].filter((path) => path in KNOWN_CORES)
  for (const path of files.keys()) {
    if (path !== 'index.html' && path !== 'favicon.ico' && !cores.includes(path)) throw new Refusal(400, `${path} is not part of a DecentraWiki wiki, so this relay does not pin it.`)
  }
  const page = files.get('index.html')
  if (page === undefined) throw new Refusal(400, 'A wiki has an index.html.')
  if (page.length > LIMITS.pageBytes) throw new Refusal(413, 'This wiki is too large for free pinning. Pin it with your own node or service.')
  const icon = files.get('favicon.ico')
  if (icon !== undefined && icon.length > LIMITS.iconBytes) throw new Refusal(413, 'The wiki\'s icon is too large.')
  if (cores.length !== 1) throw new Refusal(400, 'A wiki loads one TiddlyWiki core this relay knows.')
  const core = /** @type {string} */ (cores[0])
  if (await sha256Hex(/** @type {Uint8Array} */ (files.get(core))) !== KNOWN_CORES[/** @type {keyof typeof KNOWN_CORES} */ (core)]) {
    throw new Refusal(400, `${core} is not the TiddlyWiki core it names.`)
  }
  const html = decoder.decode(page)
  if (!html.includes(STORE) || !html.includes(PLUGIN) || !html.includes(`<script src="${core}"`)) {
    throw new Refusal(400, 'This is not a page the DecentraWiki editor published.')
  }
  return { rootName, files: [...files].map(([path, bytes]) => ({ path, bytes })) }
}
