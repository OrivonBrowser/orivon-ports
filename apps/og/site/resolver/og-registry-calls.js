// What a transaction did to a name in the registry. The registry's `Changed(name)` carries no data and is emitted by every call that
// touches a name, so the log alone cannot tell the holder setting a field of the name from the name changing hands. The transaction
// can: this reads a direct call to the registry by its selector. A call through any other contract (a Safe, a wallet that batches, a
// bundler) is not read: the light client gives no trace of what such a call did inside, and an unread call is never a setter.

import { selector, sameAddress, splitSignature } from '../sdk/abi.js'
import { toHex } from '../sdk/bytes.js'
import { REGISTRY } from './og-pins.js'

/** @typedef {import('../sdk/chain.js').Transaction} Transaction */
/** @typedef {'setContent' | 'setAddress' | 'setSubRegistrar' | 'reserve' | 'transfer' | 'disown'} RegistryFn */
/** @typedef {{ fn: 'setContent', value: string } | { fn: Exclude<RegistryFn, 'setContent'> }} RegistryCall a direct call of the registry about one name: `value` is the bytes32 a `setContent` wrote, as 0x and 64 lower-case hexadecimal digits */

/**
 * The registry's calls that take a name as their first argument, with the signature each is selected by: the owner's setters of the three
 * fields of a name (the content, the address, the sub-registrar), and the three calls that start, move or end a name's ownership.
 * @type {readonly (readonly [RegistryFn, string])[]}
 */
export const REGISTRY_CALLS = Object.freeze([
  ['setContent', 'setContent(bytes32,bytes32)'],
  ['setAddress', 'setAddress(bytes32,address,bool)'],
  ['setSubRegistrar', 'setSubRegistrar(bytes32,address)'],
  ['reserve', 'reserve(bytes32)'],
  ['transfer', 'transfer(bytes32,address)'],
  ['disown', 'disown(bytes32)']
])

/** The calls that set a field of a name its owner holds and leave the owner as it was: none of them changes who holds the name. @type {ReadonlySet<string>} */
export const SETTERS = new Set(['setContent', 'setAddress', 'setSubRegistrar'])

/** @type {ReadonlyMap<string, { fn: RegistryFn, words: number }>} each call by the hexadecimal of its selector, with the 32-byte words its arguments take */
const BY_SELECTOR = new Map(REGISTRY_CALLS.map(([fn, signature]) => [toHex(selector(signature)), { fn, words: splitSignature(signature).types.length }]))

/**
 * The call a transaction made to the registry about `key`, or null for anything else: a transaction to another address, a selector that
 * is none of the six, input of another length than the call's (a call that would read missing words as zeros is not read as the call it
 * resembles), or a first argument that is another name.
 * @param {Pick<Transaction, 'to' | 'input'>} tx
 * @param {string} key the name's registry key, 0x and 64 hexadecimal digits
 * @returns {RegistryCall | null}
 */
export function decodeRegistryCall (tx, key) {
  if (tx.to === null || !sameAddress(tx.to, REGISTRY)) return null
  const { input } = tx
  const known = input.length < 4 ? undefined : BY_SELECTOR.get(toHex(input.subarray(0, 4)))
  if (known === undefined || input.length !== 4 + 32 * known.words) return null
  if (`0x${toHex(input.subarray(4, 36))}` !== key.toLowerCase()) return null
  return known.fn === 'setContent' ? { fn: 'setContent', value: `0x${toHex(input.subarray(36, 68))}` } : /** @type {RegistryCall} */ ({ fn: known.fn })
}
