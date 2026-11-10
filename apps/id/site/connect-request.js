// The ID site's half of a sign-in: read the link a page arrived by (the arrival, or the confirmation the bridge sent), keep
// and check the challenge that proves the bridge, build the one message the person signs for the usernames they ticked, sign
// it through the Chain and build the URL that carries the answer to the bridge. No DOM here: the screens draw what these return.

import { isAddress, sameAddress, toChecksumAddress, ZERO_ADDRESS } from './sdk/abi.js'
import { toHex, utf8 } from './sdk/bytes.js'
import { attribution, isValidLabel, nameOf } from './sdk/orivonid.js'
import {
  bridgeUrl, checkAudience, checkFields, errorUrl, isChallenge, MAX_AUDIENCE, MAX_NAMES, MIN_TTL, PLAIN_LIFETIME, randomToken, signInFields, successUrl
} from './sdk/protocol.js'
import { buildMessage, hashMessage } from './sdk/siwe.js'
import { checkSigner } from './sdk/verify.js'

/** @typedef {import('./sdk/protocol.js').Request} Request */
/** @typedef {import('./sdk/protocol.js').RequestProblem} RequestProblem */

const PREFIX = '#/connect?'
const ARRIVAL_FIELDS = ['v', 'aud']
const CONFIRMATION_FIELDS = ['v', 'c', 'nonce', 'state', 'delegate', 'ttl', 'none']
/** Lifetimes a screen may offer, in seconds, before the request's own limit cuts them. */
const LIFETIMES = [3600, 86_400, 604_800, 2_592_000, 7_776_000, 15_552_000]
/** Where the challenge of a Continue is kept, in the tab, and how long the way through the bridge may take, in seconds. */
export const CHALLENGE_KEY = 'orivonid.challenge'
export const CHALLENGE_MAX_AGE = 120

/**
 * @typedef {'notConnect' | 'malformed' | 'duplicate' | 'unknownField' | 'badVersion' | 'olderVersion' | 'badChallenge' | 'badNone' | RequestProblem} ParseProblem
 * notConnect: the fragment is not `#/connect?...`. malformed: a pair without `=` or a bad percent escape. duplicate: a
 * field twice. unknownField: a field the stage of the link does not have. badVersion: not 2. olderVersion: 1. badChallenge:
 * `c` is not 32 of `A-Za-z0-9`. badNone: `none` is not alone with `v` and `c`, or not `1`. The rest are RequestProblem, one per field bound.
 */

/**
 * @typedef {{ ok: true, stage: 'arrival', audience: string }
 *   | { ok: true, stage: 'confirmation', c: string, fields: Omit<Request, 'origin'> | null }
 *   | { ok: false, reason: ParseProblem, field: string, audience: string | null }} ParsedLink
 * `fields` is null for a confirmation that says `none`: the bridge found no request. `audience` of a refusal is set for a
 * link of the older version, from the origin its `return` named, so the screen can say who to ask.
 */

/** The origin a link of version 1 returned to, when it is a plain https origin of at most MAX_AUDIENCE characters. @param {string | undefined} target */
function olderAudience (target) {
  try {
    const url = target === undefined || target.length > 2048 ? null : new URL(target)
    return url !== null && url.protocol === 'https:' && url.origin.length <= MAX_AUDIENCE && /^[\x21-\x7e]+$/.test(url.origin) ? url.origin : null
  } catch {
    return null
  }
}

/**
 * @param {string} hash `location.hash`
 * @returns {ParsedLink}
 */
export function parseRequest (hash) {
  /** No prototype, so a field named `__proto__` is a field like the rest. @type {Record<string, string>} */
  const given = Object.create(null)
  /** @type {{ reason: ParseProblem, field: string } | null} */
  let problem = null
  /** @param {ParseProblem} reason @param {string} field @returns {ParsedLink} */
  const refuse = (reason, field) => ({ ok: false, reason, field, audience: null })
  if (typeof hash !== 'string' || !hash.startsWith(PREFIX)) return refuse('notConnect', 'hash')
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
    if (Object.hasOwn(given, name)) problem ??= { reason: 'duplicate', field: name }
    else given[name] = value
  }
  if (problem !== null) return refuse(problem.reason, problem.field)
  if (given['v'] === '1') return { ok: false, reason: 'olderVersion', field: 'v', audience: olderAudience(given['return']) }
  if (given['v'] !== '2') return refuse('badVersion', 'v')
  const confirmation = given['c'] !== undefined
  const allowed = confirmation ? CONFIRMATION_FIELDS : ARRIVAL_FIELDS
  for (const name of Object.keys(given)) if (!allowed.includes(name)) return refuse('unknownField', name)
  if (!confirmation) {
    const checked = checkAudience(given['aud'])
    return checked.ok ? { ok: true, stage: 'arrival', audience: checked.origin } : refuse(checked.reason, checked.field)
  }
  const c = given['c']
  if (!isChallenge(c)) return refuse('badChallenge', 'c')
  if (given['none'] !== undefined) {
    return given['none'] === '1' && Object.keys(given).length === 3 ? { ok: true, stage: 'confirmation', c, fields: null } : refuse('badNone', 'none')
  }
  const checked = checkFields({
    ...(given['nonce'] === undefined ? {} : { nonce: given['nonce'] }),
    ...(given['state'] === undefined ? {} : { state: given['state'] }),
    ...(given['delegate'] === undefined ? {} : { delegate: given['delegate'] }),
    ...(given['ttl'] === undefined ? {} : { ttl: given['ttl'] })
  })
  return checked.ok ? { ok: true, stage: 'confirmation', c, fields: checked.fields } : refuse(checked.reason, checked.field)
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
 * Signs the sign-in for these usernames and answers the URL that carries it to the requesting site's bridge page. It
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
  return { response, url: successUrl(request.origin, response) }
}

/** Where Cancel goes on a confirmation that passed every check: the bridge, which tells the page that asked. @param {Request} request */
export const cancelUrl = (request) => errorUrl(request.origin, 'cancelled', request.state)

/** Where Cancel goes on the arrival screen, before any request was read: the bridge, which adds the state it holds. @param {string} audience */
export const arrivalCancelUrl = (audience) => errorUrl(audience, 'cancelled', null)

/** @typedef {{ c: string, aud: string, at: number }} Challenge */

/** @typedef {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void, removeItem: (key: string) => void }} Store */

/**
 * The challenge of a Continue: 32 characters made here, kept in this tab's own storage until the person comes back through
 * the bridge, replacing any earlier one. Answers it and the address of the bridge page to go to, or null when the tab
 * would not keep it (nothing is then sent anywhere, since the way back could not be checked).
 * @param {{ storage: Store | null, audience: string, now: number, random: (bytes: Uint8Array) => Uint8Array }} parts `now` is unix seconds
 * @returns {{ c: string, url: string } | null}
 */
export function startChallenge ({ storage, audience, now, random }) {
  const c = randomToken(random)
  try {
    if (storage === null) return null
    storage.setItem(CHALLENGE_KEY, JSON.stringify({ c, aud: audience, at: now }))
  } catch {
    return null
  }
  return { c, url: bridgeUrl(audience, c) }
}

/**
 * The challenge this tab holds, once: it is removed before it is read, so a second look finds none, whatever the first
 * decided. Null when there is none or it is damaged.
 * @param {Store | null} storage
 * @returns {Challenge | null}
 */
export function takeChallenge (storage) {
  try {
    const text = storage?.getItem(CHALLENGE_KEY) ?? null
    if (text === null) return null
    storage?.removeItem(CHALLENGE_KEY)
    const value = JSON.parse(text)
    const sound = value !== null && typeof value === 'object' && isChallenge(value.c) && checkAudience(value.aud).ok && Number.isSafeInteger(value.at)
    return sound ? { c: value.c, aud: value.aud, at: value.at } : null
  } catch {
    return null
  }
}

/** @typedef {{ ok: true, audience: string } | { ok: false, reason: 'noChallenge' | 'challengeExpired' | 'wrongChallenge' | 'notFromBridge', audience: string | null }} ChallengeCheck */

/**
 * Whether the person came back through the bridge of the site they pressed Continue for: the challenge is the one this tab
 * made, at most CHALLENGE_MAX_AGE old, and the browser says the page before this one was the bridge page, address and
 * query whole. The audience is the one the challenge was made for.
 * @param {{ c: string, stored: Challenge | null, referrer: unknown, now: number }} parts
 * @returns {ChallengeCheck}
 */
export function checkChallenge ({ c, stored, referrer, now }) {
  if (stored === null) return { ok: false, reason: 'noChallenge', audience: null }
  const audience = stored.aud
  if (now - stored.at > CHALLENGE_MAX_AGE || stored.at - now > 60) return { ok: false, reason: 'challengeExpired', audience }
  if (c !== stored.c) return { ok: false, reason: 'wrongChallenge', audience }
  if (referrer !== bridgeUrl(audience, c)) return { ok: false, reason: 'notFromBridge', audience }
  return { ok: true, audience }
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
