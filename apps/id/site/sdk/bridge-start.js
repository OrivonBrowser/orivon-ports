// Runs the bridge on the page that loads it: the browser's own location, referrer and storage, and a word for what
// happened. The logic is in bridge.js.

import { runBridge } from './bridge.js'
import { CHANNEL_NAME, defaultStore } from './pending.js'

const WORDS = Object.freeze({
  framed: 'This page cannot be used inside another page.',
  badLink: 'This page is opened by the Orivon ID sign-in, which gives it a code. It was opened without one.',
  notFromId: 'This page is opened by the Orivon ID sign-in. Your browser did not say that it came from there.',
  forwarded: 'Continuing your sign-in…',
  forwardedNone: 'No sign-in was started on this site in this browser. Going back…',
  landed: 'Signed in with Orivon ID. Taking you back to the site…',
  malformed: 'The answer from Orivon ID could not be read. Taking you back to the site…',
  noRequest: 'No sign-in is waiting on this site. Taking you back to the site…',
  wrongNonce: 'That answer is for another sign-in, so it was dropped. Taking you back to the site…',
  wrongState: 'That answer is for another sign-in, so it was dropped. Taking you back to the site…',
  notStored: 'This browser would not keep the answer. Taking you back to the site…'
})

/** @type {BroadcastChannel | null} */
let channel = null
try {
  channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null
} catch {
  channel = null
}

const result = runBridge({
  location: { origin: location.origin, search: location.search, hash: location.hash },
  referrer: document.referrer,
  framed: window.top !== window,
  storage: defaultStore(),
  replace: (url) => { location.replace(url) },
  clearHash: () => {
    try {
      history.replaceState(null, '', location.pathname + location.search)
    } catch {
      // The fragment stays in the address bar; the page is about to leave it.
    }
  },
  broadcast: (message) => { channel?.postMessage(message) },
  now: Math.floor(Date.now() / 1000)
})
const status = document.getElementById('status')
if (status !== null) status.textContent = WORDS[result.outcome]
