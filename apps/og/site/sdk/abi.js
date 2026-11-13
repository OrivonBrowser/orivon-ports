// Contract ABI encoding and decoding for the types this site's calls use: address, bool, uintN, bytesN,
// bytes, string, tuples and dynamic arrays. Everything a node or a resolver answers is untrusted, so a
// decode refuses what it cannot read rather than guessing: a short answer, an offset out of range, a bool that
// is not 0 or 1, an address with dirty high bytes, a string that is not UTF-8.

import { concat, fromHex, toHex, utf8 } from './bytes.js'
import { keccak256 } from './keccak.js'

export class AbiError extends Error {}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * @typedef {{ kind: 'address' } | { kind: 'bool' } | { kind: 'bytes' } | { kind: 'string' }
 *   | { kind: 'uint', bits: number } | { kind: 'bytesN', size: number }
 *   | { kind: 'array', of: AbiType } | { kind: 'tuple', of: AbiType[] }} AbiType
 */

/** @param {string} text comma-separated types, split at the top level only */
function splitTop (text) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') depth--
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  if (text !== '') parts.push(text.slice(start))
  return parts
}

/** @type {Map<string, AbiType>} */
const parsed = new Map()

/**
 * `address`, `bool`, `string`, `bytes`, `uint8` to `uint256`, `bytes1` to `bytes32`, `(a,b)` for a tuple and
 * `T[]` for a dynamic array. Nothing else: a type this site does not use is refused, not approximated.
 * @param {string} text
 * @returns {AbiType}
 */
export function parseType (text) {
  const known = parsed.get(text)
  if (known !== undefined) return known
  const type = parseUncached(text)
  parsed.set(text, type)
  return type
}

/** @param {string} text @returns {AbiType} */
function parseUncached (text) {
  if (text.endsWith('[]')) return { kind: 'array', of: parseType(text.slice(0, -2)) }
  if (text.startsWith('(') && text.endsWith(')')) return { kind: 'tuple', of: splitTop(text.slice(1, -1)).map(parseType) }
  if (text === 'address' || text === 'bool' || text === 'bytes' || text === 'string') return { kind: text }
  const uint = /^uint([1-9]\d*)$/.exec(text)
  if (uint !== null && Number(uint[1]) % 8 === 0 && Number(uint[1]) <= 256) return { kind: 'uint', bits: Number(uint[1]) }
  const fixed = /^bytes([1-9]\d?)$/.exec(text)
  if (fixed !== null && Number(fixed[1]) <= 32) return { kind: 'bytesN', size: Number(fixed[1]) }
  throw new AbiError(`unsupported ABI type "${text}"`)
}

/** @param {AbiType} type */
function isDynamic (type) {
  if (type.kind === 'bytes' || type.kind === 'string' || type.kind === 'array') return true
  return type.kind === 'tuple' && type.of.some(isDynamic)
}

/** @param {AbiType} type bytes the type takes in the head of its enclosing tuple @returns {number} */
function headSize (type) {
  if (type.kind === 'tuple' && !isDynamic(type)) return type.of.reduce((sum, part) => sum + headSize(part), 0)
  return 32
}

/** @param {bigint} value */
function word (value) {
  const out = new Uint8Array(32)
  let rest = value
  for (let i = 31; i >= 0 && rest > 0n; i--) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

/** @param {Uint8Array} bytes */
function padRight (bytes) {
  const out = new Uint8Array(Math.ceil(bytes.length / 32) * 32)
  out.set(bytes)
  return out
}

/** @param {unknown} value */
function toBytes (value) {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string' && value.startsWith('0x')) return fromHex(value)
  throw new AbiError('bytes need a Uint8Array or a 0x hex string')
}

/** @param {unknown} value */
function toBigInt (value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value)
  throw new AbiError('a number needs a bigint, a safe integer, or a decimal or 0x string')
}

/** @param {string} address 0x plus 40 hex digits, any case @returns {string} EIP-55 */
export function toChecksumAddress (address) {
  const lower = address.slice(2).toLowerCase()
  const hash = toHex(keccak256(utf8(lower)))
  let out = '0x'
  for (let i = 0; i < lower.length; i++) out += parseInt(hash[i] ?? '0', 16) >= 8 ? (lower[i] ?? '').toUpperCase() : lower[i]
  return out
}

/** Valid when 20 bytes of hex that are all one case, or whose mixed case is the EIP-55 checksum. @param {unknown} text */
export function isAddress (text) {
  if (typeof text !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(text)) return false
  const body = text.slice(2)
  return body === body.toLowerCase() || body === body.toUpperCase() || text === toChecksumAddress(text)
}

/** @param {string} left @param {string} right */
export const sameAddress = (left, right) => left.toLowerCase() === right.toLowerCase()

/**
 * @param {AbiType} type
 * @param {unknown} value
 * @returns {Uint8Array}
 */
function encodeValue (type, value) {
  switch (type.kind) {
    case 'address':
      if (!isAddress(value)) throw new AbiError('not an address')
      return word(BigInt(/** @type {string} */ (value)))
    case 'bool':
      if (typeof value !== 'boolean') throw new AbiError('not a bool')
      return word(value ? 1n : 0n)
    case 'uint': {
      const number = toBigInt(value)
      if (number < 0n || number >= 1n << BigInt(type.bits)) throw new AbiError(`does not fit uint${type.bits}`)
      return word(number)
    }
    case 'bytesN': {
      const bytes = toBytes(value)
      if (bytes.length !== type.size) throw new AbiError(`not ${type.size} bytes`)
      return padRight(bytes)
    }
    case 'bytes': {
      const bytes = toBytes(value)
      return concat(word(BigInt(bytes.length)), padRight(bytes))
    }
    case 'string': {
      if (typeof value !== 'string') throw new AbiError('not a string')
      const bytes = utf8(value)
      return concat(word(BigInt(bytes.length)), padRight(bytes))
    }
    case 'array':
      if (!Array.isArray(value)) throw new AbiError('not a list')
      return concat(word(BigInt(value.length)), encodeSequence(value.map(() => type.of), value))
    case 'tuple':
      if (!Array.isArray(value)) throw new AbiError('not a tuple (a list)')
      return encodeSequence(type.of, value)
  }
}

/** @param {AbiType[]} types @param {unknown[]} values */
function encodeSequence (types, values) {
  if (types.length !== values.length) throw new AbiError(`${types.length} types but ${values.length} values`)
  const headTotal = types.reduce((sum, type) => sum + headSize(type), 0)
  /** @type {Uint8Array[]} */
  const heads = []
  /** @type {Uint8Array[]} */
  const tails = []
  let tailLength = 0
  types.forEach((type, index) => {
    const encoded = encodeValue(type, values[index])
    if (isDynamic(type)) {
      heads.push(word(BigInt(headTotal + tailLength)))
      tails.push(encoded)
      tailLength += encoded.length
    } else {
      heads.push(encoded)
    }
  })
  return concat(...heads, ...tails)
}

/**
 * `abi.encode(values...)`. Addresses are 0x strings, numbers bigint (or a safe integer or a decimal string),
 * bytes a Uint8Array or a 0x string, tuples and arrays lists.
 * @param {string[]} types
 * @param {unknown[]} values
 */
export function encode (types, values) {
  return encodeSequence(types.map(parseType), values)
}

/** @param {Uint8Array} data @param {number} at */
function readWord (data, at) {
  if (at < 0 || at + 32 > data.length) throw new AbiError('the answer is shorter than its own layout')
  return data.subarray(at, at + 32)
}

/**
 * A length or an offset: it must point inside the data, which also keeps a hostile one from allocating.
 * @param {Uint8Array} data @param {number} at
 */
function readIndex (data, at) {
  const value = BigInt('0x' + toHex(readWord(data, at)))
  if (value > BigInt(data.length)) throw new AbiError('an offset or length points past the answer')
  return Number(value)
}

/** @param {Uint8Array} data @param {number} at @param {number} length */
function readBytes (data, at, length) {
  if (at + 32 + length > data.length) throw new AbiError('the bytes run past the answer')
  return data.slice(at + 32, at + 32 + length)
}

/**
 * @param {AbiType} type
 * @param {Uint8Array} data
 * @param {number} at where this value starts (its head for a static type, its tail for a dynamic one)
 * @returns {unknown}
 */
function decodeValue (type, data, at) {
  switch (type.kind) {
    case 'address': {
      const cell = readWord(data, at)
      if (cell.subarray(0, 12).some((byte) => byte !== 0)) throw new AbiError('an address with non-zero high bytes')
      return toChecksumAddress('0x' + toHex(cell.subarray(12)))
    }
    case 'bool': {
      const cell = readWord(data, at)
      const number = BigInt('0x' + toHex(cell))
      if (number > 1n) throw new AbiError('a bool that is neither 0 nor 1')
      return number === 1n
    }
    case 'uint': {
      const number = BigInt('0x' + toHex(readWord(data, at)))
      if (number >= 1n << BigInt(type.bits)) throw new AbiError(`a value too large for uint${type.bits}`)
      return number
    }
    case 'bytesN': {
      const cell = readWord(data, at)
      if (cell.subarray(type.size).some((byte) => byte !== 0)) throw new AbiError('bytesN with non-zero padding')
      return cell.slice(0, type.size)
    }
    case 'bytes':
      return readBytes(data, at, readIndex(data, at))
    case 'string':
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(readBytes(data, at, readIndex(data, at)))
      } catch (error) {
        if (error instanceof AbiError) throw error
        throw new AbiError('a string that is not UTF-8')
      }
    case 'array': {
      const length = readIndex(data, at)
      if (length * 32 > data.length) throw new AbiError('a list longer than the answer')
      return decodeSequence(Array.from({ length }, () => type.of), data, at + 32)
    }
    case 'tuple':
      return decodeSequence(type.of, data, at)
  }
}

/** @param {AbiType[]} types @param {Uint8Array} data @param {number} base */
function decodeSequence (types, data, base) {
  let head = base
  return types.map((type) => {
    if (isDynamic(type)) {
      const offset = readIndex(data, head)
      head += 32
      return decodeValue(type, data, base + offset)
    }
    const value = decodeValue(type, data, head)
    head += headSize(type)
    return value
  })
}

/**
 * `abi.decode(data, types)`: uint is bigint, address an EIP-55 string, bytes and bytesN a Uint8Array, tuples
 * and arrays lists.
 * @param {string[]} types
 * @param {Uint8Array} data
 * @returns {unknown[]}
 */
export function decode (types, data) {
  return decodeSequence(types.map(parseType), data, 0)
}

/**
 * @param {string} signature `name(type,type)` without spaces or names
 * @returns {{ name: string, types: string[] }}
 */
export function splitSignature (signature) {
  const open = signature.indexOf('(')
  if (open < 1 || !signature.endsWith(')')) throw new AbiError(`not a signature: ${signature}`)
  return { name: signature.slice(0, open), types: splitTop(signature.slice(open + 1, -1)) }
}

/** The four bytes a call starts with. @param {string} signature */
export const selector = (signature) => keccak256(utf8(signature)).slice(0, 4)

/** The first topic of an event. @param {string} signature @returns {string} 0x-prefixed */
export const topic0 = (signature) => '0x' + toHex(keccak256(utf8(signature)))

/** Calldata for `name(types)`. @param {string} signature @param {unknown[]} args */
export function encodeCall (signature, args) {
  return concat(selector(signature), encode(splitSignature(signature).types, args))
}

/**
 * What a reverted call said: `Error(string)`, `Panic(uint256)`, a custom error (its selector and data), or nothing.
 * @param {Uint8Array} data
 * @returns {{ kind: 'reason', reason: string } | { kind: 'panic', code: bigint } | { kind: 'custom', selector: string, data: Uint8Array } | { kind: 'empty' }}
 */
export function decodeRevert (data) {
  if (data.length < 4) return { kind: 'empty' }
  const head = toHex(data.subarray(0, 4))
  try {
    if (head === '08c379a0') return { kind: 'reason', reason: /** @type {string} */ (decode(['string'], data.subarray(4))[0]) }
    if (head === '4e487b71') return { kind: 'panic', code: /** @type {bigint} */ (decode(['uint256'], data.subarray(4))[0]) }
  } catch {
    // A malformed Error(string) is reported as the unknown error it is.
  }
  return { kind: 'custom', selector: '0x' + head, data: data.slice(4) }
}

/**
 * @typedef {{ name: string, topic: string, inputs: { name: string, type: string, indexed: boolean }[] }} EventAbi
 */

/**
 * `Name(type indexed name, type name, ...)`, the way Solidity declares an event.
 * @param {string} declaration
 * @returns {EventAbi}
 */
export function parseEvent (declaration) {
  const open = declaration.indexOf('(')
  if (open < 1 || !declaration.endsWith(')')) throw new AbiError(`not an event: ${declaration}`)
  const inputs = splitTop(declaration.slice(open + 1, -1)).map((part) => {
    const words = part.trim().split(/\s+/)
    const indexed = words[1] === 'indexed'
    return { type: words[0] ?? '', indexed, name: words[indexed ? 2 : 1] ?? '' }
  })
  const name = declaration.slice(0, open)
  return { name, topic: topic0(`${name}(${inputs.map((input) => input.type).join(',')})`), inputs }
}

/**
 * The fields of a log, by input name. An indexed string, bytes, array or tuple is only a hash on chain, so it
 * comes back as that topic.
 * @param {EventAbi} event
 * @param {{ topics: string[], data: Uint8Array }} log
 * @returns {Record<string, unknown>}
 */
export function decodeLog (event, log) {
  const indexed = event.inputs.filter((input) => input.indexed)
  if (log.topics[0] !== event.topic || log.topics.length !== indexed.length + 1) throw new AbiError(`not a ${event.name} log`)
  /** @type {Record<string, unknown>} */
  const out = {}
  indexed.forEach((input, index) => {
    const topic = /** @type {string} */ (log.topics[index + 1])
    out[input.name] = isDynamic(parseType(input.type)) ? topic : decode([input.type], fromHex(topic))[0]
  })
  const plain = event.inputs.filter((input) => !input.indexed)
  const values = decode(plain.map((input) => input.type), log.data)
  plain.forEach((input, index) => { out[input.name] = values[index] })
  return out
}
