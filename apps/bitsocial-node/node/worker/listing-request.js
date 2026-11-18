// The request a board owner sends to be listed in a directory of `bitsocialnet/lists`: the entry to add, the message a reviewer
// checks, and the board key's signature over it. The message is built here, never taken from a page, so a page can ask the
// board's key to sign a listing request and nothing else: its first line is fixed, and no signed record of pkc-js starts with a
// text line (they are CBOR maps), so the signature cannot be replayed as one.

import { ed25519 } from '@noble/curves/ed25519.js'
import { base58btc } from 'multiformats/bases/base58'

export const REQUEST_PREFIX = 'bitsocial-listing-request-v1'
/** A directory file of the lists, 5chan's or seedit's: `<family>-directories/<family>-<code>-directory.json`. */
export const REQUEST_FILE = /^(5chan|seedit)-directories\/\1-[a-z0-9]+(?:-[a-z0-9]+)*-directory\.json$/
/** The name a board owner may give for themselves in a 5chan entry. */
export const OWNER_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:bso|eth)$/

/** An Ed25519 key inside a peer ID: the identity multihash `00 24 08 01 12 20` and then the 32 bytes of the key. */
const PEER_ID_HEAD = [0x00, 0x24, 0x08, 0x01, 0x12, 0x20]

/** @param {string} base64 */
const bytesOf = (base64) => Uint8Array.from(Buffer.from(base64, 'base64'))

/**
 * The 32-byte public key a board's address (its peer ID) holds.
 * @param {string} peerId @returns {Uint8Array}
 */
export function peerKeyOf (peerId) {
  /** @type {Uint8Array | null} */
  let bytes = null
  try { bytes = base58btc.decode(`z${peerId}`) } catch { bytes = null }
  if (bytes === null || bytes.length !== PEER_ID_HEAD.length + 32 || PEER_ID_HEAD.some((byte, index) => bytes[index] !== byte)) throw new Error(`${peerId} is not an Ed25519 peer ID`)
  return bytes.slice(PEER_ID_HEAD.length)
}

/**
 * The entry to add to a directory file, in the order the lists write it (a seedit entry has no owner).
 * @param {{ file: string, address: string, publicKey: string, addedAt: number, owner?: string }} fields
 */
export function entryOf ({ file, address, publicKey, addedAt, owner }) {
  if (file.startsWith('seedit-')) return { address, addedAt, publicKey }
  return { address, publicKey, addedAt, ...(owner === undefined ? {} : { owner }) }
}

/** @param {{ file: string, entry: Record<string, unknown> }} request */
export const messageOf = ({ file, entry }) => `${REQUEST_PREFIX}\nlist: bitsocialnet/lists\nfile: ${file}\nentry: ${JSON.stringify(entry)}`

/** Whether a private key (base 64 of the 32-byte seed, as pkc-js keeps it) is the one the public key (a peer ID) names. @param {{ privateKey: string, publicKey: string }} keys */
export async function holdsKey ({ privateKey, publicKey }) {
  try {
    const mine = ed25519.getPublicKey(bytesOf(privateKey))
    const named = peerKeyOf(publicKey)
    return mine.length === named.length && mine.every((byte, index) => byte === named[index])
  } catch { return false }
}

/**
 * The signature, in base 64, of the message by the board's key. A key that is not the one `publicKey` names (a board whose
 * identity key its owner holds elsewhere) is refused, and so is a signature that does not verify.
 * @param {{ message: string, privateKey: string, publicKey: string }} request @returns {Promise<string>}
 */
export async function signRequest ({ message, privateKey, publicKey }) {
  if (!await holdsKey({ privateKey, publicKey })) throw new Error(`this node does not hold the key of ${publicKey}`)
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), bytesOf(privateKey))).toString('base64')
  if (!await verifyRequest({ message, signature, publicKey })) throw new Error('the signature did not verify under the board\'s own key')
  return signature
}

/** Whether the signature is the board's, checked against nothing but its address. @param {{ message: string, signature: string, publicKey: string }} request */
export async function verifyRequest ({ message, signature, publicKey }) {
  try {
    const bytes = bytesOf(signature)
    return bytes.length === 64 && ed25519.verify(bytes, new TextEncoder().encode(message), peerKeyOf(publicKey))
  } catch { return false }
}
