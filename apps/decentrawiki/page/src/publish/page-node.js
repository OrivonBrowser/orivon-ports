// Publishing from the IPFS node this page runs, in Orivon: the node takes the wiki's blocks, dials Orivon's
// node, and the free pinning relay has that node read the wiki from it and keep it on Filebase for FREE_DAYS.
// The bytes leave the browser over IPFS, from the person's own node. Elsewhere, where a page cannot start a
// node, or in Orivon when Settings chose the upload (publishFromNode false), free pinning takes the wiki as an
// upload (targets.js).

import * as store from '../store.js'
import { PinningError } from './pinning.js'

/** An address of Orivon's node, as the relay names it: a public IP's TCP port and the node's id. */
const DIAL_ADDRESS = /^\/ip[46]\/[0-9a-fA-F.:]+\/tcp\/\d{1,5}\/p2p\/[1-9A-HJ-NP-Za-km-z]{46,60}$/

/** Whether this page can run its own IPFS node: Orivon, with the editor's grants. */
export function pageNodeAvailable () {
  return typeof window.orivon?.net?.connect === 'function'
}

/** Whether free pinning publishes from the page's node: in Orivon, unless Settings chose the upload. */
export async function freeFromPageNode () {
  return pageNodeAvailable() && (await store.getSetting('publishFromNode', true)) !== false
}

/** Saves the choice Settings offers: the page's node (true) or an upload to Orivon's server (false). @param {boolean} on */
export async function setFreeFromPageNode (on) {
  await store.setSetting('publishFromNode', on === true)
}

/** Loads node-launch.js, the one bundled file, once. @returns {Promise<{ start: (o: { key: string, port: number | null, signal?: AbortSignal }) => Promise<{ base: string, peer: string, port: number }> }>} */
function launcher () {
  if (globalThis.decentrawikiNode) return Promise.resolve(globalThis.decentrawikiNode)
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = new URL('../../node-launch.js', import.meta.url).href
    script.onload = () => globalThis.decentrawikiNode ? resolve(globalThis.decentrawikiNode) : reject(new PinningError('unreachable', 'Your IPFS node could not be loaded.'))
    script.onerror = () => reject(new PinningError('unreachable', 'Your IPFS node could not be loaded.'))
    document.head.append(script)
  })
}

/** The key every tab of this editor shares with the node, made once. */
async function nodeKey () {
  const saved = await store.getSetting('nodeKey', null)
  if (typeof saved === 'string' && /^[0-9a-f]{64}$/.test(saved)) return saved
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  await store.setSetting('nodeKey', key)
  return key
}

/** A call to the page's node; its refusal said in words. @param {{ base: string }} node @param {string} key @param {string} path @param {RequestInit} init */
async function call (node, key, path, init = {}) {
  let response
  try {
    response = await fetch(`${node.base}${path}`, { ...init, headers: { ...(init.headers ?? {}), 'x-orivon-key': key } })
  } catch (error) {
    if (init.signal?.aborted) throw new PinningError('aborted', 'The upload was cancelled.')
    throw new PinningError('unreachable', 'Your IPFS node stopped answering. Try again.')
  }
  const text = await response.text()
  if (!response.ok) throw new PinningError('refused', `Your IPFS node refused it: ${text.trim().slice(0, 200) || `status ${response.status}`}`)
  return text === '' ? {} : JSON.parse(text)
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
  const key = await nodeKey()
  let node
  try {
    node = await (await launcher()).start({ key, port: await store.getSetting('nodePort', null), ...(signal ? { signal } : {}) })
    await store.setSetting('nodePort', node.port)
  } catch (error) {
    if (signal?.aborted) throw new PinningError('aborted', 'The upload was cancelled.')
    throw error instanceof PinningError ? error : new PinningError('unreachable', error instanceof Error ? error.message : String(error))
  }
  onStep('Handing the wiki to your IPFS node…')
  await call(node, key, '/blocks', { method: 'POST', body: car, headers: { 'content-type': 'application/vnd.ipld.car' }, ...(signal ? { signal } : {}) })

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
      await call(node, key, '/dial', { method: 'POST', body: JSON.stringify({ addr }), headers: { 'content-type': 'application/json' }, ...(signal ? { signal } : {}) })
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
