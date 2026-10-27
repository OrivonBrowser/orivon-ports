// Keeping a share online somewhere else, from the bytes kept on this computer: the share's files are read back out
// of its DAG and uploaded to a pinning service or IPFS node of the person's, and the address that service reports
// must be the one computed here.

import { parseCid } from '../ipfs/cid.js'
import { listTree, readFileBlob } from '../ipfs/dagwalk.js'
import { describe, pin } from './targets.js'

export class MismatchError extends Error {
  /** @param {string} expected @param {string} reported */
  constructor (expected, reported) {
    super(`The service stored something other than this share: it reports ${reported}, and this share is ${expected}. Nothing was recorded as kept there.`)
    this.name = 'MismatchError'
  }
}

/**
 * The files of a kept share, as Blobs that refer to the kept bytes.
 * @param {ReturnType<typeof import('../keep/store.js').createKeep>} keep @param {string} cid
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ path: string, blob: Blob }[]>}
 */
export async function keptFiles (keep, cid, signal) {
  const source = {
    block: async (/** @type {string} */ block) => (await keep.block(cid, block)) ?? Promise.reject(new Error('A block of the kept share is missing.')),
    blob: (/** @type {string} */ block) => keep.blob(cid, block)
  }
  const listed = await listTree(source, cid, signal ? { signal } : {})
  const files = []
  for (const file of listed) files.push({ path: file.path, blob: await readFileBlob(source, file.cid, signal ? { signal } : {}) })
  return files
}

/**
 * @param {ReturnType<typeof import('../keep/store.js').createKeep>} keep
 * @param {string} cid
 * @param {import('./targets.js').Target} service
 * @param {{ signal?: AbortSignal, onProgress?: (progress: { step: 'send' | 'check', text?: string }) => void }} [options]
 * @returns {Promise<{ label: string, ok: true }>}
 */
export async function pinElsewhere (keep, cid, service, { signal, onProgress = () => {} } = {}) {
  const root = parseCid(cid).string
  if (await keep.meta(root) === null) throw new Error('That share is not kept on this computer.')
  onProgress({ step: 'send', text: `Sending it to ${describe(service)}` })
  const files = await keptFiles(keep, root, signal)
  const { cid: reported } = await pin(service, { name: `Orivon Share ${root.slice(0, 12)}`, files, ...(signal ? { signal } : {}) })
  onProgress({ step: 'check', text: 'Checking the address' })
  let normal
  try {
    normal = parseCid(reported.trim()).string
  } catch {
    throw new MismatchError(root, reported)
  }
  if (normal !== root) throw new MismatchError(root, normal)
  return { label: describe(service), ok: true }
}
