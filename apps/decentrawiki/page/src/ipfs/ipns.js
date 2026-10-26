// IPNS for Ed25519 keys: names, signed records and key files, written and checked with
// WebCrypto. Plain JavaScript with no dependencies, so it runs unchanged in the editor page
// and in the pinning relay on Node. A record is laid out as Kubo writes it with its default
// `--v1compat`; the format is https://specs.ipfs.tech/ipns/ipns-record/.

import {
  base32Decode, base58Decode, bytesEqual, concatBytes, decodeVarint, readCidBytes
} from './cid.js'
import {
  base36Decode, base36Encode, encodeData, fieldBytes, fieldVarint, fromBase64, readCbor, readFields
} from './wire.js'

export const IPNS_RECORD_TYPE = 'application/vnd.ipfs.ipns-record'
export const MAX_RECORD_BYTES = 10240

const LIBP2P_KEY = 0x72
const IDENTITY = 0x00
const KEY_TYPE_ED25519 = 1n
const MAX_NAME_CHARS = 128
const MAX_KEY_FILE_BYTES = 8192
const ED25519 = { name: 'Ed25519' }
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
const SIGNATURE_PREFIX = new TextEncoder().encode('ipns-signature:')
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/

const encoder = new TextEncoder()
const strictDecoder = new TextDecoder('utf-8', { fatal: true })

/**
 * @typedef {object} IpnsRecord
 * @property {string} value the path the name points at, such as `/ipfs/bafy...`
 * @property {number} sequence
 * @property {string} validity the RFC 3339 time the record runs out
 * @property {number} validUntil `validity` as epoch milliseconds
 * @property {number} ttlMs
 * @property {Uint8Array} data the DAG-CBOR bytes that signatureV2 covers
 * @property {Uint8Array} signatureV2
 * @property {Uint8Array | null} signatureV1
 * @property {Uint8Array | null} pubKey
 */

export class IpnsError extends Error {
  /** @param {'malformed' | 'signature' | 'expired' | 'mismatch' | 'unsupported'} kind @param {string} message */
  constructor (kind, message) {
    super(message)
    this.name = 'IpnsError'
    this.kind = kind
  }
}

/** @param {string} why */
const damaged = (why) => new IpnsError('malformed', `This is not a usable IPNS record: ${why}.`)
/** @param {string} why */
const notAKeyFile = (why) => `This is not an IPNS key file DecentraWiki can use: ${why}.`

// Time

/** RFC 3339 to epoch milliseconds (nanoseconds are cut to milliseconds), or null. @param {string} text */
function parseTime (text) {
  const match = RFC3339.exec(text)
  if (match === null) return null
  const [, year, month, day, hour, minute, second, fraction = '', sign, offsetHour = '0', offsetMinute = '0'] = match
  const date = new Date(0)
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
  if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour) > 23 || Number(offsetMinute) > 59) return null
  date.setUTCHours(Number(hour), Number(minute), Number(second), Number((fraction + '00').slice(0, 3)))
  const offset = (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000
  return date.getTime() - (sign === '-' ? -offset : offset)
}

// Keys and names

/** WebCrypto without Ed25519 (an old browser) says so in words. @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
async function withEd25519 (operation) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof Error && error.name === 'NotSupportedError') {
      throw new IpnsError('unsupported', 'This browser cannot make or check IPNS signatures: its WebCrypto has no Ed25519. Update the browser.')
    }
    throw error
  }
}

/** @param {Uint8Array} seed @param {boolean} extractable @param {KeyUsage[]} usages */
function importSeed (seed, extractable, usages) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new RangeError('an Ed25519 seed has 32 bytes')
  return withEd25519(() => globalThis.crypto.subtle.importKey('pkcs8', /** @type {BufferSource} */ (concatBytes([PKCS8_PREFIX, seed])), ED25519, extractable, usages))
}

/** @returns {Promise<{ seed: Uint8Array, publicKey: Uint8Array }>} */
export async function generateNameKey () {
  const pair = /** @type {CryptoKeyPair} */ (await withEd25519(() => globalThis.crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])))
  const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey))
  if (pkcs8.length !== 48 || !bytesEqual(pkcs8.subarray(0, 16), PKCS8_PREFIX)) {
    throw new IpnsError('unsupported', 'This browser writes Ed25519 keys in a layout DecentraWiki does not know.')
  }
  const publicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey))
  return { seed: pkcs8.slice(16), publicKey }
}

/** @param {Uint8Array} seed @returns {Promise<Uint8Array>} */
export async function publicKeyOf (seed) {
  const key = await importSeed(seed, true, ['sign'])
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', key)
  return fromBase64(/** @type {string} */ (jwk.x))
}

/** libp2p's protobuf `PublicKey { Type = Ed25519, Data }`. @param {Uint8Array} publicKey */
function marshalPublicKey (publicKey) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) throw new RangeError('an Ed25519 public key has 32 bytes')
  return concatBytes([fieldVarint(1, KEY_TYPE_ED25519), fieldBytes(2, publicKey)])
}

/** The identity multihash of the marshalled key: what a peer id is. @param {Uint8Array} publicKey */
function multihashOf (publicKey) {
  const key = marshalPublicKey(publicKey)
  return concatBytes([Uint8Array.of(IDENTITY, key.length), key])
}

/** The name as Kubo prints it: a CIDv1 of codec libp2p-key, in base36. @param {Uint8Array} publicKey */
export function nameOf (publicKey) {
  return 'k' + base36Encode(concatBytes([Uint8Array.of(1, LIBP2P_KEY), multihashOf(publicKey)]))
}

/** @param {string} text @returns {{ name: string, publicKey: Uint8Array }} */
export function parseName (text) {
  const input = typeof text === 'string' ? text.trim() : ''
  const notAName = (/** @type {string} */ why) => new IpnsError('malformed', `That is not an IPNS name: ${why}. Paste the name alone (it starts with k51), without ipns:// or /ipns/.`)
  if (input === '') throw notAName('it is empty')
  if (input.length > MAX_NAME_CHARS) throw notAName('it is too long')
  /** @type {{ hashCode: number, digest: Uint8Array, whole: Uint8Array }} */
  let multihash
  try {
    if (input.startsWith('k') || input.startsWith('b')) {
      const bytes = input.startsWith('k') ? base36Decode(input.slice(1)) : base32Decode(input.slice(1))
      const { cid, length } = readCidBytes(bytes)
      if (length !== bytes.length) throw new Error('trailing bytes')
      if (cid.version !== 1 || cid.codec !== LIBP2P_KEY) {
        throw new IpnsError('malformed', 'That is a content address (a CID), not an IPNS name. An IPNS name starts with k51.')
      }
      multihash = { hashCode: cid.hashCode, digest: cid.digest, whole: bytes.subarray(2) }
    } else {
      const bytes = base58Decode(input)
      const hashCode = decodeVarint(bytes, 0)
      const size = decodeVarint(bytes, hashCode.length)
      const start = hashCode.length + size.length
      if (start + size.value !== bytes.length) throw new Error('bad multihash length')
      multihash = { hashCode: hashCode.value, digest: bytes.subarray(start), whole: bytes }
    }
  } catch (error) {
    if (error instanceof IpnsError) throw error
    throw notAName('it does not decode')
  }
  const cannotUse = new IpnsError('unsupported', 'That IPNS name belongs to a key DecentraWiki cannot use. It works with Ed25519 names, which start with k51.')
  if (multihash.hashCode !== IDENTITY) throw cannotUse
  let key
  try {
    key = readFields(multihash.digest, { 1: 'varint', 2: 'bytes' })
  } catch {
    throw notAName('it does not hold a public key')
  }
  if (key.get(1) !== KEY_TYPE_ED25519) throw cannotUse
  const data = key.get(2)
  if (!(data instanceof Uint8Array) || data.length !== 32 || !bytesEqual(multihash.whole, multihashOf(data))) {
    throw notAName('its key is damaged')
  }
  const publicKey = data.slice()
  return { name: nameOf(publicKey), publicKey }
}

// Records

/** The fields of an IpnsEntry the reader keeps. */
const ENTRY_FIELDS = /** @type {const} */ ({ 1: 'bytes', 2: 'bytes', 3: 'varint', 4: 'bytes', 5: 'varint', 6: 'varint', 7: 'bytes', 8: 'bytes', 9: 'bytes' })

/**
 * @param {{ seed: Uint8Array, value: string, sequence: number, validity: Date | string, ttlMs: number }} options
 * @returns {Promise<Uint8Array>}
 */
export async function createRecord ({ seed, value, sequence, validity, ttlMs }) {
  if (typeof value !== 'string' || value === '') throw new RangeError('an IPNS record needs a value')
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError('the sequence must be a non-negative integer')
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || BigInt(ttlMs) * 1_000_000n >= 1n << 64n) throw new RangeError('the TTL must be a non-negative number of milliseconds')
  const validityText = validity instanceof Date ? (validity.getUTCFullYear() <= 9999 ? validity.toISOString() : '') : validity
  if (typeof validityText !== 'string' || parseTime(validityText) === null) throw new RangeError('the validity must be a date, or a time in RFC 3339 form')
  const valueBytes = encoder.encode(value)
  const validityBytes = encoder.encode(validityText)
  const data = encodeData({ valueBytes, validityBytes, sequence, ttlNs: BigInt(ttlMs) * 1_000_000n })
  const key = await importSeed(seed, false, ['sign'])
  /** @param {Uint8Array} message */
  const sign = async (message) => new Uint8Array(await globalThis.crypto.subtle.sign(ED25519, key, /** @type {BufferSource} */ (message)))
  const signatureV2 = await sign(concatBytes([SIGNATURE_PREFIX, data]))
  const signatureV1 = await sign(concatBytes([valueBytes, validityBytes, encoder.encode('EOL')]))
  const record = concatBytes([
    fieldBytes(1, valueBytes), fieldBytes(2, signatureV1), fieldVarint(3, 0), fieldBytes(4, validityBytes),
    fieldVarint(5, sequence), fieldVarint(6, BigInt(ttlMs) * 1_000_000n), fieldBytes(8, signatureV2), fieldBytes(9, data)
  ])
  if (record.length > MAX_RECORD_BYTES) {
    throw new IpnsError('malformed', `This IPNS record would be ${record.length} bytes, over the ${MAX_RECORD_BYTES} allowed. Shorten the address it points at.`)
  }
  return record
}

/**
 * Reads a record and its V1 copies. Nothing is verified here.
 * @param {Uint8Array} bytes
 */
function decode (bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw damaged('it is empty')
  if (bytes.length > MAX_RECORD_BYTES) throw damaged(`it is larger than the ${MAX_RECORD_BYTES} bytes a record may have`)
  let fields
  try {
    fields = readFields(bytes, ENTRY_FIELDS)
  } catch {
    throw damaged('it is not an IPNS record')
  }
  const data = fields.get(9)
  const signatureV2 = fields.get(8)
  if (!(data instanceof Uint8Array) || !(signatureV2 instanceof Uint8Array)) {
    if (fields.has(1) && fields.has(2)) throw new IpnsError('unsupported', 'This IPNS record is in the old V1 format, which DecentraWiki does not accept. Publish again with a current Kubo.')
    throw damaged('it has no V2 signature or data')
  }
  let map
  try {
    const item = readCbor(data, 0, 0)
    if (item.next !== data.length || !(item.value instanceof Map)) throw new Error('not a map')
    map = /** @type {Map<string, unknown>} */ (item.value)
  } catch {
    throw damaged('its signed data is not valid DAG-CBOR')
  }
  /** @param {string} key */
  const bytesOf = (key) => {
    const found = map.get(key)
    if (!(found instanceof Uint8Array)) throw damaged(`its signed data has no ${key}`)
    return found
  }
  /** @param {string} key */
  const uintOf = (key) => {
    const found = map.get(key)
    if (typeof found !== 'bigint' || found < 0n || found >= 1n << 64n) throw damaged(`its signed data has no ${key}`)
    return found
  }
  const valueBytes = bytesOf('Value')
  const validityBytes = bytesOf('Validity')
  const sequence = uintOf('Sequence')
  const ttlNs = uintOf('TTL')
  if (uintOf('ValidityType') !== 0n) throw damaged('it says how it runs out in a way DecentraWiki does not know')
  if (sequence > BigInt(Number.MAX_SAFE_INTEGER)) throw damaged('its sequence number is too large')
  let value
  let validity
  try {
    value = strictDecoder.decode(valueBytes)
    validity = strictDecoder.decode(validityBytes)
  } catch {
    throw damaged('its value or expiry is not text')
  }
  const validUntil = parseTime(validity)
  if (validUntil === null) throw damaged('its expiry is not a time')
  const signatureV1 = fields.get(2)
  const pubKey = fields.get(7)
  /** @type {IpnsRecord} */
  const record = {
    value,
    sequence: Number(sequence),
    validity,
    validUntil,
    ttlMs: Number(ttlNs / 1_000_000n),
    data: data.slice(),
    signatureV2: signatureV2.slice(),
    signatureV1: signatureV1 instanceof Uint8Array ? signatureV1.slice() : null,
    pubKey: pubKey instanceof Uint8Array ? pubKey.slice() : null
  }
  const legacy = {
    value: fields.get(1),
    validityType: fields.get(3),
    validity: fields.get(4),
    sequence: fields.get(5),
    ttl: fields.get(6)
  }
  return { record, legacy, signed: { valueBytes, validityBytes, sequence, ttlNs } }
}

/** @param {Uint8Array} bytes @returns {IpnsRecord} */
export function parseRecord (bytes) {
  return decode(bytes).record
}

/**
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {{ now?: number, allowExpired?: boolean }} [options]
 * @returns {Promise<IpnsRecord>}
 */
export async function verifyRecord (bytes, name, { now = Date.now(), allowExpired = false } = {}) {
  const { publicKey } = parseName(name)
  const { record, legacy, signed } = decode(bytes)
  let valid = false
  try {
    const key = await withEd25519(() => globalThis.crypto.subtle.importKey('raw', /** @type {BufferSource} */ (publicKey), ED25519, false, ['verify']))
    valid = await globalThis.crypto.subtle.verify(ED25519, key, /** @type {BufferSource} */ (record.signatureV2), /** @type {BufferSource} */ (concatBytes([SIGNATURE_PREFIX, record.data])))
  } catch (error) {
    if (error instanceof IpnsError) throw error
  }
  if (!valid) throw new IpnsError('signature', 'This IPNS record was not signed by the key that owns this name, or it was changed after signing.')
  if (record.pubKey !== null && !bytesEqual(record.pubKey, marshalPublicKey(publicKey))) {
    throw new IpnsError('mismatch', 'This IPNS record carries a different public key than the one the name stands for.')
  }
  const disagrees = (legacy.value !== undefined && !(legacy.value instanceof Uint8Array && bytesEqual(legacy.value, signed.valueBytes))) ||
    (legacy.validity !== undefined && !(legacy.validity instanceof Uint8Array && bytesEqual(legacy.validity, signed.validityBytes))) ||
    (legacy.validityType !== undefined && legacy.validityType !== 0n) ||
    (legacy.sequence !== undefined && legacy.sequence !== signed.sequence) ||
    (legacy.ttl !== undefined && legacy.ttl !== signed.ttlNs)
  if (disagrees) throw new IpnsError('mismatch', 'This IPNS record contradicts itself: its old-format copy of the value, expiry, sequence or TTL differs from the signed one.')
  if (!allowExpired && record.validUntil <= now) {
    throw new IpnsError('expired', `This IPNS record ran out at ${record.validity}. Its owner has to publish a new one.`)
  }
  return record
}

// Key files

/** Kubo's `ipfs key export` default: libp2p's cleartext protobuf. @param {Uint8Array} seed @param {Uint8Array} publicKey */
export function encodeKeyFile (seed, publicKey) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new RangeError('an Ed25519 seed has 32 bytes')
  marshalPublicKey(publicKey)
  return concatBytes([fieldVarint(1, KEY_TYPE_ED25519), fieldBytes(2, concatBytes([seed, publicKey]))])
}

/**
 * The protobuf form, or the PKCS#8 PEM of `ipfs key export --format=pem-pkcs8-cleartext`.
 * @param {Uint8Array} bytes
 * @returns {Promise<{ seed: Uint8Array, publicKey: Uint8Array }>}
 */
export async function decodeKeyFile (bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new IpnsError('malformed', notAKeyFile('it is empty'))
  if (bytes.length > MAX_KEY_FILE_BYTES) throw new IpnsError('malformed', notAKeyFile('it is too large'))
  const text = new TextDecoder().decode(bytes).trim()
  if (text.startsWith('-----BEGIN')) {
    const pem = /^-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*)-----END \1-----$/.exec(text)
    if (pem === null) throw new IpnsError('malformed', notAKeyFile('its PEM text is damaged'))
    if (pem[1] !== 'PRIVATE KEY') throw new IpnsError('unsupported', notAKeyFile(`it is a "${pem[1]}", and only an unencrypted Ed25519 PKCS#8 key works`))
    let der
    try {
      der = fromBase64(/** @type {string} */ (pem[2]))
    } catch {
      throw new IpnsError('malformed', notAKeyFile('its PEM text is damaged'))
    }
    if (der.length !== 48 || !bytesEqual(der.subarray(0, 16), PKCS8_PREFIX)) {
      throw new IpnsError('unsupported', notAKeyFile('it is not an Ed25519 key'))
    }
    const seed = der.slice(16)
    return { seed, publicKey: await publicKeyOf(seed) }
  }
  let fields
  try {
    fields = readFields(bytes, { 1: 'varint', 2: 'bytes' })
  } catch {
    throw new IpnsError('malformed', notAKeyFile('it is neither a Kubo key file nor a PEM'))
  }
  const type = fields.get(1)
  const data = fields.get(2)
  if (type === undefined || !(data instanceof Uint8Array)) throw new IpnsError('malformed', notAKeyFile('it is neither a Kubo key file nor a PEM'))
  if (type !== KEY_TYPE_ED25519) throw new IpnsError('unsupported', notAKeyFile('it is not an Ed25519 key, and only Ed25519 keys work'))
  if (data.length !== 64) throw new IpnsError('malformed', notAKeyFile('its key has the wrong size'))
  const seed = data.slice(0, 32)
  const publicKey = data.slice(32)
  if (!bytesEqual(publicKey, await publicKeyOf(seed))) {
    throw new IpnsError('mismatch', 'This IPNS key file is damaged: its public key does not belong to its private key.')
  }
  return { seed, publicKey }
}
