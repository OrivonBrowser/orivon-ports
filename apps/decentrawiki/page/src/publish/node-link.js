// The page's link to the IPFS node it runs in Orivon: loading the one bundled launcher, the key every tab of this
// editor shares with the node, starting or joining the node, and a call to its local API with a refusal said in
// words. Publishing from the node (page-node.js) and hosting wikis on it (hosting.js) both go through here, so
// the editor has one node however many things use it.

import * as store from '../store.js'
import { PinningError } from './pinning.js'

const LOADING = 'Your IPFS node could not be loaded.'

/**
 * @typedef {{ start: (o: { key: string, port: number | null, signal?: AbortSignal, listen?: boolean }) => Promise<{ base: string, peer: string, port: number }>, stop?: (port: number) => Promise<boolean> }} Launcher
 * @typedef {{ base: string, key: string, peer: string, port: number }} Node
 */

/** Loads node-launch.js, the one bundled file, once. @returns {Promise<Launcher>} */
export function loadLauncher () {
  if (globalThis.decentrawikiNode) return Promise.resolve(globalThis.decentrawikiNode)
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = new URL('../../node-launch.js', import.meta.url).href
    script.onload = () => globalThis.decentrawikiNode ? resolve(globalThis.decentrawikiNode) : reject(new PinningError('unreachable', LOADING))
    script.onerror = () => reject(new PinningError('unreachable', LOADING))
    document.head.append(script)
  })
}

/** The key every tab of this editor shares with the node, made once. */
export async function nodeKey () {
  const saved = await store.getSetting('nodeKey', null)
  if (typeof saved === 'string' && /^[0-9a-f]{64}$/.test(saved)) return saved
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  await store.setSetting('nodeKey', key)
  return key
}

/**
 * Starts the editor's node, or joins one a tab of the editor started, on the port this editor last used.
 * @param {{ launcher?: () => Promise<Launcher>, signal?: AbortSignal, listen?: boolean }} [options] `listen`: the node is to host wikis, not only to answer the peer the page dials
 * @returns {Promise<Node>}
 */
export async function connectNode ({ launcher = loadLauncher, signal, listen = false } = {}) {
  const key = await nodeKey()
  try {
    const started = await (await launcher()).start({ key, port: await store.getSetting('nodePort', null), listen, ...(signal ? { signal } : {}) })
    await store.setSetting('nodePort', started.port)
    return { base: started.base, key, peer: started.peer, port: started.port }
  } catch (error) {
    if (signal?.aborted) throw new PinningError('aborted', 'The upload was cancelled.')
    throw error instanceof PinningError ? error : new PinningError('unreachable', error instanceof Error ? error.message : String(error))
  }
}

/**
 * A call to the node's local API; its refusal said in words.
 * @param {{ base: string, key: string }} node @param {string} path @param {RequestInit} [init]
 * @returns {Promise<{ response: Response, body: any }>} `body` is the parsed JSON answer, `{}` when there is none (/health answers plain text)
 */
export async function callNode (node, path, init = {}) {
  let response
  try {
    response = await fetch(`${node.base}${path}`, { ...init, headers: { ...(init.headers ?? {}), 'x-orivon-key': node.key } })
  } catch {
    if (init.signal?.aborted) throw new PinningError('aborted', 'The upload was cancelled.')
    throw new PinningError('unreachable', 'Your IPFS node stopped answering. Try again.')
  }
  const text = await response.text()
  if (!response.ok) throw new PinningError(response.status === 507 ? 'too-large' : 'refused', `Your IPFS node refused it: ${text.trim().slice(0, 200) || `status ${response.status}`}`)
  /** @type {any} */
  let body = {}
  try { body = text === '' ? {} : JSON.parse(text) } catch { /* plain text */ }
  return { response, body }
}
