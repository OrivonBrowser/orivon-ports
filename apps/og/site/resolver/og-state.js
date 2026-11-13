// What a name's contracts say at one block, read together: the block everything else is pinned to, and the registry,
// wrapper and resolver state of one name in as few calls as the dependencies allow (one `aggregate3`, then one more
// for a wrapped name's token). A call that fails is the contract's answer, never the node's: an owner that cannot be
// read is a name that is not there, and a record that cannot be read is a record that is not there. Only a node that
// cannot be asked throws.

import { AbiError, decode, encodeCall, sameAddress, ZERO_ADDRESS } from '../sdk/abi.js'
import { toHex } from '../sdk/bytes.js'
import { ChainError } from '../sdk/chain.js'
import { readTogether } from '../sdk/read.js'
import { PROXY, REGISTRY, TEXT_KEYS, WRAPPER } from './og-pins.js'

/** @typedef {import('../sdk/chain.js').Chain} Chain */
/** @typedef {import('./og-freshness.js').NameReads} NameReads */

/** Blocks behind the latest that no reorganisation reaches (two epochs): what a node that names no safe block is taken to have settled. */
export const FINALITY_BLOCKS = 64

/**
 * The block every read of one lookup is made at, and the highest block whose logs no reorganisation can still change. That is the node's
 * safe block, so what an answer said cannot be taken back; the lookup is pinned to it, or to the latest when the caller asks (a name this
 * page has just written) or the node has no safe block to name. Pinned to the latest, the lookup reads blocks the node may yet replace,
 * so `final` stays at the safe block, or 64 blocks (two epochs) behind the latest when the node names none.
 * @param {Chain} chain
 * @param {{ latest?: boolean }} [options]
 * @returns {Promise<{ block: number, final: number }>}
 */
export async function pinBlocks (chain, options = {}) {
  let safe = null
  try {
    safe = (await chain.getBlock('safe'))?.number ?? null
  } catch (error) {
    if (!(error instanceof ChainError) || (error.reason !== 'invalid' && error.reason !== 'badAnswer')) throw error
  }
  if (options.latest !== true && safe !== null) return { block: safe, final: safe }
  const latest = await chain.blockNumber()
  return { block: latest, final: Math.min(safe ?? latest - FINALITY_BLOCKS, latest) }
}

/**
 * The block every read of one lookup is made at: the node's safe block, so a reorganisation cannot take back what an answer
 * said, or its latest when the caller asks (a name this page has just written) or the node has no safe block to name.
 * @param {Chain} chain
 * @param {{ latest?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function pinBlock (chain, options = {}) {
  if (options.latest !== true) return (await pinBlocks(chain, options)).block
  return await chain.blockNumber()
}

/**
 * @param {Uint8Array | null} data what one call of a batch returned
 * @param {string} type
 * @returns {unknown} the decoded value, or null when the call failed or its answer does not decode
 */
function valueOf (data, type) {
  if (data === null) return null
  try {
    return decode([type], data)[0]
  } catch (error) {
    if (error instanceof AbiError) return null
    throw error
  }
}

/** @param {unknown} bytes @returns {string | null} */
const hexOf = (bytes) => bytes instanceof Uint8Array ? `0x${toHex(bytes)}` : null

/**
 * The state of one name at `block`.
 * @param {Chain} chain
 * @param {string} key the name's registry key (`keyOf`)
 * @param {number} block
 * @param {readonly string[]} [keys] the text keys to read: those an answer lists, unless the census tool asks for more
 * @returns {Promise<NameReads>} a registry owner of zero when the owner could not be read: such a name is not there
 */
export async function readName (chain, key, block, keys = TEXT_KEYS.map(([text]) => text)) {
  const [ownerData, idData, controllerData, ...textData] = await readTogether(chain, [
    { to: REGISTRY, data: encodeCall('owner(bytes32)', [key]) },
    { to: WRAPPER, data: encodeCall('nameToId(bytes32)', [key]) },
    { to: PROXY, data: encodeCall('controller(bytes32)', [key]) },
    ...keys.map((text) => ({ to: PROXY, data: encodeCall('getTextRecord(bytes32,string)', [key, text]) }))
  ], block)
  const registryOwner = /** @type {string | null} */ (valueOf(ownerData ?? null, 'address')) ?? ZERO_ADDRESS
  const nameToId = /** @type {bigint | null} */ (valueOf(idData ?? null, 'uint256')) ?? 0n
  /** @type {string | null} */
  let idToName = null
  /** @type {string | null} */
  let ownerOf = null
  if (sameAddress(registryOwner, WRAPPER) && nameToId !== 0n) {
    const [nameData, holderData] = await readTogether(chain, [
      { to: WRAPPER, data: encodeCall('idToName(uint256)', [nameToId]) },
      { to: WRAPPER, data: encodeCall('ownerOf(uint256)', [nameToId]) }
    ], block)
    idToName = hexOf(valueOf(nameData ?? null, 'bytes32'))
    ownerOf = /** @type {string | null} */ (valueOf(holderData ?? null, 'address'))
  }
  return {
    registryOwner,
    nameToId,
    idToName,
    ownerOf,
    controller: /** @type {string | null} */ (valueOf(controllerData ?? null, 'address')),
    values: Object.fromEntries(keys.map((text, index) => [text, /** @type {string | null} */ (valueOf(textData[index] ?? null, 'string'))]))
  }
}
