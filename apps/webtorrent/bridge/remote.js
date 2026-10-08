// Stands in for @electron/remote, and for `electron.remote`, which upstream's
// main window still reads (electron.js): the main-process objects upstream's
// renderer reaches synchronously, answered in the page.
//
// The two synchronous dialogs cannot show a picker and wait for it, so each
// answers "cancelled" at once and finishes the job itself, through the app's
// own dispatcher or by handing the person a file, for the calls upstream
// makes. README.md, The main process, says what each call does here.

import { app as shimApp } from 'electron'
import { watch } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { dispatch } from 'webtorrent-desktop/build/renderer/lib/dispatcher.js'
import { popupMenu } from './context-menu.js'
import { importFiles, offerDownload, pickFiles } from './files.js'
import { DOWNLOADS } from './install.js'
import { notAvailable, reportError } from './main-process.js'


export const app = {
  getPath (name) {
    if (name === 'downloads') return DOWNLOADS
    return shimApp.getPath(name)
  }
}

const currentWindow = {
  isVisible: () => document.visibilityState === 'visible',
  isMaximized: () => false
}

export function getCurrentWindow () { return currentWindow }

const isSubtitlesPick = (options) => options?.filters?.some((filter) => filter.extensions.includes('srt')) === true

let saves = 0

export const dialog = {
  /**
   * The subtitles picker (subtitles-controller.js) is shown, and what is picked is copied in and
   * added with the app's own `addSubtitles`. The other callers, the preferences' path selectors,
   * ask for a folder or a program on the computer, which Orivon does not hand out.
   */
  showOpenDialogSync (...args) {
    const options = args.length > 1 ? args[1] : args[0]
    if (isSubtitlesPick(options)) {
      pickFiles({ accept: '.srt,.vtt', multiple: false }).then(async (files) => {
        if (files.length > 0) dispatch('addSubtitles', await importFiles(files), true)
      }).catch(reportError)
    } else {
      notAvailable('Choosing a folder or a program on your computer')
    }
    return undefined
  },

  /**
   * Save Torrent File As (torrent-list-controller.js): answered with a fresh path in the app's own
   * files, and what the app writes there is handed to the person as a download.
   */
  showSaveDialogSync (...args) {
    const options = args.length > 1 ? args[1] : args[0]
    const folder = `/orivon/app/tmp/save-${String(++saves)}`
    const path = `${folder}/${basename(options?.defaultPath ?? 'file')}`
    deliverWhenWritten(folder, path).catch(reportError)
    return path
  }
}

async function deliverWhenWritten (folder, path) {
  await mkdir(folder, { recursive: true })
  await new Promise((resolve, reject) => {
    let delivered = false
    const watcher = watch(folder, () => {
      readFile(path).then((bytes) => {
        // A write can be heard more than once; the file is handed over once.
        if (bytes.length === 0 || delivered) return
        delivered = true
        watcher.close()
        clearTimeout(timer)
        offerDownload(basename(path), bytes)
        resolve()
      }, () => {})
    })
    const timer = setTimeout(() => { watcher.close(); resolve() }, 60_000)
    watcher.on('error', reject)
  })
  await rm(folder, { recursive: true, force: true })
}

export class MenuItem {
  constructor (options) { Object.assign(this, options) }
}

export class Menu {
  constructor () { this.items = [] }
  append (item) { this.items.push(item) }
  popup (options) { popupMenu(this.items, options ?? {}) }
}

export const screen = {
  getAllDisplays: () => [{ size: { width: window.screen.width, height: window.screen.height }, scaleFactor: window.devicePixelRatio }]
}
