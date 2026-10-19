// IPNS records: parse the protobuf envelope and the signed CBOR Data inside it, and verify
// the V2 signature with WebCrypto Ed25519 against the key the name itself carries.

import { concat, text, utf8 } from './bytes.js'
import { decodeCbor } from './cbor.js'
import { CODEC, HASH, parseCid } from './cid.js'
import { readFields } from './protobuf.js'

const SIGNATURE_PREFIX = 'ipns-signature:'

/**
 * @typedef {{
 *   value: string, validity: string, validityType: number, sequence: number, ttl: number | null,
 *   signatureV2: Uint8Array | null, signedData: Uint8Array | null, consistent: boolean
 * }} IpnsRecord
 */

/**
 * The record as the Data map says it, falling back to the unsigned fields of an old record.
 * `consistent` is false when both are present and disagree: that record must be refused.
 * @param {Uint8Array} bytes
 * @returns {IpnsRecord}
 */
export function parseRecord (bytes) {
  /** @type {Record<number, Uint8Array | number>} */
  const pb = {}
  for (const { field, value } of readFields(bytes)) pb[field] = value
  const signatureV2 = pb[8] instanceof Uint8Array ? pb[8] : null
  const signedData = pb[9] instanceof Uint8Array ? pb[9] : null
  const unsigned = {
    value: pb[1] instanceof Uint8Array ? text(pb[1]) : '',
    validity: pb[4] instanceof Uint8Array ? text(pb[4]) : '',
    validityType: typeof pb[3] === 'number' ? pb[3] : 0,
    sequence: typeof pb[5] === 'number' ? pb[5] : 0,
    ttl: typeof pb[6] === 'number' ? pb[6] : null
  }
  if (!signedData) return { ...unsigned, signatureV2, signedData, consistent: true }
  const data = /** @type {Record<string, unknown>} */ (decodeCbor(signedData))
  const signed = {
    value: data.Value instanceof Uint8Array ? text(data.Value) : '',
    validity: data.Validity instanceof Uint8Array ? text(data.Validity) : '',
    validityType: typeof data.ValidityType === 'number' ? data.ValidityType : 0,
    sequence: typeof data.Sequence === 'number' ? data.Sequence : 0,
    ttl: typeof data.TTL === 'number' ? data.TTL : null
  }
  const consistent = (pb[1] === undefined || unsigned.value === signed.value) && (pb[5] === undefined || unsigned.sequence === signed.sequence)
  return { ...signed, signatureV2, signedData, consistent }
}

/**
 * When a record stops being valid. Only the EOL validity type (0) is defined.
 * @param {IpnsRecord} record
 * @returns {Date | null}
 */
export function expiry (record) {
  if (record.validityType !== 0) return null
  const trimmed = record.validity.replace(/(\.\d{3})\d*Z$/, '$1Z')
  const time = Date.parse(trimmed)
  return Number.isNaN(time) ? null : new Date(time)
}

/**
 * The CID a record's value names, when the value is an /ipfs/ path.
 * @param {IpnsRecord} record
 * @returns {string | null} the CID text as written in the path
 */
export function valueCid (record) {
  const match = /^\/ipfs\/([a-z0-9]+)(?:\/.*)?$/.exec(record.value)
  return match ? /** @type {string} */ (match[1]) : null
}

/**
 * The Ed25519 key a libp2p-key name carries (an identity multihash around a protobuf
 * PublicKey), or null for a name that does not carry one.
 * @param {string} name
 * @returns {Uint8Array | null}
 */
export function publicKeyOfName (name) {
  const cid = parseCid(name)
  if (cid.codec !== CODEC.libp2pKey || cid.hashCode !== HASH.identity) return null
  let type = -1
  let data = null
  for (const { field, value } of readFields(cid.digest)) {
    if (field === 1 && typeof value === 'number') type = value
    if (field === 2 && value instanceof Uint8Array) data = value
  }
  return type === 1 && data && data.length === 32 ? data : null
}

/**
 * Whether the record's V2 signature is the name's own. 'not checked' when this browser's
 * WebCrypto has no Ed25519 or the name carries no key it can use; never a failure.
 * @param {IpnsRecord} record
 * @param {string} name
 * @returns {Promise<{ signature: 'valid' | 'invalid' | 'not checked', reason: string }>}
 */
export async function verifyRecord (record, name) {
  if (!record.consistent) return { signature: 'invalid', reason: 'the signed data disagrees with the unsigned fields' }
  if (!record.signatureV2 || !record.signedData) return { signature: 'not checked', reason: 'the record has no V2 signature' }
  const key = publicKeyOfName(name)
  if (!key) return { signature: 'not checked', reason: 'the name does not carry an Ed25519 key' }
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return { signature: 'not checked', reason: 'this browser has no WebCrypto here' }
  try {
    const imported = await subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify'])
    const message = concat(utf8(SIGNATURE_PREFIX), record.signedData)
    const ok = await subtle.verify({ name: 'Ed25519' }, imported, record.signatureV2, message)
    return ok ? { signature: 'valid', reason: '' } : { signature: 'invalid', reason: 'the signature does not match the name' }
  } catch {
    return { signature: 'not checked', reason: 'this browser has no Ed25519' }
  }
}
