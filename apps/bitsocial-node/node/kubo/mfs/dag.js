// Directories as UnixFS stores them: a plain dag-pb node of links while its entries fit in one block, and a
// hash-array-mapped trie of such nodes past kubo's threshold, which keeps a directory of any size under the node's
// block limit. Both are written and both are read, so a directory made by kubo or by this code opens the same way.

import * as dagPb from '@ipld/dag-pb'
import { murmur3128 } from '@multiformats/murmur3'
import { Bucket, createHAMT } from 'hamt-sharding'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { DAG_PB, RAW } from '../ipfs.js'
import { KuboError } from '../wire.js'

/** The size of a directory's links, name and CID bytes, past which kubo shards it. */
export const SHARD_THRESHOLD_BYTES = 262_144
const FANOUT_BITS = 8
const HAMT_HASH_CODE = 0x22n
const TEXT = new TextEncoder()

/**
 * @typedef {object} Link
 * @property {string} name
 * @property {CID} cid
 * @property {bigint} tsize the cumulative size of what the link points at
 */

/** @typedef {{ cid: CID, bytes: Uint8Array }} Block */

/** @param {import('@ipld/dag-pb').PBNode | { Data: Uint8Array, Links: Array<{ Name: string, Tsize: number, Hash: CID }> }} node @param {0 | 1} version @returns {Promise<Block>} */
async function blockOf (node, version) {
  const bytes = dagPb.encode(dagPb.prepare(node))
  return { cid: CID.create(version, DAG_PB, await sha256.digest(bytes)), bytes }
}

/** @param {Link} link */
const toPbLink = (link) => ({ Name: link.name, Tsize: Number(link.tsize), Hash: link.cid })

/** @param {Link[]} links */
function estimatedSize (links) {
  return links.reduce((sum, link) => sum + TEXT.encode(link.name).length + link.cid.bytes.length, 0)
}

/** @param {Uint8Array} bytes */
async function hamtHash (bytes) {
  return (await murmur3128.encode(bytes)).slice(0, 8).reverse()
}

/** @param {Bucket<Link>} bucket @param {0 | 1} version @param {Block[]} blocks @returns {Promise<{ cid: CID, tsize: bigint }>} */
async function writeBucket (bucket, version, blocks) {
  const children = bucket._children
  const padLength = (bucket.tableSize() - 1).toString(16).length
  const links = []
  let childrenSize = 0n
  for (let index = 0; index < children.length; index++) {
    const child = children.get(index)
    if (child == null) continue
    const label = index.toString(16).toUpperCase().padStart(padLength, '0')
    if (child instanceof Bucket) {
      const shard = await writeBucket(child, version, blocks)
      links.push({ Name: label, Tsize: Number(shard.tsize), Hash: shard.cid })
      childrenSize += shard.tsize
    } else {
      links.push({ Name: label + child.key, Tsize: Number(child.value.tsize), Hash: child.value.cid })
      childrenSize += child.value.tsize
    }
  }
  const data = new UnixFS({
    type: 'hamt-sharded-directory',
    data: Uint8Array.from(children.bitField().reverse()),
    fanout: BigInt(bucket.tableSize()),
    hashType: HAMT_HASH_CODE
  })
  const block = await blockOf({ Data: data.marshal(), Links: links }, version)
  blocks.push(block)
  return { cid: block.cid, tsize: BigInt(block.bytes.length) + childrenSize }
}

/**
 * A directory's blocks for its entries: the root's CID, its cumulative size, how many links the root holds, and
 * every block to store (the root is the last).
 * @param {Link[]} links @param {0 | 1} version
 * @returns {Promise<{ cid: CID, tsize: bigint, blocks: Block[], rootLinks: number }>}
 */
export async function encodeDirectory (links, version) {
  if (estimatedSize(links) <= SHARD_THRESHOLD_BYTES) {
    const block = await blockOf({ Data: new UnixFS({ type: 'directory' }).marshal(), Links: links.map(toPbLink) }, version)
    const children = links.reduce((sum, link) => sum + link.tsize, 0n)
    return { cid: block.cid, tsize: BigInt(block.bytes.length) + children, blocks: [block], rootLinks: links.length }
  }
  const bucket = createHAMT({ hashFn: hamtHash, bits: FANOUT_BITS })
  for (const link of links) await bucket.put(link.name, link)
  /** @type {Block[]} */
  const blocks = []
  const root = await writeBucket(bucket, version, blocks)
  return { cid: root.cid, tsize: root.tsize, blocks, rootLinks: bucket._children.compactArray().length }
}

/** @param {CID} cid @param {Uint8Array} bytes */
function decodeDagPb (cid, bytes) {
  if (cid.code !== DAG_PB) throw new KuboError('not a directory')
  const node = dagPb.decode(bytes)
  if (node.Data == null) throw new KuboError('the node has no UnixFS data')
  return { node, unixfs: UnixFS.unmarshal(node.Data) }
}

/**
 * The entries of a directory, plain or sharded.
 * @param {CID} cid @param {(cid: CID) => Promise<Uint8Array>} fetchBlock
 * @returns {Promise<{ links: Link[], rootLinks: number, tsize: bigint }>}
 */
export async function readDirectory (cid, fetchBlock) {
  const bytes = await fetchBlock(cid)
  const { node, unixfs } = decodeDagPb(cid, bytes)
  if (!unixfs.isDirectory()) throw new KuboError('not a directory')
  const tsize = node.Links.reduce((sum, link) => sum + BigInt(link.Tsize ?? 0), BigInt(bytes.length))
  /** @type {Link[]} */
  const links = []
  /** @param {import('@ipld/dag-pb').PBNode} shard @param {number} padLength */
  const collect = async (shard, padLength) => {
    for (const link of shard.Links) {
      const name = link.Name ?? ''
      if (unixfs.type !== 'hamt-sharded-directory') {
        links.push({ name, cid: link.Hash, tsize: BigInt(link.Tsize ?? 0) })
      } else if (name.length > padLength) {
        links.push({ name: name.slice(padLength), cid: link.Hash, tsize: BigInt(link.Tsize ?? 0) })
      } else {
        const inner = decodeDagPb(link.Hash, await fetchBlock(link.Hash))
        await collect(inner.node, padLength)
      }
    }
  }
  const padLength = unixfs.type === 'hamt-sharded-directory' ? (Number(unixfs.fanout ?? 256n) - 1).toString(16).length : 0
  await collect(node, padLength)
  return { links, rootLinks: node.Links.length, tsize }
}

/**
 * What a CID holds, for `stat` and for walking a path: a file (its size, how many blocks it has) or a directory.
 * @param {CID} cid @param {(cid: CID) => Promise<Uint8Array>} fetchBlock
 * @returns {Promise<{ type: 'file' | 'directory', size: number, blocks: number, tsize: bigint }>}
 */
export async function describe (cid, fetchBlock) {
  const bytes = await fetchBlock(cid)
  if (cid.code === RAW) return { type: 'file', size: bytes.length, blocks: 0, tsize: BigInt(bytes.length) }
  const { node, unixfs } = decodeDagPb(cid, bytes)
  const tsize = node.Links.reduce((sum, link) => sum + BigInt(link.Tsize ?? 0), BigInt(bytes.length))
  if (unixfs.isDirectory()) return { type: 'directory', size: 0, blocks: node.Links.length, tsize }
  return { type: 'file', size: Number(unixfs.fileSize()), blocks: node.Links.length, tsize }
}
