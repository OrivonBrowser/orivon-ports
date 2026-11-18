// What a page of this app may ask of the node to get a board listed in a directory of `bitsocialnet/lists`, over the gateway's
// socket: the boards the node hosts, a board's record as far as a directory checks it, and a listing request signed by the board's own key. Same door as the
// board manager's (manager-api.js): `POST` with `Authorization: Bearer <authKey>`, compared in constant time, and a call off the list
// is refused before it is read. The page never gets a key: the Worker builds the message, signs it and answers the signature.

import { errorResponse, jsonResponse, KuboError } from '../kubo/wire.js'
import { KeyNotHeldError, NotHostedError, UnavailableError } from './board-records.js'
import { entryOf, messageOf, OWNER_NAME, REQUEST_FILE, signRequest } from './listing-request.js'
import { bodyOf } from './manager-api.js'
import { sameKey } from './rpc-guard.js'

/** Where the socket answers them: `POST /orivon/listing/<call>`. */
export const LISTING_API_PATH = '/orivon/listing/'

/** The calls, and only these. */
export const LISTING_CALLS = Object.freeze(['boards', 'board', 'sign'])

/** @param {unknown} error */
function asKuboError (error) {
  if (error instanceof KuboError) return error
  if (error instanceof NotHostedError) return new KuboError(error.message, { status: 404 })
  if (error instanceof KeyNotHeldError) return new KuboError(error.message, { status: 409 })
  if (error instanceof UnavailableError) return new KuboError(error.message, { status: 503 })
  return error
}

/** @param {Record<string, unknown>} body */
function addressOf (body) {
  if (typeof body['address'] !== 'string' || body['address'] === '') throw new KuboError('address must be the address of a board', { status: 400 })
  return body['address']
}

/**
 * @param {{
 *   authKey: string,
 *   boards: ReturnType<typeof import('./board-records.js').boardRecords> | null,
 *   now?: () => number
 * }} options `boards` is null for a Worker with no way to read its boards, which answers that it has none; `now` is in milliseconds
 */
export function listingApi ({ authKey, boards, now = Date.now }) {
  return {
    /** @param {Request} request */
    async handle (request) {
      try {
        const url = new URL(request.url)
        if (request.method !== 'POST') return errorResponse(new KuboError('only POST allowed', { status: 405 }))
        if (!sameKey(request.headers.get('authorization') ?? '', `Bearer ${authKey}`)) return errorResponse(new KuboError('missing or wrong key', { status: 401 }))
        const call = url.pathname.slice(LISTING_API_PATH.length).replace(/\/+$/, '')
        if (!LISTING_CALLS.includes(call)) return errorResponse(new KuboError(`${call} is not a call a page may make`, { status: 403 }))
        if (boards === null) return errorResponse(new KuboError('this build of the node cannot read its boards', { status: 503 }))
        const body = await bodyOf(request)
        if (call === 'boards') return jsonResponse({ boards: boards.list() })
        const address = addressOf(body)
        if (call === 'board') return jsonResponse(await boards.read(address))
        const { file, owner } = body
        if (typeof file !== 'string' || !REQUEST_FILE.test(file)) throw new KuboError('file must be a directory file of the lists', { status: 400 })
        if (owner !== undefined && (typeof owner !== 'string' || !OWNER_NAME.test(owner))) throw new KuboError('owner must be a name that ends .bso or .eth', { status: 400 })
        const key = await boards.key(address)
        const entry = entryOf({ file, address: key.address, publicKey: key.publicKey, addedAt: Math.floor(now() / 1000), ...(owner === undefined ? {} : { owner }) })
        const message = messageOf({ file, entry })
        const signature = await signRequest({ message, privateKey: key.privateKey, publicKey: key.publicKey })
        return jsonResponse({ file, entry, message, signature, publicKey: key.publicKey })
      } catch (error) {
        return errorResponse(asKuboError(error))
      }
    }
  }
}
