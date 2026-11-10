// The transactions of a registration as pure calldata builders. Each answers { to, data }; the flow adds the
// sender and the gas. The records go through the resolver's own multicall, which delegatecalls itself, so the
// caller's roles are the ones checked.

import { encode, encodeCall, ZERO_ADDRESS } from './sdk/abi.js'
import { fromHex, toHex, utf8 } from './sdk/bytes.js'
import { dnsEncode } from './sdk/ens.js'
import { keccak256 } from './sdk/keccak.js'
import { ADDRESSES, labelId, nameOf } from './sdk/orivonid.js'

/** @typedef {{ to: string, data: Uint8Array }} Call */

/** The salt of every account's resolver: `uint256(keccak256("orivonid.resolver.v1"))`. */
export const SALT = BigInt('0x' + toHex(keccak256(utf8('orivonid.resolver.v1'))))

/** What the owner is granted on the resolver at its creation: every role and every admin role. */
export const RESOLVER_ROLES = BigInt('0x' + '1'.repeat(64))

export const ROLE_SET_ADDRESS = 1n
export const ROLE_SET_TEXT = 1n << 4n

/** The roles a resolver must give its owner at the root for the records this site writes. */
export const RECORD_ROLES = ROLE_SET_ADDRESS | ROLE_SET_TEXT

/** R1's role to change a name's resolver, which the registrar gives every buyer (with its admin role). */
export const ROLE_SET_RESOLVER = 1n << 24n

/** Seconds after a commitment before it may be revealed, and after which it is void. */
export const MIN_COMMITMENT_AGE = 60
export const MAX_COMMITMENT_AGE = 86400

export const ETH_COIN_TYPE = 60n

/** What an ERC-1155 receiver answers to a mint it accepts. */
export const ERC1155_ACCEPTED = 'f23a6e61'

/** A gas estimate becomes a limit by this many percent. */
export const GAS_MARGIN_PERCENT = 125

/**
 * The gas limit of a reveal that is sent privately. It is fixed because asking the node to estimate the reveal would
 * hand the node the label and the secret before the relay has the transaction. Measured on a mainnet fork
 * (test/fork-register-gas.test.ts): at most 349,335 gas, for a label of 63 bytes; shorter labels used 253,000 to
 * 265,000. The limit is a quarter above the most, and only the gas used is paid.
 */
export const REGISTER_GAS_LIMIT = 450_000

/** @param {number} estimate @param {number} [percent] */
export const withMargin = (estimate, percent = GAS_MARGIN_PERCENT) => Math.ceil((estimate * percent) / 100)

/** @param {Uint8Array} bytes */
const hex = (bytes) => '0x' + toHex(bytes)

/**
 * `keccak256(abi.encode(label, owner, resolver, secret))`, the registrar's makeCommitment.
 * @param {string} label
 * @param {string} owner
 * @param {string} resolver
 * @param {Uint8Array | string} secret
 * @returns {string}
 */
export function makeCommitment (label, owner, resolver, secret) {
  return hex(keccak256(encode(['string', 'address', 'address', 'bytes32'], [label, owner, resolver, secret])))
}

/** @param {Uint8Array | string} commitment @returns {Call} */
export const commitTx = (commitment) => ({ to: ADDRESSES.registrar, data: encodeCall('commit(bytes32)', [commitment]) })

/** DAI to the registrar, for exactly the price. @param {bigint} amount @returns {Call} */
export const approveTx = (amount) => ({ to: ADDRESSES.dai, data: encodeCall('approve(address,uint256)', [ADDRESSES.registrar, amount]) })

/** The resolver's `initialize` data: the owner's grants and no records, so nothing in it names a label. @param {string} owner */
export const initializeData = (owner) => encodeCall('initialize((address,uint256)[],bytes[])', [[[owner, RESOLVER_ROLES]], []])

/** The owner's resolver, made by the factory at the address `predictProxyAddress(owner, SALT)` names. @param {string} owner @returns {Call} */
export function deployResolverTx (owner) {
  const data = encodeCall('deployProxy(address,uint256,bytes)', [ADDRESSES.resolverImplementation, SALT, initializeData(owner)])
  return { to: ADDRESSES.verifiableFactory, data }
}

/** @param {string} label @param {string} owner @param {string} resolver @param {Uint8Array | string} secret @returns {Call} */
export function registerTx (label, owner, resolver, secret) {
  return { to: ADDRESSES.registrar, data: encodeCall('register(string,address,address,bytes32)', [label, owner, resolver, secret]) }
}

/**
 * The calls the resolver runs for a name: its address record for Ethereum, the contenthash when there is one, then each
 * text record.
 * @param {string} label
 * @param {string} owner
 * @param {Record<string, string>} [texts]
 * @param {Uint8Array | null} [contenthash]
 * @returns {Uint8Array[]}
 */
export function recordCalls (label, owner, texts = {}, contenthash = null) {
  const name = dnsEncode(nameOf(label))
  return [
    encodeCall('setAddress(bytes,uint256,bytes)', [name, ETH_COIN_TYPE, fromHex(owner)]),
    ...(contenthash === null ? [] : [encodeCall('setContenthash(bytes,bytes)', [name, contenthash])]),
    ...Object.entries(texts).map(([key, value]) => encodeCall('setText(bytes,string,string)', [name, key, value]))
  ]
}

/**
 * All the records in one transaction.
 * @param {string} resolver
 * @param {string} label
 * @param {string} owner
 * @param {Record<string, string>} [texts]
 * @param {Uint8Array | null} [contenthash]
 * @returns {Call}
 */
export const recordsTx = (resolver, label, owner, texts = {}, contenthash = null) => ({
  to: resolver, data: encodeCall('multicall(bytes[])', [recordCalls(label, owner, texts, contenthash)])
})

/** Points a name at another resolver in the registry; the holder's `SET_RESOLVER` role is what it needs. @param {string} label @param {string} resolver @returns {Call} */
export const setResolverTx = (label, resolver) => ({ to: ADDRESSES.r1, data: encodeCall('setResolver(uint256,address)', [labelId(label), resolver]) })

/**
 * The call R1's mint makes on an owner that has code, as an `eth_call` to ask whether the code accepts it.
 * @param {string} owner
 * @param {string} label
 * @returns {{ from: string, to: string, data: Uint8Array }}
 */
export function receiverCheck (owner, label) {
  const data = encodeCall('onERC1155Received(address,address,uint256,uint256,bytes)', [ADDRESSES.registrar, ZERO_ADDRESS, labelId(label), 1n, new Uint8Array(0)])
  return { from: ADDRESSES.r1, to: owner, data }
}
