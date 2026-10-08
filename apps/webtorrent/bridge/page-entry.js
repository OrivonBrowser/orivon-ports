// The bundle's entry: upstream's main process, hidden torrent window and main
// window, in the order Electron starts them, in one page. The files upstream
// reads with fs are copied into the app's own files first (install.js).

import { installStatic } from './install.js'
import './main-process.js'
import './drop.js'
import { installPosterCapture } from './poster-capture.js'

installStatic().then(() => {
  installPosterCapture()
  require('webtorrent-desktop/build/renderer/webtorrent.js')
  require('webtorrent-desktop/build/renderer/main.js')
}, (error) => {
  console.error('WebTorrent Desktop could not copy its default torrents into its files:', error)
})
