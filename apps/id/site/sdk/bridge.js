// The bridge: the one page of a relying site that the ID site sends the person to (BRIDGE_PATH), served as this SDK
// writes it. It runs as the relying site in the person's own browser, so it can read the request the site kept, which the
// ID site cannot, and it states its own address as the referrer of its next navigation, which only the browser can write.
// PROTOCOL.md section 4 says what each visit does.

import { checkFields, confirmationUrl, ID_ORIGIN, isChallenge } from './protocol.js'
import { clearPending, loadPending, pendingIsFresh, readAnswer, storeAnswer } from './pending.js'
import { parseMessage } from './siwe.js'

/**
 * @typedef {'framed' | 'badLink' | 'notFromId' | 'forwarded' | 'forwardedNone' | 'landed' | 'malformed' | 'noRequest' | 'wrongNonce' | 'wrongState' | 'notStored'} BridgeOutcome
 * framed, badLink, notFromId: nothing was done and nothing is navigated to (an answer's visit that did not come from the ID site has
 * only taken the fragment out of the address bar). forwarded, forwardedNone: the person goes back to the ID site with the request, or
 * with `none`. The rest are the answer's visit: landed, or an answer dropped for the reason given.
 */

/**
 * @param {object} env
 * @param {{ origin: string, search: string, hash: string }} env.location this page's
 * @param {string} env.referrer `document.referrer`
 * @param {boolean} env.framed whether the page runs inside a frame
 * @param {import('./pending.js').Store | null} env.storage the site's own storage
 * @param {(url: string) => void} env.replace `location.replace`: the visit does not stay in the history
 * @param {() => void} env.clearHash takes the fragment out of the address bar and the history
 * @param {(message: { kind: 'answer' }) => void} env.broadcast tells the other tabs of this site
 * @param {number} env.now unix seconds
 * @returns {{ outcome: BridgeOutcome, url?: string }}
 */
export function runBridge (env) {
  if (env.framed) return { outcome: 'framed' }
  return env.location.hash.startsWith('#orivonid') ? land(env) : forward(env)
}

/** @param {Parameters<typeof runBridge>[0]} env */
function forward (env) {
  const found = /^\?c=([A-Za-z0-9]+)$/.exec(env.location.search)
  const c = found?.[1]
  if (!isChallenge(c)) return { outcome: 'badLink' }
  if (originOf(env.referrer) !== ID_ORIGIN) return { outcome: 'notFromId' }
  const pending = loadPending(env.storage)
  const checked = pending !== null && pending.origin === env.location.origin && pendingIsFresh(pending, env.now)
    ? checkFields({
      nonce: pending.nonce,
      ...(pending.state === null ? {} : { state: pending.state }),
      ...(pending.key === null ? {} : { delegate: pending.key, ttl: String(pending.ttl) })
    })
    : null
  const url = confirmationUrl(/** @type {string} */ (c), checked !== null && checked.ok ? checked.fields : null)
  env.replace(url)
  return { outcome: checked !== null && checked.ok ? 'forwarded' : 'forwardedNone', url }
}

/** @param {Parameters<typeof runBridge>[0]} env */
function land (env) {
  const hash = env.location.hash
  env.clearHash()
  if (originOf(env.referrer) !== ID_ORIGIN) return { outcome: 'notFromId' }
  const pending = loadPending(env.storage)
  const live = pending !== null && pending.origin === env.location.origin && pendingIsFresh(pending, env.now) ? pending : null
  const after = live === null ? '/' : live.after
  const answer = readAnswer(hash)
  if (live === null) return leave(env, '/', 'noRequest')
  if (answer === null || answer.kind === 'malformed') return leave(env, after, 'malformed')
  if (answer.kind === 'response') {
    if (nonceOf(answer.response.message) !== live.nonce) return leave(env, after, 'wrongNonce')
  } else if (answer.state !== null && answer.state !== live.state) {
    return leave(env, after, 'wrongState')
  }
  const kept = answer.kind === 'response' ? answer : { ...answer, state: live.state }
  if (!storeAnswer(env.storage, kept, env.now)) return leave(env, after, 'notStored')
  if (answer.kind === 'error') clearPending(env.storage)
  env.broadcast({ kind: 'answer' })
  return leave(env, after, 'landed')
}

/** @param {Parameters<typeof runBridge>[0]} env @param {string} path @param {BridgeOutcome} outcome */
function leave (env, path, outcome) {
  env.replace(path)
  return { outcome, url: path }
}

/** @param {string} message @returns {string | null} */
function nonceOf (message) {
  try {
    return parseMessage(message).nonce
  } catch {
    return null
  }
}

/** @param {string} referrer */
function originOf (referrer) {
  try {
    return new URL(referrer).origin
  } catch {
    return null
  }
}
