// The address of a file from its sha2-256 digest: the CIDv1 of a dag-pb node, in base32 lower case. A CIDv1 written this way is one
// DNS label (59 characters), so it fits a host name, which the CIDv0 of the same digest (`Qm...`, base58 with capitals) does not.

import { concat } from './bytes.js'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** CID version 1, the dag-pb codec, the sha2-256 multihash code and its 32-byte length. */
const DAG_PB_SHA2_256 = Uint8Array.of(0x01, 0x70, 0x12, 0x20)

/** @param {Uint8Array} bytes @returns {string} RFC 4648 base32 in lower case, with no padding */
export function base32Lower (bytes) {
  let out = ''
  let bits = 0
  let held = 0
  for (const byte of bytes) {
    held = (held << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(held >>> (bits - 5)) & 31]
      bits -= 5
    }
    held &= (1 << bits) - 1
  }
  return bits === 0 ? out : out + ALPHABET[(held << (5 - bits)) & 31]
}

/**
 * The CIDv1 of a dag-pb node whose sha2-256 digest is `digest`, as `ipfs://` and a host name take it.
 * @param {Uint8Array} digest the 32 bytes of the digest
 * @returns {string} `b` and the base32 of the version, codec and multihash
 */
export function dagPbCid (digest) {
  if (digest.length !== 32) throw new RangeError('a sha2-256 digest is 32 bytes')
  return `b${base32Lower(concat(DAG_PB_SHA2_256, digest))}`
}
