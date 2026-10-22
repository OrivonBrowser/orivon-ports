// A multipart/form-data body built by hand, so the headers of every part are
// exactly what the pinning services expect (the browser's FormData adds and
// reorders headers, and gives a directory part no way to be written at all).

const encoder = new TextEncoder()

/**
 * @typedef {object} Part
 * @property {string} name Form field name.
 * @property {string} [filename] Sent as the part's filename, quoted.
 * @property {string} [contentType] Sent as the part's Content-Type.
 * @property {Uint8Array} bytes
 */

/** A boundary of 48 hex digits: long enough that it never occurs in a payload. */
export function randomBoundary () {
  const raw = new Uint8Array(24)
  globalThis.crypto.getRandomValues(raw)
  let hex = ''
  for (const byte of raw) hex += byte.toString(16).padStart(2, '0')
  return `----orivon${hex}`
}

/**
 * Quotes a header parameter the way browsers do: CR, LF and `"` are percent-escaped.
 * @param {string} value
 */
function quoted (value) {
  return `"${value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22')}"`
}

/**
 * @param {Part[]} parts
 * @param {string} [boundary]
 * @returns {{ body: Uint8Array, contentType: string }}
 */
export function buildMultipart (parts, boundary = randomBoundary()) {
  /** @type {Uint8Array[]} */
  const chunks = []
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name=${quoted(part.name)}`
    if (part.filename !== undefined) head += `; filename=${quoted(part.filename)}`
    head += '\r\n'
    if (part.contentType !== undefined) head += `Content-Type: ${part.contentType}\r\n`
    head += '\r\n'
    chunks.push(encoder.encode(head), part.bytes, encoder.encode('\r\n'))
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`))

  let length = 0
  for (const chunk of chunks) length += chunk.length
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.length
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}
