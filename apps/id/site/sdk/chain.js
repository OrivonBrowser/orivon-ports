// The one interface the site uses to reach Ethereum, and what every adapter of it shares. The adapters are
// chain-orivon.js (orivon.use, inside Orivon) and chain-eip1193.js (window.ethereum elsewhere, and a JSON-RPC
// node in the tests). A caller never learns which one it holds beyond `kind`.

import { fromHex } from './bytes.js'

/**
 * noWallet: nothing to ask. declined: the person said no, or closed the question. unavailable: the node or wallet
 * cannot answer now (a send that fails this way sent nothing). timeout: it took too long. limit: too wide or too
 * many at once. invalid: refused as malformed, or by the network. reverted: the call or estimate would revert.
 * unknownOutcome: a broadcast that may or may not have gone out; its hash is on the error. badAnswer: the answer
 * had the wrong shape.
 */
export const REASONS = ['noWallet', 'declined', 'unavailable', 'timeout', 'limit', 'invalid', 'reverted', 'unknownOutcome', 'badAnswer']

/** @typedef {'noWallet' | 'declined' | 'unavailable' | 'timeout' | 'limit' | 'invalid' | 'reverted' | 'unknownOutcome' | 'badAnswer'} Reason */

export class ChainError extends Error {
  /**
   * @param {Reason} reason
   * @param {string} message
   * @param {{ cause?: unknown, hash?: string, revert?: Uint8Array }} [extra]
   */
  constructor (reason, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'ChainError'
    this.reason = reason
    /** @type {string | undefined} */
    this.hash = extra.hash
    /** @type {Uint8Array | undefined} */
    this.revert = extra.revert
  }
}

/** @typedef {number | bigint | string} BlockRef a number, a tag (latest, safe, finalized, earliest), a hex number or, for getBlock only, a block hash */

/**
 * @typedef {object} TxRequest
 * @property {string} [from]
 * @property {string} [to]
 * @property {Uint8Array} [data]
 * @property {bigint} [value] wei
 * @property {number} [gas]
 * @property {number} [nonce]
 * @property {bigint} [maxFeePerGas]
 * @property {bigint} [maxPriorityFeePerGas]
 * @property {bigint} [gasPrice]
 */

/** @typedef {{ data: Uint8Array | null, revert: Uint8Array | null, offchainLookup: Uint8Array | null }} CallResult exactly one is not null */

/** @typedef {{ address: string, topics: string[], data: Uint8Array, blockNumber: number, transactionHash: string, logIndex: number, removed: boolean }} Log */

/** @typedef {{ fromBlock: BlockRef, toBlock: BlockRef, address?: string | string[], topics?: (string | null)[] }} LogFilter */

/**
 * @typedef {{
 *   number: number, hash: string, parentHash: string, timestamp: number, gasLimit: number, gasUsed: number,
 *   baseFeePerGas: bigint | null, miner: string, transactions: string[]
 * }} Block
 */

/**
 * @typedef {{
 *   transactionHash: string, blockHash: string, blockNumber: number, status: 0 | 1 | null, gasUsed: number,
 *   effectiveGasPrice: bigint, contractAddress: string | null, logs: Log[]
 * }} Receipt
 */

/**
 * @typedef {object} WaitOptions
 * @property {number} [timeoutMs] default 180000
 * @property {number} [intervalMs] default 2000
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 */

/**
 * Reads answer from the person's node; the last four ask the person. Every method rejects with a ChainError.
 * @typedef {object} Chain
 * @property {'orivon' | 'eip1193'} kind
 * @property {() => Promise<number>} chainId
 * @property {() => Promise<number>} blockNumber
 * @property {(block: BlockRef) => Promise<Block | null>} getBlock
 * @property {(tx: TxRequest, block?: BlockRef, options?: { ccipRead?: false }) => Promise<CallResult>} call a revert is an answer, not an error
 * @property {(filter: LogFilter) => Promise<Log[]>} getLogs refuses a range over 1024 blocks with `limit`
 * @property {(address: string, block?: BlockRef) => Promise<Uint8Array>} getCode
 * @property {(address: string, block?: BlockRef) => Promise<number>} getTransactionCount
 * @property {(tx: TxRequest, block?: BlockRef) => Promise<number>} estimateGas rejects `reverted` for a transaction that would fail
 * @property {() => Promise<bigint>} gasPrice
 * @property {() => Promise<bigint>} maxPriorityFeePerGas
 * @property {(hash: string) => Promise<Receipt | null>} getTransactionReceipt
 * @property {() => Promise<string[]>} addresses asks for the address
 * @property {(message: Uint8Array) => Promise<Uint8Array>} signMessage EIP-191, 65 bytes with v 27 or 28
 * @property {(tx: TxRequest) => Promise<string>} sendTransaction signs, broadcasts, answers the transaction hash
 * @property {(hash: string, options?: WaitOptions) => Promise<Receipt>} waitForReceipt
 */

/** The widest block range one getLogs may cover, counting both ends. */
export const MAX_LOG_SPAN = 1024

const NAMED_BLOCKS = new Set(['latest', 'finalized', 'safe', 'earliest'])

/** @param {number | bigint} value @returns {string} a hex quantity, no leading zeros */
export function quantityHex (value) {
  const number = BigInt(value)
  if (number < 0n) throw new ChainError('invalid', 'a negative quantity')
  return '0x' + number.toString(16)
}

/** @param {unknown} text @returns {bigint} */
export function parseQuantity (text) {
  if (typeof text !== 'string' || !/^0x[0-9a-fA-F]+$/.test(text)) throw new ChainError('badAnswer', 'a quantity that is not hexadecimal')
  return BigInt(text)
}

/** @param {unknown} value @returns {number} */
export function toNumber (value) {
  const number = typeof value === 'number' ? value : Number(parseQuantity(value))
  if (!Number.isSafeInteger(number) || number < 0) throw new ChainError('badAnswer', 'a number past what a page can hold')
  return number
}

/** @param {unknown} text @returns {Uint8Array} */
export function parseBytes (text) {
  if (typeof text !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(text)) throw new ChainError('badAnswer', 'bytes that are not hexadecimal')
  return fromHex(text)
}

/**
 * The spelling both nodes and the Orivon host accept: a tag, or a hex number without leading zeros.
 * @param {BlockRef | undefined} ref
 * @param {boolean} [allowHash] only getBlock takes a block hash
 * @returns {string}
 */
export function blockParam (ref = 'latest', allowHash = false) {
  if (typeof ref === 'number' || typeof ref === 'bigint') return quantityHex(ref)
  if (NAMED_BLOCKS.has(ref)) return ref
  if (/^0x[0-9a-fA-F]{64}$/.test(ref)) {
    if (allowHash) return ref.toLowerCase()
    throw new ChainError('invalid', 'a block hash where only a number or tag is taken')
  }
  if (/^0x[0-9a-fA-F]{1,16}$/.test(ref)) return quantityHex(BigInt(ref))
  throw new ChainError('invalid', `not a block: ${ref}`)
}

/**
 * Refuses a log range that is wider than MAX_LOG_SPAN when both ends are numbers; a range with a tag at an end
 * is left to the node to refuse.
 * @param {LogFilter} filter
 */
export function checkLogSpan (filter) {
  const from = blockParam(filter.fromBlock)
  const to = blockParam(filter.toBlock)
  if (NAMED_BLOCKS.has(from) || NAMED_BLOCKS.has(to)) return
  if (BigInt(to) - BigInt(from) + 1n > BigInt(MAX_LOG_SPAN)) throw new ChainError('limit', `a log range of more than ${MAX_LOG_SPAN} blocks`)
}

/** @param {unknown} value @returns {string[]} */
export function toAddressList (value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [/** @type {string} */ (value)]
}

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Polls until the transaction is mined. A poll that fails because the node is briefly unavailable is tried again
 * until the deadline; any other failure ends the wait.
 * @param {Pick<Chain, 'getTransactionReceipt'>} chain
 * @param {string} hash
 * @param {WaitOptions} [options]
 * @returns {Promise<Receipt>}
 */
export async function pollReceipt (chain, hash, options = {}) {
  const { timeoutMs = 180_000, intervalMs = 2_000, sleep = defaultSleep, now = Date.now } = options
  const deadline = now() + timeoutMs
  for (;;) {
    try {
      const receipt = await chain.getTransactionReceipt(hash)
      if (receipt !== null) return receipt
    } catch (error) {
      if (!(error instanceof ChainError) || (error.reason !== 'unavailable' && error.reason !== 'timeout')) throw error
    }
    if (now() >= deadline) throw new ChainError('timeout', 'the transaction was not mined in time', { hash })
    await sleep(intervalMs)
  }
}

/**
 * Fees for a new transaction: twice the current base fee plus the node's tip, so it stays valid through several
 * full blocks. `null` for a network without a base fee, where the caller sends a gasPrice instead.
 * @param {Pick<Chain, 'getBlock' | 'maxPriorityFeePerGas'>} chain
 * @returns {Promise<{ maxFeePerGas: bigint, maxPriorityFeePerGas: bigint } | null>}
 */
export async function suggestFees (chain) {
  const [block, tip] = await Promise.all([chain.getBlock('latest'), chain.maxPriorityFeePerGas()])
  if (block === null) throw new ChainError('unavailable', 'no latest block')
  if (block.baseFeePerGas === null) return null
  return { maxFeePerGas: block.baseFeePerGas * 2n + tip, maxPriorityFeePerGas: tip }
}
