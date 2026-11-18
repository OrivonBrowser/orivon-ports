// `add`: the importer kubo's `ipfs add` defaults to (UnixFS, 256 KiB chunks, CIDv0 and dag-pb leaves unless CIDv1
// is asked for), run here because the node's own add makes raw-leaf CIDv1 files, and pkc-js addresses what it adds
// by the CIDv0 `ipfs add` gives. The blocks go to the node one by one and the roots are pinned.

import { importer } from 'ipfs-unixfs-importer'
import { fixedSize } from 'ipfs-unixfs-importer/chunker'
import { nodeBlockstore } from '../ipfs.js'
import { readParts } from '../multipart.js'
import { flag, KuboError, ndjsonResponse, number } from '../wire.js'

/** @param {URLSearchParams} params */
function chunkSize (params) {
  const chunker = params.get('chunker') ?? 'size-262144'
  const match = /^size-(\d+)$/.exec(chunker)
  if (match == null) throw new KuboError(`unsupported chunker "${chunker}": only size-<bytes> is available`)
  return Number(match[1])
}

/** @param {{ node: ReturnType<typeof import('../node-client.js').createNodeClient>, pins: ReturnType<typeof import('../pins.js').createPinQueue> }} deps */
export function addRoutes ({ node, pins }) {
  return {
    /** @param {import('../facade.js').Context} ctx */
    async add (ctx) {
      const { params } = ctx
      if (flag(params, 'trickle')) throw new KuboError('the trickle layout is not available')
      if (flag(params, 'nocopy') || flag(params, 'inline')) throw new KuboError('nocopy and inline are not available')
      const hash = params.get('hash') ?? 'sha2-256'
      if (hash !== 'sha2-256') throw new KuboError(`unsupported multihash "${hash}": only sha2-256 is available`)
      const cidVersion = number(params, 'cid-version', 0)
      if (cidVersion !== 0 && cidVersion !== 1) throw new KuboError(`unsupported CID version ${cidVersion}`)
      const wrapWithDirectory = flag(params, 'wrap-with-directory')
      const onlyHash = flag(params, 'only-hash')

      const parts = (await ctx.parts()).filter((part) => part.name.startsWith('file') || part.name.startsWith('dir'))
      const candidates = parts.map((part) => ({
        ...(part.filename === '' ? {} : { path: part.filename }),
        ...(part.name.startsWith('dir') ? {} : { content: part.body })
      }))
      const blockstore = onlyHash ? { put: async () => {}, has: async () => false, get: async () => { throw new KuboError('only-hash stores nothing') } } : nodeBlockstore(node)
      const entries = []
      for await (const entry of importer(candidates, /** @type {any} */ (blockstore), {
        cidVersion,
        rawLeaves: flag(params, 'raw-leaves', cidVersion === 1),
        chunker: fixedSize({ chunkSize: chunkSize(params) }),
        wrapWithDirectory,
        shardSplitStrategy: 'links-bytes'
      })) entries.push(entry)

      if (!onlyHash && flag(params, 'pin', true)) {
        const roots = wrapWithDirectory ? entries.filter((entry) => (entry.path ?? '') === '') : entries.filter((entry) => !(entry.path ?? '').includes('/'))
        for (const root of roots) await pins.pin(root.cid.toV1().toString())
      }
      return ndjsonResponse(entries.map((entry) => ({ Name: entry.path ?? entry.cid.toString(), Hash: entry.cid.toString(), Size: String(entry.size) })))
    }
  }
}
