// Kubo's HTTP RPC, answered from Orivon's IPFS node: `handle(Request)` returns the `Response` kubo would, for the
// calls pkc-js makes (SURFACE.md), and serves the gateway beside it on the same origin. Calls the node does not
// have an answer for are refused as "not implemented", never guessed at. The mutable file system lives in the
// facade (mfs/), the rest is routes that translate to the node's own (README.md section The node's routes).

import { createGateway } from './gateway.js'
import { createMfs } from './mfs/mfs.js'
import { readParts } from './multipart.js'
import { createPinQueue } from './pins.js'
import { addRoutes } from './routes/add.js'
import { contentRoutes } from './routes/content.js'
import { filesRoutes } from './routes/files.js'
import { infoRoutes } from './routes/info.js'
import { nameRoutes } from './routes/names.js'
import { pubsubRoutes } from './routes/pubsub.js'
import { getPath, openState, withPath } from './state.js'
import { errorResponse, KuboError } from './wire.js'

const API_PREFIX = '/api/v0/'

/**
 * What a route receives.
 * @typedef {object} Context
 * @property {Request} request
 * @property {URLSearchParams} params the query
 * @property {string[]} args every `arg` of the query, in order
 * @property {AbortSignal} signal ends when the caller goes away
 * @property {() => Promise<import('./multipart.js').Part[]>} parts the multipart body, read once
 */

/**
 * @typedef {object} FacadeOptions
 * @property {ReturnType<typeof import('./node-client.js').createNodeClient>} node Orivon's IPFS node
 * @property {string} statePath the JSON file keeping the file system's root and the configuration
 * @property {string} [gateway] the multiaddr `config` gives as `Addresses.Gateway`; the origin that serves this facade
 * @property {string} [apiKey] when set, every request needs `Authorization: Bearer <apiKey>`
 * @property {string[]} [allowedOrigins] browser origins let in; a request with any other `Origin` is refused
 * @property {import('./state.js').FileSystem} [fs]
 */

/** @param {unknown} base @param {unknown} over @returns {unknown} */
function merged (base, over) {
  const isObject = (/** @type {unknown} */ one) => typeof one === 'object' && one !== null && !Array.isArray(one)
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over
  const out = { .../** @type {Record<string, unknown>} */ (base) }
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (over))) out[key] = merged(out[key], value)
  return out
}

/** @param {FacadeOptions} options */
export async function createKuboFacade ({ node, statePath, gateway = '/ip4/127.0.0.1/tcp/8080', apiKey, allowedOrigins = [], fs }) {
  const state = await openState({ statePath, fs })
  const pins = createPinQueue(node)
  const mfs = createMfs({ node, pins, state })

  const defaults = { Routing: {}, Provide: { DHT: { SweepEnabled: true } } }
  /** The configuration: what was set, over the defaults, with the gateway address always the facade's own. */
  const config = {
    /** @param {string} key */
    get (key) {
      const effective = withPath(/** @type {Record<string, unknown>} */ (merged(defaults, state.config)), 'Addresses.Gateway', gateway)
      return getPath(effective, key)
    },
    /** @param {string} key @param {unknown} value */
    async set (key, value) { await state.update({ config: withPath(state.config, key, value) }) }
  }

  /** @type {Record<string, (ctx: Context) => Response | Promise<Response>>} */
  const routes = {
    ...addRoutes({ node, pins }),
    ...contentRoutes({ node, pins, mfs }),
    ...nameRoutes({ node }),
    ...pubsubRoutes({ node }),
    ...infoRoutes({ node, config }),
    ...filesRoutes({ mfs })
  }
  const gatewayHandler = createGateway({ node })

  /** Refuses what a web page or another user's process could send: a foreign origin, or a missing or wrong key. @param {Request} request */
  function refusal (request) {
    const origin = request.headers.get('origin')
    if (origin !== null && !allowedOrigins.includes(origin)) return new KuboError('request origin is not allowed', { status: 403 })
    if (apiKey !== undefined && request.headers.get('authorization') !== `Bearer ${apiKey}`) return new KuboError('missing or wrong API key', { status: 401 })
    return undefined
  }

  /** @param {Request} request @param {URL} url */
  async function rpc (request, url) {
    const name = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '')
    if (request.method !== 'POST') return errorResponse(new KuboError('only POST allowed', { status: 405 }))
    const route = Object.hasOwn(routes, name) ? routes[name] : undefined
    if (route === undefined) return errorResponse(new KuboError(`/api/v0/${name} is not implemented by this node`, { status: 501 }))
    /** @type {Promise<import('./multipart.js').Part[]> | undefined} */
    let parts
    try {
      return await route({
        request,
        params: url.searchParams,
        args: url.searchParams.getAll('arg'),
        signal: request.signal,
        parts: () => (parts ??= readParts(request))
      })
    } catch (error) {
      return errorResponse(error)
    }
  }

  return {
    /** The gateway's multiaddr, which `config` answers for `Addresses.Gateway`. */
    gateway,
    /** @param {Request} request */
    async handle (request) {
      const refused = refusal(request)
      if (refused !== undefined) return errorResponse(refused)
      const url = new URL(request.url)
      return url.pathname.startsWith(API_PREFIX) ? rpc(request, url) : gatewayHandler.handle(request)
    },
    /** A configuration value, as `config` would answer it. @param {string} key */
    getConfig: (key) => config.get(key),
    /** Waits for the writes in flight (a flush, the pins after it) and stops nothing else. */
    async close () {
      await mfs.settle()
      await pins.settle()
    }
  }
}
