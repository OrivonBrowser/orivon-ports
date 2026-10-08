// A drop of files to seed, or of subtitles onto the player. Under Electron the
// drop handed upstream each file's path; here the files are copied into the
// app's files and upstream's own onOpen gets those paths, as the + button
// does. A drop of .torrent files alone, or of text such as a magnet link, goes
// on to upstream's handler, which takes it as it is.

import { dispatch } from 'webtorrent-desktop/build/renderer/lib/dispatcher.js'
import { importEntries, importFiles } from './files.js'
import { reportError } from './main-process.js'

document.addEventListener('drop', (event) => {
  const files = [...(event.dataTransfer?.files ?? [])]
  if (files.length === 0 || files.every((file) => /\.torrent$/i.test(file.name))) return
  event.preventDefault()
  event.stopPropagation()
  // drag-drop marks the body while something is dragged over it, and never hears this drop.
  document.body.classList.remove('drag')
  // An entry also brings a dropped folder; a drop with none (one a script made) still has its files.
  const entries = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter((entry) => entry != null)
  const copied = entries.length > 0 ? importEntries(entries) : importFiles(files)
  copied.then((paths) => { dispatch('onOpen', paths) }, reportError)
}, true)
