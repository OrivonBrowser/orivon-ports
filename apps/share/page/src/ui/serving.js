// How the page shows what it is serving: text that follows the engine's state and stops listening once it leaves the page.

import * as engine from '../engine.js'
import { count, formatBytes } from '../format.js'
import { h, replace } from '../dom.js'

/**
 * An element whose children are `render(state)`, drawn again whenever the engine's serving state changes.
 * It stops listening when it has been on the page and is no longer there.
 * @param {(state: ReturnType<typeof engine.servingState>) => any} render
 * @param {string} [tag] @param {Record<string, any>} [attrs]
 */
export function liveServing (render, tag = 'span', attrs = {}) {
  const el = h(tag, attrs)
  let seen = false
  const draw = () => {
    if (el.isConnected) seen = true
    else if (seen) {
      off()
      return
    }
    replace(el, render(engine.servingState()))
  }
  const off = engine.onServingChange(draw)
  draw()
  return el
}

/** @param {number} peers */
export function peersText (peers) {
  return peers === 0 ? 'No one connected now' : `${count(peers, 'connection')} open`
}

/** @param {number} bytes */
export function uploadedText (bytes) {
  return bytes === 0 ? 'Nothing sent yet' : `${formatBytes(bytes)} sent`
}

/** What the page's own IPFS node adds, or null when it adds nothing to say. @param {'off' | 'announced' | 'unreachable' | 'starting'} node */
export function nodeText (node) {
  if (node === 'announced') return 'Also announced on the IPFS network'
  if (node === 'starting') return 'Orivon\'s IPFS node is checking whether the IPFS network can reach this computer'
  if (node === 'unreachable') return 'This computer is not reachable from the IPFS network, so only direct connections work'
  return null
}

/** A warning when nobody can reach this computer yet, else null. @param {ReturnType<typeof engine.servingState>} state */
export function servingWarning (state) {
  if (!state.supported) return 'This browser cannot connect computers directly, so nobody can open the link from here. Keep the share with a service, or send the CAR file.'
  return state.trackers.total > 0 && state.trackers.connected === 0 && state.shares.some((share) => share.online)
    ? 'Connecting to the servers that introduce people to this computer. Nobody can open the link until that is done.'
    : null
}
