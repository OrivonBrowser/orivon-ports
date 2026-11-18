// What a page may ask of its node over the media gateway's socket: the read-only calls a Bitsocial client's statistics
// make of kubo (`id`, `swarm/peers`, `stats/bw`, the AutoNAT verdict), answered here instead of by a kubo API on a
// port. A request needs `Authorization: Bearer <authKey>`, the key that opens the RPC, so a program on the loopback
// that has not been given it, and a web page that reaches the port, get nothing; the facade's own origin check
// (`listenFacade`) refuses a request that carries an `Origin`. Any call off the list is refused before the facade sees it.

import { errorResponse, jsonResponse, KuboError } from '../kubo/wire.js'
import { noBandwidth } from './bandwidth.js'
import { sameKey } from './rpc-guard.js'

/** Where the socket answers them: `POST /orivon/api/<call>`. */
export const PAGE_API_PATH = '/orivon/api/'

/** The calls that change nothing. The mutable file system, pins, keys and pubsub are the RPC server's. */
export const PAGE_CALLS = Object.freeze(['id', 'swarm/peers', 'swarm/addrs/autonat', 'stats/bw', 'repo/stat', 'version'])

const VERDICTS = { public: 'Public', private: 'Private', unknown: 'Unknown' }

/**
 * @param {{
 *   facade: { handle: (request: Request) => Promise<Response> },
 *   authKey: string,
 *   kuboUrl: string,
 *   reachability: () => Promise<'public' | 'private' | 'unknown'>,
 *   bandwidth?: () => Promise<import('./bandwidth.js').Bandwidth | null>
 * }} options `kuboUrl` is the origin the facade answers kubo's API at, which the calls are forwarded to; `bandwidth` is the
 *   node's byte counts, null when it has none, and a page API without it says it has none
 */
export function pageApi ({ facade, authKey, kuboUrl, reachability, bandwidth = async () => null }) {
  return {
    /** @param {Request} request */
    async handle (request) {
      try {
        const url = new URL(request.url)
        if (request.method !== 'POST') return errorResponse(new KuboError('only POST allowed', { status: 405 }))
        if (!sameKey(request.headers.get('authorization') ?? '', `Bearer ${authKey}`)) return errorResponse(new KuboError('missing or wrong key', { status: 401 }))
        const call = url.pathname.slice(PAGE_API_PATH.length).replace(/\/+$/, '')
        if (!PAGE_CALLS.includes(call)) return errorResponse(new KuboError(`${call} is not a call a page may make`, { status: 403 }))
        if (call === 'stats/bw') return jsonResponse((await bandwidth()) ?? noBandwidth())
        if (call === 'swarm/addrs/autonat') return jsonResponse({ reachability: VERDICTS[await reachability()] })
        return await facade.handle(new Request(`${kuboUrl}/api/v0/${call}${url.search}`, { method: 'POST', signal: request.signal }))
      } catch (error) {
        return errorResponse(error)
      }
    }
  }
}
