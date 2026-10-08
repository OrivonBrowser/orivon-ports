// Upstream makes a torrent's poster by drawing a frame of a video served from
// a second streaming server of its own (torrent-poster.js). Electron lets its
// file:// page read that frame; here the server is another origin, and a frame
// of a video loaded without CORS cannot be read. Two things make it readable:
//
// - That server answers CORS. Upstream creates it with `createServer(0)`, a 0
//   where it means no options, so webtorrent's own default (every origin) is
//   dropped; the server gets webtorrent's defaults instead, as upstream's
//   player server already does.
// - A video pointed at a loopback server by the `src` property asks for it
//   with CORS. Any other URL, and a crossorigin the page set itself, are left
//   as they are.

const LOOPBACK = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\//

/** Called once the app's grants are in, right before upstream loads: webtorrent reads Node's globals as it loads. */
export function installPosterCapture () {
  const Torrent = require('webtorrent-desktop/node_modules/webtorrent/lib/torrent.js')
  const createServer = Torrent.prototype.createServer
  Torrent.prototype.createServer = function (options) {
    return createServer.call(this, typeof options === 'object' && options !== null ? options : undefined)
  }

  const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    ...src,
    set (value) {
      if (this.crossOrigin === null && LOOPBACK.test(String(value))) this.crossOrigin = 'anonymous'
      src.set.call(this, value)
    }
  })
}
