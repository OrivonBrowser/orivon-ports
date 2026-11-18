// What a page of this app may ask of the node to give a board a name, over the gateway's socket: the boards the node hosts, the record a
// name must hold to point at one, whether it does, and the transaction that sets the record. Same door as the listing calls (listing-api.js):
// `POST` with `Authorization: Bearer <authKey>`, compared in constant time, and a call off the list is refused before it is read. The
// node never signs or sends anything here: the transaction is data for the person's own wallet. A page can make the node ask Ethereum, so
// the calls that do are limited to two at a time.

import { errorResponse, jsonResponse, KuboError } from '../kubo/wire.js'
import { NotHostedError, UnavailableError } from './board-records.js'
import { bodyOf } from './manager-api.js'
import { NameClaimError, recordOf } from './name-claim.js'
import { sameKey } from './rpc-guard.js'

/** Where the socket answers them: `POST /orivon/name/<call>`. */
export const NAME_API_PATH = '/orivon/name/'

/** The calls, and only these. */
export const NAME_API_CALLS = Object.freeze(['boards', 'record', 'check', 'transaction'])

/** How many calls that read Ethereum may run at once. */
const READS_AT_ONCE = 2

/** @param {unknown} error */
function asKuboError (error) {
  if (error instanceof KuboError) return error
  if (error instanceof NameClaimError) return new KuboError(error.message, { status: error.status })
  if (error instanceof NotHostedError) return new KuboError(error.message, { status: 404 })
  if (error instanceof UnavailableError) return new KuboError(error.message, { status: 503 })
  return error
}

/**
 * @param {{
 *   authKey: string,
 *   boards: ReturnType<typeof import('./board-records.js').boardRecords> | null,
 *   claims: ReturnType<typeof import('./name-claim.js').nameClaims>,
 *   ethereum?: () => Record<string, unknown>
 * }} options `boards` is null for a Worker with no way to read its boards, which answers that it has none; `ethereum` says which path reads Ethereum now,
 *   and is asked when the page lists the boards, so the page can tell the person
 */
export function nameApi ({ authKey, boards, claims, ethereum }) {
  let reading = 0
  return {
    /** @param {Request} request */
    async handle (request) {
      try {
        const url = new URL(request.url)
        if (request.method !== 'POST') return errorResponse(new KuboError('only POST allowed', { status: 405 }))
        if (!sameKey(request.headers.get('authorization') ?? '', `Bearer ${authKey}`)) return errorResponse(new KuboError('missing or wrong key', { status: 401 }))
        const call = url.pathname.slice(NAME_API_PATH.length).replace(/\/+$/, '')
        if (!NAME_API_CALLS.includes(call)) return errorResponse(new KuboError(`${call} is not a call a page may make`, { status: 403 }))
        if (boards === null) return errorResponse(new KuboError('this build of the node cannot read its boards', { status: 503 }))
        const body = await bodyOf(request)
        if (call === 'boards') return jsonResponse({ boards: boards.list(), ...(ethereum === undefined ? {} : { ethereum: ethereum() }) })
        if (typeof body['address'] !== 'string' || body['address'] === '') throw new KuboError('address must be the address of a board', { status: 400 })
        const board = boards.entry(body['address'])
        const named = { name: /** @type {string} */ (body['name']), publicKey: board.publicKey }
        if (call === 'record') return jsonResponse({ address: board.address, ...recordOf(named) })
        if (reading >= READS_AT_ONCE) throw new KuboError('the node is already reading names for the page: wait for one to finish', { status: 429 })
        reading += 1
        try {
          return jsonResponse({ address: board.address, ...(call === 'check' ? await claims.check(named) : await claims.transaction(named)) })
        } finally { reading -= 1 }
      } catch (error) {
        return errorResponse(asKuboError(error))
      }
    }
  }
}
