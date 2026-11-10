// A relying site's half of sign-in: make the request, read the answer out of the fragment, verify it
// (`verifySignIn`, `verifyAction`) and end sign-ins (`revokeAllCall`). This folder is copied whole into the
// site's own bundle, so its Web3 Score stays at Level 4: no request leaves it but the person's own node.

import { encodeCall, ZERO_ADDRESS, sameAddress } from './abi.js'
import { dnsEncode } from './ens.js'
import { ADDRESSES, isValidLabel, nameOf, ownerOf, readContract, SUFFIX } from './orivonid.js'
import { keyBytes, keyHex } from './p256.js'
import { recordsHeld } from './permissions.js'
import { checkRequest, CLOCK_SKEW, decodeResponse, NOT_BEFORE_KEY, requestUrl, STATE } from './protocol.js'
import { verifyAction, verifySignIn } from './verify.js'

export { FAILURES, verifyAction, verifySignIn } from './verify.js'
export { appKey } from './key.js'

/** The lifetime asked for when a site passes a key and no `ttl`: 30 days. */
export const DEFAULT_TTL = 2_592_000
/** A request older than this, in seconds, is not answered. */
export const PENDING_MAX_AGE = 3600
const PENDING_KEY = 'orivonid.pending'
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** A request that cannot be made. `reason` is a RequestProblem, or `storage` when the pending request cannot be kept. */
export class SignInRequestError extends Error {
  /** @param {string} reason @param {string} field */
  constructor (reason, field) {
    super(`${reason} (${field})`)
    this.name = 'SignInRequestError'
    this.reason = reason
    this.field = field
  }
}

/** @typedef {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void, removeItem: (key: string) => void }} Store */

/**
 * @typedef {object} Pending what the request left behind for the answer to be checked against
 * @property {string} nonce
 * @property {string} origin the audience
 * @property {string | null} key
 * @property {number | null} ttl
 * @property {string | null} state
 * @property {number} at unix seconds
 */

/** @param {(bytes: Uint8Array) => Uint8Array} random 32 characters of 62: more than 190 bits, with no modulo bias */
function newNonce (random) {
  let out = ''
  while (out.length < 32) for (const byte of random(new Uint8Array(32))) if (byte < 248 && out.length < 32) out += ALPHABET[byte % 62]
  return out
}

/**
 * Where a request is kept when the site names no store: `localStorage`, because the tab the answer comes back to is not
 * always the tab that asked (Orivon opens another app's origin in a tab of its own, and `sessionStorage` is not shared
 * between tabs), and `sessionStorage` where that is unavailable. A request is taken out when it is answered and ignored
 * after PENDING_MAX_AGE.
 * @returns {Store | null}
 */
function defaultStore () {
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

/**
 * Starts a sign-in: makes the nonce, keeps what the answer will be checked against (in `localStorage` by default, so
 * that a tab opened for the answer finds it), and answers the URL to send the person to (`location.assign(url)`). The
 * one request in flight is the one that is kept.
 * @param {object} request
 * @param {string} request.returnUrl where the person comes back: https, no fragment; its origin is the audience
 * @param {Uint8Array | string} [request.delegateKey] the key to delegate to, from `appKey(orivon)`: 33 or 65 bytes, or hex
 * @param {number} [request.ttl] seconds the delegation may last, 60 to 15552000; DEFAULT_TTL with a key
 * @param {string} [request.state] up to 256 of A-Z a-z 0-9 . _ ~ -, given back unchanged
 * @param {{ storage?: Store, random?: (bytes: Uint8Array) => Uint8Array, now?: number }} [options]
 * @returns {string}
 */
export function requestSignIn ({ returnUrl, delegateKey, ttl, state }, options = {}) {
  const key = delegateKey === undefined ? undefined : keyBytes(delegateKey)
  if (key === null) throw new SignInRequestError('badKey', 'delegateKey')
  const nonce = newNonce(options.random ?? ((bytes) => globalThis.crypto.getRandomValues(bytes)))
  const checked = checkRequest({
    v: '1',
    returnUrl,
    nonce,
    ...(state === undefined ? {} : { state }),
    ...(key === undefined ? (ttl === undefined ? {} : { ttl: String(ttl) }) : { delegate: keyHex(key), ttl: String(ttl ?? DEFAULT_TTL) })
  })
  if (!checked.ok) throw new SignInRequestError(checked.reason, checked.field)
  const { request } = checked
  const storage = options.storage ?? defaultStore()
  /** @type {Pending} */
  const pending = {
    nonce, origin: request.origin, key: request.key, ttl: request.ttl, state: request.state,
    at: options.now ?? Math.floor(Date.now() / 1000)
  }
  try {
    if (storage === null) throw new Error('no storage')
    storage.setItem(PENDING_KEY, JSON.stringify(pending))
  } catch {
    throw new SignInRequestError('storage', 'localStorage')
  }
  return requestUrl(request)
}

/** @param {Store | null} [storage] @returns {Pending | null} */
export function loadPending (storage = defaultStore()) {
  try {
    const value = JSON.parse(storage?.getItem(PENDING_KEY) ?? 'null')
    const sound = value !== null && typeof value === 'object' && typeof value.nonce === 'string' && typeof value.origin === 'string' &&
      (value.key === null || typeof value.key === 'string') && (value.ttl === null || Number.isSafeInteger(value.ttl)) &&
      (value.state === null || typeof value.state === 'string') && Number.isSafeInteger(value.at)
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

/**
 * `leftInAddressBar` is set when the page could not take the fragment out of the address bar and the history
 * (`history.replaceState` threw): the answer is still in the URL, and the page should say so or navigate away.
 * @typedef {({ kind: 'response', response: import('./protocol.js').SignInResponse }
 *   | { kind: 'error', error: 'cancelled' | 'invalid-request', state: string | null }
 *   | { kind: 'malformed' }) & { leftInAddressBar?: true }} Answer
 */

/**
 * Reads the answer out of the URL fragment and removes it from the address bar and the history, so a reload or a
 * shared link does not carry it. Answers null when the fragment is not one of ours, and leaves it alone. A
 * `replaceState` that throws does not stop the reading: the answer comes back marked `leftInAddressBar`.
 * @param {{ hash: string, pathname: string, search: string }} location
 * @param {{ history?: { replaceState: (data: unknown, title: string, url: string) => void } }} [options]
 * @returns {Answer | null}
 */
export function readResponse (location, options = {}) {
  const found = /^#orivonid(-error)?=(.*)$/s.exec(location.hash)
  if (found === null) return null
  /** @type {{ leftInAddressBar?: true }} */
  let cleared = {}
  const history = options.history ?? globalThis.history
  try {
    history.replaceState(null, '', location.pathname + location.search)
  } catch {
    cleared = { leftInAddressBar: true }
  }
  if (found[1] === undefined) {
    const response = decodeResponse(/** @type {string} */ (found[2]))
    return response === null ? { kind: 'malformed', ...cleared } : { kind: 'response', response, ...cleared }
  }
  const error = /^(cancelled|invalid-request)(?:&state=(.+))?$/s.exec(/** @type {string} */ (found[2]))
  const state = error?.[2] ?? null
  if (error === null || (state !== null && !STATE.test(state))) return { kind: 'malformed', ...cleared }
  return { kind: 'error', error: /** @type {'cancelled' | 'invalid-request'} */ (error[1]), state, ...cleared }
}

/**
 * Verifies the answer against the request kept for it, once. The request is taken out of the store before anything is
 * checked, so a second presentation of the same answer, at once or later, finds none. It goes back only when the node
 * could not answer (`chainUnavailable`: nothing was decided, so the person may try again) or the call threw.
 * @param {unknown} response
 * @param {{ chain: import('./chain.js').Chain, now: number, origin?: string, storage?: Store }} options `origin` is this page's, when it is not the return URL's
 * @returns {ReturnType<typeof verifySignIn>}
 */
export async function completeSignIn (response, options) {
  const storage = options.storage ?? defaultStore()
  const pending = loadPending(storage)
  clearPending(storage)
  if (pending === null || options.now - pending.at > PENDING_MAX_AGE) return { ok: false, failure: 'noPendingRequest' }
  /** @type {Awaited<ReturnType<typeof verifySignIn>>} */
  let verdict
  try {
    verdict = await verifySignIn(response, {
      chain: options.chain, origin: options.origin ?? pending.origin, nonce: pending.nonce, key: pending.key,
      ...(pending.ttl === null ? {} : { ttl: pending.ttl }), state: pending.state, now: options.now
    })
  } catch (error) {
    keepPending(storage, pending)
    throw error
  }
  if (!verdict.ok && verdict.failure === 'chainUnavailable') keepPending(storage, pending)
  return verdict
}

/** Puts back a request that was taken but not decided, unless the page has made a newer one since. @param {Store | null} storage @param {Pending} pending */
function keepPending (storage, pending) {
  if (loadPending(storage) !== null) return
  try {
    storage?.setItem(PENDING_KEY, JSON.stringify(pending))
  } catch {
    // The request cannot be kept: the person signs in again.
  }
}

/**
 * The calldata that sets a name's revocation record to `nowSeconds`, which ends every sign-in made no later than that.
 * @param {string} name a label, or the full name
 * @param {number} nowSeconds
 */
export function revokeAllCalldata (name, nowSeconds) {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new TypeError('a time in whole seconds')
  return encodeCall('setText(bytes,string,string)', [dnsEncode(nameOf(labelOf(name))), NOT_BEFORE_KEY, String(nowSeconds)])
}

/** @param {string} name */
function labelOf (name) {
  const label = name.endsWith(`.${SUFFIX}`) ? name.slice(0, -SUFFIX.length - 1) : name
  if (!isValidLabel(label)) throw new TypeError(`not a username under ${SUFFIX}: ${name}`)
  return label
}

/** Every reason a RevokeError carries. */
export const REVOKE_REASONS = ['noResolver', 'noOwner', 'recordsNotHeld']

/** Why the call to end all sign-ins cannot be made: `noResolver`, `noOwner`, or `recordsNotHeld` (`detail` is the permissions.js problem). */
export class RevokeError extends Error {
  /** @param {'noResolver' | 'noOwner' | 'recordsNotHeld'} reason @param {string} message @param {string} [detail] */
  constructor (reason, message, detail = '') {
    super(message)
    this.name = 'RevokeError'
    this.reason = reason
    this.detail = detail
  }
}

/**
 * The transaction that ends all sign-ins of a name: `setText` on the resolver the registry names for it, for the
 * holder to send. It writes `nowSeconds + CLOCK_SKEW`, because a sign-in may be issued that far ahead of a verifier's
 * clock and must not outlive the record. Rejects with a RevokeError when the name has no resolver or no holder, or
 * when the holder cannot write the name's records on its resolver, since the transaction would only revert.
 * @param {import('./chain.js').Chain} chain
 * @param {string} name a label, or the full name
 * @param {number} nowSeconds
 * @param {{ holder?: string }} [options] who will send it; the registry's holder of the name by default
 * @returns {Promise<{ to: string, data: Uint8Array }>}
 */
export async function revokeAllCall (chain, name, nowSeconds, options = {}) {
  const label = labelOf(name)
  const data = revokeAllCalldata(label, nowSeconds + CLOCK_SKEW)
  const [resolver] = await readContract(chain, ADDRESSES.r1, 'getResolver(string)', [label], ['address'])
  if (sameAddress(/** @type {string} */ (resolver), ZERO_ADDRESS)) throw new RevokeError('noResolver', `${name} has no resolver to set a record on`)
  const holder = options.holder ?? await ownerOf(chain, label)
  if (holder === null) throw new RevokeError('noOwner', `${name} has no holder to send it`)
  const held = await recordsHeld((to, signature, args, outputs) => readContract(chain, to, signature, args, outputs), {
    resolver: /** @type {string} */ (resolver), holder, factory: ADDRESSES.verifiableFactory, implementation: ADDRESSES.resolverImplementation
  })
  if (!held.ok) throw new RevokeError('recordsNotHeld', `${name}: the holder cannot write its records on its resolver (${held.problem})`, held.problem)
  return { to: /** @type {string} */ (resolver), data }
}
