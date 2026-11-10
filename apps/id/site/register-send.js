// The two broadcasters the flow can be given. The Orivon one signs with ETH_0_1 and keeps the signed bytes apart
// from the send, so the flow can store the hash first and a reveal can go to the relay instead of the person's
// own node. A wallet extension signs and sends in one request, so that one knows no hash beforehand.

import { toHex } from './sdk/bytes.js'
import { ChainError, quantityHex, suggestFees } from './sdk/chain.js'
import { fromOrivonError, nonceAfter, noteBroadcast } from './sdk/chain-orivon.js'
import { keccak256 } from './sdk/keccak.js'
import { RelayError } from './relay.js'

/** @typedef {import('./sdk/chain.js').Chain} Chain */
/** @typedef {import('./register-flow.js').Broadcaster} Broadcaster */

/**
 * @param {Chain} chain
 * @returns {Broadcaster}
 */
export function walletBroadcaster (chain) {
  return {
    async prepare (tx) {
      return {
        hash: null,
        async send ({ private: priv }) {
          if (priv) throw new ChainError('invalid', 'this wallet signs and sends in one step, so it cannot send privately')
          return await chain.sendTransaction(tx)
        }
      }
    }
  }
}

/**
 * @param {object} parts
 * @param {{ use: (codes: string[], options?: { groups?: string[] }) => Promise<readonly (Record<string, any> | null)[]> }} parts.orivon the page's `orivon`
 * @param {Chain} parts.chain for the nonce and the fees
 * @param {{ send: (raw: Uint8Array) => Promise<string> }} parts.relay
 * @returns {Broadcaster}
 */
export function orivonBroadcaster ({ orivon, chain, relay }) {
  /** @param {Record<string, any> | null | undefined} handle @param {string} fn @param {unknown[]} args */
  async function invoke (handle, fn, args) {
    if (typeof handle?.[fn] !== 'function') throw new ChainError('declined', `${fn} was not allowed`)
    try {
      return await handle[fn](...args)
    } catch (error) {
      throw fromOrivonError(error, fn)
    }
  }

  return {
    async prepare (tx) {
      let handles
      try {
        handles = await orivon.use(['ETH_0_1', 'ETH_NET_0_1'], { groups: ['addresses', 'sign', 'broadcast'] })
      } catch (error) {
        throw fromOrivonError(error)
      }
      const [eth, net] = handles
      const chainId = await invoke(eth, 'chainId', [])
      const nonce = nonceAfter(orivon, tx.from, await chain.getTransactionCount(tx.from, 'latest'))
      const fees = await suggestFees(chain)
      const price = fees === null ? { gasPrice: quantityHex(await chain.gasPrice()) } : { maxFeePerGas: quantityHex(fees.maxFeePerGas), maxPriorityFeePerGas: quantityHex(fees.maxPriorityFeePerGas) }
      const wire = { from: tx.from, to: tx.to, data: tx.data.slice(), gas: tx.gas, nonce, chainId, ...price }
      const raw = /** @type {Uint8Array} */ (await invoke(eth, 'signTransaction', [wire]))
      const hash = '0x' + toHex(keccak256(raw))
      return {
        hash,
        async send ({ private: priv }) {
          if (priv) {
            try {
              const sent = await relay.send(raw)
              noteBroadcast(orivon, tx.from, nonce)
              return sent
            } catch (error) {
              if (error instanceof RelayError && error.maybeSent) noteBroadcast(orivon, tx.from, nonce)
              throw error
            }
          }
          try {
            const answered = await invoke(net, 'sendRawTransaction', [raw])
            noteBroadcast(orivon, tx.from, nonce)
            if (String(answered).toLowerCase() !== hash) throw new ChainError('badAnswer', 'the node answered another transaction hash', { hash })
          } catch (error) {
            if (error instanceof ChainError && error.reason === 'timeout') {
              noteBroadcast(orivon, tx.from, nonce)
              throw new ChainError('unknownOutcome', 'the broadcast took too long to know whether it went out', { cause: error, hash })
            }
            throw error
          }
          return hash
        }
      }
    }
  }
}
