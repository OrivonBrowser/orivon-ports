// The identifiers a WebTorrent tracker expects, and the swarm a share is found in.

import { parseCid, sha256 } from '../ipfs/cid.js'

/** The swarm name is derived from the address, so a tracker sees a hash and addresses, never the address or the bytes. */
export const SWARM_PREFIX = 'orivon-share/1:'

/** 20 bytes as a string of one character per byte, which is how WebTorrent trackers carry ids in JSON. @param {Uint8Array} bytes */
export function toBinary (bytes) {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return out
}

/** @param {string} text @returns {Uint8Array} */
export function fromBinary (text) {
  return Uint8Array.from(text, (char) => char.charCodeAt(0) & 255)
}

/** The first 20 bytes of the SHA-256 of `orivon-share/1:` and the root CID, as a binary string. @param {string} rootCid @returns {Promise<string>} */
export async function infoHashOf (rootCid) {
  const digest = await sha256(new TextEncoder().encode(`${SWARM_PREFIX}${parseCid(rootCid).string}`))
  return toBinary(digest.subarray(0, 20))
}

/** A peer id: a client tag and random bytes, 20 in all, as a binary string. */
export function randomPeerId () {
  const bytes = new Uint8Array(20)
  bytes.set(new TextEncoder().encode('-OS0100-'))
  globalThis.crypto.getRandomValues(bytes.subarray(8))
  return toBinary(bytes)
}

/** 20 random bytes naming one offer, as a binary string. */
export function randomOfferId () {
  const bytes = new Uint8Array(20)
  globalThis.crypto.getRandomValues(bytes)
  return toBinary(bytes)
}
