// Whether an account can write a name's records on its resolver, the fourth clause of the attribution rule. A
// PermissionedResolver (ENSv2, tag v2-mainnet-deployment-1) checks a setter's role for the resource its argument names
// (`keccak256(key)` for a text key, `keccak256(coinType)` for an address record) and then at the root, never per name:
// whoever holds the role there writes every name's record on that resolver.

import { sameAddress } from './abi.js'
import { fromHex, toHex, utf8 } from './bytes.js'
import { ChainError } from './chain.js'
import { keccak256 } from './keccak.js'

/** The record a name's owner sets to end the sign-ins made before it. */
export const NOT_BEFORE_KEY = 'eth.orivonstack.id.not-before'

export const ROLE_SET_ADDRESS = 1n
export const ROLE_SET_TEXT = 1n << 4n
/** The roles a resolver must give an account for the records this site writes. */
export const RECORD_ROLES = ROLE_SET_ADDRESS | ROLE_SET_TEXT
export const ETH_COIN_TYPE = 60n

/** `PermissionedResolverLib.resource(string)`. @param {string} key */
export const textResource = (key) => BigInt('0x' + toHex(keccak256(utf8(key))))

/** `PermissionedResolverLib.resource(uint256)`. @param {bigint} coinType */
export const addressResource = (coinType) => BigInt('0x' + toHex(keccak256(fromHex('0x' + coinType.toString(16).padStart(64, '0')))))

/**
 * @typedef {'notPermissionedResolver' | 'textRoleMissing' | 'addressRoleMissing' | 'unreadable'} RecordsProblem
 * notPermissionedResolver: the factory does not vouch for the resolver as the PermissionedResolver. textRoleMissing,
 * addressRoleMissing: the account cannot set the revocation record, or the address record. unreadable: the resolver
 * answered a role question with a revert or something else than a bool.
 */

/** @param {unknown} error */
const unreadable = (error) => error instanceof ChainError && (error.reason === 'reverted' || error.reason === 'badAnswer')

/**
 * Whether `holder` can write the records the sign-in rules rest on (the revocation text record and the Ethereum
 * address record) on `resolver`: the factory names the known implementation for it, and the holder has the two roles.
 * A node that cannot be asked throws; a revert is an answer, and refuses.
 * @param {(to: string, signature: string, args: unknown[], outputs: string[]) => Promise<unknown[]>} read a contract read, at the block being checked
 * @param {{ resolver: string, holder: string, factory: string, implementation: string }} parts
 * @returns {Promise<{ ok: true, problem: null } | { ok: false, problem: RecordsProblem }>}
 */
export async function recordsHeld (read, { resolver, holder, factory, implementation }) {
  try {
    const [found] = await read(factory, 'verifyContract(address)', [resolver], ['address'])
    if (typeof found !== 'string' || !sameAddress(found, implementation)) return { ok: false, problem: 'notPermissionedResolver' }
  } catch (error) {
    if (unreadable(error)) return { ok: false, problem: 'notPermissionedResolver' }
    throw error
  }
  try {
    const [[text], [address]] = await Promise.all([
      read(resolver, 'hasRoles(uint256,uint256,address)', [textResource(NOT_BEFORE_KEY), ROLE_SET_TEXT, holder], ['bool']),
      read(resolver, 'hasRoles(uint256,uint256,address)', [addressResource(ETH_COIN_TYPE), ROLE_SET_ADDRESS, holder], ['bool'])
    ])
    if (text !== true) return { ok: false, problem: 'textRoleMissing' }
    return address === true ? { ok: true, problem: null } : { ok: false, problem: 'addressRoleMissing' }
  } catch (error) {
    if (unreadable(error)) return { ok: false, problem: 'unreadable' }
    throw error
  }
}
