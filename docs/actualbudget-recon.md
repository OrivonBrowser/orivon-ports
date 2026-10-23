# Actual Budget: recon

The measurement `apps/actualbudget/` was committed on. Upstream at `v26.10.0`, commit
`2bebdbaae0b701120a8cad9d56aafd64fa04c577`, MIT. Paths are in upstream's tree at that commit.

## Shape

An Electron app in two programs plus a backend:

- **Renderer**: `packages/desktop-client`, built by `yarn workspace @actual-app/web build --mode=desktop` into
  `build-electron/`. It reaches the backend through `window.Actual.ipcConnect`.
- **Main**: `packages/desktop-electron/index.ts` (845 lines, 15 `ipcMain` handlers). Creates the window, serves
  the renderer from `app://actual/`, forks the backend as a utility process, relays `message` between them.
- **Backend**: `packages/loot-core`, built by `yarn workspace @actual-app/core build:node`
  (`vite.desktop.config.mts`) into `lib-dist/electron/bundle.desktop.js`: CommonJS, everything bundled
  except `better-sqlite3`. Entered by `packages/desktop-electron/server.ts`, which calls `initApp(false)`.

The preload (`packages/desktop-electron/preload.ts`, 115 lines) exposes one global, `Actual`, with 23 members.
It is not a generic forwarder: one member (`ipcConnect`) carries the whole backend conversation, the rest are
named.

## The bridge: 23 members

| Bucket | Count | Members |
|---|:--:|---|
| The browser already does it | 2 | `relaunch` (reload), `openURLInBrowser` (`window.open`) |
| Constants and inert | 7 | `IS_DEV`, `ACTUAL_VERSION`, `logToTerminal`, `isUpdateReadyForDownload`, `waitForUpdateReadyForDownload`, `getServerSocket`, `isSyncServerRunning` |
| Inert setters | 2 | `onEventFromMain`, `setTheme` (no call site in the renderer) |
| Refused by name | 8 | `startSyncServer`, `stopSyncServer`, `startOAuthServer`, `openInFileManager`, `moveBudgetDirectory`, `setDocumentDir`, `reload`, `applyAppUpdate` |
| Needs the backend | 2 | `ipcConnect`, `restartElectronServer` |
| Needs a capability | 2 | `openFileDialog`, `saveFile` (`orivon.fs.userSelected`) |

Capability ratio: 2 of 23 members need an `orivon.*` capability. Bridge size: well under the 500-line stop rule.

## The escape test

`openFileDialog` returns host paths that the renderer sends back to the backend to read
(`ImportActualModal.tsx:54`, `ImportTransactionsModal.tsx:556`, `ImportYNAB4Modal.tsx:35`,
`ImportYNAB5Modal.tsx:45`, `Account.tsx:623`, `Overview.tsx:363`), and the renderer reads the extension off
them (`getFileType(res[0])`). `orivon.fs.userSelected` hands out an opaque handle, never a path. The port does
not make up a host path: it copies the picked file into the app's own folder and returns that path, which
the backend (a Worker of the same app) can open. Folder pickers (`FilesSettingsModal.tsx:24`,
`FatalError.tsx:199`) are refused: the budgets' folder is the app's own.

`saveFile` (`Export.tsx:39`, `Account.tsx:663`, `Overview.tsx:337`, `BudgetAnalysis.tsx:350`) takes contents and
a file name, so the picked folder's handle stays inside the bridge.

## What the backend needs

- **Where it keeps data**: `ACTUAL_DATA_DIR` and `ACTUAL_DOCUMENT_DIR`, read from `process.env`
  (`platform/server/fs/index.electron.ts` `getDataDir`, `server/main.ts:158`). Pointing both into the app's
  folder is an environment value, not a source change.
- **Files beside its bundle**: `default-db.sqlite`, `migrations/*` (61 files, listed by name; the six `.js`
  migrations are imported statically, only their names are listed), `rootPath` from
  `path.basename(__filename) === 'bundle.desktop.js'` (`fs/index.electron.ts:11-20`).
- **Its channel to main**: `process.parentPort.on('message', ({ data }) => ...)` and `postMessage`
  (`platform/server/connection/index.electron.ts`). Nothing else of Electron's utility process.
- **SQLite**: `better-sqlite3` (`platform/server/sqlite/index.electron.ts`): `new Database(path)`, then five
  `db.function(..., { deterministic: true })` calls (`UNICODE_LOWER`, `UNICODE_UPPER`, `UNICODE_LIKE`, `REGEXP`,
  `NORMALISE`); `db.backup(path)` in `exportDatabase`; `new Database(buffer)` in `openDatabase(pathOrBuffer)`,
  reached only from `server/cloud-storage.ts:166` (`exportBuffer`, below).
- **Network**: `globalThis.fetch` with an `origin` header (`platform/server/fetch/index.electron.ts`).
- **`exportBuffer`** (`server/cloud-storage.ts:145`) is the one place a database is opened from bytes. It runs for
  `export-budget` (`server/budgetfiles/app.ts:518`) and for `upload()` (`cloud-storage.ts:289`), the first upload
  of a local budget to a sync server.

## Verdict

A port with a small bridge. Everything the bridge needs is a named member or a picked file; the backend
runs unmodified against the Node shim. What it needs from Orivon is in `apps/actualbudget/README.md`,
section What it needs from orivon-mvp.
