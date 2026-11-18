// What a page of this app may ask of the board manager over the gateway's socket: list the boards the node hosts with the state
// of their managers, read a board's config, change it, and turn a manager on or off. Same door as the page API (page-api.js):
// `POST` with `Authorization: Bearer <authKey>`, the key that opens the RPC, compared in constant time, and the facade's own
// origin check before that; a call off the list is refused before it is read. The body is one small JSON object. A board's view
// carries `noArchive`, whether the community sets `features.noArchive`: the manager reads it, a board owner sets it in the app.

import { errorResponse, jsonResponse, KuboError } from '../kubo/wire.js'
import { ConfigError } from './board-config.js'
import { NotFoundError } from './board-managers.js'
import { sameKey } from './rpc-guard.js'

/** Where the socket answers them: `POST /orivon/manager/<call>`. */
export const MANAGER_API_PATH = '/orivon/manager/'

/** The calls, and only these. */
export const MANAGER_CALLS = Object.freeze(['boards', 'board', 'enable', 'disable', 'config', 'defaults', 'defaults/set'])

/** More than a board's config and a page's worth of reasons never needs. */
const BODY_MAX = 16 * 1024

/** The body of a control call: one small JSON object, or an empty one. @param {Request} request @returns {Promise<Record<string, unknown>>} */
export async function bodyOf (request) {
  const text = await request.text()
  if (text.length > BODY_MAX) throw new KuboError('the request is too large', { status: 413 })
  if (text.trim() === '') return {}
  /** @type {unknown} */
  let value
  try { value = JSON.parse(text) } catch { throw new KuboError('the request body is not JSON', { status: 400 }) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KuboError('the request body must be a JSON object', { status: 400 })
  return /** @type {Record<string, unknown>} */ (value)
}

/** @param {unknown} error */
function asKuboError (error) {
  if (error instanceof KuboError) return error
  if (error instanceof NotFoundError) return new KuboError(error.message, { status: 404 })
  if (error instanceof ConfigError) return new KuboError(error.message, { status: 400 })
  return error
}

/**
 * @param {{
 *   authKey: string,
 *   managers: ReturnType<typeof import('./board-managers.js').superviseBoardManagers> | null,
 *   noArchive?: (address: string) => Promise<boolean | null>
 * }} options `managers` is null for a Worker whose build has no board manager, which answers that it has none; `noArchive` reads a
 * board's flag from the community (null: not known)
 */
export function managerApi ({ authKey, managers, noArchive = async () => null }) {
  /** @param {{ address: string }} view */
  const withArchive = async (view) => ({ ...view, noArchive: await noArchive(view.address) })
  return {
    /** @param {Request} request */
    async handle (request) {
      try {
        const url = new URL(request.url)
        if (request.method !== 'POST') return errorResponse(new KuboError('only POST allowed', { status: 405 }))
        if (!sameKey(request.headers.get('authorization') ?? '', `Bearer ${authKey}`)) return errorResponse(new KuboError('missing or wrong key', { status: 401 }))
        const call = url.pathname.slice(MANAGER_API_PATH.length).replace(/\/+$/, '')
        if (!MANAGER_CALLS.includes(call)) return errorResponse(new KuboError(`${call} is not a call a page may make`, { status: 403 }))
        if (managers === null) return errorResponse(new KuboError('this build of the node has no board manager', { status: 503 }))
        const body = await bodyOf(request)
        switch (call) {
          case 'boards': return jsonResponse({ boards: await Promise.all(managers.boards().map(withArchive)), defaults: managers.defaults().effective })
          case 'board': return jsonResponse(await withArchive(managers.board(/** @type {string} */ (body['address']))))
          case 'enable': return jsonResponse(await withArchive(await managers.enable(/** @type {string} */ (body['address']), body['config'])))
          case 'disable': return jsonResponse(await withArchive(await managers.disable(/** @type {string} */ (body['address']))))
          case 'config': return jsonResponse(await withArchive(await managers.configure(/** @type {string} */ (body['address']), body['config'])))
          case 'defaults': return jsonResponse(managers.defaults())
          default: return jsonResponse(await managers.configureDefaults(body['defaults']))
        }
      } catch (error) {
        return errorResponse(asKuboError(error))
      }
    }
  }
}
