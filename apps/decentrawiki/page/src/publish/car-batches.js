// Cutting a stored CAR into the batches the editor's IPFS node takes it in (hosting.js): whole sections, so that a
// wiki larger than one request is still handed over in a few.

import { decodeVarint } from '../ipfs/cid.js'

/** The most one request to the node carries. */
export const NODE_BATCH_BYTES = 32 * 1024 * 1024
export const CAR_TYPE = 'application/vnd.ipld.car'

/**
 * The batches a CAR goes to the node in: whole sections, at most `limit` bytes each, every one under the CAR's own
 * header. A CAR that fits goes as it is.
 * @param {Blob} car @param {number} [limit]
 * @returns {Promise<Blob[]>}
 */
export async function carBatches (car, limit = NODE_BATCH_BYTES) {
  if (car.size <= limit) return [car]
  const bytes = new Uint8Array(await car.arrayBuffer())
  const header = decodeVarint(bytes, 0)
  const headerEnd = header.length + header.value
  const head = bytes.subarray(0, headerEnd)
  /** @type {Blob[]} */
  const batches = []
  let from = headerEnd
  let at = headerEnd
  while (at < bytes.length) {
    const section = decodeVarint(bytes, at)
    const end = at + section.length + section.value
    if (end > bytes.length) throw new Error('the stored CAR is cut off in a block')
    if (headerEnd + (end - from) > limit && at > from) {
      batches.push(new Blob([head, bytes.subarray(from, at)], { type: CAR_TYPE }))
      from = at
    }
    at = end
  }
  batches.push(new Blob([head, bytes.subarray(from, at)], { type: CAR_TYPE }))
  return batches
}
