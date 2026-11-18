// Paths and CIDs as kubo's commands take them, and the one place a block goes to the node.

import { CID } from 'multiformats/cid'
import { KuboError } from './wire.js'

export const DAG_PB = 0x70
export const RAW = 0x55
export const DAG_CBOR = 0x71

const CODEC_NAMES = new Map([[DAG_PB, 'dag-pb'], [RAW, 'raw'], [DAG_CBOR, 'dag-cbor']])

/** @param {number} code */
export function codecName (code) {
  const name = CODEC_NAMES.get(code)
  if (name === undefined) throw new KuboError(`unsupported codec 0x${code.toString(16)}`)
  return name
}

/** @param {string} text @returns {CID} */
export function parseCid (text) {
  try {
    return CID.parse(text)
  } catch {
    throw new KuboError(`invalid path "${text}": invalid CID`)
  }
}

/** One CID however it is written, so that CIDv0 and CIDv1 of one block compare equal. @param {string | CID} cid */
export function canonical (cid) {
  const parsed = typeof cid === 'string' ? parseCid(cid) : cid
  return parsed.toV1().toString()
}

/**
 * @typedef {object} IpfsPath
 * @property {'ipfs' | 'ipns'} namespace
 * @property {string} root the CID, or the IPNS name
 * @property {string[]} segments what follows the root
 */

/** `<cid>`, `/ipfs/<cid>[/path]` or `/ipns/<name>[/path]`. @param {string} arg @returns {IpfsPath} */
export function parseIpfsPath (arg) {
  const parts = arg.split('/').filter((part) => part !== '')
  const explicit = arg.startsWith('/')
  const namespace = explicit ? parts.shift() : 'ipfs'
  const root = parts.shift()
  if ((namespace !== 'ipfs' && namespace !== 'ipns') || root == null || root === '') throw new KuboError(`invalid path "${arg}": path does not have enough components`)
  if (namespace === 'ipfs') parseCid(root)
  return { namespace, root, segments: parts }
}

/** A CID as version 0 or 1: the same block, written the way the caller asked for it. @param {CID} cid @param {number} version */
export function withVersion (cid, version) {
  return version === 0 ? cid.toV0() : cid.toV1()
}

/**
 * The store the importer writes through: each block goes to the node as the codec its CID names, unpinned (the
 * caller pins the root it keeps). The node answers with the CID it made, and a block it made another of is an error.
 * @param {{ putBlock: (bytes: Uint8Array, options: { codec: string, pin?: boolean }) => Promise<{ cid: string }> }} node
 */
export function nodeBlockstore (node) {
  return {
    /** @param {CID} cid @param {Uint8Array} bytes */
    async put (cid, bytes) {
      const stored = await node.putBlock(bytes, { codec: codecName(cid.code) })
      if (canonical(stored.cid) !== canonical(cid)) throw new KuboError(`the node stored block ${cid.toString()} as ${stored.cid}`)
      return cid
    },
    async has () { return false },
    async get () { throw new KuboError('the facade does not read blocks through the importer') }
  }
}
