// The channels upstream's main process answers with something other than the notes: the desktop
// (windows, tray, updater, command line), ZenNotes Cloud, a remote server, assistants (MCP), the
// settings files. Each is answered the way upstream's main answers when the feature is absent or
// signed out, so a screen that asks at start-up gets a value it can draw; an action nothing here
// can do rejects by name. The notes themselves are in vault-calls.js and main-process.js.

import { IPC } from '@shared/ipc'
import { openExternalUrl } from 'zennotes-desktop/main/external-urls.ts'
import { shell } from 'electron'
import { getPortableConfigSnapshot } from 'zennotes-desktop/main/app-config.ts'
import { answer, handle, listen, refused } from './ipc-kit.js'
import { platform } from './host.js'

const NO_WORKSPACE = { mode: 'local', baseUrl: null, authConfigured: false, capabilities: null, profileId: null, bootError: null }
const NO_UPDATES = {
  phase: 'unsupported', installable: false, currentVersion: '', availableVersion: null, releaseName: null, releaseDate: null,
  releaseNotes: null, progressPercent: null, transferredBytes: null, totalBytes: null, bytesPerSecond: null,
  message: 'Orivon updates this app itself.'
}
const NO_CLI = {
  available: false, reason: 'The command line tool is not part of the Orivon build.', defaultTarget: '', requiresSudo: false,
  targetOnPath: false, pathHint: null, installedAt: null, installedByThisApp: false, supportedPlatform: false
}
const NO_CLI_UPDATE = { phase: 'unsupported', message: 'The command line tool is not part of the Orivon build.' }
const NO_RAYCAST = {
  available: false, reason: 'Raycast is not part of the Orivon build.', supportedPlatform: false, installed: false, upToDate: false, extensionPath: ''
}
const NO_MCP = {
  command: '', args: [], env: {}, entryPath: null,
  unavailableReason: 'Assistants reach ZenNotes through a program on this computer, which an Orivon app does not start.'
}
const NOT_SIGNED_IN = { state: 'disconnected', account: null }

/** The desktop: windows, tray, zoom, fonts, quick capture. A tab is the window, and the shell owns the rest. */
function desktop () {
  answer(IPC.APP_PLATFORM, () => platform())
  answer(IPC.APP_LIST_FONTS, [])
  answer(IPC.APP_ICON_DATA_URL, null)
  for (const channel of [IPC.APP_ZOOM_IN, IPC.APP_ZOOM_OUT, IPC.APP_ZOOM_RESET]) answer(channel, 1)
  answer(IPC.APP_USAGE_COUNT, undefined)
  answer(IPC.APP_GET_QUICK_CAPTURE_HOTKEY, '')
  answer(IPC.APP_SET_QUICK_CAPTURE_HOTKEY, { ok: false, hotkey: '', error: 'A shortcut that works while the app is in the background is not available in a tab.' })
  answer(IPC.APP_GET_QUICK_CAPTURE_PINNED, false)
  answer(IPC.APP_SET_QUICK_CAPTURE_PINNED, false)
  answer(IPC.APP_GET_KEEP_RUNNING_IN_TRAY, false)
  answer(IPC.APP_SET_KEEP_RUNNING_IN_TRAY, false)
  answer(IPC.WINDOW_HIDE_TO_TRAY, false)
  answer(IPC.WINDOW_TOGGLE_QUICK_CAPTURE, undefined)
  for (const channel of [IPC.WINDOW_MINIMIZE, IPC.WINDOW_TOGGLE_MAXIMIZE, IPC.WINDOW_CLOSE, IPC.APP_TRAY_SYNC_STATUS, IPC.APP_QUIT, IPC.APP_RENDERER_READY]) {
    listen(channel, () => {})
  }
  refused(IPC.WINDOW_OPEN_NOTE, 'A second window')
  refused(IPC.WINDOW_OPEN_VAULT, 'A second window')
  answer(IPC.DEVTOOLS_TOGGLE, undefined)
  handle(IPC.APP_OPEN_EXTERNAL_URL, (url) => openExternalUrl(url, getPortableConfigSnapshot().externalApplicationSchemes, (target) => shell.openExternal(target)))
}

/** A file opened from outside the vault in a window of its own, and the desktop's "Open File" and drag-and-drop by path. */
function externalFiles () {
  for (const channel of [IPC.APP_READ_EXTERNAL_FILE, IPC.APP_WRITE_EXTERNAL_FILE, IPC.APP_FOLLOW_EXTERNAL_FILE_LINK, IPC.APP_MOVE_EXTERNAL_FILE_TO_VAULT]) {
    refused(channel, 'Opening a file from outside the vault')
  }
  answer(IPC.APP_OPEN_MARKDOWN_FILE, false)
  answer(IPC.APP_OPEN_FILE_DIALOG, false)
  answer(IPC.APP_OPEN_FOLDER_TEMPORARY, undefined)
}

/** The updater and the command line: Orivon updates an installed app itself, and an app starts no program. */
function updatesAndTools () {
  for (const channel of [IPC.APP_UPDATER_GET_STATE, IPC.APP_UPDATER_CHECK, IPC.APP_UPDATER_DOWNLOAD]) answer(channel, NO_UPDATES)
  answer(IPC.APP_UPDATER_CHECK_WITH_UI, undefined)
  answer(IPC.APP_UPDATER_INSTALL, undefined)
  for (const channel of [IPC.CLI_GET_STATUS, IPC.CLI_INSTALL, IPC.CLI_UNINSTALL]) answer(channel, NO_CLI)
  answer(IPC.CLI_UPDATE_GET_STATE, NO_CLI_UPDATE)
  answer(IPC.CLI_UPDATE_CHECK, NO_CLI_UPDATE)
  answer(IPC.CLI_SET_AUTO_UPDATE, false)
  answer(IPC.RAYCAST_GET_STATUS, NO_RAYCAST)
  refused(IPC.RAYCAST_INSTALL, 'Installing the Raycast extension')
  answer(IPC.MCP_RUNTIME, NO_MCP)
  answer(IPC.MCP_STATUS, [])
  answer(IPC.MCP_SERVER_TOKEN_STATE, { kind: 'none', reason: 'local' })
  for (const channel of [IPC.MCP_INSTALL, IPC.MCP_UNINSTALL, IPC.MCP_SHARE_SERVER_TOKEN, IPC.MCP_REMOVE_SERVER_TOKEN, IPC.MCP_SET_INSTRUCTIONS, IPC.MCP_GET_INSTRUCTIONS]) {
    refused(channel, 'Connecting an assistant')
  }
  answer(IPC.TIKZ_RENDER, { ok: false, error: 'TikZ is drawn by a program on this computer, which an Orivon app does not start.' })
}

const CLOUD_ACTIONS = [
  IPC.CLOUD_ACCOUNT_CONNECT, IPC.CLOUD_SERVICE_ACCOUNT_GET, IPC.CLOUD_PUBLISHED_NOTES_LIST, IPC.CLOUD_PUBLISHED_NOTE_CREATE,
  IPC.CLOUD_PUBLISHED_NOTE_UPDATE, IPC.CLOUD_PUBLISHED_NOTE_DELETE, IPC.CLOUD_VAULTS_LIST, IPC.CLOUD_VAULT_LINK_SET,
  IPC.CLOUD_VAULT_LINK_CREATE, IPC.CLOUD_ENCRYPTION_STATUS, IPC.CLOUD_ENCRYPTION_SETUP_PREPARE, IPC.CLOUD_ENCRYPTION_SETUP_FINISH,
  IPC.CLOUD_ENCRYPTION_UNLOCK, IPC.CLOUD_ENCRYPTION_PASSPHRASE_CHANGE, IPC.CLOUD_ENCRYPTION_RECOVERY_PREPARE,
  IPC.CLOUD_ENCRYPTION_RECOVERY_FINISH, IPC.CLOUD_ENCRYPTION_LOCK, IPC.CLOUD_VAULT_ENCRYPT, IPC.CLOUD_VAULT_LINK_DELETE,
  IPC.CLOUD_VAULT_DELETE, IPC.CLOUD_VAULT_SYNC, IPC.CLOUD_VAULT_BOOTSTRAP_CONFLICT_GET, IPC.CLOUD_VAULT_BOOTSTRAP_CONFLICT_RESOLVE,
  IPC.CLOUD_VAULT_CONFLICT_GET, IPC.CLOUD_VAULT_CONFLICT_REVIEW_RELEASE, IPC.CLOUD_VAULT_CONFLICT_DRAFT_SAVE,
  IPC.CLOUD_VAULT_CONFLICT_RESOLVE, IPC.CLOUD_VAULT_SETTINGS_CONFLICT_GET, IPC.CLOUD_VAULT_SETTINGS_CONFLICT_RESOLVE,
  IPC.CLOUD_BACKUPS_LIST, IPC.CLOUD_BACKUP_SCHEDULE_GET, IPC.CLOUD_BACKUP_SCHEDULE_UPDATE, IPC.CLOUD_BACKUP_ITEMS_LIST,
  IPC.CLOUD_BACKUP_ITEMS_PAGE, IPC.CLOUD_BACKUP_CREATE, IPC.CLOUD_BACKUP_DOWNLOAD, IPC.CLOUD_BACKUP_DELETE,
  IPC.CLOUD_BACKUP_RESTORE, IPC.CLOUD_BACKUP_NOTE_RESTORE
]

/** ZenNotes Cloud and a remote server: the signed-out, not-connected answer, and every action says so. */
function cloudAndRemote () {
  answer(IPC.WORKSPACE_GET_INFO, NO_WORKSPACE)
  answer(IPC.WORKSPACE_LIST_REMOTE_PROFILES, [])
  answer(IPC.WORKSPACE_RETRY_BOOT, null)
  for (const channel of [IPC.WORKSPACE_CONNECT_REMOTE, IPC.WORKSPACE_CONNECT_REMOTE_PROFILE, IPC.WORKSPACE_SAVE_REMOTE_PROFILE, IPC.VAULT_SELECT_PATH, IPC.VAULT_BROWSE_SERVER_DIRECTORIES]) {
    refused(channel, 'Connecting to a ZenNotes server')
  }
  answer(IPC.WORKSPACE_DISCONNECT_REMOTE, NO_WORKSPACE)
  answer(IPC.WORKSPACE_DELETE_REMOTE_PROFILE, undefined)
  answer(IPC.CLOUD_ACCOUNT_GET, NOT_SIGNED_IN)
  answer(IPC.CLOUD_ACCOUNT_LOGOUT, NOT_SIGNED_IN)
  answer(IPC.CLOUD_VAULT_LINK_GET, null)
  answer(IPC.CLOUD_VAULT_HAS_CHANGES, false)
  for (const channel of CLOUD_ACTIONS) refused(channel, 'ZenNotes Cloud')
  listen(IPC.CLOUD_VAULT_SYNC_WINDOW_ACK, () => {})
}

export function registerChannels () {
  desktop()
  externalFiles()
  updatesAndTools()
  cloudAndRemote()
}
