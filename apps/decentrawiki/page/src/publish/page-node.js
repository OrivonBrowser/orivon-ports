// Publishing from the IPFS node this page runs, in Orivon: the node takes the wiki's blocks, dials Orivon's
// node, and the free pinning relay has that node read the wiki from it and keep it on Filebase for FREE_DAYS.
// The bytes leave the browser over IPFS, from the person's own node. Elsewhere, where a page cannot start a
// node, or in Orivon with hosting off, free pinning takes the wiki as an upload (targets.js). When hosting is
// on, the node is the one hosting.js hosts the person's wikis on, and a version it already holds is not handed
// over again. The two switches Settings offers, hosting and free pinning, are read and saved here.

import * as store from '../store.js'
import { hosting } from './hosting.js'
import { callNode, connectNode } from './node-link.js'
import { PinningError } from './pinning.js'

/** An address of Orivon's node, as the relay names it: a public IP's TCP port and the node's id. */
const DIAL_ADDRESS = /^\/ip[46]\/[0-9a-fA-F.:]+\/tcp\/\d{1,5}\/p2p\/[1-9A-HJ-NP-Za-km-z]{46,60}$/

/** Whether free pinning is on when the person has not chosen. Provisional: the project decides, and this is the one place it is set. */
export const FREE_PINNING_DEFAULT = true

/** Whether this page can run its own IPFS node: Orivon, with the editor's grants. */
export function pageNodeAvailable () {
  return typeof window.orivon?.net?.connect === 'function'
}

/** Whether the wikis are hosted from this computer: Settings' first switch, on unless the person turned it off, and only where the page can run a node that listens (hosting.js has the default). */
export async function hostingOn () {
  return await hosting.enabled()
}

/** The changes to the first switch, one after the other: turning it off waits for the node to end, and a turn-on that began meanwhile would take that node and lose it. @type {Promise<void>} */
let switching = Promise.resolve()

/** Saves the first switch. Turning it on gives the node the stored versions at once; turning it off takes back every announcement and ends the node this page started. @param {boolean} on @returns {Promise<void>} */
export function setHosting (on) {
  const turned = switching.then(async () => {
    await store.setSetting('hostWikis', on === true)
    if (on === true) void hosting.resume()
    else await hosting.stop()
  })
  switching = turned.catch(() => {})
  return turned
}

/**
 * Hosts a version for a publish that stands or falls with it, the one only this computer hosts. When the node does
 * not take the version, or the publish is cancelled meanwhile, the wiki's kept version goes back to what it was and
 * is announced again, so the editor does not announce on its next load a version the person was told was not
 * published. Answers whether the node took it and the publish goes on. Never throws.
 * @param {string} wikiId @param {string} cid @param {Uint8Array | Blob} car @param {AbortSignal} [signal]
 */
export async function hostOrRevert (wikiId, cid, car, signal) {
  const previous = await store.getHosted(wikiId).catch(() => undefined)
  if (await hosting.host(wikiId, cid, car) && signal?.aborted !== true) return true
  try {
    await hosting.forget(wikiId, cid)
    if (previous === undefined) await store.deleteHosted(wikiId)
    else {
      await store.putHosted(previous)
      void hosting.resume()
    }
  } catch {
    // The version stays kept: the next load announces it, as it does for a wiki pinned elsewhere.
  }
  return false
}

/** Whether Publish offers Orivon's free pinning: Settings' second switch, on unless the person turned it off. */
export async function freePinningOn () {
  return await store.getSetting('freePinning', FREE_PINNING_DEFAULT) !== false
}

/** Saves the second switch. @param {boolean} on */
export async function setFreePinning (on) {
  await store.setSetting('freePinning', on === true)
}

/** A Kubo-style error answer from the relay, in its own words. @param {Response} response */
export async function relayRefusal (response) {
  const text = await response.text().catch(() => '')
  let said = ''
  try { said = JSON.parse(text)?.Message ?? '' } catch {}
  return new PinningError(response.status === 413 ? 'too-large' : 'refused', said === '' ? `Free pinning refused it (status ${response.status}).` : said)
}

/**
 * Connects the page's node to Orivon's node, so that Orivon's node can read from it: it asks free pinning where
 * Orivon's node is, and has its own node dial an address it answers.
 * @param {{ base: string, node: import('./node-link.js').Node, signal?: AbortSignal, onStep?: (text: string) => void }} options
 */
async function connectToOrivon ({ base, node, signal, onStep = () => {} }) {
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
}

/**
 * For a version hosted from this computer and pinned somewhere else, or nowhere: connects the page's node to Orivon's
 * node and answers the node's id, which the request to keep the wiki's address names so that Orivon's node reads the
 * version from it, instead of waiting for the IPFS network to find it. Never throws: null when hosting runs no node
 * or Orivon's node could not be reached, and the address is then kept from what the network finds.
 * @param {{ endpoint: string, signal?: AbortSignal }} options
 * @returns {Promise<string | null>}
 */
export async function offerNodeToOrivon ({ endpoint, signal }) {
  const node = await hosting.node(signal)
  if (node === null) return null
  try {
    await connectToOrivon({ base: endpoint.replace(/\/+$/, ''), node, ...(signal ? { signal } : {}) })
  } catch {
    // The request is still sent, with the id: Kubo may already be connected to this node.
  }
  return node.peer
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

  await connectToOrivon({ base, node, onStep, ...(signal ? { signal } : {}) })

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
