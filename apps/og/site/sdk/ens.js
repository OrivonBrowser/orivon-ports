// EIP-137 hashing and ENSIP-10 name encoding. Pure: a name must already be normalized, because a case or
// Unicode mismatch here would silently hash a different name.

import { concat, toHex, utf8 } from './bytes.js'
import { keccak256 } from './keccak.js'

export class NameError extends Error {}

/** @param {string} name @returns {Uint8Array[]} the labels as UTF-8, empty for the root */
function labelBytes (name) {
  if (name === '') return []
  return name.split('.').map((label) => {
    const bytes = utf8(label)
    if (bytes.length === 0 || bytes.length > 63) throw new NameError(`a label of ${bytes.length} bytes in "${name}"`)
    return bytes
  })
}

/** @param {string} label @returns {string} 0x-prefixed */
export const labelhash = (label) => '0x' + toHex(keccak256(utf8(label)))

/** @param {string} name @returns {string} 0x-prefixed; the root name hashes to 32 zero bytes */
export function namehash (name) {
  /** @type {Uint8Array} */
  let node = new Uint8Array(32)
  for (const label of labelBytes(name).reverse()) node = keccak256(concat(node, keccak256(label)))
  return '0x' + toHex(node)
}

/** The wire format ENSIP-10 resolvers take: each label after its length byte, then a zero byte. @param {string} name */
export function dnsEncode (name) {
  const labels = labelBytes(name)
  const parts = labels.flatMap((label) => [Uint8Array.of(label.length), label])
  const out = concat(...parts, Uint8Array.of(0))
  if (out.length > 255) throw new NameError('a name longer than 255 bytes')
  return out
}
