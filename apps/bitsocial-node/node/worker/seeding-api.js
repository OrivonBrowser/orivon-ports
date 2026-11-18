// What a page of this app may ask of seeding over the gateway's socket: its state, on and off, the space limit, the list of
// communities and a look now. Same door as the board manager's (manager-api.js): `POST` with `Authorization: Bearer <authKey>`,
// compared in constant time, a call off the list refused before it is read, one small JSON body. The `follow` call is how the
// page tells the node which communities the app's account follows: the node cannot read that, it lives in the page's own storage.

import { errorResponse, jsonResponse, KuboError } from '../kubo/wire.js'
import { ConfigError } from './board-config.js'
import { bodyOf } from './manager-api.js'
import { sameKey } from './rpc-guard.js'

/** Where the socket answers them: `POST /orivon/seeding/<call>`. */
export const SEEDING_API_PATH = '/orivon/seeding/'

/** The calls, and only these. */
export const SEEDING_CALLS = Object.freeze(['state', 'enable', 'disable', 'limit', 'add', 'remove', 'follow', 'run'])

/** @param {unknown} error */
const asKuboError = (error) => (error instanceof ConfigError ? new KuboError(error.message, { status: 400 }) : error)

/** @param {{ authKey: string, seeder: ReturnType<typeof import('./seeding.js').createSeeder> | null }} options `seeder` is null for a Worker whose build has no seeding, which answers that it has none */
export function seedingApi ({ authKey, seeder }) {
  return {
    /** @param {Request} request */
    async handle (request) {
      try {
        const url = new URL(request.url)
        if (request.method !== 'POST') return errorResponse(new KuboError('only POST allowed', { status: 405 }))
        if (!sameKey(request.headers.get('authorization') ?? '', `Bearer ${authKey}`)) return errorResponse(new KuboError('missing or wrong key', { status: 401 }))
        const call = url.pathname.slice(SEEDING_API_PATH.length).replace(/\/+$/, '')
        if (!SEEDING_CALLS.includes(call)) return errorResponse(new KuboError(`${call} is not a call a page may make`, { status: 403 }))
        if (seeder === null) return errorResponse(new KuboError('this build of the node has no seeding', { status: 503 }))
        const body = await bodyOf(request)
        switch (call) {
          case 'enable': return jsonResponse(seeder.enable())
          case 'disable': return jsonResponse(seeder.disable())
          case 'limit': return jsonResponse(seeder.setLimit(body['bytes']))
          case 'add': return jsonResponse(seeder.add(body['address']))
          case 'remove': return jsonResponse(seeder.remove(body['address']))
          case 'follow': return jsonResponse(seeder.follow(body['addresses']))
          case 'run': return jsonResponse(seeder.run())
          default: return jsonResponse(seeder.state())
        }
      } catch (error) {
        return errorResponse(asKuboError(error))
      }
    }
  }
}
