// A relying site's half of sign-in: make the request, hear the answer the bridge page left, verify it (`verifySignIn`,
// `verifyAction`) and end sign-ins (`revokeAllCall`). This folder is served at `/.well-known/orivon-id/` of the site, whole,
// so its Web3 Score stays at Level 4: no request leaves it but the person's own node.

import { encodeCall, ZERO_ADDRESS, sameAddress } from './abi.js'
import { dnsEncode } from './ens.js'
import { appKey } from './key.js'
import { ADDRESSES, isValidLabel, nameOf, ownerOf, readContract, SUFFIX } from './orivonid.js'
import { clearPending, CHANNEL_NAME, defaultStore, loadPending, PENDING_KEY, PENDING_MAX_AGE } from './pending.js'
import { recordsHeld } from './permissions.js'
import { arrivalUrl, checkAudience, checkRequest, CLOCK_SKEW, isAfterPath, NOT_BEFORE_KEY, randomToken } from './protocol.js'
import { verifySignIn } from './verify.js'

export { FAILURES, verifyAction, verifySignIn } from './verify.js'
export { appKey } from './key.js'
export { clearPending, loadPending, PENDING_MAX_AGE, takeAnswer } from './pending.js'

/** The lifetime asked for when a site asks for a key and no `ttl`: 30 days. */
export const DEFAULT_TTL = 2_592_000

/** @typedef {import('./pending.js').Store} Store */
/** @typedef {import('./pending.js').Pending} Pending */
/** @typedef {import('./pending.js').Answer} Answer */

/** A request that cannot be made. `reason` is a RequestProblem, `badAfter`, `badKey`, `olderOption`, or `storage` when the pending request cannot be kept. */
export class SignInRequestError extends Error {
  /** @param {string} reason @param {string} field */
  constructor (reason, field) {
    super(`${reason} (${field})`)
    this.name = 'SignInRequestError'
    this.reason = reason
    this.field = field
  }
}

/**
 * Starts a sign-in: makes the nonce, keeps the request in this site's own storage (`localStorage` by default, so that
 * a tab opened for the answer finds it) for the bridge page to forward, and answers the link to send the person to
 * (`location.assign(url)`). The link carries this site's origin and nothing else. The one request in flight is the one
 * that is kept.
 * @param {object} [request]
 * @param {boolean} [request.delegate] ask for the key Orivon keeps for this origin (`appKey`), which `options.orivon` reads
 * @param {number} [request.ttl] seconds the delegation may last, 60 to 15552000; DEFAULT_TTL with a key
 * @param {string} [request.state] up to 256 of A-Z a-z 0-9 . _ ~ -, given back unchanged
 * @param {string} [request.after] the path on this site where the person lands after the answer: `/` and then no `/` or `\`; `/` by default
 * @param {{ orivon?: Parameters<typeof appKey>[0], origin?: string, random?: (bytes: Uint8Array) => Uint8Array, now?: number }} [options]
 *   `origin` is this page's own, `location.origin` by default. The request is always kept where the bridge page reads it, so there is no `storage` option
 * @returns {Promise<string>}
 */
export async function requestSignIn (request = {}, options = {}) {
  for (const name of ['returnUrl', 'delegateKey']) if (name in request) throw new SignInRequestError('olderOption', name)
  if ('storage' in options) throw new SignInRequestError('olderOption', 'storage')
  const { delegate, ttl, state, after = '/' } = request
  if (delegate !== undefined && typeof delegate !== 'boolean') throw new SignInRequestError('badKey', 'delegate')
  if (!isAfterPath(after)) throw new SignInRequestError('badAfter', 'after')
  const origin = options.origin ?? globalThis.location?.origin
  const audience = checkAudience(origin)
  if (!audience.ok) throw new SignInRequestError(audience.reason, 'origin')
  /** @type {string | undefined} */
  let key
  if (delegate === true) {
    if (options.orivon === undefined) throw new SignInRequestError('badKey', 'orivon')
    key = (await appKey(options.orivon, { origin: audience.origin })).hex
  }
  const nonce = randomToken(options.random ?? ((bytes) => globalThis.crypto.getRandomValues(bytes)))
  const checked = checkRequest({
    audience: audience.origin,
    nonce,
    ...(state === undefined ? {} : { state }),
    ...(key === undefined ? (ttl === undefined ? {} : { ttl: String(ttl) }) : { delegate: key, ttl: String(ttl ?? DEFAULT_TTL) })
  })
  if (!checked.ok) throw new SignInRequestError(checked.reason, checked.field)
  const storage = defaultStore()
  /** @type {Pending} */
  const pending = {
    v: 2, origin: checked.request.origin, nonce, key: checked.request.key, ttl: checked.request.ttl, state: checked.request.state, after,
    at: options.now ?? Math.floor(Date.now() / 1000)
  }
  try {
    if (storage === null) throw new Error('no storage')
    storage.setItem(PENDING_KEY, JSON.stringify(pending))
  } catch {
    throw new SignInRequestError('storage', 'localStorage')
  }
  return arrivalUrl(checked.request.origin)
}

/**
 * Calls `handler` when the bridge page, in another tab of this site, has left an answer: that tab is the one that
 * asked when the person signed in through a new tab. The handler reads it with `takeAnswer()`. Answers a function that
 * stops listening.
 * @param {() => void} handler
 * @param {{ channel?: new (name: string) => { onmessage: ((event: { data?: unknown }) => void) | null, close: () => void } }} [options]
 * @returns {() => void}
 */
export function onAnswer (handler, options = {}) {
  const Channel = options.channel ?? globalThis.BroadcastChannel
  if (typeof Channel !== 'function') return () => {}
  const channel = new Channel(CHANNEL_NAME)
  channel.onmessage = (event) => {
    const data = /** @type {{ kind?: unknown } | null | undefined} */ (event.data)
    if (data !== null && typeof data === 'object' && data.kind === 'answer') handler()
  }
  return () => { channel.close() }
}

/**
 * Verifies the answer against the request kept for it, once. The request is taken out of the store before anything is
 * checked, so a second presentation of the same answer, at once or later, finds none. It goes back only when the node
 * could not answer (`chainUnavailable`: nothing was decided, so the person may try again) or the call threw.
 * @param {unknown} response
 * @param {{ chain: import('./chain.js').Chain, now: number, origin?: string, storage?: Store }} options `origin` is this page's, when it is not the one the request was made for
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
