// The Chain over an EIP-1193 provider: `window.ethereum` in a browser that is not Orivon, and in the tests
// a provider that forwards to a JSON-RPC node. The wallet fills the nonce, gas and fees of a transaction and
// broadcasts what it signs, so `sendTransaction` is one request here.

import { toHex } from './bytes.js'
import {
  blockParam, ChainError, checkLogSpan, parseBytes, parseQuantity, pollReceipt, quantityHex, toAddressList, toNumber
} from './chain.js'

/** @typedef {import('./chain.js').Chain} Chain */
/** @typedef {import('./chain.js').TxRequest} TxRequest */
/** @typedef {{ request: (args: { method: string, params?: unknown[] }) => Promise<unknown> }} Eip1193Provider */

const OFFCHAIN_LOOKUP = '556f1830'

/**
 * EIP-1193 and JSON-RPC error codes, as a wallet or a node reports them.
 * @param {unknown} error
 * @param {string} [fn]
 */
export function fromProviderError (error, fn = '') {
  if (error instanceof ChainError) return error
  const code = typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : NaN
  const message = error instanceof Error ? error.message : String(/** @type {{ message?: unknown }} */ (error)?.message ?? 'the provider refused')
  const cause = { cause: error }
  if (code === 4001 || code === 4100) return new ChainError('declined', message, cause)
  if (code === 4900 || code === 4901) return new ChainError('unavailable', message, cause)
  if (code === -32005 || (fn === 'getLogs' && /range|limit|too many|exceed/i.test(message))) return new ChainError('limit', message, cause)
  if (fn === 'estimateGas' && (code === 3 || /revert|gas required exceeds/i.test(message))) return new ChainError('reverted', message, cause)
  if (code === 4200 || code === -32601 || code === -32602 || code === -32000) return new ChainError('invalid', message, cause)
  return new ChainError('unavailable', message, cause)
}

/** The revert data a node attached to a failed eth_call, wherever the node put it. @param {any} error @returns {Uint8Array | null} */
function revertData (error) {
  const found = [error?.data, error?.data?.data, error?.error?.data, error?.data?.originalError?.data]
    .find((candidate) => typeof candidate === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(candidate))
  if (found !== undefined) return parseBytes(found)
  return error?.code === 3 || /execution reverted/i.test(String(error?.message)) ? new Uint8Array(0) : null
}

/** @param {TxRequest} tx */
function wireTx (tx) {
  /** @type {Record<string, unknown>} */
  const out = {}
  if (tx.from !== undefined) out['from'] = tx.from
  if (tx.to !== undefined) out['to'] = tx.to
  if (tx.data !== undefined) out['data'] = '0x' + toHex(tx.data)
  if (tx.gas !== undefined) out['gas'] = quantityHex(tx.gas)
  if (tx.nonce !== undefined) out['nonce'] = quantityHex(tx.nonce)
  for (const key of ['value', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
    const value = /** @type {Record<string, bigint | undefined>} */ (tx)[key]
    if (value !== undefined) out[key] = quantityHex(value)
  }
  return out
}

/** @param {any} raw @returns {import('./chain.js').Log} */
function logOf (raw) {
  return {
    address: raw.address, topics: [...raw.topics], data: parseBytes(raw.data), blockNumber: toNumber(raw.blockNumber),
    transactionHash: raw.transactionHash, logIndex: toNumber(raw.logIndex), removed: raw.removed === true
  }
}

/** @param {any} raw @returns {import('./chain.js').Block | null} */
function blockOf (raw) {
  if (raw === null || raw === undefined) return null
  return {
    number: toNumber(raw.number), hash: raw.hash, parentHash: raw.parentHash, timestamp: toNumber(raw.timestamp),
    gasLimit: toNumber(raw.gasLimit), gasUsed: toNumber(raw.gasUsed), miner: raw.miner,
    baseFeePerGas: raw.baseFeePerGas === undefined || raw.baseFeePerGas === null ? null : parseQuantity(raw.baseFeePerGas),
    transactions: raw.transactions.map((/** @type {any} */ tx) => typeof tx === 'string' ? tx : tx.hash)
  }
}

/** @param {any} raw @returns {import('./chain.js').Receipt | null} */
function receiptOf (raw) {
  if (raw === null || raw === undefined) return null
  return {
    transactionHash: raw.transactionHash, blockHash: raw.blockHash, blockNumber: toNumber(raw.blockNumber),
    status: raw.status === undefined || raw.status === null ? null : /** @type {0 | 1} */ (toNumber(raw.status)),
    gasUsed: toNumber(raw.gasUsed), effectiveGasPrice: parseQuantity(raw.effectiveGasPrice ?? '0x0'),
    contractAddress: raw.contractAddress ?? null, logs: raw.logs.map(logOf)
  }
}

/** Wallets answer v as 27 or 28, and some as 0 or 1. @param {Uint8Array} signature */
function normalizeV (signature) {
  if (signature.length !== 65) throw new ChainError('badAnswer', 'a signature that is not 65 bytes')
  const out = signature.slice()
  if (out[64] === 0 || out[64] === 1) out[64] += 27
  return out
}

/**
 * @param {Eip1193Provider} provider
 * @returns {Chain}
 */
export function eip1193Chain (provider) {
  async function ask (/** @type {string} */ method, /** @type {unknown[]} */ params = [], /** @type {string} */ fn = method) {
    try {
      return await provider.request({ method, params })
    } catch (error) {
      throw fromProviderError(error, fn)
    }
  }

  async function addresses () {
    let list
    try {
      list = await provider.request({ method: 'eth_requestAccounts', params: [] })
    } catch (error) {
      if (/** @type {{ code?: unknown }} */ (error)?.code !== -32601) throw fromProviderError(error)
      list = await ask('eth_accounts')
    }
    if (!Array.isArray(list)) throw new ChainError('badAnswer', 'accounts are not a list')
    return /** @type {string[]} */ (list)
  }

  /** @type {Chain} */
  const chain = {
    kind: 'eip1193',
    chainId: async () => toNumber(await ask('eth_chainId')),
    blockNumber: async () => toNumber(await ask('eth_blockNumber')),
    getBlock: async (ref) => {
      const param = blockParam(ref, true)
      return blockOf(param.length === 66 ? await ask('eth_getBlockByHash', [param, false]) : await ask('eth_getBlockByNumber', [param, false]))
    },
    call: async (tx, ref) => {
      try {
        const result = await provider.request({ method: 'eth_call', params: [wireTx(tx), blockParam(ref)] })
        return { data: parseBytes(result), revert: null, offchainLookup: null }
      } catch (error) {
        const revert = revertData(error)
        if (revert === null) throw fromProviderError(error, 'call')
        if (toHex(revert.subarray(0, 4)) === OFFCHAIN_LOOKUP) return { data: null, revert: null, offchainLookup: revert }
        return { data: null, revert, offchainLookup: null }
      }
    },
    getLogs: async (filter) => {
      checkLogSpan(filter)
      const address = toAddressList(filter.address)
      const logs = await ask('eth_getLogs', [{
        fromBlock: blockParam(filter.fromBlock), toBlock: blockParam(filter.toBlock),
        ...(address.length === 0 ? {} : { address }), ...(filter.topics === undefined ? {} : { topics: filter.topics })
      }], 'getLogs')
      if (!Array.isArray(logs)) throw new ChainError('badAnswer', 'logs are not a list')
      return logs.map(logOf)
    },
    getCode: async (address, ref) => parseBytes(await ask('eth_getCode', [address, blockParam(ref)])),
    getStorageAt: async (address, slot, ref) => parseBytes(await ask('eth_getStorageAt', [address, slot, blockParam(ref)])),
    getTransactionCount: async (address, ref) => toNumber(await ask('eth_getTransactionCount', [address, blockParam(ref)])),
    estimateGas: async (tx, ref) => toNumber(await ask('eth_estimateGas', [wireTx(tx), blockParam(ref)], 'estimateGas')),
    gasPrice: async () => parseQuantity(await ask('eth_gasPrice')),
    maxPriorityFeePerGas: async () => parseQuantity(await ask('eth_maxPriorityFeePerGas')),
    getTransactionReceipt: async (hash) => receiptOf(await ask('eth_getTransactionReceipt', [hash])),
    addresses,
    signMessage: async (message) => {
      const [address] = await addresses()
      if (address === undefined) throw new ChainError('declined', 'no address was given')
      return normalizeV(parseBytes(await ask('personal_sign', ['0x' + toHex(message), address])))
    },
    sendTransaction: async (tx) => {
      const from = tx.from ?? (await addresses())[0]
      if (from === undefined) throw new ChainError('declined', 'no address was given')
      const hash = await ask('eth_sendTransaction', [wireTx({ ...tx, from })])
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ChainError('badAnswer', 'the wallet answered no transaction hash')
      return hash.toLowerCase()
    },
    waitForReceipt: async (hash, options) => await pollReceipt(chain, hash, options)
  }
  return chain
}
