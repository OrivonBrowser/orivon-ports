// The HTTP gateway apps load media from: `/ipfs/<cid>[/path]` and `/ipns/<name>[/path]` as file bytes with a content
// type and byte ranges, and `/ipns/<name>?format=ipns-record` as the node's signed record, passed through. Files only;
// a directory is a 404. Everything it serves is marked nosniff and sandboxed, because the bytes are anyone's.

import { CID } from 'multiformats/cid'
import { NodeError } from './node-client.js'
import { parseCid } from './ipfs.js'
import { describe } from './mfs/dag.js'
import { followName } from './routes/content.js'
import { KuboError } from './wire.js'

const TYPES = new Map(Object.entries({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4',
  json: 'application/json', txt: 'text/plain; charset=utf-8', html: 'text/plain; charset=utf-8', pdf: 'application/pdf'
}))

const SIGNATURES = /** @type {Array<[string, number[], number]>} */ ([
  ['image/png', [0x89, 0x50, 0x4e, 0x47], 0], ['image/jpeg', [0xff, 0xd8, 0xff], 0], ['image/gif', [0x47, 0x49, 0x46, 0x38], 0],
  ['video/webm', [0x1a, 0x45, 0xdf, 0xa3], 0], ['audio/ogg', [0x4f, 0x67, 0x67, 0x53], 0], ['application/pdf', [0x25, 0x50, 0x44, 0x46], 0],
  ['audio/mpeg', [0x49, 0x44, 0x33], 0], ['video/mp4', [0x66, 0x74, 0x79, 0x70], 4]
])

/** @param {number[]} signature @param {Uint8Array} bytes @param {number} at */
const matches = (signature, bytes, at) => signature.every((byte, index) => bytes[at + index] === byte)

/** A content type from the file name when it has a known extension, else from the first bytes, else a safe default. @param {string} name @param {Uint8Array} head */
export function contentType (name, head) {
  const byName = TYPES.get(name.slice(name.lastIndexOf('.') + 1).toLowerCase())
  if (byName !== undefined && name.includes('.')) return byName
  for (const [type, signature, at] of SIGNATURES) if (matches(signature, head, at)) return type
  const ascii = String.fromCharCode(...head.subarray(0, 4))
  if (ascii === 'RIFF' && String.fromCharCode(...head.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return 'application/octet-stream'
}

/**
 * The bytes a `Range` header names, or null for no range (or one that is not a single byte range, which is served whole).
 * @param {string | null} header @param {number} size @returns {{ start: number, end: number } | 'unsatisfiable' | null}
 */
export function parseRange (header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '')
  if (match === null || (match[1] === '' && match[2] === '')) return null
  if (match[1] === '') {
    const last = Math.min(Number(match[2]), size)
    return last === 0 ? 'unsatisfiable' : { start: size - last, end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  return start >= size || end < start ? 'unsatisfiable' : { start, end }
}

/** A stream that gives `head` first and then what `reader` has. @param {Uint8Array} head @param {ReadableStreamDefaultReader<Uint8Array>} reader */
function withHead (head, reader) {
  let sent = false
  return new ReadableStream({
    async pull (controller) {
      if (!sent) { sent = true; controller.enqueue(head); return }
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel (reason) { return reader.cancel(reason) }
  })
}

const SECURE = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' }

/** @param {number} status @param {string} text */
const plain = (status, text) => new Response(`${text}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURE } })

/** @param {unknown} error */
function failure (error) {
  if (error instanceof NodeError) return plain(error.status === 404 ? 404 : error.status === 504 ? 504 : 502, error.text === '' ? error.message : error.text)
  if (error instanceof KuboError) return plain(error.message === 'file does not exist' ? 404 : 400, error.message)
  throw error
}

/** @param {{ node: ReturnType<typeof import('./node-client.js').createNodeClient> }} deps */
export function createGateway ({ node }) {
  /** @param {URL} url @param {Request} request */
  async function ipnsRecord (url, request) {
    const upstream = await node.gateway(`${url.pathname}${url.search}`, { accept: request.headers.get('accept') ?? 'application/vnd.ipfs.ipns-record' }, request.signal)
    return new Response(upstream.body, {
      status: 200, headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/vnd.ipfs.ipns-record', 'Cache-Control': 'no-cache', ...SECURE }
    })
  }

  /** @param {URL} url @param {Request} request */
  async function content (url, request) {
    const parts = url.pathname.split('/').filter((part) => part !== '').map(decodeURIComponent)
    const namespace = parts.shift()
    const root = parts.shift()
    if (root === undefined) return plain(400, 'missing path')
    let target = { cid: root, segments: parts }
    if (namespace === 'ipns') {
      const followed = await followName(node, root, request.signal)
      target = { cid: followed.cid, segments: [...followed.segments, ...parts] }
    }
    parseCid(target.cid)
    const path = [target.cid, ...target.segments].join('/')
    const resolved = target.segments.length === 0 ? target.cid : await node.resolve(path, request.signal)
    const info = await describe(CID.parse(resolved), (cid) => node.getBlock(cid.toString(), request.signal))
    if (info.type !== 'file') return plain(404, 'directories are not served')

    const range = parseRange(request.headers.get('range'), info.size)
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}`, ...SECURE } })
    const start = range?.start ?? 0
    const length = range === null ? info.size : range.end - range.start + 1
    const headers = new Headers({
      'Accept-Ranges': 'bytes', 'Content-Length': String(length), ETag: `"${resolved}"`,
      'Cache-Control': 'public, max-age=29030400, immutable', ...SECURE
    })
    if (range !== null) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
    const name = url.searchParams.get('filename') ?? target.segments.at(-1) ?? ''

    if (request.method === 'HEAD' || length === 0) {
      headers.set('Content-Type', contentType(name, new Uint8Array(0)))
      return new Response(null, { status: range === null ? 200 : 206, headers })
    }
    const upstream = await node.cat(path, { offset: start, length, signal: request.signal })
    const reader = /** @type {ReadableStream<Uint8Array>} */ (upstream.body).getReader()
    const first = await reader.read()
    const head = first.value ?? new Uint8Array(0)
    headers.set('Content-Type', contentType(name, start === 0 ? head : new Uint8Array(0)))
    return new Response(first.done === true ? null : withHead(head, reader), { status: range === null ? 200 : 206, headers })
  }

  return {
    /** @param {Request} request */
    async handle (request) {
      const url = new URL(request.url)
      if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'method not allowed')
      try {
        if (url.pathname.startsWith('/ipns/') && url.searchParams.get('format') === 'ipns-record') return await ipnsRecord(url, request)
        if (url.pathname.startsWith('/ipfs/') || url.pathname.startsWith('/ipns/')) return await content(url, request)
        return plain(404, 'not found')
      } catch (error) {
        return failure(error)
      }
    }
  }
}
