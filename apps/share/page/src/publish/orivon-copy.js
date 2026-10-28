// Keeping a share on Orivon's server too, when the person ticks the box: the share's CAR, made from the bytes
// kept on this computer, goes to the copy service (apps/share/copy/), which keeps it for 30 days. The share's
// address is computed here, and the copy counts only when the service answers with that address. A protected
// share's CAR holds the age file and the note, nothing else, so the service never sees what the password
// protects. One `[share-copy]` line per attempt goes to the page's console, which a bug report carries.

import { parseCid } from '../ipfs/cid.js'

/** The copy service, behind Orivon's telemetry host. */
export const COPY_SERVICE = 'https://telemetry.orivonstack.com/share'
/** The most one copy holds, as a CAR: the service refuses a larger one, so the page does not send it (provisional, README). */
export const COPY_MAX_BYTES = 200 * 1024 * 1024
export const COPY_DAYS = 30
export const COPY_LABEL = 'Orivon\'s server'

const MESSAGE_LIMIT = 300

/** @typedef {'too-large' | 'unreachable' | 'refused' | 'mismatch' | 'bad-answer' | 'aborted'} CopyErrorKind */
export class CopyError extends Error {
  /** @param {CopyErrorKind} kind @param {string} message */
  constructor (kind, message) {
    super(message)
    this.name = 'CopyError'
    this.kind = kind
  }
}

/** @param {number} bytes */
function tooLarge (bytes) {
  return new CopyError('too-large', `A copy on Orivon's server holds ${COPY_MAX_BYTES / 1048576} MiB at most, and this share is ${(bytes / 1048576).toFixed(0)} MiB. It is still online from this computer.`)
}

/** The service's own words from an error body, or ''. @param {string} text */
function wordsOf (text) {
  try {
    const said = JSON.parse(text.trim().split('\n')[0] ?? '')?.Message
    return typeof said === 'string' ? said.slice(0, MESSAGE_LIMIT) : ''
  } catch {
    return ''
  }
}

/**
 * One request to the service: the text of a 2xx answer, or the refusal in the service's words.
 * @param {string} url @param {RequestInit} init @param {{ fetchImpl: typeof fetch, signal?: AbortSignal | undefined }} context
 */
async function request (url, init, { fetchImpl, signal }) {
  let response
  let text
  try {
    response = await fetchImpl(url, { ...init, ...(signal ? { signal } : {}) })
    text = await response.text()
  } catch (error) {
    if (signal?.aborted || /** @type {any} */ (error)?.name === 'AbortError') throw new CopyError('aborted', 'The upload was cancelled.')
    throw new CopyError('unreachable', 'Could not reach Orivon\'s server. Check your connection and try again.')
  }
  if (!response.ok) {
    const said = wordsOf(text)
    throw new CopyError(response.status === 413 ? 'too-large' : 'refused', said === '' ? `Orivon's server refused the copy (status ${response.status}).` : said)
  }
  return text
}

/**
 * The answer's address and the time it keeps the copy until, accepted only for `root`.
 * @param {string} text @param {string} root
 * @returns {{ kept: boolean, keptUntil: number | null }}
 */
function answerOf (text, root) {
  let entry
  try {
    entry = JSON.parse(text.trim().split('\n')[0] ?? '')
  } catch {
    throw new CopyError('bad-answer', 'Orivon\'s server answered in a form this page does not understand.')
  }
  let hash
  try {
    hash = parseCid(String(entry?.Hash ?? '')).string
  } catch {
    throw new CopyError('bad-answer', 'Orivon\'s server did not say which address it kept.')
  }
  if (hash !== root) throw new CopyError('mismatch', `Orivon's server kept something other than this share: it reports ${hash}, and this share is ${root}. Nothing was recorded as kept there.`)
  const until = typeof entry.KeptUntil === 'string' ? Date.parse(entry.KeptUntil) : NaN
  return { kept: Number.isFinite(until), keptUntil: Number.isFinite(until) ? until : null }
}

/**
 * Sends the kept share to the copy service, unless the service already keeps it, and resolves with until when.
 * @param {ReturnType<typeof import('../keep/store.js').createKeep>} keep
 * @param {string} cid
 * @param {{ signal?: AbortSignal, onProgress?: (progress: { step: 'send', text: string }) => void, fetchImpl?: typeof fetch, service?: string }} [options]
 * @returns {Promise<{ label: string, ok: true, keptUntil: number | null }>}
 */
export async function keepOnOrivon (keep, cid, { signal, onProgress = () => {}, fetchImpl = fetch, service = COPY_SERVICE } = {}) {
  const root = parseCid(cid).string
  const tag = root.slice(0, 12)
  try {
    const meta = await keep.meta(root)
    if (meta === null) throw new Error('That share is not kept on this computer.')
    if (meta.stored > COPY_MAX_BYTES) throw tooLarge(meta.stored)
    onProgress({ step: 'send', text: 'Sending a copy to Orivon\'s server' })
    const car = await keep.car(root)
    if (car.size > COPY_MAX_BYTES) throw tooLarge(car.size)
    const context = { fetchImpl, signal }
    const base = service.replace(/\/+$/, '')
    // Asked first, so a copy already kept, or one that would be refused, costs no upload.
    const asked = answerOf(await request(`${base}/api/v0/status?arg=${root}&size=${car.size}`, { method: 'POST' }, context), root)
    let keptUntil = asked.keptUntil
    if (!asked.kept) {
      const sent = answerOf(await request(`${base}/api/v0/keep?arg=${root}`, { method: 'POST', headers: { 'content-type': 'application/vnd.ipld.car' }, body: car }, context), root)
      if (!sent.kept) throw new CopyError('bad-answer', 'Orivon\'s server did not say until when it keeps the copy.')
      keptUntil = sent.keptUntil
    }
    console.warn(`[share-copy] ${asked.kept ? 'already kept' : 'kept'} ${tag}… (${car.size} bytes)${keptUntil === null ? '' : ` until ${new Date(keptUntil).toISOString().slice(0, 10)}`}`)
    return { label: COPY_LABEL, ok: true, keptUntil }
  } catch (error) {
    console.warn(`[share-copy] not kept ${tag}…: ${error instanceof CopyError ? `${error.kind}, ` : ''}${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}
