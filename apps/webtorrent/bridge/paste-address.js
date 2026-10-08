// A right-click on the torrent list's background pastes a torrent address
// (upstream's openTorrentListContextMenu reads the system clipboard at once
// with electron.clipboard.readText()). Orivon lets no page read what the
// person copied elsewhere, so the gesture opens upstream's own box for a
// torrent address instead, where the person pastes it. A right-click on a
// torrent's row is left to upstream, which opens that torrent's menu.

import { dispatch } from 'webtorrent-desktop/build/renderer/lib/dispatcher.js'

document.addEventListener('contextmenu', (event) => {
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('.torrent-list') == null || target.closest('.torrent') != null) return
  event.preventDefault()
  event.stopPropagation()
  dispatch('openTorrentAddress')
}, true)
