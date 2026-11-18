// A `fetch` over `http.request`, for the Worker's calls to the node's own API.
//
// A Worker's `fetch` is the engine's, which gives one page six HTTP/1.1 connections to one host and port, and the node's API is one host and port. A slow read of
// someone else's content holds one of them for as long as the node waits on the network, so a few of them keep the call that matters (a community's key import,
// which its first signed record waits for) out of the connections. Node's own `http` client has no such limit: it opens a socket for each request unless an agent
// pools them, and Orivon's `http` client runs every request over a real `net.Socket` of its own and never pools. So the node client and the status readers call
// the node through this, and the desktop's behaviour is the Worker's: no call waits for another's connection.
//
// What it is: the part of `fetch` the node client and the readers use, with the same answers and failures (a `Response` whose body is a stream, a TypeError
// "fetch failed" with the cause for a connection that cannot be made, the signal's reason for an abort). What it is not: a general client. It speaks `http:` only,
// sends `Connection: close`, asks for no compression, and does not follow a redirect (the node's API never sends one, and a 3xx is returned as it came).

/**
 * @typedef {object} HttpModule
 * @property {(options: Record<string, unknown>) => any} request Node's `http.request`, or the Worker's shim of it
 */

const BODYLESS = new Set(['GET', 'HEAD'])
const NO_BODY_STATUS = new Set([204, 205, 304])
/** How much of an answer waits unread before the connection is told to stop sending until the reader catches up. */
const READ_AHEAD_BYTES = 256 * 1024

/** @param {unknown} value @returns {value is ArrayBuffer} */
const isArrayBuffer = (value) => Object.prototype.toString.call(value) === '[object ArrayBuffer]'

/** @param {unknown} value @returns {value is ReadableStream<Uint8Array>} */
const isStream = (value) => typeof value === 'object' && value !== null && typeof /** @type {{ getReader?: unknown }} */ (value).getReader === 'function'

/** The pauses between a call and its asks again after the limiter refused it: the shim's own for its sockets (`limit-retry.ts`), about 4.4 s in all. */
const LIMIT_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 200, 200, 400, 400, 400, 800, 800, 800]

/** @param {number} ms @param {AbortSignal | undefined} signal @param {(ms: number) => Promise<void>} pause @returns {Promise<void>} after `ms`, or rejected with the signal's reason when it aborts first */
function waitOrAbort (ms, signal, pause) {
  if (signal === undefined) return pause(ms)
  return new Promise((resolve, reject) => {
    const onAbort = () => { reject(abortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    pause(ms).then(() => { signal.removeEventListener('abort', onAbort); resolve(undefined) }, reject)
  })
}

/** @param {unknown} error a failure `fetch` would reject with @returns {boolean} whether the origin's call limiter refused the call */
const isLimitRefusal = (error) => error instanceof Error && /** @type {{ code?: unknown }} */ (error.cause)?.code === 'limit'

/** @param {unknown} cause @returns {TypeError} what `fetch` rejects with when the call cannot be made or the answer breaks */
const failed = (cause) => new TypeError('fetch failed', { cause })

/** @param {AbortSignal} signal */
const abortReason = (signal) => signal.reason ?? new DOMException('This operation was aborted', 'AbortError')

/** @param {Uint8Array} chunk @returns {Uint8Array} the chunk as a plain view, with no copy */
const asBytes = (chunk) => (chunk.constructor === Uint8Array ? chunk : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))

/**
 * The body of a call as bytes or as a stream, and the content type fetch would give it.
 * @param {unknown} body
 * @returns {Promise<{ bytes: Uint8Array | null, stream: ReadableStream<Uint8Array> | null, contentType: string | null }>}
 */
async function bodyOf (body) {
  if (body === null || body === undefined) return { bytes: null, stream: null, contentType: null }
  if (typeof body === 'string') return { bytes: new TextEncoder().encode(body), stream: null, contentType: 'text/plain;charset=UTF-8' }
  if (isArrayBuffer(body)) return { bytes: new Uint8Array(body), stream: null, contentType: null }
  if (ArrayBuffer.isView(body)) return { bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), stream: null, contentType: null }
  if (isStream(body)) return { bytes: null, stream: body, contentType: null }
  // A Blob, a FormData (its multipart encoding and boundary) or a URLSearchParams: the engine encodes it, as it would for its own fetch.
  const encoded = new Response(/** @type {BodyInit} */ (body))
  return { bytes: new Uint8Array(await encoded.arrayBuffer()), stream: null, contentType: encoded.headers.get('content-type') }
}

/**
 * @param {HttpModule} http
 * @param {{ note?: (line: string) => void, pause?: (ms: number) => Promise<void> }} [options] `note` hears of a call asked again; `pause` is the wait between two asks (the clock, for a test)
 * @returns {typeof fetch}
 */
export function createHttpFetch (http, options = {}) {
  const note = options.note
  const pause = options.pause ?? ((/** @type {number} */ ms) => new Promise((resolve) => { setTimeout(resolve, ms) }))
  return /** @type {typeof fetch} */ (async function httpFetch (input, init) {
    const asked = typeof Request !== 'undefined' && input instanceof Request ? input : null
    const url = new URL(asked === null ? String(input) : asked.url)
    if (url.protocol !== 'http:') throw new TypeError(`fetch over http.request takes an http: URL, not ${url.protocol}`)
    const method = (init?.method ?? asked?.method ?? 'GET').toUpperCase()
    const signal = init?.signal ?? asked?.signal ?? undefined
    const own = init !== undefined && init !== null && 'body' in init
    const given = own ? init.body : asked?.body
    if (given !== null && given !== undefined && BODYLESS.has(method)) throw new TypeError('Request with GET/HEAD method cannot have body.')
    const { bytes, stream, contentType } = await bodyOf(given)
    const headers = new Headers(init?.headers ?? asked?.headers)
    if (contentType !== null && !headers.has('content-type')) headers.set('content-type', contentType)
    if (!headers.has('content-length') && !headers.has('transfer-encoding')) {
      if (bytes !== null) headers.set('content-length', String(bytes.byteLength))
      else if (stream !== null) headers.set('transfer-encoding', 'chunked')
      else if (!BODYLESS.has(method) && method !== 'DELETE') headers.set('content-length', '0')
    }
    headers.set('connection', 'close')
    if (signal?.aborted === true) { void stream?.cancel(abortReason(signal)).catch(() => {}); throw abortReason(signal) }

    /** One ask of the node: a socket, the request, and the answer's head. @returns {Promise<Response>} */
    const once = () => new Promise((resolve, reject) => {
      let settled = false
      let over = false
      /** @type {null | ((reason: unknown) => void)} */
      let failBody = null
      const request = http.request({
        protocol: 'http:',
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port === '' ? 80 : Number(url.port),
        method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(headers),
        agent: false
      })
      const onAbort = () => {
        const reason = abortReason(/** @type {AbortSignal} */ (signal))
        request.destroy()
        void stream?.cancel(reason).catch(() => {})
        over = true
        if (!settled) { settled = true; reject(reason) } else failBody?.(reason)
      }
      const release = () => { signal?.removeEventListener('abort', onAbort) }
      signal?.addEventListener('abort', onAbort, { once: true })
      request.on('error', (/** @type {unknown} */ error) => {
        release()
        if (over) return
        over = true
        if (!settled) { settled = true; reject(failed(error)) } else failBody?.(failed(error))
      })
      request.on('response', (/** @type {any} */ res) => {
        settled = true
        const status = Number(res.statusCode)
        const answered = new Headers()
        const raw = /** @type {string[]} */ (res.rawHeaders ?? [])
        for (let index = 0; index + 1 < raw.length; index += 2) { try { answered.append(String(raw[index]), String(raw[index + 1])) } catch { /* a header the engine refuses to hold */ } }
        let body = null
        if (method === 'HEAD' || NO_BODY_STATUS.has(status)) {
          release()
          res.resume()
        } else {
          /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
          let sink = null
          let done = false
          const finish = (/** @type {unknown} */ error) => {
            if (done) return
            done = true
            over = true
            release()
            if (error === undefined) sink?.close(); else sink?.error(error)
          }
          failBody = (reason) => { res.destroy(); finish(reason) }
          body = new ReadableStream({
            start (controller) {
              sink = controller
              res.on('data', (/** @type {Uint8Array} */ chunk) => {
                if (done) return
                controller.enqueue(asBytes(chunk))
                if (controller.desiredSize !== null && controller.desiredSize <= 0) res.pause()
              })
              res.on('end', () => { finish() })
              res.on('error', (/** @type {unknown} */ error) => { finish(failed(error)) })
              res.on('close', () => { finish(failed(new Error('the connection closed before the answer ended'))) })
            },
            pull () { res.resume() },
            cancel () { done = true; over = true; release(); res.destroy(); request.destroy() }
          }, new ByteLengthQueuingStrategy({ highWaterMark: READ_AHEAD_BYTES }))
        }
        const response = new Response(body, { status, statusText: String(res.statusMessage ?? ''), headers: answered })
        Object.defineProperty(response, 'url', { value: url.href })
        resolve(response)
      })
      if (stream !== null) pump(stream, request, (error) => { request.destroy(); if (!over) { over = true; release(); if (!settled) { settled = true; reject(failed(error)) } else failBody?.(failed(error)) } })
      else request.end(bytes === null ? undefined : bytes)
    })

    // The per-origin limiter refuses a call before it runs, so a request it refused has not reached the node and may be sent again; the shim's `http` dials without the
    // asking-again its `net.Socket` has, so it is done here, with the shim's own pauses. A body that was a stream is consumed and cannot be sent twice.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await once()
      } catch (error) {
        const wait = LIMIT_RETRY_DELAYS_MS[attempt]
        if (wait === undefined || stream !== null || !isLimitRefusal(error) || signal?.aborted === true) throw error
        note?.(`node http ${method} ${url.pathname} refused by the origin's call limit, asking again in ${String(wait)} ms (ask ${String(attempt + 2)})`)
        await waitOrAbort(wait, signal, pause)
      }
    }
  })
}

/**
 * Writes a stream to a request as it produces, waiting for the request to take what it was given, and ends the request.
 * @param {ReadableStream<Uint8Array>} stream @param {any} request @param {(error: unknown) => void} fail
 */
async function pump (stream, request, fail) {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (request.destroyed === true) return
      const chunk = typeof value === 'string' ? new TextEncoder().encode(value) : value
      if (!request.write(chunk)) await new Promise((resolve) => { request.once('drain', resolve); request.once('close', resolve) })
    }
    request.end()
  } catch (error) {
    fail(error)
  }
}

/**
 * What a failed call says in a trace line: the error's name, and for a "fetch failed" the code and words of what made it fail.
 * @param {unknown} error
 */
export function failureText (error) {
  if (!(error instanceof Error)) return String(error)
  const cause = /** @type {{ code?: unknown, message?: unknown } | undefined} */ (error.cause)
  if (cause === undefined || cause === null || typeof cause !== 'object') return error.name
  return `${error.name} (${[cause.code, cause.message].filter((part) => typeof part === 'string' && part !== '').join(' ').slice(0, 200)})`
}

/**
 * The fetch the Worker calls the node with: the node API's own origin over `http.request` and every other URL (the Ethereum providers and the like) over `other`.
 * @param {{ http: HttpModule, base: string, fetch: typeof fetch, note?: (line: string) => void, pause?: (ms: number) => Promise<void> }} options `base` is the node API's origin, as the node client names it; `note` and `pause` are `createHttpFetch`'s
 * @returns {typeof fetch}
 */
export function createNodeFetch ({ http, base, fetch: other, note, pause }) {
  const origin = new URL(base).origin
  const direct = createHttpFetch(http, { ...(note === undefined ? {} : { note }), ...(pause === undefined ? {} : { pause }) })
  return /** @type {typeof fetch} */ ((input, init) => {
    let href
    try { href = new URL(typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input)).origin } catch { href = '' }
    return (href === origin ? direct : other)(input, init)
  })
}
