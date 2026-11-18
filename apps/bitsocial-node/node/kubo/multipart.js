// A multipart/form-data body, read as bytes: kubo-rpc-client builds its own (no length, a file per part, the part's
// name and path in the headers) and `fetch` builds another for FormData, so the parts are read here and not through a
// runtime's parser, which differs between them and rewrites binary parts into files.

import { KuboError } from './wire.js'

const CRLF = [13, 10]
const HEADER_END = [13, 10, 13, 10]
const DECODER = new TextDecoder()
const ENCODER = new TextEncoder()

/**
 * @typedef {object} Part
 * @property {string} name the form field, without the options kubo-rpc-client appends after a `?`
 * @property {string} filename decoded from the percent-encoding kubo-rpc-client gives it
 * @property {Uint8Array} body
 */

/** @param {Uint8Array} haystack @param {ArrayLike<number>} needle @param {number} from */
function indexOf (haystack, needle, from) {
  const first = needle[0] ?? 0
  for (let at = haystack.indexOf(first, from); at !== -1 && at + needle.length <= haystack.length; at = haystack.indexOf(first, at + 1)) {
    let same = true
    for (let i = 1; i < needle.length; i++) {
      if (haystack[at + i] !== needle[i]) { same = false; break }
    }
    if (same) return at
  }
  return -1
}

/** @param {string} value @param {string} key */
function option (value, key) {
  const match = new RegExp(`(?:^|[;\\s])${key}="((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(value)
  return match?.[1]?.replace(/\\(.)/g, '$1')
}

/** @param {string} filename */
function decodeFilename (filename) {
  try { return decodeURIComponent(filename) } catch { return filename }
}

/** The parts of a body, in order. @param {Uint8Array} body @param {string | null} contentType */
export function parseMultipart (body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '')
  const token = boundary?.[1] ?? boundary?.[2]
  if (token == null) throw new KuboError('request Content-Type isn\'t multipart/form-data')
  const delimiter = ENCODER.encode(`--${token}`)
  const separator = [...CRLF, ...delimiter]
  /** @type {Part[]} */
  const parts = []
  let at = indexOf(body, delimiter, 0)
  while (at !== -1) {
    let start = at + delimiter.length
    if (body[start] === 45 && body[start + 1] === 45) break
    if (body[start] === 13 && body[start + 1] === 10) start += 2
    const headerEnd = indexOf(body, HEADER_END, start)
    if (headerEnd === -1) throw new KuboError('malformed multipart body')
    const headers = DECODER.decode(body.subarray(start, headerEnd))
    const bodyStart = headerEnd + 4
    const bodyEnd = indexOf(body, separator, bodyStart)
    if (bodyEnd === -1) throw new KuboError('malformed multipart body')
    const disposition = /^content-disposition:\s*(.*)$/im.exec(headers)?.[1] ?? ''
    parts.push({
      name: (option(disposition, 'name') ?? '').split('?')[0] ?? '',
      filename: decodeFilename(option(disposition, 'filename') ?? ''),
      body: body.subarray(bodyStart, bodyEnd)
    })
    at = bodyEnd + 2
  }
  return parts
}

/** The bytes of a request's body, or none. @param {Request} request */
export async function readBody (request) {
  return new Uint8Array(await request.arrayBuffer())
}

/** The parts of a request's multipart body; a body with none is an error kubo words as it does. @param {Request} request */
export async function readParts (request) {
  const parts = parseMultipart(await readBody(request), request.headers.get('content-type'))
  if (parts.length === 0) throw new KuboError('request has no multipart parts')
  return parts
}
