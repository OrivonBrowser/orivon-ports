// What the node says when a call fails, as the kubo error pkc-js reads: the node's own words when it has them, and
// the words kubo uses where pkc-js matches on them.

import { NodeError } from './node-client.js'
import { KuboError } from './wire.js'

/**
 * @param {unknown} error
 * @param {{ notFound?: string }} [words] what a 404 is called, when the node's text does not say
 */
export function fromNode (error, words = {}) {
  if (!(error instanceof NodeError)) return error
  if (error.status === 404 && words.notFound !== undefined) return new KuboError(words.notFound)
  if (error.status === 504) return new KuboError(`context deadline exceeded: ${error.text}`)
  return new KuboError(error.text === '' ? error.message : error.text)
}

/**
 * Runs a call to the node and raises what fails as a KuboError.
 * @template T @param {() => Promise<T>} call @param {{ notFound?: string }} [words]
 * @returns {Promise<T>}
 */
export async function viaNode (call, words) {
  try {
    return await call()
  } catch (error) {
    throw fromNode(error, words)
  }
}
