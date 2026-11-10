// ENS by hand: namehash, the Universal Resolver call, reading its answer and its reverts, and the
// contenthash format. No library; the one call is resolve(bytes,bytes) around contenthash(bytes32).

import { concat, fromHex, toHex, utf8 } from './bytes.js'
import { cidToString, CODEC, parseCidBytes, readVarint } from './cid.js'
import { keccak256 } from './keccak.js'

/** ENS's Universal Resolver on mainnet. It finds a name's resolver in ENSv2 and in ENSv1 alike. */
export const UNIVERSAL_RESOLVER = '0xeeeeeeee14d718c2b47d9923deab1335e144eeee'
const RESOLVE_SELECTOR = '9061b923'
const CONTENTHASH_SELECTOR = 'bc1c58d1'
/** The Universal Resolver reverts this page tells apart, by error selector. */
const REVERT = { resolverNotFound: '77209fe8', resolverNotContract: '1e9535f2', resolverError: '95c0c752', unreachableName: '5fe9a5df', unsupportedProfile: '7b1c461b', offchainLookup: '556f1830' }
const NS = { ipfs: 0xe3, swarm: 0xe4, ipns: 0xe5 }
const SWARM = { manifestCodec: 0xfa, keccak256: 0x1b }

/**
 * EIP-137. Labels are lower-cased; full ENS normalisation is not needed for the names this
 * page asks about.
 * @param {string} name
 * @returns {string} 0x-prefixed
 */
export function namehash (name) {
  let node = new Uint8Array(32)
  if (name !== '') {
    for (const label of name.toLowerCase().split('.').reverse()) node = keccak256(concat(node, keccak256(utf8(label))))
  }
  return '0x' + toHex(node)
}

/**
 * The DNS wire form the Universal Resolver takes a name in: each label after its length byte, then a zero byte.
 * @param {string} name
 * @returns {Uint8Array}
 */
export function dnsEncode (name) {
  const labels = name.toLowerCase().split('.').map((label) => utf8(label))
  if (labels.some((label) => label.length === 0 || label.length > 255)) throw new Error(`${name} has a label DNS cannot encode`)
  return concat(...labels.map((label) => concat(Uint8Array.of(label.length), label)), Uint8Array.of(0))
}

/** @param {number} n */
const word = (n) => fromHex(n.toString(16).padStart(64, '0'))

/** @param {Uint8Array} bytes */
function padded (bytes) {
  const out = new Uint8Array(Math.ceil(bytes.length / 32) * 32)
  out.set(bytes)
  return out
}

/**
 * `resolve(dnsEncode(name), contenthash(namehash(name)))` on the Universal Resolver.
 * @param {string} name
 * @returns {{ to: string, data: string }}
 */
export function contenthashLookup (name) {
  const dns = dnsEncode(name)
  const inner = fromHex(CONTENTHASH_SELECTOR + namehash(name).slice(2))
  const body = concat(word(64), word(64 + 32 + padded(dns).length), word(dns.length), padded(dns), word(inner.length), padded(inner))
  return { to: UNIVERSAL_RESOLVER, data: '0x' + RESOLVE_SELECTOR + toHex(body) }
}

/**
 * What a Universal Resolver revert says about a contenthash lookup.
 * @param {string} data the revert data, 0x-prefixed; empty when the RPC gave none
 * @returns {'noresolver' | 'nocontenthash' | 'offchain' | 'other'} `offchain` is a name answered through CCIP-Read
 */
export function revertMeaning (data) {
  const hex = (data.startsWith('0x') ? data.slice(2) : data).toLowerCase()
  const selector = hex.slice(0, 8)
  if (selector === REVERT.resolverNotFound || selector === REVERT.resolverNotContract) return 'noresolver'
  // ENSv2's mirror of the v1 registry reverts UnreachableName for a v1 name with no resolver, wrapped in
  // ResolverError(bytes): its selector, an offset word, a length word, then the inner error's selector.
  if (selector === REVERT.resolverError && hex.slice(136, 144) === REVERT.unreachableName) return 'noresolver'
  if (selector === REVERT.unsupportedProfile) return 'nocontenthash'
  if (selector === REVERT.offchainLookup) return 'offchain'
  return 'other'
}

/**
 * The `bytes` in a single-return-value ABI answer.
 * @param {string} result
 * @returns {Uint8Array}
 */
export function decodeAbiBytes (result) {
  const data = fromHex(result)
  if (data.length < 64) return new Uint8Array(0)
  const offset = Number(BigInt('0x' + toHex(data.subarray(0, 32))))
  const length = Number(BigInt('0x' + toHex(data.subarray(offset, offset + 32))))
  if (offset + 32 + length > data.length) throw new Error('ABI bytes run past the answer')
  return data.slice(offset + 32, offset + 32 + length)
}

/**
 * The contenthash bytes in the Universal Resolver's answer, `(bytes result, address resolver)`, whose `result` is
 * the resolver's own ABI-encoded `bytes`.
 * @param {string} result
 * @returns {Uint8Array}
 */
export function decodeResolveAnswer (result) {
  if (fromHex(result).length < 96) throw new Error('the answer is shorter than (bytes, address)')
  return decodeAbiBytes('0x' + toHex(decodeAbiBytes(result)))
}

/**
 * A Swarm contenthash's body: a CIDv1 of the swarm-manifest codec holding a keccak-256 multihash, whose digest is
 * the 32-byte reference.
 * @param {Uint8Array} bytes
 * @returns {string | null} the reference as 64 hex characters, null for any other shape
 */
function swarmReference (bytes) {
  try {
    const cid = parseCidBytes(bytes)
    if (cid.version !== 1 || cid.codec !== SWARM.manifestCodec || cid.hashCode !== SWARM.keccak256 || cid.digest.length !== 32) return null
    return toHex(cid.digest)
  } catch {
    return null
  }
}

/**
 * EIP-1577 contenthash: a multicodec namespace, then a CID.
 * @param {Uint8Array} bytes
 * @returns {{ kind: 'ipns' | 'ipfs', uri: string, cid: string } | { kind: 'swarm', uri: string, reference: string } | { kind: 'other', uri: string } | { kind: 'empty' }}
 */
export function decodeContenthash (bytes) {
  if (bytes.length === 0) return { kind: 'empty' }
  const [namespace, start] = readVarint(bytes, 0)
  if (namespace === NS.swarm) {
    const reference = swarmReference(bytes.slice(start))
    return reference === null ? { kind: 'other', uri: 'bzz:// with a value that is not a manifest' } : { kind: 'swarm', uri: `bzz://${reference}`, reference }
  }
  if (namespace === NS.ipns || namespace === NS.ipfs) {
    const cid = parseCidBytes(bytes.slice(start))
    const isIpns = namespace === NS.ipns
    if (isIpns && cid.codec !== CODEC.libp2pKey) return { kind: 'other', uri: 'ipns:// with a CID that is not a key' }
    const text = cidToString(cid, isIpns ? 'k' : 'b')
    return { kind: isIpns ? 'ipns' : 'ipfs', uri: `${isIpns ? 'ipns' : 'ipfs'}://${text}`, cid: text }
  }
  return { kind: 'other', uri: `multicodec 0x${namespace.toString(16)}://…` }
}
