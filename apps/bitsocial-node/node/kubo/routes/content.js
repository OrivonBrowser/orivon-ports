// Blocks, content, pins, the repo and the routing calls: each answered from the node's block, pin, cat, resolve,
// repo, provide and routing routes in the words and shapes kubo-rpc-client reads.

import { canonical, parseCid, parseIpfsPath, withVersion } from '../ipfs.js'
import { fromNode, viaNode } from '../errors.js'
import { NodeError } from '../node-client.js'
import { flag, jsonResponse, KuboError, ndjsonResponse, bytesResponse, number } from '../wire.js'

const BLOCK_FORMATS = new Map([['raw', 'raw'], ['dag-pb', 'dag-pb'], ['protobuf', 'dag-pb'], ['v0', 'dag-pb'], ['dag-cbor', 'dag-cbor'], ['cbor', 'dag-cbor']])
const SENDING_QUERY = { Type: 0, ID: '', Extra: '', Responses: null }

/** @typedef {ReturnType<typeof import('../node-client.js').createNodeClient>} NodeClient */

/** The path a command names, with an IPNS name followed to what it points at. @param {NodeClient} node @param {string} arg @param {AbortSignal} [signal] */
async function contentPath (node, arg, signal) {
  const parsed = parseIpfsPath(arg)
  if (parsed.namespace === 'ipfs') return { cid: parsed.root, segments: parsed.segments }
  const target = await followName(node, parsed.root, signal)
  return { cid: target.cid, segments: [...target.segments, ...parsed.segments] }
}

/** An IPNS name followed, hop by hop, to the `/ipfs/` path it ends at. @param {NodeClient} node @param {string} name @param {AbortSignal} [signal] @returns {Promise<{ cid: string, segments: string[] }>} */
export async function followName (node, name, signal) {
  let current = name
  for (let hops = 0; hops < 32; hops++) {
    const value = await viaNode(() => node.resolveName(current, signal), { notFound: `could not resolve name: ${current}` })
    const parsed = parseIpfsPath(value)
    if (parsed.namespace === 'ipfs') return { cid: parsed.root, segments: parsed.segments }
    current = parsed.root
  }
  throw new KuboError(`could not resolve name (too many redirects): ${name}`)
}

/**
 * Removes a block. The node refuses (409) a block that a pin or a provide keeps. A provide holds nothing in kubo, so it is
 * stopped and the block goes; a pin stays, and kubo says so in the block's own line of the answer, never by failing the call,
 * which is how pkc-js's purge of a comment (`unpinStaleCids`, then `block.rm`) finishes with the block of a pinned DAG still there.
 * @param {NodeClient} node @param {string} cid @returns {Promise<boolean | 'kept'>} false when the node has no such block
 */
async function removeBlock (node, cid) {
  for (let stopped = false; ; stopped = true) {
    try {
      return await node.removeBlock(cid)
    } catch (error) {
      if (!(error instanceof NodeError) || error.status !== 409) throw fromNode(error)
      if (stopped || !(await viaNode(() => node.unprovide(cid)))) return 'kept'
    }
  }
}

/** @param {{ node: NodeClient, pins: ReturnType<typeof import('../pins.js').createPinQueue>, mfs: { settle: () => Promise<void> } }} deps */
export function contentRoutes ({ node, pins, mfs }) {
  return {
    /** @param {import('../facade.js').Context} ctx */
    async 'block/put' (ctx) {
      const { params } = ctx
      const format = params.get('format') ?? params.get('cid-codec') ?? 'raw'
      const codec = BLOCK_FORMATS.get(format)
      if (codec === undefined) throw new KuboError(`unsupported block format "${format}"`)
      const mhtype = params.get('mhtype') ?? 'sha2-256'
      if (mhtype !== 'sha2-256') throw new KuboError(`unsupported multihash "${mhtype}": only sha2-256 is available`)
      const version = format === 'v0' || (params.get('version') === '0' && codec === 'dag-pb') ? 0 : 1
      const part = (await ctx.parts())[0]
      if (part === undefined) throw new KuboError('request has no block data')
      const stored = await viaNode(() => node.putBlock(part.body, { codec, pin: flag(params, 'pin') }))
      return jsonResponse({ Key: withVersion(parseCid(stored.cid), version).toString(), Size: stored.size })
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'block/rm' (ctx) {
      const force = flag(ctx.params, 'force')
      const lines = []
      for (const arg of ctx.args) {
        const { root } = parseIpfsPath(arg)
        const removed = await removeBlock(node, canonical(root))
        if (removed === 'kept') lines.push({ Hash: arg, Error: 'pinned: kept by a pin' })
        else lines.push(removed || force ? { Hash: arg } : { Hash: arg, Error: 'blockstore: block not found' })
      }
      return ndjsonResponse(lines)
    },

    /** @param {import('../facade.js').Context} ctx */
    async cat (ctx) {
      const arg = ctx.args[0]
      if (arg === undefined) throw new KuboError('argument "ipfs-path" is required')
      const { cid, segments } = await contentPath(node, arg, ctx.signal)
      const upstream = await viaNode(() => node.cat([cid, ...segments].join('/'), {
        offset: number(ctx.params, 'offset'), length: number(ctx.params, 'length'), signal: ctx.signal
      }), { notFound: 'file does not exist' })
      return bytesResponse(upstream.body ?? new Uint8Array(0))
    },

    /** @param {import('../facade.js').Context} ctx */
    async resolve (ctx) {
      const arg = ctx.args[0]
      if (arg === undefined) throw new KuboError('argument "name" is required')
      const { cid, segments } = await contentPath(node, arg, ctx.signal)
      if (segments.length === 0) return jsonResponse({ Path: `/ipfs/${cid}` })
      const resolved = await viaNode(() => node.resolve([cid, ...segments].join('/'), ctx.signal), { notFound: 'file does not exist' })
      return jsonResponse({ Path: `/ipfs/${resolved}` })
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'pin/ls' (ctx) {
      const type = ctx.params.get('type') ?? 'all'
      const all = await viaNode(() => node.pins())
      const listed = type === 'all' || type === 'recursive' ? all : []
      const known = new Map(listed.map((pin) => [canonical(pin.cid), pin.cid]))
      const chosen = ctx.args.length === 0
        ? [...known.values()]
        : ctx.args.map((arg) => {
            const found = known.get(canonical(parseIpfsPath(arg).root))
            if (found === undefined) throw new KuboError(`path '${arg}' is not pinned`)
            return found
          })
      if (!flag(ctx.params, 'stream')) return jsonResponse({ Keys: Object.fromEntries(chosen.map((cid) => [cid, { Type: 'recursive' }])) })
      return ndjsonResponse(chosen.map((cid) => ({ Cid: cid, Type: 'recursive' })))
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'pin/rm' (ctx) {
      const removed = []
      for (const arg of ctx.args) {
        const { root } = parseIpfsPath(arg)
        const done = await viaNode(() => pins.unpin(canonical(root)))
        if (!done) throw new KuboError('not pinned or pinned indirectly')
        removed.push(root)
      }
      return jsonResponse({ Pins: removed })
    },

    async 'repo/stat' () {
      const stat = await viaNode(() => node.repoStat())
      return jsonResponse({ RepoSize: stat.repoSize, StorageMax: stat.storageMax, NumObjects: stat.numObjects, RepoPath: '', Version: 'fs-repo@16' })
    },

    /** One line per block the node dropped, as kubo streams them. Anything the file system just flushed is pinned first, so a flush in flight is not collected. */
    async 'repo/gc' () {
      await mfs.settle()
      await pins.settle()
      const removed = await viaNode(() => node.repoGc())
      return ndjsonResponse(removed.map((cid) => ({ Key: { '/': cid } })))
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'routing/put' (ctx) {
      const key = ctx.args[0] ?? ''
      const name = /^\/ipns\/(.+)$/.exec(key)?.[1]
      if (name === undefined) throw new KuboError(`routing/put takes an /ipns/ key, not "${key}"`)
      const record = (await ctx.parts())[0]
      if (record === undefined) throw new KuboError('request has no record')
      await viaNode(() => node.routingPut(name, record.body, flag(ctx.params, 'allow-offline'), ctx.signal))
      return ndjsonResponse([SENDING_QUERY])
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'routing/provide' (ctx) {
      for (const arg of ctx.args) await viaNode(() => node.provide(canonical(parseIpfsPath(arg).root), flag(ctx.params, 'recursive'), ctx.signal))
      return ndjsonResponse([SENDING_QUERY])
    }
  }
}
