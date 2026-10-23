// The two file dialogs Electron's main answers, over Orivon's pickers. Neither hands the renderer a
// host path: a picked file is copied into the app's own folder and the backend is told that path
// (backend-client.js, importFile), and a saved file is written into a picked folder by name, with
// the folder handle kept here. `orivon.fs.userSelected` needs a recent click or key press on the
// page. A save is called after the backend has built the file, which can be seconds later, so a
// refusal for want of one shows a button of this file's own and the pick happens inside its click.

import { bytesOf, needsActivation, safeFileName } from './plan.js'

const PROMPT_ID = 'actualbudget-save-prompt'

/** The file picker for `options` (Electron's `{ properties, filters }`); a folder is refused, since nothing outside the app's folder is read by name here. */
export async function pickFiles (orivon, options) {
  const properties = options?.properties ?? ['openFile']
  if (properties.includes('openDirectory')) {
    const error = new Error('Actual.openFileDialog: folders cannot be chosen in this build; budgets live in the app\'s own folder')
    error.name = 'OrivonBridgeError'
    throw error
  }
  const picked = await orivon.fs.userSelected({ multiple: properties.includes('multiSelections') })
  return picked.length === 0 ? undefined : picked
}

/** Shows a prompt with one button that picks the folder and one that cancels; resolves the folder, or null. */
function promptForFolder (doc, orivon, { filename, title }) {
  return new Promise((resolve, reject) => {
    doc.getElementById(PROMPT_ID)?.remove()
    const box = doc.createElement('div')
    box.id = PROMPT_ID
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-label', title)
    box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);z-index:2147483647;font:14px sans-serif'
    const card = doc.createElement('div')
    card.style.cssText = 'background:#fff;color:#222;padding:20px 24px;border-radius:8px;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,.3)'
    const text = doc.createElement('p')
    text.textContent = `${title}: ${filename} is ready. Choose the folder to save it in.`
    const choose = doc.createElement('button')
    choose.type = 'button'
    choose.textContent = 'Choose a folder'
    const cancel = doc.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'Cancel'
    const finish = (settle, value) => { box.remove(); settle(value) }
    choose.addEventListener('click', () => {
      orivon.fs.userSelected({ directory: true }).then((folder) => { finish(resolve, folder) }, (error) => { finish(reject, error) })
    })
    cancel.addEventListener('click', () => { finish(resolve, null) })
    card.append(text, choose, cancel)
    box.append(card)
    doc.body.append(box)
  })
}

/** Writes `contents` into a folder the person picks, under `filename`. Resolves false when they cancelled. */
export async function saveToPickedFolder ({ orivon, doc }, contents, filename, title = 'Save') {
  const bytes = bytesOf(contents)
  const name = safeFileName(filename, 'export')
  let folder
  try {
    folder = await orivon.fs.userSelected({ directory: true })
  } catch (error) {
    if (!needsActivation(error)) throw error
    folder = await promptForFolder(doc, orivon, { filename: name, title })
  }
  if (folder === null || folder === undefined) return false
  await folder.writeFile(name, bytes)
  return true
}
