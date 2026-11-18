// Workaround, deletable when Orivon's Node shim gives `Buffer` the 'base64url' encoding. The shim's Buffer is the `buffer` package (v6), which stops at "Unknown encoding: base64url", and
// the spam-blocker challenge writes the payload of the address it sends a poster to with `Buffer.from(bytes).toString('base64url')`: pkc-js wraps that exception as "invalid getChallenge
// response from community challenge", so a board with the challenge held every author's post it asked the challenge about with an error and no challenge.

/**
 * Teaches a Buffer class the 'base64url' encoding for the three calls code uses it through: `toString`, `from` and `isEncoding`. A class that already knows it is left as it is.
 * @param {any} BufferClass the class to teach: the global `Buffer` of the Worker
 * @returns {boolean} true when the class was patched, false when it already knew the encoding
 */
export function supportBase64Url (BufferClass) {
  if (knowsBase64Url(BufferClass)) return false
  const plainToString = BufferClass.prototype.toString
  const plainFrom = BufferClass.from
  const plainIsEncoding = BufferClass.isEncoding
  /** @this {any} @param {unknown} [encoding] @param {number} [start] @param {number} [end] */
  BufferClass.prototype.toString = function toString (encoding, start, end) {
    if (isBase64Url(encoding)) return plainToString.call(this, 'base64', start, end).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    // eslint-disable-next-line prefer-rest-params
    return plainToString.apply(this, /** @type {any} */ (arguments))
  }
  /** @this {any} @param {unknown} value @param {unknown} [encodingOrOffset] */
  BufferClass.from = function from (value, encodingOrOffset) {
    if (typeof value === 'string' && isBase64Url(encodingOrOffset)) return plainFrom.call(this, value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    // eslint-disable-next-line prefer-rest-params
    return plainFrom.apply(this, /** @type {any} */ (arguments))
  }
  /** @param {unknown} encoding */
  BufferClass.isEncoding = function isEncoding (encoding) {
    return isBase64Url(encoding) || plainIsEncoding.call(this, encoding)
  }
  return true
}

/** @param {unknown} encoding */
const isBase64Url = (encoding) => typeof encoding === 'string' && encoding.toLowerCase() === 'base64url'

/** @param {any} BufferClass */
function knowsBase64Url (BufferClass) {
  try {
    return BufferClass.from([251, 255]).toString('base64url') === '-_8'
  } catch {
    return false
  }
}
