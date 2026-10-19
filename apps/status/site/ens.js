// ENS by hand: namehash, the two eth_call payloads, ABI decoding of the answers and the
// contenthash format. No library; the registry and resolver ABIs are one function each.

import { concat, fromHex, toHex, utf8 } from './bytes.js'
import { cidToString, CODEC, parseCidBytes, readVarint } from './cid.js'
import { keccak256 } from './keccak.js'

export const REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const RESOLVER_SELECTOR = '0178b8bf'
const CONTENTHASH_SELECTOR = 'bc1c58d1'
const NS = { ipfs: 0xe3, swarm: 0xe4, ipns: 0xe5 }

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

/** @param {string} node 0x-prefixed namehash */
export const resolverCall = (node) => ({ to: REGISTRY, data: '0x' + RESOLVER_SELECTOR + node.slice(2) })

/**
 * @param {string} resolver address
 * @param {string} node 0x-prefixed namehash
 */
export const contenthashCall = (resolver, node) => ({ to: resolver, data: '0x' + CONTENTHASH_SELECTOR + node.slice(2) })

/**
 * The address in a 32-byte `address` return value; null for the zero address or an empty answer.
 * @param {string} result
 * @returns {string | null}
 */
export function decodeAddress (result) {
  const hex = result.startsWith('0x') ? result.slice(2) : result
  if (hex.length < 64) return null
  const address = hex.slice(24, 64)
  return /^0+$/.test(address) ? null : '0x' + address
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
 * EIP-1577 contenthash: a multicodec namespace, then a CID.
 * @param {Uint8Array} bytes
 * @returns {{ kind: 'ipns' | 'ipfs', uri: string, cid: string } | { kind: 'other', uri: string } | { kind: 'empty' }}
 */
export function decodeContenthash (bytes) {
  if (bytes.length === 0) return { kind: 'empty' }
  const [namespace, start] = readVarint(bytes, 0)
  if (namespace === NS.ipns || namespace === NS.ipfs) {
    const cid = parseCidBytes(bytes.slice(start))
    const isIpns = namespace === NS.ipns
    if (isIpns && cid.codec !== CODEC.libp2pKey) return { kind: 'other', uri: 'ipns:// with a CID that is not a key' }
    const text = cidToString(cid, isIpns ? 'k' : 'b')
    return { kind: isIpns ? 'ipns' : 'ipfs', uri: `${isIpns ? 'ipns' : 'ipfs'}://${text}`, cid: text }
  }
  const label = namespace === NS.swarm ? 'bzz' : `multicodec 0x${namespace.toString(16)}`
  return { kind: 'other', uri: `${label}://…` }
}
