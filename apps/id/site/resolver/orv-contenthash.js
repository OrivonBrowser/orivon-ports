// ENSIP-7 contenthash, written as the address Orivon's ENS resolver answers for it: ipfs://, ipns://, bzz:// or ar://.
// The browser parses what it is given again before it loads anything, so this only has to agree with it on what each
// form means; a form it would refuse (a libp2p key under the ipfs code, a Swarm hash that is not Keccak-256) gives null.

import { concat, text, toHex } from '../sdk/bytes.js'

const IPFS = 0xe3
const SWARM = 0xe4
const IPNS = 0xe5
const ARWEAVE = 0xb29910
const CIDV1 = 1
const DAG_PB = 0x70
const LIBP2P_KEY = 0x72
const IDENTITY = 0x00
const KECCAK_256 = 0x1b
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** @typedef {{ type: 'ipfs' | 'ipns' | 'bzz' | 'arw', value: string }} Address */

/**
 * The unsigned varint at `at`, and where it ends; null when it is cut off or longer than eight bytes.
 * @param {Uint8Array} bytes
 * @param {number} at
 * @returns {[number, number] | null}
 */
function varint (bytes, at) {
  let value = 0
  for (let i = 0; i < 8 && at + i < bytes.length; i++) {
    const byte = /** @type {number} */ (bytes[at + i])
    value += (byte & 0x7f) * 2 ** (7 * i)
    if ((byte & 0x80) === 0) return [value, at + i + 1]
  }
  return null
}

/**
 * A CID, v0 or v1, and nothing after it.
 * @param {Uint8Array} bytes
 * @returns {{ codec: number, hash: Uint8Array, hashCode: number, digest: Uint8Array, v0: boolean } | null}
 */
function parseCid (bytes) {
  if (bytes.length === 34 && bytes[0] === 0x12 && bytes[1] === 0x20) {
    return { codec: DAG_PB, hash: bytes, hashCode: 0x12, digest: bytes.subarray(2), v0: true }
  }
  if (bytes[0] !== CIDV1) return null
  const codec = varint(bytes, 1)
  const code = codec === null ? null : varint(bytes, codec[1])
  const length = code === null ? null : varint(bytes, code[1])
  if (codec === null || code === null || length === null) return null
  const digest = bytes.subarray(length[1])
  if (digest.length !== length[0]) return null
  return { codec: codec[0], hash: bytes.subarray(codec[1]), hashCode: code[0], digest, v0: false }
}

/** @param {Uint8Array} bytes @returns {string} lower-case, no padding */
export function base32 (bytes) {
  let out = ''
  let bits = 0
  let held = 0
  for (const byte of bytes) {
    held = (held << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(held >>> (bits - 5)) & 31]
      bits -= 5
    }
    held &= (1 << bits) - 1
  }
  return bits > 0 ? out + BASE32[(held << (5 - bits)) & 31] : out
}

/** @param {Uint8Array} bytes */
const base36 = (bytes) => BigInt('0x' + toHex(bytes)).toString(36)

/** @param {Uint8Array} bytes @returns {string} */
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

/** @param {Uint8Array} digest @returns {string | null} a DNS name of two labels or more, or null */
function domainIn (digest) {
  try {
    const name = text(digest).toLowerCase()
    const labels = name.split('.')
    return name.length <= 253 && labels.length >= 2 && labels.every((label) => DNS_LABEL.test(label)) ? name : null
  } catch {
    return null
  }
}

/**
 * @param {Uint8Array} hash a contenthash: the protocol code, then that protocol's value
 * @returns {Address | null} null for an empty contenthash and for a protocol or form the browser does not load
 */
export function addressOfContenthash (hash) {
  const protocol = varint(hash, 0)
  if (protocol === null) return null
  const value = hash.subarray(protocol[1])
  if (protocol[0] === ARWEAVE) return value.length === 32 ? { type: 'arw', value: `ar://${base64url(value)}` } : null
  const cid = parseCid(value)
  if (cid === null) return null
  if (protocol[0] === IPFS) {
    if (cid.codec === LIBP2P_KEY) return null
    return { type: 'ipfs', value: `ipfs://b${base32(cid.v0 ? concat(Uint8Array.of(CIDV1, DAG_PB), cid.hash) : value)}` }
  }
  if (protocol[0] === SWARM) {
    return cid.hashCode === KECCAK_256 && cid.digest.length === 32 ? { type: 'bzz', value: `bzz://${toHex(cid.digest)}` } : null
  }
  if (protocol[0] !== IPNS) return null
  if (cid.hashCode === IDENTITY && cid.codec !== LIBP2P_KEY) {
    const domain = domainIn(cid.digest)
    return domain === null ? null : { type: 'ipns', value: `ipns://${domain}` }
  }
  return { type: 'ipns', value: `ipns://k${base36(concat(Uint8Array.of(CIDV1, LIBP2P_KEY), cid.hash))}` }
}
