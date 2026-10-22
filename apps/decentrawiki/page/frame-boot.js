// The editing frame's half of the handover: tells the editor page it is ready,
// boots TiddlyWiki with the tiddlers the page sends, and gives the frame plugin
// ($:/plugins/orivon/decentrawiki-frame) the way to answer. The frame is
// sandboxed with an opaque origin, so only its parent can talk to it.
(function () {
  'use strict'
  const PROTOCOL = 'decentrawiki-frame'
  let booted = false

  function send (message) {
    window.parent.postMessage({ protocol: PROTOCOL, ...message }, '*')
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (event.source !== window.parent || data === null || typeof data !== 'object' || data.protocol !== PROTOCOL) return
    if (data.type !== 'load' || booted) return
    booted = true
    const tw = window.$tw
    tw.preloadTiddlers = tw.preloadTiddlers || []
    for (const fields of Array.isArray(data.tiddlers) ? data.tiddlers : []) tw.preloadTiddlers.push(fields)
    tw.decentrawikiFrame = { send, open: data.open ?? null }
    try {
      tw.boot.boot(() => send({ type: 'booted' }))
    } catch (error) {
      send({ type: 'boot-failed', message: String(error?.message ?? error) })
    }
  })

  send({ type: 'ready' })
})()
