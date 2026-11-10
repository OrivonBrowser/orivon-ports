// The ID site's half of a sign-in: read a request out of `location.hash`, refuse a malformed one with a reason the
// screen can word, check how the person arrived, build the one message the person signs for the usernames they ticked,
// sign it through the Chain and build the URL that carries the answer back. No DOM here: the consent screen draws
// what these return.

import { isAddress, sameAddress, toChecksumAddress, ZERO_ADDRESS } from './sdk/abi.js'
import { toHex, utf8 } from './sdk/bytes.js'
import { attribution, isValidLabel, nameOf } from './sdk/orivonid.js'
import {
  checkRequest, errorUrl, MAX_NAMES, MIN_TTL, PLAIN_LIFETIME, signInFields, successUrl
} from './sdk/protocol.js'
import { buildMessage, hashMessage } from './sdk/siwe.js'
import { checkSigner } from './sdk/verify.js'

/** @typedef {import('./sdk/protocol.js').Request} Request */
/** @typedef {import('./sdk/protocol.js').RequestProblem} RequestProblem */

const PREFIX = '#/connect?'
const FIELDS = ['v', 'return', 'nonce', 'state', 'delegate', 'ttl']
/** Lifetimes a screen may offer, in seconds, before the request's own limit cuts them. */
const LIFETIMES = [3600, 86_400, 604_800, 2_592_000, 7_776_000, 15_552_000]

/**
 * @typedef {'notConnect' | 'malformed' | 'duplicate' | 'unknownField' | RequestProblem} ParseProblem
 * notConnect: the fragment is not `#/connect?...`. malformed: a pair without `=` or a bad percent escape. duplicate: a
 * field twice. unknownField: a field v1 does not have. The rest are RequestProblem, one per field bound.
 */

/**
 * @param {string} hash `location.hash`
 * @returns {{ ok: true, request: Request } | { ok: false, reason: ParseProblem, field: string, returnUrl: string | null }}
 * `returnUrl` is set when the request's `return` is sound by itself, so the screen can offer to go back.
 */
export function parseRequest (hash) {
  /** @type {Record<string, string>} */
  const given = {}
  /** @type {{ reason: ParseProblem, field: string } | null} */
  let problem = null
  if (typeof hash !== 'string' || !hash.startsWith(PREFIX)) return { ok: false, reason: 'notConnect', field: 'hash', returnUrl: null }
  for (const pair of hash.slice(PREFIX.length).split('&')) {
    const at = pair.indexOf('=')
    if (at < 1) {
      problem ??= { reason: 'malformed', field: pair }
      continue
    }
    let name
    let value
    try {
      name = decodeURIComponent(pair.slice(0, at))
      value = decodeURIComponent(pair.slice(at + 1))
    } catch {
      problem ??= { reason: 'malformed', field: pair.slice(0, at) }
      continue
    }
    if (!FIELDS.includes(name)) problem ??= { reason: 'unknownField', field: name }
    else if (Object.hasOwn(given, name)) problem ??= { reason: 'duplicate', field: name }
    else given[name] = value
  }
  const checked = checkRequest({
    ...(given['v'] === undefined ? {} : { v: given['v'] }),
    ...(given['return'] === undefined ? {} : { returnUrl: given['return'] }),
    ...(given['nonce'] === undefined ? {} : { nonce: given['nonce'] }),
    ...(given['state'] === undefined ? {} : { state: given['state'] }),
    ...(given['delegate'] === undefined ? {} : { delegate: given['delegate'] }),
    ...(given['ttl'] === undefined ? {} : { ttl: given['ttl'] })
  })
  if (problem === null && checked.ok) return checked
  const alone = checkRequest({ v: '1', returnUrl: given['return'] ?? '', nonce: 'a'.repeat(16) })
  const found = problem ?? (checked.ok ? null : { reason: checked.reason, field: checked.field })
  return { ok: false, reason: /** @type {ParseProblem} */ (found?.reason), field: found?.field ?? '', returnUrl: alone.ok ? alone.request.returnUrl : null }
}

/** The longest a person may let this request last: the key's ttl, or ten minutes without a key. @param {Request} request */
export const maxLifetime = (request) => request.key === null ? PLAIN_LIFETIME : /** @type {number} */ (request.ttl)

/** The lifetimes worth offering, shortest first, the request's own limit last. @param {Request} request @returns {number[]} */
export function lifetimeOptions (request) {
  if (request.key === null) return [PLAIN_LIFETIME]
  const limit = maxLifetime(request)
  return [...LIFETIMES.filter((seconds) => seconds < limit && seconds >= MIN_TTL), limit]
}

/** Every reason a ConnectError carries. */
export const CONNECT_REASONS = ['names', 'lifetime', 'resolvers', 'wrongAccount', 'notAttributed', 'recordsNotHeld', 'wrongSigner']

/**
 * Why the ID site would not sign: `names`, `lifetime`, `resolvers` (a username without its resolver), `wrongAccount`,
 * `notAttributed` or `recordsNotHeld` (a label in `detail`; `problem` says why records are not held) or `wrongSigner`.
 */
export class ConnectError extends Error {
  /**
   * @param {'names' | 'lifetime' | 'resolvers' | 'wrongAccount' | 'notAttributed' | 'recordsNotHeld' | 'wrongSigner'} reason
   * @param {string} [detail]
   * @param {string | null} [problem] a RecordsProblem of permissions.js, or `invalidLabel` or `noResolver`
   */
  constructor (reason, detail = '', problem = null) {
    super(detail === '' ? reason : `${reason}: ${detail}`)
    this.name = 'ConnectError'
    this.reason = reason
    this.detail = detail
    this.problem = problem
  }
}

/**
 * The labels of a sign-in as the message lists them, or a ConnectError: at least one, at most MAX_NAMES, none twice,
 * each one the registrar would sell. @param {string[]} labels
 */
function sortedLabels (labels) {
  const sorted = [...new Set(labels)].sort()
  if (sorted.length === 0 || sorted.length > MAX_NAMES || sorted.length !== labels.length || !sorted.every(isValidLabel)) throw new ConnectError('names')
  return sorted
}

/** The seconds a sign-in lasts: ten minutes without a key; with one, the lifetime chosen, between MIN_TTL and the ttl. @param {Request} request @param {number} [lifetime] */
function lifetimeOf (request, lifetime) {
  if (request.key === null) return PLAIN_LIFETIME
  if (lifetime === undefined || !Number.isSafeInteger(lifetime) || lifetime < MIN_TTL || lifetime > maxLifetime(request)) throw new ConnectError('lifetime')
  return lifetime
}

/**
 * The message for the usernames ticked and the lifetime chosen. Without a key the lifetime is ten minutes and
 * `lifetime` is ignored; with one it is whole seconds from MIN_TTL to the request's ttl. `resolvers` holds, for each
 * label, the resolver R1 names for it now (`attribution(...).forward.resolver`): the message binds the username to it.
 * @param {{ request: Request, address: string, labels: string[], resolvers: Record<string, string>, now: number, lifetime?: number }} parts `now` is unix seconds
 * @returns {{ message: string, labels: string[], expiresAt: number }} the labels in the order the message lists them
 */
export function buildSignInMessage ({ request, address, labels, resolvers, now, lifetime }) {
  const sorted = sortedLabels(labels)
  const seconds = lifetimeOf(request, lifetime)
  const bound = sorted.map((label) => resolvers?.[label])
  if (!bound.every((resolver) => typeof resolver === 'string' && isAddress(resolver) && !sameAddress(resolver, ZERO_ADDRESS))) throw new ConnectError('resolvers')
  const expiresAt = now + seconds
  return {
    message: buildMessage(signInFields({
      address, origin: request.origin, nonce: request.nonce, issuedAt: now, expiresAt, labels: sorted, resolvers: /** @type {string[]} */ (bound), key: request.key
    })),
    labels: sorted,
    expiresAt
  }
}

/**
 * Signs the sign-in for these usernames and answers the URL that carries it back to the requesting site. It
 * checks, just before signing, that the wallet's address is the one shown and that each username still belongs to
 * it (all four clauses of the attribution rule, so its records can be written by the holder), and just after, that
 * the signature is the address's.
 * @param {{ request: Request, chain: import('./sdk/chain.js').Chain, address: string, labels: string[], now: number, lifetime?: number }} parts
 * @returns {Promise<{ response: import('./sdk/protocol.js').SignInResponse, url: string }>}
 */
export async function signIn ({ request, chain, address, labels, now, lifetime }) {
  const [current] = await chain.addresses()
  if (current === undefined || !sameAddress(current, address)) throw new ConnectError('wrongAccount')
  const sorted = sortedLabels(labels)
  lifetimeOf(request, lifetime)
  /** @type {Record<string, string>} */
  const resolvers = {}
  for (const label of sorted) {
    const found = await attribution(chain, label, address)
    if (!found.ok) {
      const only = found.owner.ok && found.roles.ok && found.forward.ok
      throw only ? new ConnectError('recordsNotHeld', label, found.records.problem) : new ConnectError('notAttributed', label)
    }
    resolvers[label] = /** @type {string} */ (found.forward.resolver)
  }
  const built = buildSignInMessage({ request, address, labels: sorted, resolvers, now, ...(lifetime === undefined ? {} : { lifetime }) })
  const signature = await chain.signMessage(utf8(built.message))
  if (await checkSigner(chain, address, hashMessage(built.message), signature) === null) throw new ConnectError('wrongSigner')
  const response = {
    v: /** @type {const} */ (1),
    message: built.message,
    signature: '0x' + toHex(signature),
    address: toChecksumAddress(address),
    names: built.labels.map(nameOf),
    ...(request.state === null ? {} : { state: request.state })
  }
  return { response, url: successUrl(request.returnUrl, response) }
}

/** Where the person goes when they cancel. Only for a request whose arrival was checked: see `exitTarget`. @param {Request} request */
export const cancelUrl = (request) => errorUrl(request.returnUrl, 'cancelled', request.state)

/** Where the person goes from a request that cannot be answered, when its `return` was sound. See `exitTarget`. @param {string} returnUrl */
export const invalidRequestUrl = (returnUrl) => errorUrl(returnUrl, 'invalid-request', null)

/**
 * @typedef {{ ok: true, unverified: boolean, audience: string }
 *   | { ok: false, reason: 'framed' | 'wrongOrigin' | 'unknownOrigin', audience: string, seen: string | null }} Arrival
 * `unverified` is true for a plain sign-in that came with no referrer: the screen shows `arrivalWords(arrival)` above
 * Continue. `seen` is the origin the person came from, when the referrer named one.
 */

/**
 * Whether the person plausibly pressed Sign in on the audience itself. A request names the site it returns to and a
 * key to delegate to, and nothing in it says who put it in front of the person, so the ID site asks the browser:
 * it refuses to run in a frame; it refuses a referrer that is another origin than the audience; and with no referrer
 * (a link from a mail or a chat, or a site that sends none) it refuses any request that carries a key and lets a
 * plain sign-in, which delegates nothing, go on with a warning.
 * @param {{ request: { origin: string, key: string | null }, referrer: string, framed: boolean }} parts `referrer` is `document.referrer`; `framed` is `window.top !== window`
 * @returns {Arrival}
 */
export function checkArrival ({ request, referrer, framed }) {
  return arrivalOf(request.origin, request.key !== null, referrer, framed)
}

/** @param {string} audience @param {boolean} carriesKey @param {unknown} referrer @param {unknown} framed @returns {Arrival} */
function arrivalOf (audience, carriesKey, referrer, framed) {
  /** @param {'framed' | 'wrongOrigin' | 'unknownOrigin'} reason @param {string | null} seen @returns {Arrival} */
  const refuse = (reason, seen) => ({ ok: false, reason, audience, seen })
  if (framed !== false) return refuse('framed', null)
  if (typeof referrer !== 'string' || referrer === '') return carriesKey ? refuse('unknownOrigin', null) : { ok: true, unverified: true, audience }
  let seen
  try {
    seen = new URL(referrer).origin
  } catch {
    return refuse('wrongOrigin', null)
  }
  return seen === audience ? { ok: true, unverified: false, audience } : refuse('wrongOrigin', seen)
}

/**
 * The words for an arrival that stops the sign-in, or for the warning above Continue when it is `unverified`; null
 * when there is nothing to say. The page draws them as text.
 * @param {Arrival} arrival
 * @returns {string | null}
 */
export function arrivalWords (arrival) {
  if (arrival.ok) return arrival.unverified ? `Only continue if you just pressed Sign in on ${arrival.audience}.` : null
  if (arrival.reason === 'framed') return 'This page cannot be used inside another page. Open it in its own tab.'
  if (arrival.reason === 'wrongOrigin') return `You came from ${arrival.seen ?? 'another page'}, not from ${arrival.audience}. Go back to ${arrival.audience} and press Sign in there.`
  return `This request lets ${arrival.audience} act for you, and your browser did not say which page sent you. Go back to ${arrival.audience} and press Sign in there.`
}

/**
 * Where Cancel (a request that parsed) or "tell the site" (a request refused after its `return` passed) may go: a URL
 * on a `return` that passed every check, its arrival included, and never one that failed any. A request that did not
 * parse is judged by the origin of its `return` and, since its key is unknown, as if it carried one.
 * @param {ReturnType<typeof parseRequest>} parsed
 * @param {{ referrer: string, framed: boolean }} arriving
 * @returns {{ answer: 'cancelled' | 'invalid-request', url: string } | null}
 */
export function exitTarget (parsed, arriving) {
  if (parsed.ok) {
    return checkArrival({ request: parsed.request, ...arriving }).ok ? { answer: 'cancelled', url: cancelUrl(parsed.request) } : null
  }
  if (parsed.returnUrl === null || !arrivalOf(new URL(parsed.returnUrl).origin, true, arriving.referrer, arriving.framed).ok) return null
  return { answer: 'invalid-request', url: invalidRequestUrl(parsed.returnUrl) }
}

/**
 * What the consent shows of `return`: the audience origin always, and the whole address whenever it is more than the
 * origin's root, since a path or a query can be a redirect to somewhere else.
 * @param {Request} request
 * @returns {{ origin: string, full: string | null, words: string | null }}
 */
export function returnDisplay (request) {
  const full = request.returnUrl === `${request.origin}/` ? null : request.returnUrl
  return { origin: request.origin, full, words: full === null ? null : `The answer goes to this exact address on ${request.origin}. Check that it is a page of that site.` }
}

/** The one thing to do about a name on a resolver its holder cannot write, and where it is done. @param {string} name the full username */
export const moveAdvice = (name) => `Choose “Move to your own resolver” for ${name} in My IDs, then sign in.`

/** For a resolver that would not answer: try again, and if it never does, move the name. @param {string} name the full username */
export const retryOrMove = (name) => `Try again in a moment. If it keeps failing, choose “Move to your own resolver” for ${name} in My IDs.`

/**
 * The words for a username whose records the address cannot write, and what to do about it.
 * @param {string} name the full username
 * @param {string | null} problem a RecordsProblem, `noResolver` or `invalidLabel`
 * @returns {{ words: string, remedy: string }}
 */
export function recordsNotHeldWords (name, problem) {
  const remedy = moveAdvice(name)
  if (problem === 'noResolver') return { words: `${name} has no resolver, so it has no records to read or to end a sign-in with.`, remedy }
  if (problem === 'notPermissionedResolver') return { words: `${name} points at a resolver that Orivon ID cannot check. A sign-in made with it could not be ended by you.`, remedy }
  if (problem === 'unreadable') return { words: `The resolver of ${name} would not say whether you can change its records.`, remedy: retryOrMove(name) }
  return { words: `You cannot change the records of ${name} on its resolver. Whoever controls that resolver could end or restore your sign-ins, so it is not offered.`, remedy }
}

/**
 * Why a username the address holds cannot be offered for a sign-in, or null when it can. Each of the four clauses of
 * the attribution rule has its words.
 * @param {import('./sdk/orivonid.js').Attribution} found
 * @returns {{ reason: 'owner' | 'roles' | 'rolesUnreadable' | 'forward' | 'recordsNotHeld', words: string, remedy: string | null } | null}
 */
export function whyNotOffered (found) {
  const name = nameOf(found.label)
  if (found.ok) return null
  if (!found.owner.ok) return { reason: 'owner', words: `This address does not hold ${name}.`, remedy: null }
  if (!found.roles.ok) {
    return found.roles.problem === 'rolesUnreadable'
      ? { reason: 'rolesUnreadable', words: `The registry would not say who holds roles on ${name}.`, remedy: 'Try again in a moment.' }
      : { reason: 'roles', words: `Another account holds a role on ${name}.`, remedy: null }
  }
  if (!found.forward.ok) {
    return { reason: 'forward', words: `${name} does not point at this address (${found.forward.problem ?? 'unknown'}).`, remedy: `Set the address record of ${name} to this address from #/me.` }
  }
  return { reason: 'recordsNotHeld', ...recordsNotHeldWords(name, found.records?.problem ?? null) }
}
