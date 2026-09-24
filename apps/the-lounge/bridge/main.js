// The engine's entry point, bundled by esbuild into
// public/orivon/lounge-engine.js and injected as the first script in <head>
// (hooks.mjs): it must be in place before the client's module bundle runs,
// because the bundle opens the socket.io connection the shim answers.

import { installSioShim } from './lounge-sio.js'
import { LoungeServer } from './lounge-server.js'

function boot () {
  if (window.orivon === undefined) {
    // Without the shell's capability API there is nothing to back IRC with.
    // Run anyway so the page renders instead of throwing at load time; the
    // network connect attempt will be the thing that reports why.
    console.error('The Lounge port: window.orivon is missing; IRC connections are unavailable.')
  }
  const server = new LoungeServer()
  const sio = installSioShim(window)
  server.attach(sio)
}

boot()
