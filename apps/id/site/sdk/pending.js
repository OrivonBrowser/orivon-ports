// What a relying site keeps between the request and the answer, in its own storage: the request in flight, and the answer
// the bridge page has put there for the page that asked. The ID site never sees either. The bridge (bridge.js) and the
// page that asks and verifies (connect.js) both read them here.

import { checkResponse, decodeResponse, isAfterPath, STATE } from './protocol.js'

/** A request older than this, in seconds, is not forwarded and not answered. */
export const PENDING_MAX_AGE = 3600
export const PENDING_KEY = 'orivonid.pending'
export const ANSWER_KEY = 'orivonid.answer'
/** The name of the BroadcastChannel the bridge tells the other tabs of the site on. */
export const CHANNEL_NAME = 'orivonid'

/** @typedef {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void, removeItem: (key: string) => void }} Store */

/**
 * @typedef {object} Pending the request in flight, which the bridge forwards and the answer is checked against
 * @property {2} v
 * @property {string} origin the audience: this site's origin
 * @property {string} nonce
 * @property {string | null} key
 * @property {number | null} ttl
 * @property {string | null} state
 * @property {string} after the path on this site where the person lands
 * @property {number} at unix seconds
 */

/**
 * `leftInAddressBar` is set when the page could not take the fragment out of the address bar and the history
 * (`history.replaceState` threw): the answer is still in the URL.
 * @typedef {({ kind: 'response', response: import('./protocol.js').SignInResponse }
 *   | { kind: 'error', error: 'cancelled', state: string | null }
 *   | { kind: 'malformed' }) & { leftInAddressBar?: true }} Answer
 */

/**
 * Where a request is kept when the site names no store: `localStorage`, because the tab the answer comes back to is not
 * always the tab that asked (Orivon opens another app's origin in a tab of its own, and `sessionStorage` is not shared
 * between tabs), and `sessionStorage` where that is unavailable.
 * @returns {Store | null}
 */
export function defaultStore () {
  for (const name of /** @type {const} */ (['localStorage', 'sessionStorage'])) {
    try {
      const store = globalThis[name]
      if (store !== undefined && store !== null) return store
    } catch {
      // Blocked storage: try the next kind.
    }
  }
  return null
}

/** @param {Store | null} [storage] @returns {Pending | null} */
export function loadPending (storage = defaultStore()) {
  try {
    const value = JSON.parse(storage?.getItem(PENDING_KEY) ?? 'null')
    const sound = value !== null && typeof value === 'object' && value.v === 2 && typeof value.nonce === 'string' && typeof value.origin === 'string' &&
      (value.key === null || typeof value.key === 'string') && (value.ttl === null || Number.isSafeInteger(value.ttl)) &&
      (value.state === null || typeof value.state === 'string') && isAfterPath(value.after) && Number.isSafeInteger(value.at)
    return sound ? value : null
  } catch {
    return null
  }
}

/** @param {Store | null} [storage] */
export function clearPending (storage = defaultStore()) {
  try {
    storage?.removeItem(PENDING_KEY)
  } catch {
    // Nothing kept, nothing to clear.
  }
}

/** @param {Pending} pending @param {number} now unix seconds */
export const pendingIsFresh = (pending, now) => now - pending.at <= PENDING_MAX_AGE && now - pending.at >= -60

/**
 * The answer a fragment carries, or null when it is not one of ours: `#orivonid=<response>` or
 * `#orivonid-error=cancelled[&state=<state>]`. A fragment of ours that cannot be read is `malformed`.
 * @param {string} hash
 * @returns {Answer | null}
 */
export function readAnswer (hash) {
  const found = /^#orivonid(-error)?=(.*)$/s.exec(hash)
  if (found === null) return null
  if (found[1] === undefined) {
    const response = decodeResponse(/** @type {string} */ (found[2]))
    return response === null ? { kind: 'malformed' } : { kind: 'response', response }
  }
  const error = /^cancelled(?:&state=(.+))?$/s.exec(/** @type {string} */ (found[2]))
  const state = error?.[1] ?? null
  if (error === null || (state !== null && !STATE.test(state))) return { kind: 'malformed' }
  return { kind: 'error', error: 'cancelled', state }
}

/** Puts an answer where the page that asked reads it. Answers whether it could. @param {Store | null} storage @param {Answer} answer @param {number} now */
export function storeAnswer (storage, answer, now) {
  try {
    if (storage === null) return false
    storage.setItem(ANSWER_KEY, JSON.stringify({ answer, at: now }))
    return true
  } catch {
    return false
  }
}

/**
 * The answer the bridge left, once: it is taken out of the store before it is read, so a second page, or the same page
 * again, finds none. Null when there is none, when it is older than PENDING_MAX_AGE or when it is not an answer.
 * @param {{ storage?: Store | null, now?: number }} [options]
 * @returns {Answer | null}
 */
export function takeAnswer (options = {}) {
  const storage = options.storage === undefined ? defaultStore() : options.storage
  const now = options.now ?? Math.floor(Date.now() / 1000)
  try {
    const text = storage?.getItem(ANSWER_KEY) ?? null
    if (text === null) return null
    storage?.removeItem(ANSWER_KEY)
    const kept = JSON.parse(text)
    if (kept === null || typeof kept !== 'object' || !Number.isSafeInteger(kept.at) || now - kept.at > PENDING_MAX_AGE) return null
    const answer = kept.answer
    if (answer?.kind === 'error' && answer.error === 'cancelled' && (answer.state === null || (typeof answer.state === 'string' && STATE.test(answer.state)))) {
      return { kind: 'error', error: 'cancelled', state: answer.state }
    }
    if (answer?.kind === 'response') {
      const response = checkResponse(answer.response)
      return response === null ? null : { kind: 'response', response }
    }
    return null
  } catch {
    return null
  }
}
