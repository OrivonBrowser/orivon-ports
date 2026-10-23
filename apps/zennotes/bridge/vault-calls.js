// The channels upstream's main process answers by calling one of its own functions on the open
// vault's folder: `handle(IPC.X, (_e, ...args) => fn(requireVault().root, ...args))`. Here the
// functions are upstream's own, bundled from its source, and the folder is the one the person
// picked (state.js). A channel that does more than that is in main-process.js.

import { IPC } from '@shared/ipc'
import * as vault from 'zennotes-desktop/main/vault.ts'
import { scanAllTasks, scanTasksForPath } from 'zennotes-desktop/main/tasks.ts'
import { deleteCustomTemplate, listCustomTemplates, readCustomTemplate, writeCustomTemplate } from 'zennotes-desktop/main/templates.ts'
import {
  createDatabase, createRecordPage, listDatabases, readDatabase, renameDatabase, writeDatabaseRows, writeDatabaseSchema
} from 'zennotes-desktop/main/databases.ts'
import { deleteWorkflowFile, listWorkflowFiles, writeWorkflowFile } from 'zennotes-desktop/main/workflows.ts'
import { applyWorkflowOps, deleteWorkflowRuns, listWorkflowRuns, undoWorkflowRun } from 'zennotes-desktop/main/workflow-apply.ts'
import { handle } from './ipc-kit.js'
import { session } from './state.js'

/** A channel answered by `run(root, ...args)` on the open vault. */
function vaultCall (channel, run) {
  handle(channel, (...args) => run(session.require().root, ...args))
}

/** A database tab can outlive its file; upstream answers null for that one failure so the tab is forgotten, and lets every other error through. */
async function openDatabase (root, rel) {
  try {
    return await readDatabase(root, rel)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Database not found')) return null
    throw error
  }
}

export function registerVaultCalls () {
  vaultCall(IPC.VAULT_ROOT_CONTENT_HIDDEN, vault.rootContentHiddenByInboxMode)
  vaultCall(IPC.VAULT_LIST_NOTES, vault.listNotes)
  vaultCall(IPC.VAULT_LIST_FOLDERS, vault.listFolders)
  vaultCall(IPC.VAULT_LIST_ASSETS, vault.listAssets)
  vaultCall(IPC.VAULT_HAS_ASSETS_DIR, vault.hasAssetsDir)
  vaultCall(IPC.VAULT_GENERATE_DEMO_TOUR, vault.generateDemoTour)
  vaultCall(IPC.VAULT_REMOVE_DEMO_TOUR, vault.removeDemoTour)
  vaultCall(IPC.VAULT_SEARCH_TEXT, vault.searchVaultText)

  // Notes.
  vaultCall(IPC.VAULT_READ_NOTE, vault.readNote)
  vaultCall(IPC.VAULT_WRITE_NOTE, vault.writeNote)
  vaultCall(IPC.VAULT_APPEND_NOTE, (root, rel, body, position) => vault.appendToNote(root, rel, body, position === 'start' ? 'start' : 'end'))
  vaultCall(IPC.VAULT_CREATE_NOTE, vault.createNote)
  vaultCall(IPC.VAULT_CREATE_EXCALIDRAW, vault.createExcalidraw)
  vaultCall(IPC.VAULT_CONVERT_OBSIDIAN_EXCALIDRAW, vault.convertObsidianExcalidraw)
  vaultCall(IPC.VAULT_RENAME_NOTE, vault.renameNote)
  vaultCall(IPC.VAULT_DELETE_NOTE, vault.deleteNote)
  vaultCall(IPC.VAULT_MOVE_TO_TRASH, vault.moveToTrash)
  vaultCall(IPC.VAULT_RESTORE_FROM_TRASH, vault.restoreFromTrash)
  vaultCall(IPC.VAULT_EMPTY_TRASH, vault.emptyTrash)
  vaultCall(IPC.VAULT_ARCHIVE_NOTE, vault.archiveNote)
  vaultCall(IPC.VAULT_UNARCHIVE_NOTE, vault.unarchiveNote)
  vaultCall(IPC.VAULT_DUPLICATE_NOTE, vault.duplicateNote)
  vaultCall(IPC.VAULT_MOVE_NOTE, vault.moveNote)
  vaultCall(IPC.VAULT_READ_COMMENTS, vault.readNoteComments)
  vaultCall(IPC.VAULT_WRITE_COMMENTS, vault.writeNoteComments)
  vaultCall(IPC.VAULT_SCAN_TASKS, scanAllTasks)
  vaultCall(IPC.VAULT_SCAN_TASKS_FOR, scanTasksForPath)

  // Folders.
  vaultCall(IPC.VAULT_CREATE_FOLDER, vault.createFolder)
  vaultCall(IPC.VAULT_RENAME_FOLDER, vault.renameFolder)
  vaultCall(IPC.VAULT_DELETE_FOLDER, vault.deleteFolder)
  vaultCall(IPC.VAULT_DUPLICATE_FOLDER, vault.duplicateFolder)

  // Attachments, from bytes the page holds (a pasted image) and from the vault's own assets folder.
  vaultCall(IPC.VAULT_IMPORT_PASTED_IMAGE, vault.importPastedImage)
  vaultCall(IPC.VAULT_RENAME_ASSET, vault.renameAsset)
  vaultCall(IPC.VAULT_MOVE_ASSET, vault.moveAsset)
  vaultCall(IPC.VAULT_DUPLICATE_ASSET, vault.duplicateAsset)
  vaultCall(IPC.VAULT_DELETE_ASSET, vault.deleteAsset)
  vaultCall(IPC.VAULT_RESTORE_DELETED_ASSET, vault.restoreDeletedAsset)
  vaultCall(IPC.VAULT_LIST_DELETED_ASSETS, vault.listDeletedAssets)
  vaultCall(IPC.VAULT_PURGE_DELETED_ASSET, vault.purgeDeletedAsset)
  vaultCall(IPC.VAULT_EMPTY_DELETED_ASSETS, vault.emptyDeletedAssets)

  // Databases (a CSV and its sidecar), templates and workflows: files in the vault.
  vaultCall(IPC.VAULT_OPEN_DATABASE, openDatabase)
  vaultCall(IPC.VAULT_WRITE_DATABASE_ROWS, writeDatabaseRows)
  vaultCall(IPC.VAULT_WRITE_DATABASE_SCHEMA, writeDatabaseSchema)
  vaultCall(IPC.VAULT_CREATE_DATABASE, createDatabase)
  vaultCall(IPC.VAULT_RENAME_DATABASE, renameDatabase)
  vaultCall(IPC.VAULT_CREATE_RECORD_PAGE, createRecordPage)
  vaultCall(IPC.VAULT_LIST_DATABASES, listDatabases)
  vaultCall(IPC.VAULT_LIST_TEMPLATES, listCustomTemplates)
  vaultCall(IPC.VAULT_READ_TEMPLATE, readCustomTemplate)
  vaultCall(IPC.VAULT_WRITE_TEMPLATE, writeCustomTemplate)
  vaultCall(IPC.VAULT_DELETE_TEMPLATE, deleteCustomTemplate)
  vaultCall(IPC.VAULT_LIST_WORKFLOWS, listWorkflowFiles)
  vaultCall(IPC.VAULT_WRITE_WORKFLOW, writeWorkflowFile)
  vaultCall(IPC.VAULT_DELETE_WORKFLOW, deleteWorkflowFile)
  vaultCall(IPC.VAULT_APPLY_WORKFLOW, applyWorkflowOps)
  vaultCall(IPC.VAULT_UNDO_WORKFLOW_RUN, undoWorkflowRun)
  vaultCall(IPC.VAULT_LIST_WORKFLOW_RUNS, listWorkflowRuns)
  vaultCall(IPC.VAULT_DELETE_WORKFLOW_RUNS, (root, workflowId) => {
    if (typeof workflowId !== 'string' || workflowId === '') throw new Error('deleteWorkflowRuns needs a workflow id')
    return deleteWorkflowRuns(root, workflowId)
  })
}
