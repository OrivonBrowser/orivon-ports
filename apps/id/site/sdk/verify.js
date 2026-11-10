// What a relying site does with a sign-in: `verifySignIn` when the person comes back, `verifyAction` for each later
// request signed by the delegated key. Both end in the same chain reads, made now. A failure is a value with a
// name, never a thrown error; only a call made wrongly (a clock in milliseconds) throws.

import { sameAddress, toChecksumAddress } from './abi.js'
import { concat, fromHex, toHex } from './bytes.js'
import { ChainError } from './chain.js'
import { frameAction, isAudience } from './key.js'
import { attribution, nameOf, readContract, records } from './orivonid.js'
import { isLowS as isLowP256, keyBytes, verifyP256 } from './p256.js'
import {
  checkResponse, CLOCK_SKEW, ID_DOMAIN, MAX_TTL, MIN_TTL, NOT_BEFORE_KEY, PLAIN_LIFETIME, readResources, signInFields, statementFor
} from './protocol.js'
import { buildMessage, formatTime, hashMessage, parseMessage, parseTime, SiweError } from './siwe.js'

/** @typedef {import('./chain.js').Chain} Chain */
/** @typedef {import('./protocol.js').SignInResponse} SignInResponse */
/** @typedef {{ ok: true, response: SignInResponse, fields: import('./siwe.js').SiweFields, labels: string[], resolvers: string[], key: string | null, issuedAt: number, expiresAt: number }} Local */

/**
 * Why a sign-in or an action was refused. malformedResponse: not the object the ID site hands back.
 * malformedMessage: not an EIP-4361 message in its one form. wrongDomain: not signed on the ID site. wrongAudience:
 * made for another site. wrongChain, wrongNonce, wrongAddress, wrongState: a field is not what was asked or signed.
 * badTimes, notYetValid, expired, badLifetime: the clock. badResources, namesMismatch, wrongStatement, notCanonical:
 * the message is not the one the ID site writes. keyMismatch: the key is not the one asked for. badSignature: the
 * address did not sign it (`detail` is `highS` for the second, high-s form of a signature, which is refused). notAttributed:
 * the address does not hold the username now (`detail` says which clause; `rolesUnreadable` when the registry would not
 * say who holds a role). resolverChanged: the username's records are on another resolver than the one it was signed
 * with. recordsNotHeld: the address cannot write the username's records on its resolver (`detail` says why). revoked: the
 * owner ended it. revocationUnreadable: the record is there but cannot be read as a time.
 * chainUnavailable: the node could not answer, so nothing is proven. For an action: noKey, badAction (the inputs),
 * badActionSignature, cryptoUnavailable (no WebCrypto). noPendingRequest: no request of this tab is waiting for an answer.
 * @typedef {'malformedResponse' | 'malformedMessage' | 'wrongDomain' | 'wrongAudience' | 'wrongChain' | 'wrongNonce'
 *   | 'wrongAddress' | 'wrongState' | 'badTimes' | 'notYetValid' | 'expired' | 'badLifetime' | 'badResources' | 'namesMismatch'
 *   | 'wrongStatement' | 'notCanonical' | 'keyMismatch' | 'badSignature' | 'notAttributed' | 'resolverChanged' | 'recordsNotHeld'
 *   | 'revoked' | 'revocationUnreadable' | 'chainUnavailable' | 'noKey' | 'badAction' | 'badActionSignature' | 'cryptoUnavailable' | 'noPendingRequest'} Failure
 */
export const FAILURES = [
  'malformedResponse', 'malformedMessage', 'wrongDomain', 'wrongAudience', 'wrongChain', 'wrongNonce', 'wrongAddress', 'wrongState',
  'badTimes', 'notYetValid', 'expired', 'badLifetime', 'badResources', 'namesMismatch', 'wrongStatement', 'notCanonical', 'keyMismatch',
  'badSignature', 'notAttributed', 'resolverChanged', 'recordsNotHeld', 'revoked', 'revocationUnreadable', 'chainUnavailable', 'noKey', 'badAction', 'badActionSignature',
  'cryptoUnavailable', 'noPendingRequest'
]

/** @typedef {{ ok: false, failure: Failure, detail?: string, name?: string }} Refused */

/**
 * @typedef {object} Verified
 * @property {true} ok
 * @property {string} address the address that signed, EIP-55
 * @property {string[]} names the full usernames the address holds, as the message lists them
 * @property {string | null} key the delegated key, `0x` and 66 hex digits, or null
 * @property {number} notAfter unix seconds: the message's Expiration Time
 * @property {number} issuedAt unix seconds
 * @property {'ecrecover' | 'erc1271'} via how the signer was proven
 */

const ECRECOVER = '0x0000000000000000000000000000000000000001'
/** The order of secp256k1's group: EIP-2 accepts a signature only with s in the lower half of it. */
const K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const ERC1271_MAGIC = '1626ba7e'
const LANES = 4

/** @param {Failure} failure @param {string} [detail] @param {string} [name] @returns {Refused} */
function refuse (failure, detail, name) {
  return { ok: false, failure, ...(detail === undefined ? {} : { detail }), ...(name === undefined ? {} : { name }) }
}

/** A clock in milliseconds would pass every expiry check. @param {unknown} now */
function checkClock (now) {
  if (!Number.isSafeInteger(now) || /** @type {number} */ (now) < 1_000_000_000 || /** @type {number} */ (now) > 100_000_000_000) {
    throw new TypeError('now is unix time in whole seconds')
  }
}

/**
 * Everything the message and the response can show without asking the chain.
 * @param {unknown} input
 * @param {{ origin: string, nonce: string | null, key: string | null | undefined, state: string | null | undefined, ttl: number | undefined, now: number }} ctx
 * `nonce` null skips the nonce (a sign-in already accepted); `key` and `state` undefined skip theirs.
 * @returns {Local | Refused}
 */
function inspect (input, ctx) {
  const response = checkResponse(input)
  if (response === null) return refuse('malformedResponse')
  /** @type {import('./siwe.js').SiweFields} */
  let fields
  try {
    fields = parseMessage(response.message)
  } catch (error) {
    if (error instanceof SiweError) return refuse('malformedMessage', error.message)
    throw error
  }
  if (fields.scheme !== undefined || fields.domain !== ID_DOMAIN) return refuse('wrongDomain', fields.domain)
  if (fields.uri !== ctx.origin) return refuse('wrongAudience', fields.uri)
  if (fields.chainId !== 1) return refuse('wrongChain', String(fields.chainId))
  if (ctx.nonce !== null && fields.nonce !== ctx.nonce) return refuse('wrongNonce')
  if (response.address !== fields.address) return refuse('wrongAddress')
  if (ctx.state !== undefined && (response.state ?? null) !== ctx.state) return refuse('wrongState')
  const issued = parseTime(fields.issuedAt)
  const expires = fields.expirationTime === undefined ? null : parseTime(fields.expirationTime)
  if (issued === null || expires === null || issued <= 0 || expires <= issued || expires > 253_402_300_799_000) return refuse('badTimes')
  const issuedAt = issued / 1000
  const expiresAt = expires / 1000
  if (formatTime(issuedAt) !== fields.issuedAt || formatTime(expiresAt) !== fields.expirationTime) return refuse('badTimes', 'times are written as YYYY-MM-DDTHH:MM:SSZ')
  const found = readResources(fields.resources ?? [])
  if (!found.ok) return refuse('badResources', found.detail)
  const { labels, resolvers, key } = found
  const lifetime = expiresAt - issuedAt
  const allowed = key === null ? lifetime === PLAIN_LIFETIME : lifetime >= MIN_TTL && lifetime <= Math.min(MAX_TTL, ctx.ttl ?? MAX_TTL)
  if (!allowed) return refuse('badLifetime', `${lifetime} seconds`)
  if (issuedAt > ctx.now + CLOCK_SKEW) return refuse('notYetValid')
  if (expiresAt <= ctx.now) return refuse('expired')
  if (response.names.join() !== labels.map(nameOf).join()) return refuse('namesMismatch')
  if (ctx.key !== undefined && key !== ctx.key) return refuse('keyMismatch', ctx.key === null ? 'a key nobody asked for' : key === null ? 'no key' : 'another key')
  if (fields.statement !== statementFor({ origin: ctx.origin, key })) return refuse('wrongStatement')
  if (buildMessage(signInFields({ address: fields.address, origin: ctx.origin, nonce: fields.nonce, issuedAt, expiresAt, labels, resolvers, key })) !== response.message) {
    return refuse('notCanonical')
  }
  return { ok: true, response, fields, labels, resolvers, key, issuedAt, expiresAt }
}

/**
 * What `ecrecover` says of a signature, asked of the precompile through the person's own node.
 * @param {Chain} chain
 * @param {Uint8Array} hash 32 bytes
 * @param {Uint8Array} signature 65 bytes, v 27 or 28
 * @returns {Promise<string | null>} the address, or null when the precompile refuses it
 */
async function recover (chain, hash, signature) {
  const input = concat(hash, new Uint8Array(31), Uint8Array.of(signature[64] ?? 0), signature.subarray(0, 64))
  const result = await chain.call({ to: ECRECOVER, data: input }, 'latest', { ccipRead: false })
  const out = result.data
  if (out === null || out.length !== 32 || out.subarray(0, 12).some((byte) => byte !== 0)) return null
  return toChecksumAddress('0x' + toHex(out.subarray(12)))
}

/** Whether the s of a 65-byte signature is in the lower half of the order, the one of its two forms EIP-2 accepts. @param {Uint8Array} signature */
const isLowK1 = (signature) => BigInt('0x' + toHex(signature.subarray(32, 64))) <= K1_ORDER >> 1n

/**
 * Whether `address` signed `hash`: its own key by `ecrecover` first, and only when that is another address and the
 * address has code, the contract's say-so (EIP-1271). An account that delegates to code by EIP-7702 and signs with
 * its own key is the first case.
 * @param {Chain} chain
 * @param {string} address
 * @param {Uint8Array} hash 32 bytes
 * @param {Uint8Array} signature 65 bytes
 * @returns {Promise<'ecrecover' | 'erc1271' | null>}
 */
export async function checkSigner (chain, address, hash, signature) {
  if (signature.length !== 65 || (signature[64] !== 27 && signature[64] !== 28) || !isLowK1(signature)) return null
  const recovered = await recover(chain, hash, signature)
  if (recovered !== null && sameAddress(recovered, address)) return 'ecrecover'
  if ((await chain.getCode(address)).length === 0) return null
  try {
    const [magic] = await readContract(chain, address, 'isValidSignature(bytes32,bytes)', [hash, signature], ['bytes4'])
    return toHex(/** @type {Uint8Array} */ (magic)) === ERC1271_MAGIC ? 'erc1271' : null
  } catch (error) {
    if (error instanceof ChainError && (error.reason === 'reverted' || error.reason === 'badAnswer')) return null
    throw error
  }
}

/**
 * The time in the name's revocation record: 0 when there is none, null when there is one that is not a time.
 * @param {Chain} chain
 * @param {string} label
 * @returns {Promise<number | null>}
 */
async function notBefore (chain, label) {
  const found = await records(chain, label, [NOT_BEFORE_KEY])
  const value = found.texts[NOT_BEFORE_KEY]
  if (found.failed.includes(`text:${NOT_BEFORE_KEY}`)) return null
  if (value === null || value === undefined) return 0
  return /^(?:0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
}

/**
 * What the chain says now, once the message is known to be the right one.
 * @param {Chain} chain
 * @param {Local} local
 * @returns {Promise<Verified | Refused>}
 */
async function onChain (chain, local) {
  try {
    const { response, fields, labels } = local
    const signature = fromHex(response.signature)
    if (!isLowK1(signature)) return refuse('badSignature', 'highS')
    const via = await checkSigner(chain, fields.address, hashMessage(response.message), signature)
    if (via === null) return refuse('badSignature')
    /** @type {(Refused | null)[]} */
    const results = new Array(labels.length).fill(null)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(LANES, labels.length) }, async () => {
      while (next < labels.length) {
        const index = next++
        results[index] = await checkName(chain, /** @type {string} */ (labels[index]), fields.address, local.issuedAt, /** @type {string} */ (local.resolvers[index]))
      }
    }))
    const failed = results.find((result) => result !== null)
    if (failed) return failed
    return { ok: true, address: fields.address, names: labels.map(nameOf), key: local.key, notAfter: local.expiresAt, issuedAt: local.issuedAt, via }
  } catch (error) {
    if (error instanceof ChainError) return refuse('chainUnavailable', error.reason)
    throw error
  }
}

/**
 * One username, read now: the attribution rule, then that its records are still on the resolver it was signed with,
 * then the revocation record. A username transferred away and back passes again (PROTOCOL.md section 7).
 * @param {Chain} chain @param {string} label @param {string} address @param {number} issuedAt
 * @param {string} bound the resolver the person signed the username with, lower case
 * @returns {Promise<Refused | null>}
 */
async function checkName (chain, label, address, issuedAt, bound) {
  const found = await attribution(chain, label, address)
  const name = nameOf(label)
  if (!found.owner.ok) return refuse('notAttributed', 'owner', name)
  if (!found.roles.ok) return refuse('notAttributed', found.roles.problem ?? 'roles', name)
  const resolver = found.forward.resolver
  if (resolver === null || !sameAddress(resolver, bound)) return refuse('resolverChanged', resolver ?? 'none', name)
  if (!found.forward.ok) return refuse('notAttributed', `forward:${found.forward.problem}`, name)
  if (!found.records.ok) return refuse('recordsNotHeld', found.records.problem ?? 'unreadable', name)
  const since = await notBefore(chain, label)
  if (since === null) return refuse('revocationUnreadable', NOT_BEFORE_KEY, nameOf(label))
  return issuedAt <= since ? refuse('revoked', String(since), nameOf(label)) : null
}

/**
 * Checks a sign-in the person brought back, every step in the order PROTOCOL.md lists, and answers who signed in
 * and as which usernames. Nothing in the response is believed until the chain agrees.
 * @param {unknown} response the object `readResponse` decoded
 * @param {object} options
 * @param {Chain} options.chain the person's own node
 * @param {string} options.origin this site's origin, the audience the message must name
 * @param {string} options.nonce the one stored when the request was made
 * @param {string | null} options.key the key asked for, as `requestSignIn` stored it, or null when none was
 * @param {number} options.now unix seconds
 * @param {number} [options.ttl] the lifetime asked for, when a key was
 * @param {string | null} [options.state] the state sent, or null when none was
 * @returns {Promise<Verified | Refused>}
 */
export async function verifySignIn (response, options) {
  checkClock(options.now)
  if (options.key === undefined) throw new TypeError('key: pass the key that was asked for, or null when none was')
  const local = inspect(response, {
    origin: options.origin, nonce: options.nonce, key: options.key, state: options.state ?? null, ttl: options.ttl, now: options.now
  })
  return local.ok ? await onChain(options.chain, local) : local
}

/**
 * Checks one request signed by the delegated key, and re-reads the chain: the key's signature over the payload,
 * and the whole sign-in again (signer, the usernames still held by the address, no revocation), so a transfer, a
 * changed address record, an expiry or an "end all sign-ins" since the sign-in voids the request.
 * @param {object} options
 * @param {unknown} options.signIn the response that `verifySignIn` accepted, as stored
 * @param {Uint8Array} options.payload the bytes the request carries
 * @param {Uint8Array} options.signature 64 bytes from `appKey(...).sign(payload)`
 * @param {string} options.origin this site's origin
 * @param {Chain} options.chain
 * @param {number} options.now unix seconds
 * @returns {Promise<Verified | Refused>}
 */
export async function verifyAction (options) {
  checkClock(options.now)
  if (!isAudience(options.origin)) throw new TypeError('origin is this site\'s own origin: scheme and host, no path')
  const { payload, signature } = options
  if (!(payload instanceof Uint8Array) || !(signature instanceof Uint8Array) || signature.length !== 64) return refuse('badAction')
  const local = inspect(options.signIn, { origin: options.origin, nonce: null, key: undefined, state: undefined, ttl: undefined, now: options.now })
  if (!local.ok) return local
  const key = local.key === null ? null : keyBytes(local.key)
  if (key === null) return refuse('noKey')
  if (!isLowP256(signature)) return refuse('badActionSignature', 'highS')
  /** @type {boolean} */
  let valid
  try {
    valid = await verifyP256(key, frameAction(payload, options.origin), signature)
  } catch {
    return refuse('cryptoUnavailable')
  }
  return valid ? await onChain(options.chain, local) : refuse('badActionSignature')
}

