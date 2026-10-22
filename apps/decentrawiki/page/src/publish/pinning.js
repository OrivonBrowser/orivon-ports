// Uploads a static site directory to a pinning target and returns the root
// CID the target computed: a Kubo node (the person's own, or a Kubo-compatible
// service such as Filebase) through its RPC API, or Pinata through its folder
// upload. The caller compares that CID with the one it computed locally.
// No key ever reaches an error message.

import { buildMultipart } from './multipart.js'

const MESSAGE_LIMIT = 300
const PINATA_UPLOAD = 'https://api.pinata.cloud/pinning/pinFileToIPFS'
const PINATA_TEST = 'https://api.pinata.cloud/data/testAuthentication'
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]']

const encoder = new TextEncoder()

/**
 * @typedef {'unauthorized'|'unreachable'|'too-large'|'refused'|'bad-answer'|'aborted'|'bad-address'} PinningErrorKind
 * @typedef {{ path: string, bytes: Uint8Array }} PinFile
 * @typedef {{ name: string, hash: string, size: number }} KuboEntry
 */

export class PinningError extends Error {
  /**
   * @param {PinningErrorKind} kind
   * @param {string} message
   */
  constructor (kind, message) {
    super(message)
    this.name = 'PinningError'
    this.kind = kind
  }
}

/**
 * Trims an endpoint, drops trailing slashes and refuses anything that is not
 * an http(s) address; plain http is allowed for this machine only.
 * @param {string} value
 * @returns {string}
 */
export function normaliseEndpoint (value) {
  const text = String(value ?? '').trim()
  let url
  try {
    url = new URL(text)
  } catch {
    throw new PinningError('bad-address', 'That address is not valid. It should look like https://example.com or http://127.0.0.1:5001.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PinningError('bad-address', 'The address must start with https:// (or http:// for a service on this computer).')
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new PinningError('bad-address', 'Only a service on this computer can use http://. Use an https:// address for any other service.')
  }
  if (url.username !== '' || url.password !== '') {
    throw new PinningError('bad-address', 'Leave the user name and password out of the address and enter the key in its own field.')
  }
  return (url.origin + url.pathname).replace(/\/+$/, '')
}

/**
 * The strings that must never be echoed: the whole credential and its token part.
 * @param {string | undefined} credential
 * @returns {string[]}
 */
function secretsOf (credential) {
  const text = String(credential ?? '').trim()
  if (text === '') return []
  const token = text.split(/\s+/).pop() ?? ''
  return token === text || token === '' ? [text] : [text, token]
}

/**
 * @param {string} text
 * @param {string[]} secrets
 */
function redact (text, secrets) {
  let out = text
  for (const secret of secrets) out = out.split(secret).join('***')
  return out
}

/**
 * The service's own words from a JSON or plain-text error body, or ''.
 * @param {string} text
 */
function serviceMessage (text) {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.startsWith('<')) return ''
  let found = trimmed
  try {
    const json = JSON.parse(trimmed)
    const error = json?.error
    const candidates = [
      json?.Message, json?.message,
      typeof error === 'string' ? error : undefined,
      [error?.reason, error?.details].filter((part) => typeof part === 'string').join(': ')
    ]
    found = candidates.find((candidate) => typeof candidate === 'string' && candidate !== '') ?? ''
  } catch {
    // Not JSON: the text itself is the message.
  }
  return found.length > MESSAGE_LIMIT ? `${found.slice(0, MESSAGE_LIMIT - 1)}…` : found
}

/**
 * Sends one request and returns the body text of a 2xx answer.
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ fetchImpl: typeof fetch, signal?: AbortSignal | undefined, secrets: string[] }} context
 * @returns {Promise<string>}
 */
async function send (url, init, { fetchImpl, signal, secrets }) {
  const aborted = (/** @type {any} */ error) => signal?.aborted === true || error?.name === 'AbortError' || error?.name === 'TimeoutError'
  const abortedError = () => new PinningError('aborted', 'The upload was cancelled.')
  let response
  let text
  try {
    response = await fetchImpl(url, { ...init, ...(signal ? { signal } : {}) })
    text = await response.text()
  } catch (error) {
    if (aborted(error)) throw abortedError()
    throw new PinningError('unreachable', 'Could not reach the service. Check the address and your connection, and that the service accepts requests from this page.')
  }
  if (response.status === 401 || response.status === 403) {
    throw new PinningError('unauthorized', 'The service refused the key: check it and try again.')
  }
  if (response.status === 413) {
    throw new PinningError('too-large', 'The site is too large for this service.')
  }
  if (!response.ok) {
    const said = redact(serviceMessage(text), secrets)
    throw new PinningError('refused', said === ''
      ? `The service refused the upload (status ${response.status}).`
      : `The service refused the upload: ${said}`)
  }
  return text
}

/**
 * @param {string} path
 * @returns {string[]}
 */
function pathSegments (path) {
  const segments = String(path).split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new TypeError(`Not a relative file path: ${path}`)
  }
  return segments
}

/** @param {string} rootName */
function checkRoot (rootName) {
  if (typeof rootName !== 'string' || rootName === '' || rootName.includes('/') || rootName === '.' || rootName === '..') {
    throw new TypeError('rootName must be one folder name')
  }
}

/**
 * The Kubo NDJSON answer as entries; an error line becomes a refusal.
 * @param {string} text
 * @param {string[]} secrets
 */
function parseNdjson (text, secrets) {
  /** @type {KuboEntry[]} */
  const entries = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let json
    try {
      json = JSON.parse(line)
    } catch {
      throw new PinningError('bad-answer', 'The service answered in a form this page does not understand.')
    }
    if (json?.Type === 'error') {
      const said = redact(serviceMessage(line), secrets)
      throw new PinningError('refused', said === '' ? 'The service refused the upload.' : `The service refused the upload: ${said}`)
    }
    if (typeof json?.Name === 'string' && typeof json?.Hash === 'string') {
      entries.push({ name: json.Name, hash: json.Hash, size: Number(json.Size) || 0 })
    }
  }
  return entries
}

/**
 * Uploads a directory through the Kubo RPC API and pins it.
 * @param {{ endpoint: string, authorization?: string, rootName: string, files: PinFile[], fetchImpl?: typeof fetch, signal?: AbortSignal }} options
 * @returns {Promise<{ cid: string, entries: KuboEntry[] }>}
 */
export async function kuboAdd ({ endpoint, authorization, rootName, files, fetchImpl = fetch, signal }) {
  const base = normaliseEndpoint(endpoint)
  checkRoot(rootName)

  const empty = new Uint8Array(0)
  /** @type {import('./multipart.js').Part[]} */
  const parts = [{ name: 'file', filename: encodeURIComponent(rootName), contentType: 'application/x-directory', bytes: empty }]
  const seen = new Set()
  for (const file of files) {
    const segments = pathSegments(file.path)
    for (let depth = 1; depth < segments.length; depth++) {
      const dir = segments.slice(0, depth).join('/')
      if (seen.has(dir)) continue
      seen.add(dir)
      parts.push({ name: 'file', filename: encodeURIComponent(`${rootName}/${dir}`), contentType: 'application/x-directory', bytes: empty })
    }
    parts.push({ name: 'file', filename: encodeURIComponent(`${rootName}/${file.path}`), contentType: 'application/octet-stream', bytes: file.bytes })
  }

  const { body, contentType } = buildMultipart(parts)
  const query = 'cid-version=1&pin=true&quieter=false&progress=false&wrap-with-directory=false'
  const headers = { 'content-type': contentType, ...(authorization ? { authorization } : {}) }
  const text = await send(`${base}/api/v0/add?${query}`, { method: 'POST', headers, body }, { fetchImpl, signal, secrets: secretsOf(authorization) })

  const entries = parseNdjson(text, secretsOf(authorization))
  const root = entries.find((entry) => entry.name === rootName)
  if (!root || root.hash === '') {
    throw new PinningError('bad-answer', 'The service did not say which address the site got.')
  }
  return { cid: root.hash, entries }
}

/**
 * Asks a Kubo API for its version: a connection and key test.
 * @param {{ endpoint: string, authorization?: string, fetchImpl?: typeof fetch, signal?: AbortSignal }} options
 * @returns {Promise<{ version: string }>}
 */
export async function kuboVersion ({ endpoint, authorization, fetchImpl = fetch, signal }) {
  const base = normaliseEndpoint(endpoint)
  const headers = authorization ? { authorization } : {}
  const text = await send(`${base}/api/v0/version`, { method: 'POST', headers }, { fetchImpl, signal, secrets: secretsOf(authorization) })
  let version
  try {
    version = JSON.parse(text)?.Version
  } catch {
    version = undefined
  }
  if (typeof version !== 'string' || version === '') {
    throw new PinningError('bad-answer', 'That address answered, but it does not look like an IPFS service.')
  }
  return { version }
}

/**
 * Uploads a directory to Pinata as one folder.
 * @param {{ jwt: string, rootName: string, name: string, files: PinFile[], fetchImpl?: typeof fetch, signal?: AbortSignal }} options
 * @returns {Promise<{ cid: string }>}
 */
export async function pinataUpload ({ jwt, rootName, name, files, fetchImpl = fetch, signal }) {
  checkRoot(rootName)
  /** @type {import('./multipart.js').Part[]} */
  const parts = files.map((file) => {
    pathSegments(file.path)
    return { name: 'file', filename: `${rootName}/${file.path}`, contentType: 'application/octet-stream', bytes: file.bytes }
  })
  parts.push(
    { name: 'pinataOptions', bytes: encoder.encode(JSON.stringify({ cidVersion: 1 })) },
    { name: 'pinataMetadata', bytes: encoder.encode(JSON.stringify({ name })) }
  )
  const { body, contentType } = buildMultipart(parts)
  const headers = { 'content-type': contentType, authorization: `Bearer ${jwt}` }
  const text = await send(PINATA_UPLOAD, { method: 'POST', headers, body }, { fetchImpl, signal, secrets: secretsOf(jwt) })

  let cid
  try {
    cid = JSON.parse(text)?.IpfsHash
  } catch {
    cid = undefined
  }
  if (typeof cid !== 'string' || cid === '') {
    throw new PinningError('bad-answer', 'Pinata did not say which address the site got.')
  }
  return { cid }
}

/**
 * Checks a Pinata key.
 * @param {{ jwt: string, fetchImpl?: typeof fetch, signal?: AbortSignal }} options
 * @returns {Promise<{ ok: true }>}
 */
export async function pinataTest ({ jwt, fetchImpl = fetch, signal }) {
  const headers = { authorization: `Bearer ${jwt}` }
  await send(PINATA_TEST, { method: 'GET', headers }, { fetchImpl, signal, secrets: secretsOf(jwt) })
  return { ok: true }
}
