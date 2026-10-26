// Upstream's main process, as much of it as the notes need, answering in the page what the preload
// sends. Which channels are here and why is in README.md, The main process. The functions that read
// and write the notes are upstream's own (vault-calls.js); this file holds the choices that are the
// port's: which folder is the vault, where the settings live, and what each action that needs the
// desktop answers.

import { Buffer } from 'node:buffer'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, dialog, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import * as vault from 'zennotes-desktop/main/vault.ts'
import {
  getConfigFilePath, getPortableConfigSnapshot, initAppConfig, setPortableConfig
} from 'zennotes-desktop/main/app-config.ts'
import { createCustomTheme, deleteCustomTheme, getCustomThemesDir, listCustomThemes } from 'zennotes-desktop/main/custom-themes.ts'
import { deleteOverride, listOverrides } from 'zennotes-desktop/main/overrides.ts'
import { clearUndoHistories, readUndoHistory, writeUndoHistory } from 'zennotes-desktop/main/undo-history-store.ts'
import { answer, handle, refused, sync } from './ipc-kit.js'
import { registerChannels } from './channels.js'
import { registerVaultCalls } from './vault-calls.js'
import { installInfo, seedFirstRun } from './host.js'
import { createNoteStream } from './session.js'
import { session } from './state.js'

const listNotesPage = createNoteStream({ listNotes: vault.listNotes })

/** Where upstream keeps the open tabs, panes and cursors, so they travel with the vault. */
const workspaceFile = (root) => path.join(root, '.zennotes', 'workspace.json')

/** The vault: which folder it is, its settings, and the files beside the notes. */
function registerVault () {
  handle(IPC.VAULT_GET_CURRENT, () => session.current())
  handle(IPC.VAULT_LIST_LOCAL, () => session.list())
  handle(IPC.VAULT_OPEN_LOCAL, async (root) => (typeof root === 'string' && root.trim() !== '' ? await session.switchTo(root.trim()) : null))
  handle(IPC.VAULT_CLOSE, () => session.close())
  // The picker is Orivon's: the person chooses the folder, and the answer is a path that stands for it.
  handle(IPC.VAULT_PICK, async () => {
    const result = await dialog.showOpenDialog({ title: 'Choose a vault folder', properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Open Vault' })
    if (result.canceled || result.filePaths.length === 0) return null
    return await session.open(result.filePaths[0])
  })
  handle(IPC.VAULT_GET_SETTINGS, () => vault.getVaultSettings(session.require().root))
  handle(IPC.VAULT_SET_SETTINGS, (next) => vault.setVaultSettings(session.require().root, next))
  handle(IPC.VAULT_LIST_NOTES_STREAM, (request) => listNotesPage(session.require().root, request))
  handle(IPC.VAULT_READ_ASSET_BASE64, async (assetPath) => {
    const rel = String(assetPath ?? '').trim()
    if (rel === '') throw new Error('Asset path is required.')
    return Buffer.from(await fs.readFile(vault.absolutePath(session.require().root, rel))).toString('base64')
  })
  handle(IPC.WORKSPACE_STATE_READ, async () => {
    try {
      return await fs.readFile(workspaceFile(session.require().root), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  })
  handle(IPC.WORKSPACE_STATE_WRITE, async (json) => {
    if (typeof json !== 'string') return
    const file = workspaceFile(session.require().root)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, json, 'utf8')
  })
  // Undo history is machine-local, so it sits in the app's own files, keyed by the vault.
  handle(IPC.UNDO_HISTORY_READ, (notePath) => readUndoHistory(app.getPath('userData'), session.require().root, notePath))
  handle(IPC.UNDO_HISTORY_WRITE, (notePath, json) => writeUndoHistory(app.getPath('userData'), session.require().root, notePath, json))
  handle(IPC.UNDO_HISTORY_CLEAR, () => clearUndoHistories(app.getPath('userData')))
  // Searching runs in the page. ripgrep and fzf are programs on the computer, which an app does not start.
  answer(IPC.VAULT_TEXT_SEARCH_CAPABILITIES, { ripgrep: false, fzf: false })
  // What leaves the vault or reaches into the computer.
  for (const [channel, what] of [
    [IPC.VAULT_EXPORT_NOTE_PDF, 'Exporting a note to PDF'], [IPC.VAULT_EXPORT_NOTE_DOCX, 'Exporting a note to Word'],
    [IPC.VAULT_EXPORT_WORKFLOW, 'Exporting a workflow'], [IPC.VAULT_IMPORT_WORKFLOW_FILE, 'Importing a workflow from a file'],
    [IPC.VAULT_IMPORT_FILES, 'Dropping files from the computer into a note'], [IPC.VAULT_REVEAL_NOTE, 'Showing a note in the file manager'],
    [IPC.VAULT_REVEAL_NOTE_TARGET, 'Showing a note in the file manager'], [IPC.VAULT_REVEAL_FILE_PATH, 'Showing a file in the file manager'],
    [IPC.VAULT_REVEAL_FOLDER, 'Showing a folder in the file manager'], [IPC.VAULT_REVEAL_FOLDER_TARGET, 'Showing a folder in the file manager'],
    [IPC.VAULT_REVEAL_ASSETS_DIR, 'Showing the vault in the file manager']
  ]) {
    refused(channel, what)
  }
  const opensOutside = { ok: false, error: 'Opening a file in another program is not available in the Orivon build of ZenNotes.' }
  answer(IPC.VAULT_OPEN_EXTERNAL_FILE, opensOutside)
  answer(IPC.VAULT_OPEN_ASSET_EXTERNALLY, opensOutside)
  // A link preview is fetched by the page's own network, which the manifest does not grant.
  handle(IPC.VAULT_FETCH_LINK_METADATA, (url) => ({ url: String(url ?? ''), ok: false }))
  // Edits an assistant made through the program Orivon does not start: none to review.
  answer(IPC.VAULT_LIST_AGENT_EDITS, [])
  answer(IPC.VAULT_READ_AGENT_EDIT, null)
  answer(IPC.VAULT_WRITE_AGENT_EDIT, undefined)
}

/** The settings file, themes and overrides: files the app owns. */
function registerSettings () {
  sync(IPC.CONFIG_GET_SYNC, () => getPortableConfigSnapshot())
  sync(IPC.APP_INSTALL_INFO_SYNC, () => installInfo())
  handle(IPC.CONFIG_SET, (next) => setPortableConfig(next ?? {}))
  handle(IPC.CONFIG_GET_PATH, () => getConfigFilePath())
  refused(IPC.CONFIG_REVEAL, 'Showing the settings file in the file manager')
  handle(IPC.CUSTOM_THEMES_LIST, () => listCustomThemes())
  handle(IPC.CUSTOM_THEMES_GET_DIR, () => getCustomThemesDir())
  handle(IPC.CUSTOM_THEMES_DELETE, (slug) => deleteCustomTheme(slug))
  handle(IPC.CUSTOM_THEMES_CREATE, (input) => createCustomTheme(input))
  refused(IPC.CUSTOM_THEMES_REVEAL, 'Showing the themes folder in the file manager')
  handle(IPC.OVERRIDES_LIST, () => listOverrides())
  handle(IPC.OVERRIDES_DELETE, (name) => deleteOverride(name))
  refused(IPC.OVERRIDES_REVEAL, 'Showing the overrides folder in the file manager')
  // Languages are WebAssembly grammars loaded through a URL scheme only the desktop program registers.
  answer(IPC.CUSTOM_CODE_LANGUAGES_LIST, [])
  for (const channel of [IPC.CUSTOM_CODE_LANGUAGES_INSTALL, IPC.CUSTOM_CODE_LANGUAGES_UPDATE, IPC.CUSTOM_CODE_LANGUAGES_DELETE, IPC.CUSTOM_CODE_LANGUAGES_REVEAL]) {
    refused(channel, 'Custom code languages')
  }
}

/** Registers every channel, then reads the settings file: the renderer reads them synchronously when it starts. */
export function registerMainProcess () {
  registerVault()
  registerSettings()
  registerVaultCalls()
  registerChannels()
}

/** Start-up work that must finish before upstream's renderer runs: the app's own files are readable, and the settings are loaded. */
export async function start () {
  await app.whenReady()
  await initAppConfig((next) => { ipcRenderer.send(IPC.CONFIG_ON_CHANGE, next) })
  seedFirstRun()
}
