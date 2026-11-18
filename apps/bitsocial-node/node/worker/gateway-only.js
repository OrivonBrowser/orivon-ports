// The facade as the gateway socket serves it. The facade answers kubo's RPC (`/api/v0/`) and the gateway on one
// origin, and pkc-js reaches both inside this process with no socket; what a page may reach over a socket is the
// gateway, the few read-only calls of page-api.js, the board manager's control calls (manager-api.js), the challenge list
// (challenges-api.js), the listing calls (listing-api.js), the name calls (name-api.js), seeding (seeding-api.js) and how the node is
// reached (reach-api.js), so the RPC is left to the in-process caller.

import { CHALLENGES_API_PATH } from './challenges-api.js'
import { LISTING_API_PATH } from './listing-api.js'
import { MANAGER_API_PATH } from './manager-api.js'
import { NAME_API_PATH } from './name-api.js'
import { PAGE_API_PATH } from './page-api.js'
import { REACH_API_PATH } from './reach-api.js'
import { SEEDING_API_PATH } from './seeding-api.js'

/**
 * @param {{ handle: (request: Request) => Promise<Response> }} facade
 * @param {{ handle: (request: Request) => Promise<Response> }} [api] answers the paths under `/orivon/api/`
 * @param {{ handle: (request: Request) => Promise<Response> }} [manager] answers the paths under `/orivon/manager/`
 * @param {{ handle: (request: Request) => Promise<Response> }} [listing] answers the paths under `/orivon/listing/`
 * @param {{ handle: (request: Request) => Promise<Response> }} [names] answers the paths under `/orivon/name/`
 * @param {{ handle: (request: Request) => Promise<Response> }} [seeding] answers the paths under `/orivon/seeding/`
 * @param {{ handle: (request: Request) => Promise<Response> }} [reach] answers the paths under `/orivon/reach/`
 * @param {{ handle: (request: Request) => Promise<Response> }} [challenges] answers the paths under `/orivon/challenges/`
 */
export function gatewayOnly (facade, api, manager, listing, names, seeding, reach, challenges) {
  return {
    /** @param {Request} request */
    async handle (request) {
      const path = new URL(request.url).pathname
      if (api !== undefined && path.startsWith(PAGE_API_PATH)) return api.handle(request)
      if (manager !== undefined && path.startsWith(MANAGER_API_PATH)) return manager.handle(request)
      if (listing !== undefined && path.startsWith(LISTING_API_PATH)) return listing.handle(request)
      if (names !== undefined && path.startsWith(NAME_API_PATH)) return names.handle(request)
      if (seeding !== undefined && path.startsWith(SEEDING_API_PATH)) return seeding.handle(request)
      if (reach !== undefined && path.startsWith(REACH_API_PATH)) return reach.handle(request)
      if (challenges !== undefined && path.startsWith(CHALLENGES_API_PATH)) return challenges.handle(request)
      if (path.startsWith('/api/') || [PAGE_API_PATH, MANAGER_API_PATH, CHALLENGES_API_PATH, LISTING_API_PATH, NAME_API_PATH, SEEDING_API_PATH, REACH_API_PATH].some((prefix) => path.startsWith(prefix))) return new Response('not found\n', { status: 404, headers: { 'Content-Type': 'text/plain' } })
      return facade.handle(request)
    }
  }
}
