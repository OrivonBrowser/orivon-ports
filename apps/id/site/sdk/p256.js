// The key `orivon.id` serves is a NIST P-256 key: SEC1 uncompressed on the way out, a 64-byte r||s ECDSA signature
// over SHA-256. A sign-in carries it compressed (33 bytes); WebCrypto checks the signature, so no curve code here
// beyond opening a compressed point, which needs one modular square root.

import { concat, fromHex, toHex } from './bytes.js'

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn
/** The order of the curve's group. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

/** @param {bigint} base @param {bigint} exponent */
function powMod (base, exponent) {
  let result = 1n
  let square = base % P
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if ((rest & 1n) === 1n) result = (result * square) % P
    square = (square * square) % P
  }
  return result
}

/** @param {Uint8Array} bytes */
const asInteger = (bytes) => BigInt('0x' + (toHex(bytes) || '0'))

/** @param {bigint} value */
function asBytes (value) {
  return fromHex(value.toString(16).padStart(64, '0'))
}

/** y^2 = x^3 - 3x + b on the curve. @param {bigint} x */
const rightSide = (x) => (((x * x) % P) * x - 3n * x + B + 3n * P) % P

/**
 * The 65 bytes (`04 || x || y`) of a compressed point, or null when the bytes are not a point of the curve.
 * @param {Uint8Array} compressed 33 bytes, `02` or `03` then x
 * @returns {Uint8Array | null}
 */
export function decompress (compressed) {
  if (!(compressed instanceof Uint8Array) || compressed.length !== 33 || (compressed[0] !== 2 && compressed[0] !== 3)) return null
  const x = asInteger(compressed.subarray(1))
  if (x >= P) return null
  const target = rightSide(x)
  let y = powMod(target, (P + 1n) / 4n)
  if ((y * y) % P !== target) return null
  if ((y & 1n) !== BigInt(compressed[0] & 1)) y = P - y
  return concat(Uint8Array.of(4), compressed.subarray(1), asBytes(y))
}

/**
 * The 33 bytes of a point, or null when the 65 bytes are not a point of the curve.
 * @param {Uint8Array} uncompressed `04 || x || y`
 * @returns {Uint8Array | null}
 */
export function compress (uncompressed) {
  if (!(uncompressed instanceof Uint8Array) || uncompressed.length !== 65 || uncompressed[0] !== 4) return null
  const x = asInteger(uncompressed.subarray(1, 33))
  const y = asInteger(uncompressed.subarray(33))
  if (x >= P || y >= P || (y * y) % P !== rightSide(x)) return null
  return concat(Uint8Array.of(2 + Number(y & 1n)), uncompressed.subarray(1, 33))
}

/**
 * A key as the 33 bytes a sign-in carries, from those bytes, from the 65 an `orivon.id.publicKey` answers, or from
 * either as `0x` hex. Null for anything that is not a point of the curve.
 * @param {unknown} input
 * @returns {Uint8Array | null}
 */
export function keyBytes (input) {
  let bytes = input
  if (typeof input === 'string') {
    if (!/^0x(?:[0-9a-fA-F]{66}|[0-9a-fA-F]{130})$/.test(input)) return null
    bytes = fromHex(input)
  }
  if (!(bytes instanceof Uint8Array)) return null
  if (bytes.length === 65) return compress(bytes)
  return bytes.length === 33 && decompress(bytes) !== null ? bytes.slice() : null
}

/** The spelling of a key in a URL and in a message: 0x and 66 lower-case hex digits. @param {Uint8Array} key */
export const keyHex = (key) => '0x' + toHex(key)

/**
 * Whether `signature` is the ECDSA/SHA-256 signature of `data` by the key, the way `orivon.id.sign` makes one. A
 * signature that cannot be read is false; a page without WebCrypto throws.
 * @param {Uint8Array} key 33 bytes
 * @param {Uint8Array} data
 * @param {Uint8Array} signature 64 bytes, r then s
 * @returns {Promise<boolean>}
 */
export async function verifyP256 (key, data, signature) {
  const open = decompress(key)
  if (open === null || !(signature instanceof Uint8Array) || signature.length !== 64) return false
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) throw new Error('no WebCrypto here')
  try {
    const imported = await subtle.importKey('raw', open, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, signature, data)
  } catch {
    return false
  }
}

/** Whether `s`, the second half of a 64-byte r||s signature, is in the lower half of the order, the one form of two that a verifier accepts. @param {Uint8Array} signature */
export const isLowS = (signature) => signature.length === 64 && asInteger(signature.subarray(32)) <= N >> 1n

/**
 * The same signature with s in the lower half of the order (r, n - s is a valid twin of r, s for ECDSA).
 * @param {Uint8Array} signature 64 bytes
 * @returns {Uint8Array}
 */
export function lowS (signature) {
  const s = asInteger(signature.subarray(32))
  return s <= N >> 1n ? signature : concat(signature.subarray(0, 32), asBytes(N - s))
}
