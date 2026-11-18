// IPNS keys, publishing and resolving, answered from the node's key, publish and name routes. The node names a key
// by its multihash in base 58, which is what pkc-js asks for (`ipns-base=b58mh`); kubo's own default is base 36, and
// both are answered.

import { base36 } from 'multiformats/bases/base36'
import { base58btc } from 'multiformats/bases/base58'
import { CID } from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
import { viaNode } from '../errors.js'
import { NodeError } from '../node-client.js'
import { parseIpfsPath } from '../ipfs.js'
import { followName } from './content.js'
import { flag, jsonResponse, KuboError, ndjsonResponse, parseGoDuration } from '../wire.js'

const LIBP2P_KEY = 0x72

/** @typedef {ReturnType<typeof import('../node-client.js').createNodeClient>} NodeClient */

/** A key's name as the caller's `ipns-base` writes it. @param {string} b58 @param {string | null} base */
function nameIn (b58, base) {
  if (base === 'b58mh') return b58
  return CID.createV1(LIBP2P_KEY, Digest.decode(base58btc.baseDecode(b58))).toString(base36)
}

/** An IPNS name in the base 58 the node knows it by, from base 36 or 58. @param {string} name */
function nameForNode (name) {
  const bare = name.replace(/^\/ipns\//, '')
  if (!bare.startsWith('k')) return bare
  try { return base58btc.baseEncode(CID.parse(bare, base36).multihash.bytes) } catch { return bare }
}

/** @param {{ node: NodeClient }} deps */
export function nameRoutes ({ node }) {
  /** @param {{ label: string, name: string }} key @param {string | null} base */
  const keyJson = (key, base) => ({ Name: key.label, Id: nameIn(key.name, base) })

  return {
    /** @param {import('../facade.js').Context} ctx */
    async 'key/import' (ctx) {
      const label = ctx.args[0]
      if (label === undefined || label === '') throw new KuboError('argument "name" is required')
      const format = ctx.params.get('format') ?? 'libp2p-protobuf-cleartext'
      if (format !== 'libp2p-protobuf-cleartext') throw new KuboError(`unsupported key format "${format}": only libp2p-protobuf-cleartext is available`)
      const part = (await ctx.parts())[0]
      if (part === undefined) throw new KuboError('request has no key')
      try {
        return jsonResponse(keyJson(await node.importKey(label, part.body), ctx.params.get('ipns-base')))
      } catch (error) {
        if (error instanceof NodeError && error.status === 409) throw new KuboError(`key with name '${label}' already exists`)
        throw error
      }
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'key/gen' (ctx) {
      const label = ctx.args[0]
      if (label === undefined || label === '') throw new KuboError('argument "name" is required')
      const type = ctx.params.get('type') ?? 'ed25519'
      if (type !== 'ed25519') throw new KuboError(`unsupported key type "${type}": only ed25519 is available`)
      try {
        return jsonResponse(keyJson(await node.generateKey(label), ctx.params.get('ipns-base')))
      } catch (error) {
        if (error instanceof NodeError && error.status === 409) throw new KuboError(`key with name '${label}' already exists`)
        throw error
      }
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'key/list' (ctx) {
      const keys = await viaNode(() => node.listKeys())
      return jsonResponse({ Keys: keys.map((key) => keyJson(key, ctx.params.get('ipns-base'))) })
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'key/rm' (ctx) {
      const known = new Map((await viaNode(() => node.listKeys())).map((key) => [key.label, key]))
      const removed = []
      for (const label of ctx.args) {
        const key = known.get(label)
        if (key === undefined || !await viaNode(() => node.removeKey(label))) throw new KuboError('no key by the given name was found')
        removed.push(keyJson(key, ctx.params.get('ipns-base')))
      }
      return jsonResponse({ Keys: removed })
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'name/publish' (ctx) {
      const arg = ctx.args[0]
      if (arg === undefined) throw new KuboError('argument "ipfs-path" is required')
      const { namespace, root, segments } = parseIpfsPath(arg)
      const value = `/${namespace}/${[root, ...segments].join('/')}`
      const lifetime = parseGoDuration(ctx.params.get('lifetime'))
      const ttl = parseGoDuration(ctx.params.get('ttl'))
      const record = await viaNode(() => node.publishName({
        label: ctx.params.get('key') ?? 'self',
        value,
        ...(lifetime === undefined ? {} : { lifetimeSeconds: Math.max(1, Math.round(lifetime)) }),
        ...(ttl === undefined ? {} : { ttlSeconds: Math.max(1, Math.round(ttl)) }),
        allowOffline: flag(ctx.params, 'allow-offline')
      }, ctx.signal), { notFound: 'no key by the given name was found' })
      return jsonResponse({ Name: nameIn(record.name, ctx.params.get('ipns-base')), Value: record.value })
    },

    /** One hop, or the whole chain to an /ipfs/ path as kubo does by default. @param {import('../facade.js').Context} ctx */
    async 'name/resolve' (ctx) {
      const arg = ctx.args[0]
      if (arg === undefined) throw new KuboError('argument "name" is required')
      const name = nameForNode(arg)
      let path
      if (flag(ctx.params, 'recursive', true)) {
        const target = await followName(node, name, ctx.signal)
        path = `/ipfs/${[target.cid, ...target.segments].join('/')}`
      } else {
        path = await viaNode(() => node.resolveName(name, ctx.signal), { notFound: `could not resolve name: ${name}` })
      }
      return flag(ctx.params, 'stream') ? ndjsonResponse([{ Path: path }]) : jsonResponse({ Path: path })
    }
  }
}
