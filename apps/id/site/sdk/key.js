// The relying site's own key: the per-origin P-256 key `orivon.id` derives for this page's origin, silently and
// from the person's seed. It is what a sign-in delegates to, and what later requests are signed with.
//
// What the broker does (src/broker/policy/derive-p256.ts): `publicKey({ curve: 'P-256' })` answers 65 bytes, SEC1
// uncompressed. `sign({ curve: 'P-256', payload })` answers 64 bytes, r then s, ECDSA over SHA-256 of the payload
// exactly as given, with a random nonce (so s may be either half of the order). `secp256k1` is not served.

import { concat, utf8 } from './bytes.js'
import { compress, keyHex, lowS } from './p256.js'

/** Put in front of every payload the key signs for a sign-in, so a signature made for another purpose never reads as one. */
export const ACTION_PREFIX = 'orivonid:action:v1\n'

/** Whether `origin` is the origin of a URL, spelled as a URL writes it: https, a host in ASCII, no path. @param {unknown} origin */
export function isAudience (origin) {
  if (typeof origin !== 'string' || !/^https:\/{2}[\x21-\x7e]+$/.test(origin)) return false
  try {
    return new URL(origin).origin === origin
  } catch {
    return false
  }
}

/**
 * The bytes the key signs for `payload` sent to the site at `origin`: the prefix, the audience origin and a line feed,
 * then the payload. An origin has no line feed, so the frame reads one way, and a signature made for one site means
 * nothing at another that holds a sign-in for the same key.
 * @param {Uint8Array} payload
 * @param {string} origin
 */
export function frameAction (payload, origin) {
  if (!isAudience(origin)) throw new TypeError('origin is the site\'s own origin: scheme and host, no path')
  return concat(utf8(`${ACTION_PREFIX}${origin}\n`), payload)
}

/**
 * @typedef {object} AppKey
 * @property {'p256'} curve
 * @property {string} origin the site the key signs for: the audience a verifier names
 * @property {Uint8Array} publicKey 33 bytes, compressed
 * @property {string} hex the same as `0x` and 66 lower-case hex digits, as a request and a message spell it
 * @property {(payload: Uint8Array) => Promise<Uint8Array>} sign 64 bytes, s in the lower half: sign the payload a server will check with `verifyAction`
 */

/**
 * @param {{ id: { publicKey: (options: { curve: string }) => Promise<Uint8Array>, sign: (options: { curve: string, payload: Uint8Array }) => Promise<Uint8Array> } }} orivon
 * @param {{ origin?: string }} [options] `origin` is this page's own, `location.origin` by default
 * @returns {Promise<AppKey>}
 */
export async function appKey (orivon, options = {}) {
  const origin = options.origin ?? globalThis.location?.origin
  if (!isAudience(origin)) throw new TypeError('appKey needs this page\'s origin: pass { origin }')
  const publicKey = compress(await orivon.id.publicKey({ curve: 'P-256' }))
  if (publicKey === null) throw new Error('orivon.id answered something that is not a P-256 point')
  return {
    curve: 'p256',
    origin,
    publicKey,
    hex: keyHex(publicKey),
    sign: async (payload) => {
      const signature = await orivon.id.sign({ curve: 'P-256', payload: frameAction(payload, origin) })
      if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('orivon.id answered a signature that is not 64 bytes')
      return lowS(signature)
    }
  }
}
