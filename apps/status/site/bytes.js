// Byte helpers shared by the pure modules. Plain Uint8Array in, plain Uint8Array out.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** @param {Uint8Array} bytes */
export function toHex (bytes) {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** @param {string} hex with or without a leading 0x */
export function fromHex (hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error('not a hex string')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** @param {...Uint8Array} parts */
export function concat (...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** @param {Uint8Array} left @param {Uint8Array} right */
export function equalBytes (left, right) {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false
  return true
}

/** @param {string} text */
export const utf8 = (text) => encoder.encode(text)

/** @param {Uint8Array} bytes */
export const text = (bytes) => decoder.decode(bytes)

/** @param {string} base64 standard alphabet, padded or not */
export function fromBase64 (base64) {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
