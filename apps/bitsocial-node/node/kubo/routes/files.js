// The mutable file system, `files/*`: each command reads its path and options off the query, takes file bytes from
// the multipart body, and answers in kubo's shapes (an empty body for the ones that change the tree).

import { bytesResponse, emptyResponse, flag, jsonResponse, KuboError, ndjsonResponse, number } from '../wire.js'

/** @param {URLSearchParams} params @returns {0 | 1} */
function cidVersion (params) {
  const version = number(params, 'cid-version', 1)
  if (version !== 0 && version !== 1) throw new KuboError(`unsupported CID version ${version}`)
  return version
}

/** @param {import('../facade.js').Context} ctx @param {string} name */
function only (ctx, name) {
  const arg = ctx.args[0]
  if (arg === undefined) throw new KuboError(`argument "${name}" is required`)
  return arg
}

/** @param {{ mfs: ReturnType<typeof import('../mfs/mfs.js').createMfs> }} deps */
export function filesRoutes ({ mfs }) {
  return {
    /** @param {import('../facade.js').Context} ctx */
    async 'files/write' (ctx) {
      const { params } = ctx
      const path = only(ctx, 'path')
      const hash = params.get('hash') ?? 'sha2-256'
      if (hash !== 'sha2-256') throw new KuboError(`unsupported multihash "${hash}": only sha2-256 is available`)
      const part = (await ctx.parts())[0]
      if (part === undefined) throw new KuboError('request has no file data')
      const count = number(params, 'count')
      const version = cidVersion(params)
      await mfs.write(path, count === undefined ? part.body : part.body.subarray(0, count), {
        offset: number(params, 'offset', 0),
        create: flag(params, 'create'),
        truncate: flag(params, 'truncate'),
        parents: flag(params, 'parents'),
        flush: flag(params, 'flush', true),
        version,
        rawLeaves: flag(params, 'raw-leaves', version === 1)
      })
      return emptyResponse()
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'files/mkdir' (ctx) {
      await mfs.mkdir(only(ctx, 'path'), { parents: flag(ctx.params, 'parents'), flush: flag(ctx.params, 'flush', true) })
      return emptyResponse()
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'files/rm' (ctx) {
      only(ctx, 'path')
      await mfs.rm(ctx.args, { recursive: flag(ctx.params, 'recursive'), force: flag(ctx.params, 'force'), flush: flag(ctx.params, 'flush', true) })
      return emptyResponse()
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'files/mv' (ctx) {
      if (ctx.args.length < 2) throw new KuboError('this command requires a source and a destination')
      await mfs.mv(ctx.args.slice(0, -1), /** @type {string} */ (ctx.args.at(-1)), { parents: flag(ctx.params, 'parents'), flush: flag(ctx.params, 'flush', true) })
      return emptyResponse()
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'files/cp' (ctx) {
      if (ctx.args.length < 2) throw new KuboError('this command requires a source and a destination')
      await mfs.cp(ctx.args.slice(0, -1), /** @type {string} */ (ctx.args.at(-1)), { parents: flag(ctx.params, 'parents'), flush: flag(ctx.params, 'flush', true) })
      return emptyResponse()
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'files/stat' (ctx) {
      const found = await mfs.stat(only(ctx, 'path'))
      return jsonResponse({ Hash: found.cid, Size: found.size, CumulativeSize: Number(found.tsize), Blocks: found.blocks, Type: found.type, WithLocality: false })
    },

    /** The entries of a directory: `{"Entries": [...]}`, or one line each with `stream`. @param {import('../facade.js').Context} ctx */
    async 'files/ls' (ctx) {
      const entries = (await mfs.ls(ctx.args[0] ?? '/')).map((entry) => ({ Name: entry.name, Type: entry.type === 'directory' ? 1 : 0, Size: entry.size, Hash: entry.cid }))
      return flag(ctx.params, 'stream') ? ndjsonResponse(entries) : jsonResponse({ Entries: entries.length === 0 ? null : entries })
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'files/read' (ctx) {
      const upstream = await mfs.read(only(ctx, 'path'), {
        offset: number(ctx.params, 'offset'), length: number(ctx.params, 'count') ?? number(ctx.params, 'length'), signal: ctx.signal
      })
      return bytesResponse(upstream.body ?? new Uint8Array(0))
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'files/flush' (ctx) {
      return jsonResponse({ Cid: await mfs.flush(ctx.args[0] ?? '/') })
    }
  }
}
