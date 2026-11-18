// Orivon's IPFS node, as the facade calls it over its loopback HTTP API: one method per route, each answering with
// the node's JSON or bytes and failing with a NodeError that keeps the status and the node's own words. The routes and
// their answers are the contract in README.md section The node's routes.

import { failureText } from './http-fetch.js'
import { createLanes, laneOf } from './lanes.js'

/** A non-2xx answer from the node. */
export class NodeError extends Error {
  /** @param {number} status @param {string} text @param {string} what */
  constructor (status, text, what) {
    super(`${what}: ${status}${text === '' ? '' : ` ${text}`}`)
    this.name = 'NodeError'
    this.status = status
    this.text = text
  }
}

/**
 * @typedef {object} NodeOptions
 * @property {string} base the node's API origin, e.g. `http://127.0.0.1:5001`
 * @property {string} key the node's `x-orivon-key`
 * @property {string} [partition] the block partition the node keeps this app's blocks and pins in
 * @property {string} [keys] the scope the node keeps this app's IPNS keys in
 * @property {typeof fetch} [fetch] the fetch to call the node with, the runtime's when not given
 * @property {ReturnType<typeof createLanes>} [lanes] which calls may wait for a connection (lanes.js); the usual lanes when not given
 * @property {(line: string) => void} [trace] where a line goes for each call sent and each answer, with the clock (a measurement; nothing is written without it)
 * @property {() => number} [now] the clock, `Date.now` when not given
 */

/**
 * A stream's response, with `release` called when its body ends, fails or is cancelled: the place the stream held is then given back.
 * @param {Response} response @param {() => void} release
 */
function heldOpen (response, release) {
  if (response.body === null) { release(); return response }
  const reader = response.body.getReader()
  const body = new ReadableStream({
    async pull (controller) {
      try {
        const { done, value } = await reader.read()
        if (done) { release(); controller.close() } else controller.enqueue(value)
      } catch (error) { release(); controller.error(error) }
    },
    cancel (reason) { release(); return reader.cancel(reason) }
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/** @param {string} path */
const encodePath = (path) => path.split('/').filter((segment) => segment !== '').map(encodeURIComponent).join('/')

/** @param {NodeOptions} options */
export function createNodeClient (options) {
  const { key, partition = 'bitsocial', keys = 'bitsocial' } = options
  const base = options.base.replace(/\/+$/, '')
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const lanes = options.lanes ?? createLanes()
  const trace = options.trace
  const now = options.now ?? Date.now
  /** The names (base 58, as the node spells them) of the keys the node holds for this app, learned from the key calls this client makes. */
  const held = new Set()
  /** @param {unknown} one @returns {unknown} */
  const learn = (one) => {
    const name = typeof one === 'object' && one !== null ? /** @type {{ name?: unknown }} */ (one).name : undefined
    if (typeof name === 'string' && name !== '') held.add(name)
    return one
  }
  let out = 0
  const PIN_RETRIES = 40

  /**
   * @param {string} method @param {string} path
   * @param {{ query?: Record<string, string | number | boolean | undefined>, body?: BodyInit | null, signal?: AbortSignal, headers?: Record<string, string> }} [call]
   */
  async function raw (method, path, call = {}) {
    const url = new URL(`${base}${path}`)
    for (const [name, value] of Object.entries(call.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value))
    const lane = laneOf(path, (name) => held.has(name))
    const queued = now()
    const send = () => {
      const sent = now()
      if (trace !== undefined) trace(`node call t=${String(sent)} ${method} ${path} lane=${lane} waited=${String(sent - queued)} out=${String(++out)} held=${String(lanes.snapshot().held)}`)
      return fetchImpl(url.toString(), {
        method,
        body: call.body ?? null,
        signal: call.signal,
        headers: { 'x-orivon-key': key, 'x-orivon-partition': partition, 'x-orivon-keys': keys, ...call.headers }
      }).then((answer) => {
        out -= 1
        if (trace !== undefined) trace(`node done t=${String(now())} ${method} ${path} ${String(answer.status)} in ${String(now() - sent)} ms`)
        return answer
      }, (error) => {
        out -= 1
        if (trace !== undefined) trace(`node done t=${String(now())} ${method} ${path} failed in ${String(now() - sent)} ms: ${failureText(error)}`)
        throw error
      })
    }
    const release = lane === 'held' ? lanes.hold() : undefined
    let response
    try {
      response = await (lane === 'slow' ? lanes.slow(send, call.signal) : send())
      if (!response.ok) {
        const text = (await response.text().catch(() => '')).trim()
        throw new NodeError(response.status, text, `${method} ${path}`)
      }
    } catch (error) {
      release?.()
      throw error
    }
    return release === undefined ? response : heldOpen(response, release)
  }

  /** @param {string} method @param {string} path @param {Parameters<typeof raw>[2]} [call] */
  async function json (method, path, call) {
    return (await raw(method, path, call)).json()
  }

  /** @param {string} method @param {string} path @param {Parameters<typeof raw>[2]} [call] @returns {Promise<boolean>} false for a 404 */
  async function found (method, path, call) {
    try {
      await raw(method, path, call)
      return true
    } catch (error) {
      if (error instanceof NodeError && error.status === 404) return false
      throw error
    }
  }

  /** The node runs one pin at a time and answers 429 to a second: wait and ask again. @param {string} cid @param {AbortSignal} [signal] */
  async function pin (cid, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await json('POST', `/orivon/pin/${cid}`, { signal })
      } catch (error) {
        if (!(error instanceof NodeError) || error.status !== 429 || attempt >= PIN_RETRIES) throw error
        await new Promise((resolve) => setTimeout(resolve, Math.min(50 * (attempt + 1), 500)))
      }
    }
  }

  return {
    base,
    raw,
    async id () { return json('GET', '/id') },
    /** The node's addresses; null when it has no status to give (it does not listen). */
    async status () {
      try { return await json('GET', '/status') } catch (error) {
        if (error instanceof NodeError && (error.status === 404 || error.status === 503)) return null
        throw error
      }
    },
    /** @param {Uint8Array} bytes @param {{ codec: string, pin?: boolean }} blockOptions @returns {Promise<{ cid: string, size: number }>} */
    async putBlock (bytes, blockOptions) {
      return json('POST', '/orivon/block/put', { query: { codec: blockOptions.codec, pin: blockOptions.pin === true }, body: bytes })
    },
    /** One block's bytes, from the store or over Bitswap. @param {string} cid @param {AbortSignal} [signal] */
    async getBlock (cid, signal) {
      return new Uint8Array(await (await raw('GET', `/ipfs/${cid}`, { query: { format: 'raw' }, signal })).arrayBuffer())
    },
    /** @param {string} cid */
    async removeBlock (cid) { return found('DELETE', `/orivon/block/${cid}`) },
    pin,
    /** @param {string} cid */
    async unpin (cid) { return found('DELETE', `/orivon/pin/${cid}`) },
    /** @param {AbortSignal} [signal] @returns {Promise<Array<{ cid: string, blocks: number, bytes: number }>>} */
    async pins (signal) { return (await json('GET', '/orivon/pins', { signal })).pins ?? [] },
    /** The bytes of a UnixFS path. @param {string} path `<cid>[/path]` @param {{ offset?: number, length?: number, signal?: AbortSignal }} [read] */
    async cat (path, read = {}) {
      return raw('GET', `/orivon/cat/${encodePath(path)}`, { query: { offset: read.offset, length: read.length }, signal: read.signal })
    },
    /** The CID a path names. @param {string} path `<cid>[/path]` @param {AbortSignal} [signal] @returns {Promise<string>} */
    async resolve (path, signal) { return (await json('GET', `/orivon/resolve/${encodePath(path)}`, { signal })).cid },
    /** @param {string} cid @returns {Promise<Array<{ name: string, cid: string, size: number, type: string }>>} */
    async ls (cid) { return json('GET', `/orivon/ls/${cid}`) },
    async repoStat () { return json('GET', '/orivon/repo/stat') },
    /** @returns {Promise<string[]>} the CIDs of the blocks it dropped */
    async repoGc () { return (await json('POST', '/orivon/repo/gc')).removed ?? [] },
    /** The peers the node is connected to now, in either direction. @returns {Promise<Array<{ peer: string, addr: string }>>} */
    async swarmPeers () { return (await json('GET', '/orivon/swarm/peers')).peers ?? [] },
    /** @param {string} cid @param {boolean} recursive @param {AbortSignal} [signal] */
    async provide (cid, recursive, signal) { return raw('POST', `/orivon/provide/${cid}`, { query: { recursive }, signal }) },
    /** Stops providing a root, which lets go of the blocks the provide held. @param {string} cid @returns {Promise<boolean>} false when it was not provided */
    async unprovide (cid) { return found('DELETE', `/orivon/provide/${cid}`) },
    /** @param {string} label @param {Uint8Array} bytes @returns {Promise<{ label: string, name: string }>} */
    async importKey (label, bytes) {
      try {
        return learn(await json('POST', '/orivon/ipns/keys/import', { query: { label }, body: bytes }))
      } catch (error) {
        // The node already holds the key: the list says under which name.
        if (error instanceof NodeError && error.status === 409) await this.listKeys().catch(() => null)
        throw error
      }
    },
    /** @param {string} label @returns {Promise<{ label: string, name: string }>} */
    async generateKey (label) { return learn(await json('POST', '/orivon/ipns/keys', { body: JSON.stringify({ label }), headers: { 'content-type': 'application/json' } })) },
    /** @returns {Promise<Array<{ label: string, name: string }>>} */
    async listKeys () {
      const keys = await json('GET', '/orivon/ipns/keys')
      if (Array.isArray(keys)) keys.forEach(learn)
      return keys
    },
    /** @param {string} label */
    async removeKey (label) { return found('DELETE', `/orivon/ipns/keys/${encodeURIComponent(label)}`) },
    /** @param {{ label: string, value: string, lifetimeSeconds?: number, ttlSeconds?: number, allowOffline?: boolean }} record @param {AbortSignal} [signal] @returns {Promise<{ name: string, value: string, sequence: number }>} */
    async publishName (record, signal) {
      return json('POST', '/orivon/ipns/publish', { body: JSON.stringify(record), headers: { 'content-type': 'application/json' }, signal })
    },
    /** `allowOffline` answers once the node keeps the record and sends it on its topic; the put to the DHT then runs in the background. @param {string} name @param {Uint8Array} record @param {boolean} allowOffline @param {AbortSignal} [signal] */
    async routingPut (name, record, allowOffline, signal) { return raw('POST', '/orivon/routing/put', { query: { key: `/ipns/${name}`, ...(allowOffline ? { allowOffline: true } : {}) }, body: record, signal }) },
    /** @param {string} name @param {AbortSignal} [signal] @returns {Promise<string>} */
    async resolveName (name, signal) { return (await json('GET', `/orivon/name/resolve/${encodeURIComponent(name)}`, { signal })).value },
    /** The gateway's own answer for a path, passed through. @param {string} pathAndQuery @param {Record<string, string>} [headers] @param {AbortSignal} [signal] */
    async gateway (pathAndQuery, headers, signal) { return raw('GET', pathAndQuery, { headers, signal }) },
    /** The node's pubsub subscription, answered once the node has accepted it, then as one stream. @param {string} topic @param {AbortSignal} [signal] */
    async pubsubSubscribe (topic, signal) { return raw('POST', '/pubsub/sub', { query: { topic }, signal }) },
    /** @param {string} topic @param {Uint8Array} bytes @param {AbortSignal} [signal] */
    async pubsubPublish (topic, bytes, signal) { return raw('POST', '/pubsub/pub', { query: { topic }, body: bytes, signal }) },
    /** @returns {Promise<string[]>} */
    async pubsubTopics () { return (await json('GET', '/pubsub/ls')).topics ?? [] },
    /** @param {string} [topic] @returns {Promise<string[]>} */
    async pubsubPeers (topic) { return (await json('GET', '/pubsub/peers', { query: { topic } })).peers ?? [] }
  }
}
