// Bundled for the page by esbuild.orivon.config.mjs as orivon/actual-backend.js, a classic script the
// build adds to the entry document. It builds the page's side of the backend over the shim's
// child_process, fs and fetch and publishes it as window.__orivonActualBackend, which the bridge's
// members call (actualbudget.js). ORIVON_INSTALL_STAMP and ORIVON_VIRTUAL_ROOT are build-time constants.

import { fork } from 'child_process'
import fsp from 'fs/promises'
import { createBackend } from './backend-client.js'
import { pickFiles, saveToPickedFolder } from './file-dialogs.js'
import { createStatusLine } from './status-line.js'

const root = ORIVON_VIRTUAL_ROOT

const backend = createBackend({
  root,
  stamp: ORIVON_INSTALL_STAMP,
  serverPath: new URL('server.mjs', document.baseURI).pathname,
  fork,
  files: {
    mkdir: async (path, options) => { await fsp.mkdir(path, options) },
    writeFile: async (path, bytes) => { await fsp.writeFile(path, bytes) },
    readFile: async (path) => await fsp.readFile(path),
    readdir: async (path) => await fsp.readdir(path),
    rm: async (path, options) => { await fsp.rm(path, options) }
  },
  fetch: async (url) => await fetch(url, { cache: 'no-store' }),
  locks: navigator.locks,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  newId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  log: (text) => { console.info('[actual backend]', text.trimEnd()) },
  mark: (name) => { performance.mark(name) },
  progress: createStatusLine(document)
})

window.__orivonActualBackend = {
  listen: backend.listen,
  post: backend.post,
  restart: backend.restart,
  openFileDialog: async (options) => {
    const picked = await pickFiles(window.orivon, options)
    return picked === undefined ? undefined : await Promise.all(picked.map(backend.importFile))
  },
  saveFile: async (contents, filename, title) => await saveToPickedFolder({ orivon: window.orivon, doc: document }, contents, filename, title)
}

// Started now, not at the renderer's first message: its boot overlaps the renderer's own loading.
backend.warm()

// The backend ends with this page, so a reload or a closed tab never leaves two holding the budget.
window.addEventListener('pagehide', () => { backend.stop() })
