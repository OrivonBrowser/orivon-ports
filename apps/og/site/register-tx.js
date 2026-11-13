// The calls of a registration as pure calldata builders. Each answers `{ to, data }` (`value` for the tip); the flow adds the
// sender and the gas. The three Linagee contracts are the ones in resolver/og-pins.js, and no contract here is Orivon's. The calls past
// the registration's own are the ones a held name is managed with.

import { encodeCall } from './sdk/abi.js'
import { PROXY, REGISTRY, WRAPPER } from './resolver/og-pins.js'

/** @typedef {{ to: string, data: Uint8Array, value?: bigint }} Call */

/** Takes a free name for the sender. A taken name is not an error: the registry does nothing and says nothing. @param {string} key @returns {Call} */
export const reserveTx = (key) => ({ to: REGISTRY, data: encodeCall('reserve(bytes32)', [key]) })

/** Names who may write the name's records besides its owner. @param {string} key @param {string} account @returns {Call} */
export const setControllerTx = (key, account) => ({ to: PROXY, data: encodeCall('setController(bytes32,address)', [key, account]) })

/** Tells the wrapper who is about to hand it the name. Only the registry owner may. @param {string} key @returns {Call} */
export const createWrapperTx = (key) => ({ to: WRAPPER, data: encodeCall('createWrapper(bytes32)', [key]) })

/** Gives the name to `receiver`. For the wrapper this strands the name unless `createWrapper` came first. @param {string} key @param {string} receiver @returns {Call} */
export const transferTx = (key, receiver) => ({ to: REGISTRY, data: encodeCall('transfer(bytes32,address)', [key, receiver]) })

/** Takes the name the wrapper holds for the sender and mints its token to them. @param {string} key @returns {Call} */
export const wrapTx = (key) => ({ to: WRAPPER, data: encodeCall('wrap(bytes32)', [key]) })

/** @param {string} key @param {string} textKey @param {string} value @returns {Call} */
export const setTextTx = (key, textKey, value) => ({ to: PROXY, data: encodeCall('setTextRecord(bytes32,string,string)', [key, textKey, value]) })

/** A plain transfer of ether. @param {string} to @param {bigint} value @returns {Call} */
export const tipTx = (to, value) => ({ to, data: new Uint8Array(0), value })

/** Burns the wrapper's token for a name and gives the name back to the token's holder in the registry. @param {string | bigint} tokenId @returns {Call} */
export const unwrapTx = (tokenId) => ({ to: WRAPPER, data: encodeCall('unwrap(uint256)', [BigInt(tokenId)]) })

/** Removes the name's controller. Only the registry owner may. @param {string} key @returns {Call} */
export const unsetControllerTx = (key) => ({ to: PROXY, data: encodeCall('unsetController(bytes32)', [key]) })

/** @param {string} key @param {string} textKey @returns {Call} */
export const unsetTextTx = (key, textKey) => ({ to: PROXY, data: encodeCall('unsetTextRecord(bytes32,string)', [key, textKey]) })

/** Makes the name the sender's primary one, replacing the one before. @param {string} key @returns {Call} */
export const setPrimaryTx = (key) => ({ to: PROXY, data: encodeCall('setPrimary(bytes32)', [key]) })

/** Ends the sender's primary name. @returns {Call} */
export const unsetPrimaryTx = () => ({ to: PROXY, data: encodeCall('unsetPrimary()', []) })

/** Sends the wrapper's token to `to`, which must be able to receive one. @param {string} from @param {string} to @param {string | bigint} tokenId @returns {Call} */
export const sendTokenTx = (from, to, tokenId) => ({ to: WRAPPER, data: encodeCall('safeTransferFrom(address,address,uint256)', [from, to, BigInt(tokenId)]) })
