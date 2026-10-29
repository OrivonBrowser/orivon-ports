// The page's link to the IPFS node it runs in Orivon: loading the one bundled launcher, the key every tab of this
// editor shares with the node, starting or joining the node, and a call to its local API with a refusal said in
// words. Publishing from the node (page-node.js) and hosting wikis on it (hosting.js) both go through here, so
// the editor has one node however many things use it.

import * as store from '../store.js'
import { PinningError } from './pinning.js'

const LOADING = 'Your IPFS node could not be loaded.'
const KEY_SHAPE = /^[0-9a-f]{64}$/

/**
 * @typedef {{ start: (o: { key: string, port: number | null, signal?: AbortSignal, listen?: boolean }) => Promise<{ base: string, peer: string, port: number }>, find?: (o: { key: string, port: number | null }) => Promise<{ base: string, peer: string, port: number } | null>, stop?: (port: number) => Promise<boolean>, owns?: (port: number) => boolean }} Launcher
 * @typedef {{ base: string, key: string, peer: string, port: number }} Node
 */

/**
 * Whether this page can start the node now: Orivon's `net.connect`, and `process`, the Node global the launcher
 * spawns the node through. Orivon gives a page the Node globals only once the tab runs as the app, so they are the
 * sign that the editor has been let in. A first visit loads the page as an ordinary website while Orivon asks: every
 * `window.orivon` member is there and refuses, `process` is not, and Allow reloads the tab as the app, which runs the
 * page again from its start.
 */
export function canRunNode () {
  const page = globalThis.window
  return typeof page?.orivon?.net?.connect === 'function' && typeof page.process !== 'undefined'
}

/**
 * Whether the page is in Orivon without its network access: `window.orivon` is an object with no `net.connect`. When
 * Orivon cannot install its full surface in the main world it exposes a fail-closed `window.orivon` instead: every member
 * refuses, `net` holds only `lookup`, and `app.grants()` refuses, so the page can read from it neither a grant nor a first
 * visit. Another browser has no `window.orivon` at all.
 */
function orivonWithoutNetwork () {
  const orivon = globalThis.window?.orivon
  return typeof orivon === 'object' && orivon !== null && typeof orivon.net?.connect !== 'function'
}

/**
 * Whether Orivon has let the editor in while this tab has none of the Node globals: Orivon installs them fail-open, so
 * a tab that runs as the app can lack them. A first visit's website tells itself apart by what `orivon.app.grants()`
 * reports: no network grant until the person has answered, and a refused or failing call is the same. @returns {Promise<boolean>}
 */
async function grantedWithoutNodeGlobals () {
  const page = globalThis.window
  if (typeof page?.orivon?.net?.connect !== 'function' || typeof page.process !== 'undefined' || typeof page.orivon.app?.grants !== 'function') return false
  try {
    const grants = await page.orivon.app.grants()
    return Array.isArray(grants) && grants.some((grant) => grant?.capability === 'tcp.connect')
  } catch {
    return false
  }
}

/** What a report says of a tab that is in Orivon but cannot run the node, by what `blockedTab` answers. */
export const BLOCKED_LINES = {
  globals: 'could not start the IPFS node: Orivon let the editor in, but this tab loaded without the Node globals the node starts through',
  network: 'could not start the IPFS node: Orivon did not give this tab the network access the node needs (window.orivon has no net.connect)'
}

/**
 * What keeps a tab that is in Orivon from running the node: 'network' (Orivon's fail-closed `window.orivon`) or 'globals' (the
 * editor let in, no Node globals), else null: a page in another browser, a first visit's website, or a tab that can run it.
 * The two are exclusive, because the second needs `net.connect` and the first has none.
 * @returns {Promise<'globals' | 'network' | null>}
 */
export async function blockedTab () {
  if (orivonWithoutNetwork()) return 'network'
  return await grantedWithoutNodeGlobals() ? 'globals' : null
}

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
  if (typeof saved === 'string' && KEY_SHAPE.test(saved)) return saved
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  await store.setSetting('nodeKey', key)
  return key
}

/**
 * Starts the editor's node, or joins one a tab of the editor started, on the port this editor last used.
 * @param {{ launcher?: () => Promise<Launcher>, signal?: AbortSignal, listen?: boolean, port?: number }} [options] `listen`: the node is to host wikis, not only to answer the peer the page dials; `port`: where to look first instead of the port the editor last used
 * @returns {Promise<Node>}
 */
export async function connectNode ({ launcher = loadLauncher, signal, listen = false, port } = {}) {
  const key = await nodeKey()
  try {
    const started = await (await launcher()).start({ key, port: port ?? await store.getSetting('nodePort', null), listen, ...(signal ? { signal } : {}) })
    await store.setSetting('nodePort', started.port)
    return { base: started.base, key, peer: started.peer, port: started.port }
  } catch (error) {
    if (signal?.aborted) throw new PinningError('aborted', 'The upload was cancelled.')
    throw error instanceof PinningError ? error : new PinningError('unreachable', error instanceof Error ? error.message : String(error))
  }
}

/**
 * The editor's node as some tab of it left it, found on the port the editor last used without starting one; null when
 * none answers, or when this editor has never made a key.
 * @param {{ launcher?: () => Promise<Launcher> }} [options]
 * @returns {Promise<Node | null>}
 */
export async function findNode ({ launcher = loadLauncher } = {}) {
  const key = await store.getSetting('nodeKey', null)
  if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return null
  const found = await (await launcher()).find?.({ key, port: await store.getSetting('nodePort', null) })
  return found ? { base: found.base, key, peer: found.peer, port: found.port } : null
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
