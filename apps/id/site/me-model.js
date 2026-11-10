// What My IDs says about each ID, and the small things its actions need. Pure, except the cache helpers, which take
// the store they are given.

import { notOffered } from './offer-model.js'
import { recordsNotHeldWords } from './connect-request.js'
import { toHex } from './sdk/bytes.js'
import { RevokeError } from './sdk/connect.js'
import { nameOf } from './sdk/orivonid.js'
import { NOT_BEFORE_KEY } from './sdk/protocol.js'
import { REASONS, reasonOfError } from './register-reasons.js'
import { formatTime } from './words.js'

/** Text records worth showing without being asked for; a person can add any other key. */
export const COMMON_KEYS = Object.freeze(['avatar', 'description', 'url', 'com.github', 'com.twitter', 'org.telegram', 'email'])

/** @typedef {import('./sdk/orivonid.js').Attribution} Attribution */

/** Whether an ID can sign in, and if not, why in words and what to do. @param {Attribution} one @returns {{ ok: boolean, tone: 'ok' | 'warn', label: string, why: string | null }} */
export function nameStatus (one) {
  if (one.ok) return { ok: true, tone: 'ok', label: 'Can sign in', why: null }
  const offer = notOffered(one)
  return { ok: false, tone: 'warn', label: 'Cannot sign in yet', why: [offer?.words, offer?.remedy].filter(Boolean).join(' ') }
}

const CONTENTHASH_KINDS = /** @type {Record<string, string>} */ ({ e3: 'IPFS', e4: 'Swarm', e5: 'IPNS' })

/** @param {Uint8Array | null} bytes @returns {{ kind: string, hex: string } | null} */
export function contenthashView (bytes) {
  if (bytes === null || bytes.length === 0) return null
  const hex = toHex(bytes)
  return { kind: CONTENTHASH_KINDS[hex.slice(0, 2)] ?? 'Other', hex: `0x${hex}` }
}

/** The records that differ from what was read; an emptied record is sent as an empty string. @param {Record<string, string | null>} before @param {Record<string, string>} after */
export function changedTexts (before, after) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(after)) if ((before[key] ?? '') !== value.trim()) out[key] = value.trim()
  return out
}

/** The time a name's sign-ins were last ended, from its record, or null. @param {string | null | undefined} value */
export function endedAt (value) {
  if (value === null || value === undefined || !/^[1-9][0-9]{0,15}$/.test(value)) return null
  return { seconds: Number(value), text: formatTime(Number(value)) }
}

/**
 * The end time a sign-in made at `now` would still run into, when the record is ahead of the clock: such a sign-in is void
 * at once, because it is issued no later than the record. Null when the record is none, unreadable or in the past.
 * @param {string | null | undefined} value
 * @param {number} now unix seconds
 */
export function endedAhead (value, now) {
  const ended = endedAt(value)
  return ended !== null && ended.seconds >= now ? ended : null
}

/** What an ID's card says of the sign-ins ended with it. @param {ReturnType<typeof endedAt>} ended @param {number} now unix seconds */
export function signInsWords (ended, now) {
  if (ended === null) return 'None have been ended.'
  return ended.seconds >= now
    ? `Every sign-in made until ${ended.text} has been ended. A new one works after that.`
    : `Every sign-in made before ${ended.text} has been ended.`
}

/** @param {string} key */
export const isReservedKey = (key) => key === NOT_BEFORE_KEY

/** The words of the confirmation before "End all sign-ins". @param {string} name */
export function endSignInsWords (name) {
  return {
    title: `End all sign-ins made with ${name}?`,
    body: [
      'Every site you signed in to with this ID will stop accepting that sign-in, and so will any key it was given. They will ask you to sign in again.',
      `This sends one transaction that writes the current time to a public record of ${name}. It costs gas and it cannot be taken back once it is mined. Signing in again works after five minutes.`,
      'It does not move or change the ID, and it does not touch your other IDs.'
    ],
    confirm: 'End all sign-ins',
    cancel: 'Keep them'
  }
}

/**
 * Whether the button that ends all sign-ins is offered, from what `revokeAllCall` said when it was asked before the card
 * was drawn: nothing (it is), a RevokeError (it is not, and why in words), or a failure to ask (try again).
 * @param {string} label
 * @param {unknown} error what the call threw, or null
 * @returns {{ canEnd: true } | { canEnd: false, words: string, remedy: string | null, retry: boolean }}
 */
export function endAvailability (label, error) {
  if (error === null) return { canEnd: true }
  const name = nameOf(label)
  if (!(error instanceof RevokeError)) {
    return { canEnd: false, words: REASONS[reasonOfError(error).reason]?.words ?? 'Whether you can end its sign-ins could not be checked.', remedy: null, retry: true }
  }
  if (error.reason === 'noOwner') return { canEnd: false, words: `${name} has no holder, so nobody can end its sign-ins.`, remedy: null, retry: false }
  const problem = error.reason === 'noResolver' ? 'noResolver' : error.detail
  const found = recordsNotHeldWords(name, problem)
  return { canEnd: false, words: found.words, remedy: found.remedy, retry: problem === 'unreadable' }
}

/** What Orivon ID will never do with an ID, so a request for it elsewhere reads as wrong. */
export const PERMANENT_NOTES = Object.freeze([
  'Orivon ID never asks you to approve another account to move your IDs (setApprovalForAll). If any page asks for that, decline: ' +
    'an approved account acts with your rights on every ID you hold, including taking them away.',
  'Revoking an admin right on an ID is permanent, and nobody can grant it back. Orivon ID does not do it. Check what any other tool is about to sign before you let it.'
])

const CACHE_PREFIX = 'orivonid.names.v1.'

/** @typedef {{ get: (key: string) => unknown, set: (key: string, value: string) => unknown }} Store */

/** The scan a past visit kept, or null if there is none or it is not ours. @param {Store} store @param {string} address */
export function readCache (store, address) {
  try {
    const raw = store.get(CACHE_PREFIX + address.toLowerCase())
    if (raw === null || raw === undefined) return null
    const cache = JSON.parse(String(raw))
    const sound = cache?.version === 1 && Number.isSafeInteger(cache.lastBlock) && typeof cache.address === 'string' &&
      cache.labels !== null && typeof cache.labels === 'object' && Object.values(cache.labels).every((label) => typeof label === 'string') &&
      Array.isArray(cache.held) && cache.held.every((/** @type {unknown} */ label) => typeof label === 'string')
    return sound ? cache : null
  } catch {
    return null
  }
}

/** @param {Store} store @param {string} address @param {unknown} cache */
export function writeCache (store, address, cache) {
  try {
    store.set(CACHE_PREFIX + address.toLowerCase(), JSON.stringify(cache))
  } catch {
    // The cache only saves the next visit a scan; the page works without it.
  }
}

const KEYS_PREFIX = 'orivonid.keys.v1'

/** The record keys a person added themselves. @param {Store} store @returns {string[]} */
export function readKeys (store) {
  try {
    const keys = JSON.parse(String(store.get(KEYS_PREFIX) ?? '[]'))
    return Array.isArray(keys) ? keys.filter((key) => typeof key === 'string' && key !== '' && key.length <= 64) : []
  } catch {
    return []
  }
}

/** @param {Store} store @param {string[]} keys */
export function writeKeys (store, keys) {
  try {
    store.set(KEYS_PREFIX, JSON.stringify([...new Set(keys)].slice(0, 32)))
  } catch {
    // As above.
  }
}
