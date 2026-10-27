// The HTTP server that shows a decrypted website inside Share, in Orivon. The page listens on a loopback port
// (`orivon.net.listen`, 5210 to 5213), and each site is served at `http://<label>.localhost:<port>/`, where the label
// is derived from the share's address with a secret that is kept in this browser: stable, so a site keeps its own
// storage from one opening to the next, and not guessable by another program on the computer. A request whose
// `Host` is not the label of a site being shown is answered 404. GET and HEAD only, one range at most, and every
// answer ends the connection.

import { base32Encode } from '../ipfs/cid.js'

export const PORTS = [5210, 5211, 5212, 5213]
const MAX_HEADER_BYTES = 16 * 1024
const MAX_HEADERS = 100
const HEADER_WAIT_MS = 10_000
const MAX_CONNECTIONS = 32
const CHUNK_BYTES = 64 * 1024

const MIME = /** @type {Record<string, string>} */ ({
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', xhtml: 'application/xhtml+xml; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  pdf: 'application/pdf', wasm: 'application/wasm', zip: 'application/zip'
})

/** The content type for a file name, by its extension. @param {string} path */
export function mimeTypeOf (path) {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return path.includes('.') ? MIME[extension] ?? 'application/octet-stream' : 'application/octet-stream'
}

/**
 * `Range: bytes=...` for a file of `size` bytes: one range as `[start, end]` (end included), `null` for no range or
 * one that is not understood (the whole file is sent), or `'unsatisfiable'`.
 * @param {string | undefined} header @param {number} size
 * @returns {[number, number] | null | 'unsatisfiable'}
 */
export function parseRange (header, size) {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const [, first = '', last = ''] = match
  if (first === '' && last === '') return null
  if (first === '') {
    const suffix = Number(last)
    if (suffix === 0) return 'unsatisfiable'
    return size === 0 ? 'unsatisfiable' : [Math.max(size - suffix, 0), size - 1]
  }
  const start = Number(first)
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (start >= size || end < start) return 'unsatisfiable'
  return [start, end]
}

/**
 * The request line and headers of text that ends with a blank line.
 * @param {string} head
 * @returns {{ method: string, target: string, headers: Map<string, string> } | null}
 */
export function parseRequest (head) {
  const lines = head.split('\r\n')
  const line = /^([A-Z]{3,10}) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? '')
  if (line === null) return null
  /** @type {Map<string, string>} */
  const headers = new Map()
  for (const text of lines.slice(1)) {
    if (text === '') break
    const colon = text.indexOf(':')
    if (colon <= 0 || headers.size >= MAX_HEADERS) return null
    headers.set(text.slice(0, colon).trim().toLowerCase(), text.slice(colon + 1).trim())
  }
  return { method: /** @type {string} */ (line[1]), target: /** @type {string} */ (line[2]), headers }
}

/** The files a request path names: decoded, with no way out of the site. Null when it is not a path to serve. @param {string} target @returns {{ path: string, directory: boolean } | null} */
export function pathOf (target) {
  const raw = target.split('#')[0]?.split('?')[0] ?? ''
  if (!raw.startsWith('/')) return null
  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const segments = decoded.split('/').slice(1)
  const directory = decoded.endsWith('/')
  const kept = segments.filter((segment) => segment !== '')
  if (kept.some((segment) => segment === '.' || segment === '..')) return null
  return { path: kept.join('/'), directory }
}

/** @param {number} status */
function reason (status) {
  return /** @type {Record<number, string>} */ ({ 200: 'OK', 206: 'Partial Content', 301: 'Moved Permanently', 400: 'Bad Request', 404: 'Not Found', 405: 'Method Not Allowed', 416: 'Range Not Satisfiable', 431: 'Request Header Fields Too Large', 503: 'Service Unavailable' })[status] ?? 'Error'
}

const encoder = new TextEncoder()

/**
 * @typedef {{ readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, close: () => Promise<void> }} SocketLike
 * @typedef {{ localPort: number, connections: ReadableStream<SocketLike>, close: () => Promise<void> }} ServerLike
 * @typedef {{ files: Map<string, Blob> }} Site
 */

/**
 * @param {{ listen: (options: { port: number, scope: 'local' }) => Promise<ServerLike>, ports?: number[] }} options
 */
export function createSiteServer ({ listen, ports = PORTS }) {
  /** @type {Map<string, Site>} */
  const sites = new Map()
  /** @type {ServerLike | null} */
  let server = null
  /** @type {Promise<ServerLike> | null} */
  let starting = null
  let connections = 0

  /** @param {SocketLike} socket @param {number} status @param {Record<string, string | number>} headers @param {Blob | string | null} body @param {boolean} head */
  async function respond (socket, status, headers, body, head) {
    const blob = body === null ? new Blob([]) : typeof body === 'string' ? new Blob([body]) : body
    const lines = [`HTTP/1.1 ${status} ${reason(status)}`]
    for (const [name, value] of Object.entries({ 'Content-Length': blob.size, Connection: 'close', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', ...headers })) lines.push(`${name}: ${value}`)
    const writer = socket.writable.getWriter()
    try {
      await writer.write(encoder.encode(`${lines.join('\r\n')}\r\n\r\n`))
      if (!head) {
        const reader = blob.stream().getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          for (let at = 0; at < value.length; at += CHUNK_BYTES) await writer.write(value.subarray(at, at + CHUNK_BYTES))
        }
      }
      await writer.close()
    } finally {
      writer.releaseLock()
    }
  }

  /** @param {SocketLike} socket @param {number} port */
  async function answer (socket, port) {
    const reader = socket.readable.getReader()
    let text = ''
    const decoder = new TextDecoder('latin1')
    const timer = setTimeout(() => { reader.cancel().catch(() => {}) }, HEADER_WAIT_MS)
    try {
      while (!text.includes('\r\n\r\n')) {
        const { value, done } = await reader.read()
        if (done) return
        text += decoder.decode(value, { stream: true })
        const end = text.indexOf('\r\n\r\n')
        if (end > MAX_HEADER_BYTES || (end < 0 && text.length > MAX_HEADER_BYTES)) {
          await respond(socket, 431, { 'Content-Type': 'text/plain; charset=utf-8' }, 'The request headers are too large.\n', false)
          return
        }
      }
    } finally {
      clearTimeout(timer)
      reader.releaseLock()
    }
    const request = parseRequest(text.slice(0, text.indexOf('\r\n\r\n') + 2))
    if (request === null) return await respond(socket, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request.\n', false)
    const head = request.method === 'HEAD'
    if (request.method !== 'GET' && !head) return await respond(socket, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed.\n', false)
    const host = (request.headers.get('host') ?? '').toLowerCase()
    const label = host.endsWith(`.localhost:${port}`) ? host.slice(0, -`.localhost:${port}`.length) : ''
    const site = label === '' ? undefined : sites.get(label)
    const notFound = () => respond(socket, 404, { 'Content-Type': 'text/html; charset=utf-8' }, '<!doctype html><meta charset="utf-8"><title>Not found</title><h1>Not found</h1><p>This page is not in the shared site.</p>\n', head)
    if (site === undefined) return await notFound()
    const asked = pathOf(request.target)
    if (asked === null) return await respond(socket, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request.\n', head)
    const index = (/** @type {string} */ dir) => (dir === '' ? 'index.html' : `${dir}/index.html`)
    const resolved = asked.directory || asked.path === '' ? index(asked.path) : asked.path
    const file = site.files.get(resolved)
    if (file === undefined && !asked.directory && site.files.has(index(asked.path))) {
      return await respond(socket, 301, { Location: `/${asked.path.split('/').map(encodeURIComponent).join('/')}/`, 'Content-Type': 'text/plain; charset=utf-8' }, null, head)
    }
    if (file === undefined) return await notFound()
    const type = mimeTypeOf(resolved)
    const range = parseRange(request.headers.get('range'), file.size)
    if (range === 'unsatisfiable') return await respond(socket, 416, { 'Content-Range': `bytes */${file.size}`, 'Content-Type': 'text/plain; charset=utf-8' }, null, head)
    if (range === null) return await respond(socket, 200, { 'Content-Type': type, 'Accept-Ranges': 'bytes' }, file, head)
    return await respond(socket, 206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${range[0]}-${range[1]}/${file.size}` }, file.slice(range[0], range[1] + 1), head)
  }

  /** @param {ServerLike} opened */
  async function accept (opened) {
    const reader = opened.connections.getReader()
    for (;;) {
      const { value: socket, done } = await reader.read()
      if (done) return
      if (connections >= MAX_CONNECTIONS) {
        socket.close().catch(() => {})
        continue
      }
      connections += 1
      answer(socket, opened.localPort).catch(() => {}).finally(() => {
        connections -= 1
        socket.close().catch(() => {})
      })
    }
  }

  /** The listener, on the first free port. @returns {Promise<ServerLike>} */
  function listener () {
    if (server !== null) return Promise.resolve(server)
    starting ??= (async () => {
      let lastError = new Error('No port for the website viewer was free.')
      for (const port of ports) {
        try {
          const opened = await listen({ port, scope: 'local' })
          server = opened
          accept(opened).catch(() => {})
          return opened
        } catch (error) {
          lastError = error instanceof Error ? error : lastError
        }
      }
      throw new Error(`The website viewer could not start: ${lastError.message}`)
    })().finally(() => { starting = null })
    return starting
  }

  return {
    /**
     * Serves a site. The label is the first 32 characters of the base32 of HMAC-SHA256(secret, cid).
     * @param {string} cid @param {{ path: string, file: Blob }[]} entries @param {Uint8Array} secret
     * @returns {Promise<{ url: string, origin: string, stop: () => Promise<void> }>}
     */
    async add (cid, entries, secret) {
      const key = await crypto.subtle.importKey('raw', /** @type {BufferSource} */ (secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const label = base32Encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(cid)))).slice(0, 32)
      const opened = await listener()
      sites.set(label, { files: new Map(entries.map((entry) => [entry.path, entry.file])) })
      const origin = `http://${label}.localhost:${opened.localPort}`
      return {
        url: `${origin}/`,
        origin,
        stop: async () => {
          sites.delete(label)
          if (sites.size === 0 && server !== null) {
            const closing = server
            server = null
            await closing.close().catch(() => {})
          }
        }
      }
    },
    get sites () { return sites.size }
  }
}
