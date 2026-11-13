// The handles of the page's `orivon`, answered by a node's JSON-RPC and a test key: a stand-in for the browser that lets the
// registration's real send code run against an anvil fork. The shape rules of Orivon's broker are kept by test/support/fake-orivon.ts
// (bytes are Uint8Array, quantities are hex strings, an optional field is absent), so a call the broker would refuse is refused here.
// The wallet signs real EIP-1559 transactions with the key, and `sendRawTransaction` sends the bytes it was given, unchanged.

import { fromHex, toHex } from '../site/sdk/bytes.js'
import { fakeOrivon } from '../test/support/fake-orivon.ts'
import { addressOfKey, signTransaction } from './fork-signer.mjs'

/** A tag a fork has no consensus layer for answers as the latest block. @param {unknown} block */
const tag = (block) => block === 'safe' || block === 'finalized' ? 'latest' : block

/** @param {unknown} value */
const hex = (value) => `0x${BigInt(/** @type {any} */ (value)).toString(16)}`

/**
 * @param {string} url the node's JSON-RPC URL
 * @param {string} method
 * @param {unknown[]} params
 */
export async function rpc (url, method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = /** @type {{ result?: unknown, error?: { code: number, message: string, data?: unknown } }} */ (await response.json())
  if (body.error !== undefined) throw Object.assign(new Error(body.error.message), { rpcCode: body.error.code, data: body.error.data })
  return body.result
}

/** @param {Record<string, any>} tx the wire form a handle takes */
function toRpcTx (tx) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of ['from', 'to', 'value', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) if (tx[key] !== undefined) out[key] = tx[key]
  for (const key of ['gas', 'nonce', 'chainId']) if (tx[key] !== undefined) out[key] = hex(tx[key])
  if (tx['data'] !== undefined) out['data'] = `0x${toHex(tx['data'])}`
  return out
}

/** @param {any} log */
const logOf = (log) => ({
  address: log.address, topics: log.topics, data: fromHex(log.data.slice(2)), blockNumber: Number(log.blockNumber),
  transactionHash: log.transactionHash, logIndex: Number(log.logIndex), removed: log.removed === true
})

/**
 * The page's `orivon`, answered by a node and signing with `key`.
 * @param {object} parts
 * @param {string} parts.url the node's JSON-RPC URL
 * @param {Uint8Array} parts.key the wallet's private key
 * @param {boolean} [parts.series] whether the wallet signs a whole series with one confirmation (`signTransactions`)
 * @param {(index: number, raw: Uint8Array) => Promise<void> | void} [parts.beforeSend] runs before the nth raw transaction is sent to the node
 * @param {{ signed: number, confirmations: number, sent: string[] }} [parts.counts] filled in as the wallet is used
 */
export function forkOrivon ({ url, key, series = true, beforeSend, counts = { signed: 0, confirmations: 0, sent: [] } }) {
  const account = addressOfKey(key)
  const ask = (/** @type {string} */ method, /** @type {unknown[]} */ ...params) => rpc(url, method, params)

  async function fees () {
    const [block, tip] = await Promise.all([ask('eth_getBlockByNumber', 'latest', false), ask('eth_maxPriorityFeePerGas')])
    const base = BigInt(/** @type {any} */ (block).baseFeePerGas)
    return { maxPriorityFeePerGas: BigInt(/** @type {string} */ (tip)), maxFeePerGas: base * 2n + BigInt(/** @type {string} */ (tip)) }
  }

  /** @param {Record<string, any>} tx @param {number} nonce */
  async function sign (tx, nonce) {
    const price = tx['maxFeePerGas'] === undefined ? await fees() : { maxFeePerGas: BigInt(tx['maxFeePerGas']), maxPriorityFeePerGas: BigInt(tx['maxPriorityFeePerGas']) }
    counts.signed++
    return signTransaction(key, {
      chainId: tx['chainId'], nonce, ...price, gas: tx['gas'], to: tx['to'], value: tx['value'] === undefined ? 0n : BigInt(tx['value']), data: tx['data']
    })
  }

  /** @type {Record<string, (...args: any[]) => unknown>} */
  const answers = {
    chainId: async () => Number(await ask('eth_chainId')),
    blockNumber: async () => Number(await ask('eth_blockNumber')),
    getBlock: async (block) => {
      const found = /** @type {any} */ (await ask('eth_getBlockByNumber', tag(block), false))
      return {
        number: Number(found.number), hash: found.hash, parentHash: found.parentHash, timestamp: Number(found.timestamp), gasLimit: Number(found.gasLimit),
        gasUsed: Number(found.gasUsed), miner: found.miner, transactions: found.transactions, baseFeePerGas: found.baseFeePerGas ?? null
      }
    },
    call: async (tx, block) => {
      try {
        return { data: fromHex(/** @type {string} */ (await ask('eth_call', toRpcTx(tx), tag(block))).slice(2)), revert: null, offchainLookup: null }
      } catch (error) {
        const data = /** @type {any} */ (error).data
        if (/** @type {any} */ (error).rpcCode === 3 || /revert/i.test(String(/** @type {Error} */ (error).message))) {
          return { data: null, revert: typeof data === 'string' ? fromHex(data.slice(2)) : new Uint8Array(0), offchainLookup: null }
        }
        throw Object.assign(new Error(String(/** @type {Error} */ (error).message)), { code: 'unavailable' })
      }
    },
    getLogs: async (filter) => (/** @type {any[]} */ (await ask('eth_getLogs', { ...filter, fromBlock: tag(filter.fromBlock), toBlock: tag(filter.toBlock) }))).map(logOf),
    getCode: async (address, block) => fromHex(/** @type {string} */ (await ask('eth_getCode', address, tag(block))).slice(2)),
    getStorageAt: async (address, slot, block) => fromHex(/** @type {string} */ (await ask('eth_getStorageAt', address, slot, tag(block))).slice(2).padStart(64, '0')),
    getTransactionCount: async (address, block) => Number(await ask('eth_getTransactionCount', address, tag(block))),
    estimateGas: async (tx, block) => {
      try {
        return Number(await ask('eth_estimateGas', toRpcTx(tx), tag(block)))
      } catch (error) {
        throw Object.assign(new Error(String(/** @type {Error} */ (error).message)), { code: 'invalid' })
      }
    },
    gasPrice: () => ask('eth_gasPrice'),
    maxPriorityFeePerGas: () => ask('eth_maxPriorityFeePerGas'),
    getTransactionReceipt: async (hash) => {
      const found = /** @type {any} */ (await ask('eth_getTransactionReceipt', hash))
      if (found === null) return null
      return {
        transactionHash: found.transactionHash, blockHash: found.blockHash, blockNumber: Number(found.blockNumber), status: Number(found.status),
        gasUsed: Number(found.gasUsed), effectiveGasPrice: found.effectiveGasPrice, contractAddress: found.contractAddress ?? null, logs: found.logs.map(logOf)
      }
    },
    getAddresses: () => [account],
    signTransaction: async (tx) => {
      counts.confirmations++
      return await sign(tx, tx['nonce'])
    },
    signTransactions: async (txs) => {
      counts.confirmations++
      const first = Number(await ask('eth_getTransactionCount', account, 'pending'))
      return await Promise.all(txs.map((tx, index) => sign(tx, first + index)))
    },
    sendRawTransaction: async (raw) => {
      await beforeSend?.(counts.sent.length, raw)
      const hash = /** @type {string} */ (await ask('eth_sendRawTransaction', `0x${toHex(raw)}`))
      counts.sent.push(hash)
      return hash
    }
  }
  const fake = fakeOrivon(answers, [], { plan: series })
  return { ...fake, account, counts, ask }
}
