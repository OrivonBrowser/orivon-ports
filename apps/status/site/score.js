// The Web3 Score provider's evaluation of a build, read the way Orivon reads one: a bucket file
// named by the first hex characters of the SHA-256 of the identifier, holding every evaluation
// that hashes there. Pure apart from the hash; the requests are in fetchers.js.

import { text, toHex, utf8 } from './bytes.js'
import { sha256 } from './verify.js'

/**
 * The bucket an identifier is filed under.
 * @param {string} id for example `cid:bafy…`
 * @param {number} hexChars 1 or 2
 */
export async function bucketOf (id, hexChars) {
  return toHex(await sha256(utf8(id))).slice(0, hexChars)
}

/**
 * The provider's `provider.json`, checked for the two things this page relies on.
 * @param {unknown} value
 * @returns {{ name: string, bucketHexChars: 1 | 2 } | null}
 */
export function readProvider (value) {
  const provider = /** @type {any} */ (value)
  if (provider?.standard !== 'orivon-web3-score/1') return null
  if (provider.bucketHexChars !== 1 && provider.bucketHexChars !== 2) return null
  return { name: typeof provider.name === 'string' ? provider.name.slice(0, 80) : 'the provider', bucketHexChars: provider.bucketHexChars }
}

/**
 * The evaluation of `id` in a bucket file, or null when the bucket holds none (a missing bucket
 * means the same). An evaluation off the website scale is no evaluation.
 * @param {unknown} file
 * @param {string} id
 * @param {string} bucket
 * @returns {{ level: number, privacy: boolean, evaluated: string } | null}
 */
export function findEvaluation (file, id, bucket) {
  const body = /** @type {any} */ (file)
  if (!body || body.subject !== 'website' || body.bucket !== bucket || !Array.isArray(body.entries)) return null
  const entry = body.entries.find((/** @type {any} */ candidate) => candidate?.id === id)
  const level = entry?.trustlessity?.level
  if (!Number.isInteger(level) || level < 1 || level > 4) return null
  return {
    level,
    privacy: entry.trustlessity.privacy === true && level === 4,
    evaluated: /^\d{4}-\d{2}-\d{2}$/.test(String(entry.evaluated)) ? entry.evaluated : 'on an unknown date'
  }
}

/** @param {{ level: number, privacy: boolean, evaluated: string }} evaluation */
export const describeEvaluation = (evaluation) => `Level ${evaluation.level}${evaluation.privacy ? ' + privacy' : ''}`

/** The provider file bytes as JSON, or null. @param {Uint8Array} bytes */
export function parseJsonBytes (bytes) {
  try {
    return JSON.parse(text(bytes))
  } catch {
    return null
  }
}
