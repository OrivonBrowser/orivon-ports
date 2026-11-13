// Signs EIP-1559 transactions with a test key, so the fork run sends real signed bytes to a node. Test-side only: the key is a
// throwaway, and the arithmetic behind it (test/support/secp256k1.ts) takes time depending on the key.

import { concat, fromHex, toHex } from '../site/sdk/bytes.js'
import { keccak256 } from '../site/sdk/keccak.js'
import { addressOf, signDigest } from '../test/support/secp256k1.ts'

/** @param {bigint | number} value */
const bigEndian = (value) => {
  const text = BigInt(value).toString(16)
  return text === '0' ? new Uint8Array(0) : fromHex(text.length % 2 === 1 ? `0${text}` : text)
}

/** @param {Uint8Array | (Uint8Array | unknown[])[]} item @returns {Uint8Array} */
function rlp (item) {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && (item[0] ?? 0) < 0x80) return item
    return concat(lengthPrefix(item.length, 0x80), item)
  }
  const body = concat(...item.map((one) => rlp(/** @type {any} */ (one))))
  return concat(lengthPrefix(body.length, 0xc0), body)
}

/** @param {number} length @param {number} offset */
function lengthPrefix (length, offset) {
  if (length < 56) return Uint8Array.of(offset + length)
  const size = bigEndian(length)
  return concat(Uint8Array.of(offset + 55 + size.length), size)
}

/** The address of a private key, as a checksummed string. @param {Uint8Array} key */
export const addressOfKey = (key) => addressOf(key)

/**
 * @param {Uint8Array} key
 * @param {{ chainId: number, nonce: number, maxPriorityFeePerGas: bigint, maxFeePerGas: bigint, gas: number, to: string, value?: bigint, data?: Uint8Array }} tx
 * @returns {Uint8Array} the raw transaction, type 2
 */
export function signTransaction (key, tx) {
  const fields = [
    bigEndian(tx.chainId), bigEndian(tx.nonce), bigEndian(tx.maxPriorityFeePerGas), bigEndian(tx.maxFeePerGas), bigEndian(tx.gas),
    fromHex(tx.to.slice(2)), bigEndian(tx.value ?? 0n), tx.data ?? new Uint8Array(0), []
  ]
  const type = Uint8Array.of(2)
  const signature = signDigest(key, keccak256(concat(type, rlp(/** @type {any} */ (fields)))))
  const trim = (/** @type {Uint8Array} */ bytes) => bigEndian(BigInt(`0x${toHex(bytes)}`))
  return concat(type, rlp(/** @type {any} */ ([...fields, bigEndian((signature[64] ?? 27) - 27), trim(signature.subarray(0, 32)), trim(signature.subarray(32, 64))])))
}
