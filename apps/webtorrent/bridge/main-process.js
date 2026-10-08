// Stands in for upstream's main process (src/main/ipc.js and what it calls):
// every channel the two windows send to main is answered here, in the page.
// The `wt-*` relay main did between the windows needs nothing: both windows
// run in this page on orivon-mvp's one in-page bus, and no channel is heard
// by both. What main sent back to a window, it sends here a turn later, as
// IPC would. README.md, The main process, lists each channel and its answer.

import { ipcMain, ipcRenderer } from 'electron'
import { rm } from 'node:fs/promises'
import { dispatch } from 'webtorrent-desktop/build/renderer/lib/dispatcher.js'
import { exportPath, importFiles, pickFiles } from './files.js'

/** What main sent a window, a turn later. */
const toWindow = (channel, ...args) => { setTimeout(() => { ipcRenderer.send(channel, ...args) }, 0) }

/** Says, in the app's own error bar, what Orivon cannot do for it. */
export const notAvailable = (what) => { dispatch('error', `${what} is not available in Orivon.`) }

export function reportError (error) {
  dispatch('error', error instanceof Error ? error : new Error(String(error)))
}

const isTorrentFile = (file) => /\.torrent$/i.test(file.name)

// Dialogs (src/main/dialog.js): the page's own picker, then the action main dispatched.
ipcMain.on('openTorrentFile', () => {
  pickFiles({ accept: '.torrent,application/x-bittorrent' }).then((files) => {
    for (const file of files) dispatch('addTorrent', file)
  }, reportError)
})
ipcMain.on('openFiles', () => {
  pickFiles().then(async (files) => {
    if (files.length === 0) return
    // A .torrent is added as the File it is; files to seed are read by path, so they are copied in first.
    if (files.every(isTorrentFile)) dispatch('onOpen', files)
    else dispatch('onOpen', await importFiles(files))
  }).catch(reportError)
})

// Shell (src/main/shell.js): the app's files cannot open in another program, so they are copied out.
ipcMain.on('openPath', (event, path) => { exportPath(path).catch(reportError) })
ipcMain.on('showItemInFolder', (event, path) => { exportPath(path).catch(reportError) })
ipcMain.on('moveItemToTrash', (event, path) => {
  // The app's files have no trash: the data is removed, as "Remove torrent and delete data" asks.
  rm(path, { recursive: true, force: true }).catch(reportError)
})

// The window (src/main/windows/main.js).
ipcMain.on('setTitle', (event, title) => { document.title = title })
ipcMain.on('toggleFullScreen', (event, flag) => {
  const wanted = flag ?? document.fullscreenElement === null
  if (wanted && document.fullscreenElement === null) document.documentElement.requestFullscreen().catch(reportError)
  if (!wanted && document.fullscreenElement !== null) document.exitFullscreen().catch(reportError)
})
document.addEventListener('fullscreenchange', () => { toWindow('fullscreenChanged', document.fullscreenElement !== null) })

// The player (power-save-blocker.js): the screen stays on while a video plays, as Electron's blocker keeps it.
let wakeLock = null
const keepAwake = () => {
  if (wakeLock !== null || navigator.wakeLock === undefined) return
  wakeLock = navigator.wakeLock.request('screen').catch(() => null)
}
const letSleep = () => {
  const held = wakeLock
  wakeLock = null
  held?.then((sentinel) => sentinel?.release()).catch(() => {})
}
ipcMain.on('onPlayerOpen', keepAwake)
ipcMain.on('onPlayerPlay', keepAwake)
ipcMain.on('onPlayerPause', letSleep)
ipcMain.on('onPlayerClose', letSleep)

// An external player (external-player.js) is a program on the computer, which Orivon does not start.
ipcMain.on('checkForExternalPlayer', () => { toWindow('checkForExternalPlayer', false) })
ipcMain.on('openExternalPlayer', () => { toWindow('dispatch', 'externalPlayerNotFound') })

// Preferences that change the computer rather than the app.
ipcMain.on('setDefaultFileHandler', (event, flag) => { if (flag) notAvailable('Opening magnet links and .torrent files with WebTorrent') })
ipcMain.on('setStartup', (event, flag) => { if (flag) notAvailable('Starting WebTorrent when you log in') })
ipcMain.on('startFolderWatcher', () => { notAvailable('Watching a folder on your computer for new .torrent files') })

// Answered by doing nothing: each one drove a part of the desktop a tab does not have (the dock, the
// taskbar, the menu bar, the window's size), or told main something only main used.
for (const channel of [
  'ipcReady', 'ipcReadyWebTorrent', 'stateSaved', 'setBadge', 'setProgress', 'setAllowNav', 'setAspectRatio',
  'setBounds', 'show', 'downloadFinished', 'onPlayerUpdate', 'quitExternalPlayer', 'stopFolderWatcher'
]) {
  ipcMain.on(channel, () => {})
}
