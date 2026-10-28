// Publishing from the IPFS node this page runs, in Orivon: the node takes the wiki's blocks, dials Orivon's
// node, and the free pinning relay has that node read the wiki from it and keep it on Filebase for FREE_DAYS.
// The bytes leave the browser over IPFS, from the person's own node. Elsewhere, where a page cannot start a
// node, free pinning takes the wiki as an upload (targets.js). When hosting is on, the node is the one
// hosting.js hosts the person's wikis on, and a version it already holds is not handed over again.

import { hosting } from './hosting.js'
import { callNode, connectNode } from './node-link.js'
import { PinningError } from './pinning.js'

/** An address of Orivon's node, as the relay names it: a public IP's TCP port and the node's id. */
const DIAL_ADDRESS = /^\/ip[46]\/[0-9a-fA-F.:]+\/tcp\/\d{1,5}\/p2p\/[1-9A-HJ-NP-Za-km-z]{46,60}$/

/** Whether this page can run its own IPFS node: Orivon, with the editor's grants. */
export function pageNodeAvailable () {
  return typeof window.orivon?.net?.connect === 'function'
}

/** A Kubo-style error answer from the relay, in its own words. @param {Response} response */
export async function relayRefusal (response) {
  const text = await response.text().catch(() => '')
  let said = ''
  try { said = JSON.parse(text)?.Message ?? '' } catch {}
  return new PinningError(response.status === 413 ? 'too-large' : 'refused', said === '' ? `Free pinning refused it (status ${response.status}).` : said)
}

/**
 * Publishes a built site from the page's node and has Orivon keep it.
 * @param {{ endpoint: string, cid: string, car: Uint8Array, signal?: AbortSignal, onStep?: (text: string) => void }} options
 * @returns {Promise<{ cid: string, keptUntil: number | null }>}
 */
export async function publishFromPageNode ({ endpoint, cid, car, signal, onStep = () => {} }) {
  const base = endpoint.replace(/\/+$/, '')
  onStep('Starting your IPFS node, in this page…')
  // The node that hosts the person's wikis, when hosting is on and it can run; otherwise one that only answers the peer dialled here.
  const shared = await hosting.node(signal)
  const node = shared ?? await connectNode(signal ? { signal } : {})
  onStep('Handing the wiki to your IPFS node…')
  if (shared === null || !hosting.holds(cid)) {
    await callNode(node, '/blocks', { method: 'POST', body: car, headers: { 'content-type': 'application/vnd.ipld.car' }, ...(signal ? { signal } : {}) })
    if (shared !== null) hosting.markHeld(cid, car.length)
  }

  onStep('Connecting your node to Orivon\'s node…')
  let orivon
  try {
    const answer = await fetch(`${base}/api/v0/node`, { method: 'POST', ...(signal ? { signal } : {}) })
    if (!answer.ok) throw await relayRefusal(answer)
    orivon = await answer.json()
  } catch (error) {
    if (error instanceof PinningError) throw error
    throw new PinningError('unreachable', 'Could not reach Orivon\'s node. Check your connection and try again.')
  }
  // The node refuses private addresses itself; these are also only what Orivon's node can be reached at.
  const addrs = Array.isArray(orivon?.addrs) ? orivon.addrs.filter((/** @type {unknown} */ a) => typeof a === 'string' && DIAL_ADDRESS.test(a)).slice(0, 8) : []
  let dialed = null
  for (const addr of addrs) {
    try {
      await callNode(node, '/dial', { method: 'POST', body: JSON.stringify({ addr }), headers: { 'content-type': 'application/json' }, ...(signal ? { signal } : {}) })
      dialed = addr
      break
    } catch (error) {
      if (error instanceof PinningError && error.kind === 'aborted') throw error
    }
  }
  if (dialed === null) throw new PinningError('unreachable', 'Your IPFS node could not connect to Orivon\'s node. Check your connection and try again.')

  onStep('Orivon\'s node is reading the wiki from yours…')
  let response
  try {
    response = await fetch(`${base}/api/v0/pin-from?arg=${encodeURIComponent(cid)}&peer=${encodeURIComponent(node.peer)}`, { method: 'POST', ...(signal ? { signal } : {}) })
  } catch {
    if (signal?.aborted) throw new PinningError('aborted', 'The upload was cancelled.')
    throw new PinningError('unreachable', 'Could not reach free pinning. Check your connection and try again.')
  }
  if (!response.ok) throw await relayRefusal(response)
  const line = await response.json()
  const keptUntil = typeof line?.KeptUntil === 'string' ? Date.parse(line.KeptUntil) : NaN
  return { cid: String(line?.Hash ?? ''), keptUntil: Number.isFinite(keptUntil) ? keptUntil : null }
}
