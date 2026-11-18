// Answers `fetch` calls to the facade's origin in this process, with no socket: kubo-rpc-client and pkc-js's own raw
// requests both go through the global `fetch`, looked up when they call, so replacing it covers them. Requests to
// any other origin pass to the fetch that was there. Bodies of any kind are read to bytes first, because the facade
// reads whole bodies and the callers hand streams, `FormData` and iterators.

const DECODER_FALLBACK = 'application/octet-stream'

/** @param {unknown} chunk */
function chunkBytes (chunk) {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk)
  if (chunk instanceof Uint8Array) return chunk
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  throw new TypeError('a request body chunk is not bytes')
}

/** @param {Uint8Array[]} chunks */
function join (chunks) {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length }
  return out
}

/** @param {unknown} body @returns {Promise<{ bytes: Uint8Array, type: string | null }>} */
async function bodyBytes (body) {
  if (body == null) return { bytes: new Uint8Array(0), type: null }
  if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return { bytes: chunkBytes(body), type: null }
  }
  if (body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams) {
    const wrapped = new Request('http://body.invalid/', { method: 'POST', body })
    return { bytes: new Uint8Array(await wrapped.arrayBuffer()), type: wrapped.headers.get('content-type') }
  }
  /** @type {Uint8Array[]} */
  const chunks = []
  if (body instanceof ReadableStream) {
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(chunkBytes(value))
    }
  } else if (Symbol.asyncIterator in /** @type {object} */ (body) || Symbol.iterator in /** @type {object} */ (body)) {
    for await (const chunk of /** @type {AsyncIterable<unknown>} */ (body)) chunks.push(chunkBytes(chunk))
  } else {
    throw new TypeError('unsupported request body')
  }
  return { bytes: join(chunks), type: null }
}

/** @param {AbortSignal} signal */
const abortError = (signal) => (signal.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError'))

/**
 * @param {Response} response @param {AbortSignal | null | undefined} signal
 * A streamed answer that fails with the abort when the caller aborts, as a network stream would.
 */
function abortable (response, signal) {
  if (signal == null || response.body === null) return response
  const reader = response.body.getReader()
  const stream = new ReadableStream({
    async pull (controller) {
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    start (controller) {
      signal.addEventListener('abort', () => {
        controller.error(abortError(signal))
        reader.cancel(signal.reason).catch(() => {})
      }, { once: true })
    },
    cancel (reason) { return reader.cancel(reason) }
  })
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/**
 * Makes `target.fetch` answer requests to `baseUrl` (a URL, or several) from `facade`. Returns a function that puts
 * the previous fetch back.
 * @param {{ fetch: typeof fetch }} target `globalThis`, or any object with a `fetch`
 * @param {string | string[]} baseUrl
 * @param {{ handle: (request: Request) => Promise<Response> }} facade
 */
export function installFetchHook (target, baseUrl, facade) {
  const origins = new Set([baseUrl].flat().map((one) => new URL(one).origin))
  const previous = target.fetch

  target.fetch = /** @type {typeof fetch} */ (async function hookedFetch (input, init) {
    const source = input instanceof Request ? input : undefined
    const url = new URL(source?.url ?? String(input))
    if (!origins.has(url.origin)) return previous.call(target, input, init)

    const method = (init?.method ?? source?.method ?? 'GET').toUpperCase()
    const headers = new Headers(source?.headers)
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value)
    const signal = init?.signal ?? source?.signal
    if (signal?.aborted === true) throw abortError(signal)

    const hasBody = method !== 'GET' && method !== 'HEAD'
    const { bytes, type } = hasBody ? await bodyBytes(init?.body ?? (source === undefined ? null : await source.arrayBuffer())) : { bytes: new Uint8Array(0), type: null }
    if (type !== null && !headers.has('content-type')) headers.set('content-type', type)
    if (hasBody && !headers.has('content-type')) headers.set('content-type', DECODER_FALLBACK)

    const request = new Request(url, { method, headers, body: hasBody ? bytes : undefined, ...(signal == null ? {} : { signal }) })
    const answered = facade.handle(request)
    if (signal == null) return answered
    const aborted = new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError(signal)), { once: true }))
    return abortable(await Promise.race([answered, aborted]), signal)
  })

  return () => { target.fetch = previous }
}
