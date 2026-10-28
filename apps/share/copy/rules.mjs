// What the copy service accepts: one share, as the CAR the Share page keeps it in. Pure, so the service and the
// tests share it. A CAR is read block by block, each block hashed and compared with its address. Only files and
// folders (dag-pb and raw blocks) are taken, and the blocks must be exactly the share the address names: all of
// them reachable from it, none missing. What the service passes on is a new CAR written from the checked
// blocks (`write`), never the bytes it was sent, so the node and the pinning account cannot read a body
// differently from how it was checked.

import { carHeader, carSectionHead } from '../page/src/ipfs/car.js'
import { TooLargeError, readCarStream } from '../page/src/ipfs/car-stream.js'
import { DAG_PB, RAW, parseCid, readCidBytes } from '../page/src/ipfs/cid.js'
import { decodeNode } from '../page/src/ipfs/dagpb.js'

const MEBIBYTE = 1024 * 1024

export const LIMITS = {
  /** One share's CAR: the most the service takes in one copy (provisional, README). */
  carBytes: 200 * MEBIBYTE,
  /** Blocks in one share. Share holds 10000 files at most, and 200 MiB is under a thousand 256 KiB blocks. */
  blocks: 40_000,
  /** Links over all the folders and files of one share, which bounds the memory the check holds. */
  links: 100_000
}

export const TOO_LARGE = `This share is too large for Orivon's server to keep: it keeps ${LIMITS.carBytes / MEBIBYTE} MiB or less in one copy.`

export class Refusal extends Error {
  /** @param {number} status @param {string} message */
  constructor (status, message) {
    super(message)
    this.name = 'Refusal'
    this.status = status
  }
}

/**
 * Reads a share's CAR from `body`, checks it, and hands the checked blocks to `write` as a CAR of their own.
 * @param {ReadableStream<Uint8Array>} body
 * @param {string} root the address the share is kept under
 * @param {(chunk: Uint8Array) => Promise<void>} write
 * @param {number} [maxBytes]
 * @returns {Promise<{ blocks: number, bytes: number }>} what was written
 */
export async function checkCar (body, root, write, maxBytes = LIMITS.carBytes) {
  const rootCid = parseCid(root).string
  /** @type {Map<string, string[]>} every block, with the blocks it links to */
  const graph = new Map()
  let links = 0
  let bytes = 0
  /** @param {Uint8Array} chunk */
  const put = async (chunk) => {
    bytes += chunk.length
    await write(chunk)
  }
  try {
    await put(carHeader(rootCid))
    for await (const { cid, data } of readCarStream(body, { expectedRoot: rootCid, maxBytes })) {
      if (graph.has(cid)) continue
      const codec = parseCid(cid).codec
      if (codec !== DAG_PB && codec !== RAW) throw new Refusal(400, 'A share is files and folders. This CAR holds another kind of block.')
      const children = codec === DAG_PB ? decodeNode(data).links.map((link) => readCidBytes(link.hash).cid.string) : []
      links += children.length
      if (graph.size >= LIMITS.blocks || links > LIMITS.links) throw new Refusal(413, TOO_LARGE)
      graph.set(cid, children)
      await put(carSectionHead(cid, data.length))
      await put(data)
    }
  } catch (error) {
    if (error instanceof Refusal) throw error
    if (error instanceof TooLargeError) throw new Refusal(413, TOO_LARGE)
    throw new Refusal(400, `This is not a share Orivon's server can keep. ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!graph.has(rootCid)) throw new Refusal(400, 'The CAR does not hold the first block of the share it is sent for.')
  const reached = new Set([rootCid])
  const queue = [rootCid]
  for (let at = 0; at < queue.length; at++) {
    for (const child of graph.get(/** @type {string} */ (queue[at])) ?? []) {
      if (!graph.has(child)) throw new Refusal(400, 'The share is incomplete: a block it names is not in the CAR.')
      if (reached.has(child)) continue
      reached.add(child)
      queue.push(child)
    }
  }
  if (reached.size !== graph.size) throw new Refusal(400, 'The CAR holds a block that is not part of the share.')
  return { blocks: graph.size, bytes }
}
