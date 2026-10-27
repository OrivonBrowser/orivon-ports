// The parts of Share that live as long as the page: the kept shares, the trackers' sockets, the page's IPFS node and
// what is being served. Made on first use; the engine and the publish and receive code share the one made here.

import { createKeep } from './keep/store.js'
import { openBackend } from './keep/backends.js'
import { createNodeProvider, pageNodeAvailable } from './node/provide.js'
import { createServing } from './serve/manager.js'
import { randomPeerId } from './serve/ids.js'
import { createTrackerHub } from './serve/tracker.js'

/**
 * @typedef {object} Runtime
 * @property {ReturnType<typeof createKeep>} keep
 * @property {ReturnType<typeof createServing>} serving
 * @property {ReturnType<typeof createTrackerHub>} hub
 * @property {boolean} supported whether this page can serve over WebRTC at all
 * @property {{ durable: boolean, kind: string }} storage
 */

/** @type {Promise<Runtime> | null} */
let made = null
/** @type {Runtime | null} */
let current = null
/** @type {((runtime: Runtime) => void)[]} */
const hooks = []

/** @param {Runtime} runtime */
function wire (runtime) {
  current = runtime
  for (const hook of hooks) hook(runtime)
}

/** @param {Runtime} runtime The runtime the rest of Share uses; a test hands in its own. */
export function useRuntime (runtime) {
  made = Promise.resolve(runtime)
  wire(runtime)
}

/** The runtime, if it has been made; never makes it. */
export function currentRuntime () {
  return current
}

/** Runs `hook` with the runtime once it exists (at once if it does). @param {(runtime: Runtime) => void} hook */
export function onRuntime (hook) {
  hooks.push(hook)
  if (current !== null) hook(current)
}

/** @returns {Promise<Runtime>} */
export function getRuntime () {
  made ??= (async () => {
    const backend = await openBackend()
    const keep = createKeep(backend)
    const supported = typeof WebSocket === 'function' && typeof RTCPeerConnection === 'function'
    const hub = createTrackerHub({ peerId: randomPeerId() })
    const node = pageNodeAvailable() ? createNodeProvider({ keep }) : null
    const serving = createServing({ keep, hub, node, supported })
    /** @type {Runtime} */
    const runtime = { keep, serving, hub, supported, storage: { durable: backend.durable, kind: backend.kind } }
    wire(runtime)
    return runtime
  })()
  return made
}
