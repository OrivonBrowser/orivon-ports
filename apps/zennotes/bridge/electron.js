// What `import ... from 'electron'` gives upstream's preload and main modules: orivon-mvp's shim,
// plus the two members the shim refuses that the preload needs. `contextBridge` publishes the
// preload's object on `window`, as a classic script can; `webUtils.getPathForFile` answers an empty
// path because a page is never given the path of a file the person dropped on it.

import {
  app, clipboard, dialog, ipcMain, ipcRenderer, safeStorage, shell, BrowserWindow, Menu, Tray
} from 'electron'

export const contextBridge = {
  exposeInMainWorld (name, api) {
    globalThis[name] = api
  }
}

export const webUtils = {
  getPathForFile () {
    return ''
  }
}

export { app, clipboard, dialog, ipcMain, ipcRenderer, safeStorage, shell, BrowserWindow, Menu, Tray }

export default { app, clipboard, contextBridge, dialog, ipcMain, ipcRenderer, safeStorage, shell, webUtils, BrowserWindow, Menu, Tray }
