// What the consent screen says, from the request and the choices made on it. The wording of what the person agrees
// to is the protocol's (PROTOCOL.md section 2). Pure.

import {
  arrivalWords, checkArrival, ConnectError, exitTarget, lifetimeOptions, maxLifetime, parseRequest, recordsNotHeldWords, returnDisplay
} from './connect-request.js'
import { notOffered } from './offer-model.js'
import { nameOf, SUFFIX } from './sdk/orivonid.js'
import { MAX_NAMES, MIN_TTL, PLAIN_LIFETIME } from './sdk/protocol.js'
import { REASONS, reasonOfError } from './register-reasons.js'
import { formatDuration, formatTime, keyPreview } from './words.js'

/** @typedef {import('./sdk/protocol.js').Request} Request */

/** Why a request was refused, for each name `parseRequest` gives. */
export const PROBLEM_WORDS = Object.freeze({
  notConnect: 'This address is not a sign-in request.',
  malformed: 'Part of the request is damaged: it is not written as name=value, or it has a broken escape.',
  duplicate: 'The request gives the same field twice.',
  unknownField: 'The request has a field that sign-in version 1 does not have.',
  badVersion: 'The request is for another version of the sign-in. This page speaks version 1.',
  missingReturn: 'The request does not say where to send you back.',
  returnTooLong: 'The address to send you back to is longer than 2048 characters.',
  returnNotAscii: 'The address to send you back to uses characters outside plain ASCII. A host outside ASCII must be written in punycode.',
  returnNotUrl: 'The address to send you back to is not a web address.',
  returnNotHttps: 'The address to send you back to is not secure. Only https addresses are accepted.',
  returnHasFragment: 'The address to send you back to already has a # part. It cannot, because the answer is written there.',
  returnHasCredentials: 'The address to send you back to carries a user name or a password.',
  audienceTooLong: 'The site asking has an address longer than 64 characters. A sign-in cannot show that much of it, so it is not accepted.',
  missingNonce: 'The request has no one-time code (nonce), so an answer could not be told from a replay.',
  badNonce: 'The one-time code (nonce) must be 16 to 64 letters and digits.',
  badState: 'The state value must be 1 to 256 letters, digits or the characters . _ ~ -',
  badKey: 'The key the site wants to delegate to is not a valid P-256 key.',
  missingTtl: 'The request asks for a key but does not say how long it may last.',
  badTtl: 'The lifetime asked for must be between 60 seconds and 180 days.',
  ttlWithoutKey: 'The request gives a lifetime but no key.'
})

/**
 * What the person is told before the wallet opens. The message is written for this site (its domain) and gives the site
 * signed in to as its URI, so a wallet that checks the URI against the domain warns about every sign-in made here.
 * @param {string} audience the origin of the site signed in to
 */
export const walletWarningWords = (audience) =>
  `Your wallet will warn you about this sign-in. That is expected: this site signs you in on behalf of ${audience}, ` +
  `so the URI in the message is that site's, not this one's. Before you confirm, check that the URI it shows is ${audience}.`

/** @param {string} reason @param {string} field */
export const problemWords = (reason, field) => {
  const words = /** @type {Record<string, string>} */ (PROBLEM_WORDS)[reason] ?? 'The request cannot be read.'
  return field === '' || field === 'hash' ? words : `${words} (${field})`
}

/**
 * What the screen for a request is, decided before anything is drawn: the request read, and how the person arrived
 * (the page's `document.referrer`, and whether it runs in a frame) checked against the site that would be signed in
 * to. `exit` is the only place the screen may navigate to besides the answer: null shows no way back to the site.
 * @param {{ hash: string, referrer: string, framed: boolean }} parts
 * @returns {{ kind: 'invalid', words: string, returnOrigin: string | null, note: string | null, exit: ReturnType<typeof exitTarget> }
 *   | { kind: 'stopped', request: Request, words: string }
 *   | { kind: 'consent', request: Request, warning: string | null, returnShown: ReturnType<typeof returnDisplay>, exit: NonNullable<ReturnType<typeof exitTarget>> }}
 */
export function connectEntry ({ hash, referrer, framed }) {
  const parsed = parseRequest(hash)
  const exit = exitTarget(parsed, { referrer, framed })
  if (!parsed.ok) {
    const returnOrigin = parsed.returnUrl === null ? null : new URL(parsed.returnUrl).origin
    const note = returnOrigin !== null && exit === null
      ? `The request names ${returnOrigin} as the place to go back to, but this page cannot tell that you came from there, so it sends nothing back.`
      : null
    return { kind: 'invalid', words: problemWords(parsed.reason, parsed.field), returnOrigin, note, exit }
  }
  const arrival = checkArrival({ request: parsed.request, referrer, framed })
  if (!arrival.ok || exit === null) return { kind: 'stopped', request: parsed.request, words: arrivalWords(arrival) ?? 'This sign-in cannot continue here.' }
  return { kind: 'consent', request: parsed.request, warning: arrivalWords(arrival), returnShown: returnDisplay(parsed.request), exit }
}

/** The words for a sign-in that stopped before anything was sent. @param {unknown} error @returns {{ words: string, retry: boolean }} */
export function signInFailure (error) {
  if (error instanceof ConnectError) {
    const reasons = /** @type {Record<string, { words: string, retry: boolean }>} */ ({
      names: { words: `Choose from 1 to ${MAX_NAMES} IDs to share.`, retry: true },
      lifetime: { words: 'Choose how long the sign-in lasts.', retry: true },
      wrongAccount: { words: 'Your wallet now shows another address than the one on this screen. Nothing was signed. Reload the page to start again.', retry: false },
      notAttributed: {
        words: `${error.detail === '' ? 'An ID' : `${error.detail}.${SUFFIX}`} no longer belongs to this address, so nothing was signed. ` +
          'Reload the page to see the IDs you hold now.',
        retry: false
      },
      wrongSigner: { words: 'The signature does not come from your address, so it was not sent. Nothing was shared.', retry: true },
      resolvers: { words: 'An ID you chose has no resolver to tie the sign-in to, so nothing was signed. Reload the page to see the IDs you hold now.', retry: false },
      recordsNotHeld: heldWords(error)
    })
    return reasons[error.reason] ?? { words: 'The sign-in stopped.', retry: true }
  }
  const found = reasonOfError(error)
  if (found.reason === 'declined') return { words: 'You declined to sign, so nothing was shared.', retry: true }
  return { words: REASONS[found.reason]?.words ?? found.detail, retry: true }
}

/** @param {ConnectError} error `recordsNotHeld`: the ID is the error's detail, why is its problem */
function heldWords (error) {
  const found = recordsNotHeldWords(nameOf(error.detail), error.problem)
  return { words: `${found.words} Nothing was signed. ${found.remedy}`, retry: error.problem === 'unreadable' }
}

/** The lifetimes to offer, each in words. @param {Request} request @returns {{ seconds: number, label: string }[]} */
export const lifetimeChoices = (request) => lifetimeOptions(request).map((seconds) => ({ seconds, label: formatDuration(seconds) }))

/** @typedef {{ label: string, reason: string, name: string, words: string, remedy: string | null, link: { href: string, label: string } | null }} Unusable */

/**
 * Why an ID that holds up on chain still cannot sign in now: its sign-ins were just ended, and one made before the end
 * time of that record would be void as soon as the site checked it.
 * @param {string} label
 * @param {number} until the record, unix seconds
 * @returns {Unusable}
 */
export function endedWords (label, until) {
  const name = nameOf(label)
  return { label, reason: 'ended', name, words: `Every sign-in made with ${name} was just ended. A new one works after ${formatTime(until)}.`, remedy: null, link: null }
}

/**
 * @param {object} parts
 * @param {Request} parts.request
 * @param {{ label: string, attribution: import('./sdk/orivonid.js').Attribution }[]} parts.names the IDs the address holds
 * @param {ReadonlySet<string>} parts.ticked labels the person chose to share
 * @param {number} parts.lifetime seconds, ignored without a key
 * @param {number} parts.now unix seconds
 * @param {ReadonlyMap<string, number>} [parts.endedUntil] the IDs whose sign-ins were ended, by the end time on their record
 */
export function consentView ({ request, names, ticked, lifetime, now, endedUntil = new Map() }) {
  /** @param {string} label */
  const waiting = (label) => (endedUntil.get(label) ?? 0) >= now
  const shareable = names.filter((one) => one.attribution.ok && !waiting(one.label))
  const chosen = shareable.filter((one) => ticked.has(one.label)).length
  const seconds = request.key === null ? PLAIN_LIFETIME : Math.min(Math.max(lifetime, MIN_TTL), maxLifetime(request))
  return {
    audience: request.origin,
    shareable,
    unusable: names.flatMap((one) => {
      if (one.attribution.ok) return waiting(one.label) ? [endedWords(one.label, endedUntil.get(one.label) ?? 0)] : []
      const offer = notOffered(one.attribution)
      return offer === null ? [] : [{ label: one.label, ...offer }]
    }),
    chosen,
    canSignIn: chosen >= 1 && chosen <= MAX_NAMES,
    tooMany: chosen > MAX_NAMES,
    key: request.key === null ? null : { preview: keyPreview(request.key), full: request.key },
    seconds,
    expires: formatTime(now + seconds),
    lifetimeWords: formatDuration(seconds),
    terms: termsOf(request, now + seconds),
    walletWarning: walletWarningWords(request.origin)
  }
}

/** What the person agrees to, in the protocol's words. @param {Request} request @param {number} expiresAt */
function termsOf (request, expiresAt) {
  const audience = request.origin
  if (request.key === null) {
    return [
      `${audience} learns which IDs you tick and the address that holds them.`,
      `It learns this for ${formatDuration(PLAIN_LIFETIME)}. It cannot act for you.`
    ]
  }
  return [
    `${audience} learns which IDs you tick and the address that holds them.`,
    `It can act as these IDs until ${formatTime(expiresAt)}: it accepts requests signed by its key ${keyPreview(request.key)} as coming from you, for as long as you hold them.`,
    'It cannot move funds.',
    'You can end it at any time with “End all sign-ins” on this site, under My IDs.'
  ]
}
