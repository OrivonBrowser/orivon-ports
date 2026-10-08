// What `require('electron')` gives upstream's modules: orivon-mvp's shim, plus
// `remote`, which Electron 14 removed and upstream's main window still reads
// (build/renderer/main.js). @electron/remote is that module's replacement, so
// the same stand-in answers both (remote.js).

import shim from 'electron'
import * as remote from './remote.js'

export default new Proxy(shim, {
  get (target, name, receiver) {
    if (name === 'remote') return remote
    return Reflect.get(target, name, receiver)
  }
})
