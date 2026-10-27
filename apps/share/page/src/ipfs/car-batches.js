// Blocks into CAR batches. A sink takes blocks as the importer makes them, leaves out one it has seen already, and
// hands a batch on as a Blob whenever the next section would take it past `batchBytes`. A batch holds no more than
// that, header included, which is how the page's own IPFS node takes blocks (a CAR of 64 MiB at most).

import { carHeader, carSectionHead } from './car.js'

/**
 * @typedef {object} BatcherOptions
 * @property {number} batchBytes the most one batch holds, header included
 * @property {'each' | 'first'} header a header in front of every batch, or of the first only
 * @property {(firstCid: string) => string} rootFor the root the header of a batch names, given the batch's first block
 * @property {(batch: Blob, info: { blocks: number, bytes: number }) => void | Promise<void>} onBatch
 */

/** @param {BatcherOptions} options */
export function createBatcher ({ batchBytes, header, rootFor, onBatch }) {
  const seen = new Set()
  /** @type {BlobPart[]} */
  let parts = []
  let size = 0
  let blocks = 0
  /** @type {string | null} */
  let first = null
  let batches = 0
  let blocksTotal = 0

  async function flush () {
    if (first === null) return
    const prefix = header === 'each' || batches === 0 ? carHeader(rootFor(first)) : null
    const body = prefix === null ? parts : [prefix, ...parts]
    const bytes = size + (prefix?.length ?? 0)
    const info = { blocks, bytes }
    parts = []
    size = 0
    blocks = 0
    first = null
    batches += 1
    await onBatch(new Blob(body), info)
  }

  /** @param {string} cid @param {Uint8Array} data */
  async function sink (cid, data) {
    if (seen.has(cid)) return
    seen.add(cid)
    const head = carSectionHead(cid, data.length)
    const section = head.length + data.length
    const reserved = header === 'each' || batches === 0 ? carHeader(rootFor(first ?? cid)).length : 0
    if (first !== null && size + section + reserved > batchBytes) await flush()
    first ??= cid
    parts.push(/** @type {BlobPart} */ (head), /** @type {BlobPart} */ (data))
    size += section
    blocks += 1
    blocksTotal += 1
  }

  return { sink, finish: flush, get blocks () { return blocksTotal }, get batches () { return batches } }
}
