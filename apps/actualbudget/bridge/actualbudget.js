// The window.Actual members that carry a decision rather than a shape. Upstream's preload has
// 23; the other 13 are declared in ./members.json and generated. Every one that touches the
// backend or a picked file delegates to window.__orivonActualBackend, which backend-entry.js
// installs from a script of its own (the backend starts a forked child, and a classic bridge
// script has no module system to import the shim's child_process from).
//
// This file is spliced into the composed bridge, so it is not a module: it declares
// `appMembers`, which the installer calls with the kit.

function appMembers (kit) {
  const backend = (member) => {
    const api = window.__orivonActualBackend
    if (api === undefined) throw new kit.BridgeError(member, 'not-built', 'the backend script did not load')
    return api
  }

  return {
    // Upstream's desktop preload reads both from main: IS_DEV is false in a packaged app, and the
    // version is desktop-electron's. The build compares this constant with the clone's package.
    IS_DEV: false,
    ACTUAL_VERSION: '26.10.0',

    logToTerminal: (...args) => { console.log(...args) },

    // `func` receives `{ on, emit }`. Upstream's `emit(name, data)` sends `data` to the backend
    // process; `on('message', handler)` hears everything the backend sends back.
    ipcConnect: (func) => {
      const api = backend('ipcConnect')
      func({
        on: (name, handler) => { api.listen(name, handler) },
        emit: (name, data) => { api.post(data) }
      })
    },

    // Relaunching the Electron app is reloading the page here: the backend ends with the page and
    // the next one starts a new one.
    relaunch: () => { window.location.reload() },
    restartElectronServer: () => { backend('restartElectronServer').restart() },

    // Resolves the paths of the files the person picked, as the backend can read them: each is
    // copied into the app's own folder first. A folder is never picked here. Cancelling resolves
    // undefined, as Electron's synchronous dialog does.
    openFileDialog: async (options) => await backend('openFileDialog').openFileDialog(options),

    // Electron asks for a file name with a save dialog. Here the person picks a folder and the file
    // is written into it under the name the app gave; the folder handle stays in the bridge.
    saveFile: async (contents, filename, dialogTitle) => { await backend('saveFile').saveFile(contents, filename, dialogTitle) },

    openURLInBrowser: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },

    // Upstream's desktop preload returns a promise that never settles: there is nothing to wait for.
    waitForUpdateReadyForDownload: () => new Promise(() => {})
  }
}
