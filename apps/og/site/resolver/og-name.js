// The name rules of `.og`. A Linagee name is a registry key, the UTF-8 bytes of one label padded with zero bytes to
// 32. The registry accepts any bytes, so the resolver answers only labels that ENSIP-15 would leave as they are: one
// spelling per name, and none that a lookalike can stand in for.

import { toHex, utf8 } from '../sdk/bytes.js'
import { ens_normalize as normalize } from './vendor/ens-normalize.js'

export const NAMESPACE = 'og'

/** The longest label: the registry key holds 32 bytes. */
export const MAX_LABEL_BYTES = 32

/** @param {string} message */
const refusal = (message) => Object.assign(new Error(message), { code: 'invalid' })

/**
 * The key a label is filed under in the registry, the resolver and the wrapper: its UTF-8 bytes, then zeros.
 * @param {string} label a label that passed `parseOgName`
 * @returns {string} 0x and 64 hexadecimal characters
 */
export const keyOf = (label) => `0x${toHex(utf8(label)).padEnd(64, '0')}`

/**
 * The label of a `.og` name, or null when no such name can be answered: the label is not already in ENSIP-15 form (so
 * `Alice.og` is not `alice.og`), is empty or over 32 bytes, or the name has a dot before `.og` (the registry has no
 * subnames). A host from the address bar is lower-case ASCII; a site may ask with any text. Throws `invalid` for a name
 * that is not under `.og` at all, which the router should have sent elsewhere.
 * @param {unknown} name
 * @returns {string | null}
 */
export function parseOgName (name) {
  if (typeof name !== 'string') throw refusal('a name is text')
  const parts = (name.endsWith('.') ? name.slice(0, -1) : name).split('.')
  if (parts.pop()?.toLowerCase() !== NAMESPACE) throw refusal(`${name} is not a .${NAMESPACE} name`)
  const [label, ...deeper] = parts
  if (label === undefined || label === '' || deeper.length > 0 || utf8(label).length > MAX_LABEL_BYTES) return null
  try {
    return normalize(label) === label ? label : null
  } catch {
    return null
  }
}

/**
 * Why `text` cannot be the label of a `.og` name, or null when it can: the same rules as `parseOgName`, one reason at a time, for a
 * person who typed it. `text` is the label alone, without `.og`.
 * @param {string} text
 * @returns {{ reason: 'empty' | 'dot' | 'tooLong' | 'notNormal' | 'invalid', normalized?: string, bytes?: number } | null}
 *   `notNormal` carries the one spelling the resolver answers; `tooLong` the label's length in bytes
 */
export function labelProblem (text) {
  if (text === '') return { reason: 'empty' }
  if (text.includes('.')) return { reason: 'dot' }
  const bytes = utf8(text).length
  if (bytes > MAX_LABEL_BYTES) return { reason: 'tooLong', bytes }
  let normalized
  try {
    normalized = normalize(text)
  } catch {
    return { reason: 'invalid' }
  }
  return normalized === text ? null : { reason: 'notNormal', normalized }
}
