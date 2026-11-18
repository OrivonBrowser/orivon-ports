// What the listing and name calls know of a board the node hosts: where it is and the key it is addressed by, the part of its record a
// directory checks (never a key, and none of a challenge's options), and the board's own key for the signature. All come from pkc-js's
// RPC server's own instance, which lists the boards it hosts, and a board it does not host is refused before pkc-js is asked for it,
// because asking would start a read of the network for a board somebody else hosts.

import { holdsKey } from './listing-request.js'

/** A board the node does not host: 404. */
export class NotHostedError extends Error {}
/** pkc-js's RPC server is not up yet: 503. */
export class UnavailableError extends Error {}
/** The node hosts the board but not its identity key (its owner holds it elsewhere): 409. */
export class KeyNotHeldError extends Error {}

const primitives = (/** @type {unknown} */ value) => Object.fromEntries(Object.entries(typeof value === 'object' && value !== null ? value : {}).filter(([, one]) => ['string', 'boolean', 'number'].includes(typeof one)))

/** @param {{ pkc: () => any }} options `pkc` is the RPC server's pkc-js instance, or null while there is none */
export function boardRecords ({ pkc }) {
  function up () {
    const instance = pkc()
    if (instance === null || instance === undefined) throw new UnavailableError('the node is still starting')
    return instance
  }

  /** The node's own list entry of a board it hosts, found by its address, its name or its key. @param {string} address */
  function locate (address) {
    const entry = (up().communities ?? []).find((/** @type {any} */ one) => one.address === address || one.name === address || one.publicKey === address)
    if (entry === undefined) throw new NotHostedError(`${address} is not a board this node hosts`)
    return entry
  }

  /** @param {string} address */
  async function find (address) {
    const entry = locate(address)
    const community = await up().createCommunity({ address: entry.address })
    return { entry, community, publicKey: String(entry.publicKey ?? community.signer?.address ?? entry.address) }
  }

  /** @param {{ community: any, publicKey: string }} board */
  const holds = (board) => holdsKey({ privateKey: String(board.community.signer?.privateKey ?? ''), publicKey: board.publicKey })

  return {
    /** The boards the node hosts: where each is, and the key it is addressed by. */
    list: () => (up().communities ?? []).map((/** @type {any} */ one) => ({ address: String(one.address), name: typeof one.name === 'string' ? one.name : null, publicKey: String(one.publicKey ?? one.address) })),
    /** Where a hosted board is and the key it is addressed by, without reading its record or opening it. @param {string} address */
    entry (address) {
      const one = locate(address)
      return { address: String(one.address), name: typeof one.name === 'string' ? one.name : null, publicKey: String(one.publicKey ?? one.address) }
    },
    /** The record as far as a listing checks it. @param {string} address */
    async read (address) {
      const board = await find(address)
      const { community, entry } = board
      return {
        address: String(entry.address), name: typeof entry.name === 'string' ? entry.name : null, publicKey: board.publicKey,
        title: typeof community.title === 'string' ? community.title : null,
        published: typeof community.updatedAt === 'number', signable: await holds(board),
        features: primitives(community.features),
        challenges: (Array.isArray(community.challenges) ? community.challenges : []).filter((/** @type {any} */ one) => typeof one?.type === 'string').map((/** @type {any} */ one) => ({ type: one.type, pendingApproval: one.pendingApproval === true })),
        rules: (Array.isArray(community.rules) ? community.rules : []).filter((/** @type {unknown} */ rule) => typeof rule === 'string')
      }
    },
    /** The board's address, public key and private key, for a signature. @param {string} address */
    async key (address) {
      const board = await find(address)
      if (!await holds(board)) throw new KeyNotHeldError(`this node does not hold the key of ${board.publicKey}: its owner holds it elsewhere`)
      return { address: String(board.entry.address), publicKey: board.publicKey, privateKey: String(board.community.signer.privateKey) }
    }
  }
}
