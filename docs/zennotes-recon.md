# ZenNotes port reconnaissance

Read against a local clone of **ZenNotes/zennotes** at `9e989aade4f01e14c69c641af7db964abc2f6c3f`
(tag `v2.83.0`, MIT). Line numbers are that revision's. `orivon-port recon <clone>` finds nothing at
the clone's root (a monorepo: `apps/desktop`, `apps/web`, `packages/*`), and finds six of the
preload's members at `apps/desktop`, because the renderer lives in `packages/app-core`. The counts
below are from reading the preload and the main process.

## The shape: a notes folder behind a wide preload

| Fact | Evidence |
|---|---|
| A monorepo of one renderer and several hosts | `package.json` (`workspaces`), `docs/monorepo-architecture.md` |
| The renderer is `packages/app-core`, shared by the desktop app and the web client | `docs/monorepo-architecture.md`, `apps/desktop/electron.vite.config.ts` (`renderer.resolve.alias` `@renderer`) |
| The web client talks to a Go server and has no notes folder of its own | `docs/web-architecture.md` (Mode A), `docs/monorepo-architecture.md` (Deployment Modes) |
| The desktop app is `electron-vite`: main, preload and renderer | `apps/desktop/electron.vite.config.ts`, `apps/desktop/package.json` (`build`) |
| One preload global, `zen`, with 264 members | `apps/desktop/src/preload/index.ts:271` (`const api: ZenBridge`), `:939` (`exposeInMainWorld('zen', api)`) |
| 239 distinct channels sent to main, 15 received from it | `apps/desktop/src/preload/index.ts` (`ipcRenderer.invoke`, `send`, `sendSync`; `ipcRenderer.on`) |
| 192 members called by the renderer | `grep -rhoE "window\.zen\.[A-Za-z]+" packages/app-core/src` |
| A notes folder (a "vault") is plain Markdown files, with a few folders and a `.zennotes/` directory | `apps/desktop/src/main/vault.ts:1779-1811` (`ensureVaultLayout`), `docs/reference/vault-and-folder-model.md` |
| The renderer holds vault-relative paths and never the folder's own path for reads and writes | `apps/desktop/src/main/index.ts:4498` (`VAULT_READ_NOTE` takes `relPath`), `:4728` (`VAULT_WRITE_NOTE`) |
| The vault module is 4,680 lines of asynchronous `fs.promises` and no synchronous call | `apps/desktop/src/main/vault.ts` (`grep -n "Sync(" vault.ts` finds none) |
| It runs a program only for the optional ripgrep and fzf search backends | `vault.ts:2581, 2796, 2892` (`execFile`, `spawn`); the built-in backend is the default without them (`:2619-2625`) |
| The main process registers about 200 handlers in one function | `apps/desktop/src/main/index.ts:3588-5674` (`registerIpc`) |
| Most vault handlers are `fn(requireVault().root, ...args)` | `apps/desktop/src/main/index.ts:4020-5286` |
| The renderer gates screens on `getCapabilities()` | `packages/app-core/src/components/SettingsModal.tsx:663`, `lib/commands.ts:261`, `lib/cloud-auto-sync.ts:223` |

## The deciding question: does a folder the person picks work?

`vault.ts` is written in paths (`path.join(root, ...)`), and the renderer is not, so the escape test
(`docs/porting-guide.md`) passes: the renderer asks for "the note at `inbox/a.md`", and the folder
stays in main. What Orivon gives instead of a host path is `dialog.showOpenDialog`'s stand-in path
for a picked folder, `/orivon/picked/<id>`, which the Node shim's `fs` reads and writes through the
pick's handle (orivon-mvp ADR-0091). Upstream's own vault module therefore runs unmodified on it,
bundled for the page, with `root` set to that path.

| `fs` call in the vault module and what it needs | Count in the main-process modules the bundle holds |
|---|---|
| `rm`, `mkdir`, `readFile`, `readdir`, `rename`, `access`, `writeFile`, `stat` | 48, 48, 39, 32, 27, 26, 24, 21 |
| `lstat`, `open`, `rmdir`, `realpath`, `readlink`, `mkdtemp`, `unlink`, `copyFile`, `symlink`, `cp`, `chmod` | 10, 8, 8, 4, 4, 4, 3, 3, 2, 1, 1 |

The synchronous forms and `fs.watch` fail on a picked path (`ENOSYS`), and the module has no
synchronous form. Its watcher (`chokidar`, `watcher.ts`) needs `fs.watch`: the port answers it with a
watcher that never reports a change (`apps/zennotes/bridge/no-watch.js`).

## What the port holds

| | |
|---|---|
| Upstream code run in the page, unmodified | `preload/index.ts`, and from `main/`: `vault.ts`, `app-config.ts`, `tasks.ts`, `templates.ts`, `databases.ts`, `workflows.ts`, `workflow-apply.ts`, `custom-themes.ts`, `overrides.ts`, `undo-history-store.ts` and what they import |
| Channels the preload sends | 239 |
| Answered by calling an upstream function on the open vault | 58 (`bridge/vault-calls.js`) |
| Answered by the port's own few lines (which folder is open, settings, paging, undo history, the app's files) | 25 of the 52 in `bridge/main-process.js`; the others are 7 answered with a value and 20 refused by name |
| Answered as upstream answers when the feature is absent, or refused by name | 131 (`bridge/channels.js`): the updater, the command line, Raycast, assistants (MCP), the Notion and Obsidian imports, Unsplash, task reminders, ZenNotes Cloud, a remote server, a second window, the tray, quick capture, opening a file from outside the vault |
| Capability flags the port turns off so the screens are not drawn | 11 (`bridge/host.js`) |

The capability ratio, members that need an `orivon.*` power over all members: the notes folder is
the one power (`orivon.fs.userSelected`, through `dialog`), and the app's own files are the other
(`orivon.fs`, through `app.getPath('userData')`). Every other member is either upstream's own
function, a value, or a refusal.

## What the port refuses, and where the seam is

| Feature | Evidence | Verdict |
|---|---|---|
| Watching the folder for changes made by another program | `main/watcher.ts` (`chokidar`) | No event: a file edited elsewhere shows when the app next reads it |
| Search with ripgrep or fzf | `main/vault.ts:2593-2625` | The built-in backend |
| Export a note to PDF or Word, show a file in the file manager, open a file in another program | `main/index.ts:4883-5286` (export, reveal, open) | Refused by name |
| Dropping a file from the computer into a note | `preload/index.ts:719-722` (`webUtils.getPathForFile`), `main/index.ts:5016` (`VAULT_IMPORT_FILES` takes host paths) | Refused: a page is never given a dropped file's path. A pasted image works |
| A note's images and other embeds | `preload/index.ts:741-752` (`zen-asset://`), `main/index.ts:6340` (`protocol.handle`) | `bridge/assets.js` gives each element a `blob:` address of the file |
| The updater, the command line tool, Raycast, assistants (MCP) | `main/index.ts:3919`, `:5523-5593` | Answered as upstream answers when absent |
| ZenNotes Cloud, a remote ZenNotes server | `main/index.ts:3624` (`CLOUD_ACCOUNT_GET`), `:3991` (`WORKSPACE_CONNECT_REMOTE`) | Off: no network is declared |
| Spelling and grammar (Harper), custom code languages, Typst and Excalidraw fonts | `main/index.ts:371-380`, `:6366-6468` (`zen-excalidraw:`, `zen-typst:`, `zen-harper:` schemes) | Off or without their assets: those URL schemes belong to the desktop program |
| Importing from Notion or Obsidian | `main/index.ts:3924-3968`, `main/obsidian-import.ts`, `main/notion-import.ts` | Off (`supportsImport`): Notion needs the network, and the Obsidian copy is staged under the app's own files and moved into the vault |
| Unsplash cover search and its access key | `main/index.ts:3969-3980`, `main/secret-store.ts:422-462` | The search is refused by name, so the cover picker's tab reports it unavailable; a key cannot be saved |
| Task reminders (OS notifications) | `main/index.ts:5491` (`TASK_REMINDERS_SET`), `preload/index.ts:824-830` | The two preload members are removed, so the Reminders settings are not drawn |
| Remembering the notes folder between page loads | `main/index.ts:2532` (`setVault` writes the path into the settings) | The path of a picked folder lasts until the page reloads (orivon-mvp); the folder is chosen again |

## Verdict

**A target.** The bridge is upstream's own preload plus answers for its calls: 1,132 lines across
eighteen files, the longest 218, most of the rest one line per channel. The folder the
person picks works through the stand-in path, so the notes stay ordinary files in it. Not a target
would have been a bridge written member by member over `orivon.fs.userSelected` (about 60 members
with logic upstream keeps in a 4,680-line module), and this port avoids that by running the module.
