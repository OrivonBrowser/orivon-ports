// Kubo's HTTP RPC conventions, shared by every route: the error body and its status, JSON and ndjson answers, the
// multibase text kubo-rpc-client wraps topics and pubsub data in, Go durations, and reading options off a query.

const JSON_TYPE = 'application/json'
const TEXT = new TextEncoder()

/** An error a route reports as kubo would: `{"Message","Code","Type"}` with the status kubo uses for it. */
export class KuboError extends Error {
  /** @param {string} message @param {{ status?: number, code?: number }} [options] */
  constructor (message, { status = 500, code = 0 } = {}) {
    super(message)
    this.name = 'KuboError'
    this.status = status
    this.code = code
  }
}

/** @param {unknown} error */
export function toKuboError (error) {
  if (error instanceof KuboError) return error
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError') return new KuboError('context deadline exceeded')
  return new KuboError(error instanceof Error ? error.message : String(error))
}

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff' }

/** @param {unknown} error */
export function errorResponse (error) {
  const { message, status, code } = toKuboError(error)
  return new Response(JSON.stringify({ Message: message, Code: code, Type: 'error' }), {
    status, headers: { ...BASE_HEADERS, 'Content-Type': JSON_TYPE }
  })
}

/** @param {unknown} value @param {number} [status] */
export function jsonResponse (value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { ...BASE_HEADERS, 'Content-Type': JSON_TYPE } })
}

/** What kubo answers for a command that has nothing to say: 200 and an empty body. */
export function emptyResponse () {
  return new Response('', { status: 200, headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain' } })
}

/** @param {BodyInit} body @param {string} [type] */
export function bytesResponse (body, type = 'application/octet-stream') {
  return new Response(body, { status: 200, headers: { ...BASE_HEADERS, 'Content-Type': type, 'X-Stream-Output': '1' } })
}

/**
 * One JSON object per line, as kubo streams events. The first item is awaited before the answer is built, so a
 * route that fails at once answers with an HTTP error and not a broken stream; later items stream as they come, and
 * the iterator is closed when the reader goes away.
 * @param {AsyncIterable<unknown> | Iterable<unknown>} items
 */
export async function ndjsonResponse (items) {
  const iterator = (Symbol.asyncIterator in items ? items[Symbol.asyncIterator]() : items[Symbol.iterator]())
  let first = await iterator.next()
  const stream = new ReadableStream({
    async pull (controller) {
      try {
        const step = first ?? await iterator.next()
        first = undefined
        if (step.done === true) controller.close()
        else controller.enqueue(TEXT.encode(`${JSON.stringify(step.value)}\n`))
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel () { await iterator.return?.() }
  })
  return new Response(stream, { status: 200, headers: { ...BASE_HEADERS, 'Content-Type': JSON_TYPE, 'X-Stream-Output': '1' } })
}

/** An option kubo reads as a boolean: absent is the default, `true` and an empty value are true. @param {URLSearchParams} params @param {string} name @param {boolean} [fallback] */
export function flag (params, name, fallback = false) {
  const value = params.get(name)
  if (value == null) return fallback
  return value === '' || value === 'true' || value === '1'
}

/** @param {URLSearchParams} params @param {string} name @param {number} [fallback] */
export function number (params, name, fallback) {
  const value = params.get(name)
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new KuboError(`invalid value for option "${name}": ${value}`)
  return parsed
}

const UNITS = { ns: 1e-9, us: 1e-6, µs: 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 }

/** A Go duration ("20000ms", "24h", "1m30s") as seconds, or undefined for text that is not one. @param {string | null | undefined} text */
export function parseGoDuration (text) {
  if (text == null || text === '') return undefined
  const pattern = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gy
  let seconds = 0
  let end = 0
  for (const match of text.matchAll(pattern)) {
    seconds += Number(match[1]) * UNITS[/** @type {keyof typeof UNITS} */ (match[2])]
    end = (match.index ?? 0) + match[0].length
  }
  return end === text.length && end > 0 ? seconds : undefined
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** base64url without padding. @param {Uint8Array} bytes */
export function toBase64Url (bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const triple = (a << 16) | (b << 8) | c
    out += B64[(triple >> 18) & 63] + B64[(triple >> 12) & 63]
    if (i + 1 < bytes.length) out += B64[(triple >> 6) & 63]
    if (i + 2 < bytes.length) out += B64[triple & 63]
  }
  return out.replaceAll('+', '-').replaceAll('/', '_')
}

/** Bytes from base64 or base64url, padded or not. @param {string} text */
export function fromBase64 (text) {
  const clean = text.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '')
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4))
  let at = 0
  for (let i = 0; i < clean.length; i += 4) {
    let triple = 0
    let count = 0
    for (let j = 0; j < 4 && i + j < clean.length; j++) {
      const index = B64.indexOf(/** @type {string} */ (clean[i + j]))
      if (index < 0) throw new KuboError('invalid base64')
      triple |= index << (18 - 6 * j)
      count++
    }
    if (count >= 2) out[at++] = (triple >> 16) & 255
    if (count >= 3) out[at++] = (triple >> 8) & 255
    if (count >= 4) out[at++] = triple & 255
  }
  return out.subarray(0, at)
}

/** What kubo-rpc-client sends for text it wraps: a multibase string, `u` for base64url. @param {string} text */
export function encodeRpcText (text) {
  return `u${toBase64Url(TEXT.encode(text))}`
}

/** @param {string} value */
export function decodeRpcText (value) {
  return value.startsWith('u') ? new TextDecoder().decode(fromBase64(value.slice(1))) : value
}

/** @param {Uint8Array} bytes */
export function encodeRpcBytes (bytes) {
  return `u${toBase64Url(bytes)}`
}

/** A signal that ends with the request's or after the `timeout` option kubo takes, whichever is first. @param {URLSearchParams} params @param {AbortSignal} [signal] */
export function signalFor (params, signal) {
  const seconds = parseGoDuration(params.get('timeout'))
  const signals = [signal, seconds == null ? undefined : AbortSignal.timeout(Math.max(1, Math.round(seconds * 1000)))].filter((one) => one != null)
  return signals.length === 0 ? undefined : (signals.length === 1 ? signals[0] : AbortSignal.any(signals))
}
