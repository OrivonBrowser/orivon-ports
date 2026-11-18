// What a page of this app may ask of the anti-spam challenges the node runs, over the gateway's socket: the list, with each
// challenge's description and the schema of its options, and each one this build left out with why; and, for a board this node hosts,
// its challenges (`boards`, `board`) and the one write, `apply`, which sets them (board-challenges.js). Same door as the page API
// (page-api.js): `POST` with `Authorization: Bearer <authKey>`, compared in constant time, after the facade's own origin check; a call
// off the list is refused before it is read. Nothing here installs or removes a challenge: the set is what the Worker was built with
// (challenges.js), and a board names one in its own settings.

import { errorResponse, jsonResponse, KuboError } from '../kubo/wire.js'
import { ConflictError, NotHostedError, SettingsError } from './board-challenges.js'
import { sameKey } from './rpc-guard.js'

/** Where the socket answers it: `POST /orivon/challenges/<call>`. */
export const CHALLENGES_API_PATH = '/orivon/challenges/'

/** The calls, and only these. */
export const CHALLENGE_CALLS = Object.freeze(['list', 'boards', 'board', 'apply'])

/** A call that names a board needs a board's address and little else; `apply` carries a whole list of challenges, whose options can hold a prompt or a list of words. */
const BODY_MAX = 16 * 1024
const APPLY_BODY_MAX = 256 * 1024

/** @param {Request} request @param {number} max @returns {Promise<Record<string, unknown>>} */
async function bodyOf (request, max) {
  const text = await request.text()
  if (text.length > max) throw new KuboError('the request is too large', { status: 413 })
  if (text.trim() === '') return {}
  /** @type {unknown} */
  let value
  try { value = JSON.parse(text) } catch { throw new KuboError('the request body is not JSON', { status: 400 }) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KuboError('the request body must be a JSON object', { status: 400 })
  return /** @type {Record<string, unknown>} */ (value)
}

/** @param {unknown} error */
function asKuboError (error) {
  if (error instanceof NotHostedError) return new KuboError(error.message, { status: 404 })
  if (error instanceof ConflictError) return new KuboError(error.message, { status: 409 })
  return error
}

/**
 * @param {{
 *   authKey: string,
 *   challenges: { list: () => ReturnType<typeof import('./challenges.js').describeChallenges> } | null,
 *   boards?: ReturnType<typeof import('./board-challenges.js').boardChallenges> | null,
 *   ethereum?: () => Record<string, unknown>
 * }} options `challenges` is null for a Worker whose build bundles none, which answers that it has none; `boards` is null for one that cannot
 *   edit a board's challenges; `ethereum` says which path reads Ethereum now (the name API's), which the list of boards carries so that a page names the host
 *   a challenge that reads Ethereum reaches
 */
export function challengesApi ({ authKey, challenges, boards = null, ethereum }) {
  return {
    /** @param {Request} request */
    async handle (request) {
      try {
        if (request.method !== 'POST') return errorResponse(new KuboError('only POST allowed', { status: 405 }))
        if (!sameKey(request.headers.get('authorization') ?? '', `Bearer ${authKey}`)) return errorResponse(new KuboError('missing or wrong key', { status: 401 }))
        const call = new URL(request.url).pathname.slice(CHALLENGES_API_PATH.length).replace(/\/+$/, '')
        if (!CHALLENGE_CALLS.includes(call)) return errorResponse(new KuboError(`${call} is not a call a page may make`, { status: 403 }))
        if (call === 'list') {
          if (challenges === null) return errorResponse(new KuboError('this build of the node has no challenges', { status: 503 }))
          await bodyOf(request, BODY_MAX)
          return jsonResponse(challenges.list())
        }
        if (boards === null) return errorResponse(new KuboError('this build of the node cannot edit a board\'s challenges', { status: 503 }))
        const body = await bodyOf(request, call === 'apply' ? APPLY_BODY_MAX : BODY_MAX)
        if (call === 'boards') return jsonResponse({ ...boards.boards(), ...(ethereum === undefined ? {} : { ethereum: ethereum() }) })
        if (typeof body['address'] !== 'string' || body['address'] === '') throw new KuboError('address must be the address of a board', { status: 400 })
        if (call === 'board') return jsonResponse(await boards.board(body['address']))
        if (body['expect'] !== undefined && !Array.isArray(body['expect'])) throw new KuboError('expect must be the list of challenges that was read', { status: 400 })
        return jsonResponse(await boards.apply(body['address'], body['challenges'], body['expect']))
      } catch (error) {
        if (error instanceof SettingsError) return jsonResponse({ Message: error.message, Code: 0, Type: 'error', failures: error.failures }, 400)
        return errorResponse(asKuboError(error))
      }
    }
  }
}
