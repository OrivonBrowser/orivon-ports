# ZenNotes port reconnaissance

Read against a local clone of **ZenNotes/zennotes** at `9e2c651c9bddd9dd71dcbd161a4018ce102d96cd`
(tag `v2.74.0`, MIT). Line numbers are that revision's. `orivon-port recon <clone>` finds nothing at
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
| One preload global, `zen`, with 238 members | `apps/desktop/src/preload/index.ts:254` (`const api: ZenBridge`), `:875` (`exposeInMainWorld('zen', api)`) |
| 216 distinct channels sent to main, 12 received from it | `apps/desktop/src/preload/index.ts` (`ipcRenderer.invoke`, `send`, `sendSync`; `ipcRenderer.on`) |
| 169 members called by the renderer | `grep -rhoE "window\.zen\.[A-Za-z]+" packages/app-core/src` |
| A notes folder (a "vault") is plain Markdown files, with a few folders and a `.zennotes/` directory | `apps/desktop/src/main/vault.ts:1691-1722` (`ensureVaultLayout`), `docs/reference/vault-and-folder-model.md` |
| The renderer holds vault-relative paths and never the folder's own path for reads and writes | `apps/desktop/src/main/index.ts:4135-4140` (`VAULT_READ_NOTE` takes `relPath`), `:4365` (`VAULT_WRITE_NOTE`) |
| The vault module is 4,577 lines of asynchronous `fs.promises` and no synchronous call | `apps/desktop/src/main/vault.ts` (`grep -n "Sync(" vault.ts` finds none) |
| It runs a program only for the optional ripgrep and fzf search backends | `vault.ts:2489, 2704, 2800` (`execFile`, `spawn`); the built-in backend is the default without them (`:2527-2537`) |
| The main process registers about 200 handlers in one function | `apps/desktop/src/main/index.ts:3296-5289` (`registerIpc`) |
| Most vault handlers are `fn(requireVault().root, ...args)` | `apps/desktop/src/main/index.ts:3807-4960` |
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
| `mkdir`, `readFile`, `rm`, `writeFile`, `access`, `readdir`, `rename`, `stat` | 40, 32, 30, 22, 22, 21, 19, 18 |
| `open`, `lstat`, `rmdir`, `mkdtemp`, `unlink`, `realpath`, `copyFile`, `readlink`, `symlink`, `cp`, `chmod` | 6, 6, 4, 4, 3, 3, 3, 2, 1, 1, 1 |

The synchronous forms and `fs.watch` fail on a picked path (`ENOSYS`), and the module has no
synchronous form. Its watcher (`chokidar`, `watcher.ts`) needs `fs.watch`: the port answers it with a
watcher that never reports a change (`apps/zennotes/bridge/no-watch.js`).

## What the port holds

| | |
|---|---|
| Upstream code run in the page, unmodified | `preload/index.ts`, and from `main/`: `vault.ts`, `app-config.ts`, `tasks.ts`, `templates.ts`, `databases.ts`, `workflows.ts`, `workflow-apply.ts`, `custom-themes.ts`, `overrides.ts`, `undo-history-store.ts` and what they import |
| Channels the preload sends | 216 |
| Answered by calling an upstream function on the open vault | 58 (`bridge/vault-calls.js`) |
| Answered by the port's own few lines (which folder is open, settings, paging, undo history, the app's files) | 25 of the 51 in `bridge/main-process.js`; the others are 7 answered with a value and 19 refused by name |
| Answered as upstream answers when the feature is absent, or refused by name | 109 (`bridge/channels.js`): the updater, the command line, Raycast, assistants (MCP), ZenNotes Cloud, a remote server, a second window, the tray, quick capture, opening a file from outside the vault |
| Capability flags the port turns off so the screens are not drawn | 10 (`bridge/host.js`) |

The capability ratio, members that need an `orivon.*` power over all members: the notes folder is
the one power (`orivon.fs.userSelected`, through `dialog`), and the app's own files are the other
(`orivon.fs`, through `app.getPath('userData')`). Every other member is either upstream's own
function, a value, or a refusal.

## What the port refuses, and where the seam is

| Feature | Evidence | Verdict |
|---|---|---|
| Watching the folder for changes made by another program | `main/watcher.ts` (`chokidar`) | No event: a file edited elsewhere shows when the app next reads it |
| Search with ripgrep or fzf | `main/vault.ts:2501-2537` | The built-in backend |
| Export a note to PDF or Word, show a file in the file manager, open a file in another program | `main/index.ts:4520-4620` (export, reveal, open) | Refused by name |
| Dropping a file from the computer into a note | `preload/index.ts:662-668` (`webUtils.getPathForFile`), `main/index.ts:4653` (`VAULT_IMPORT_FILES` takes host paths) | Refused: a page is never given a dropped file's path. A pasted image works |
| A note's images and other embeds | `preload/index.ts:669-696` (`zen-asset://`), `main/index.ts:5955-5978` (`protocol.handle`) | `bridge/assets.js` gives each element a `blob:` address of the file |
| The updater, the command line tool, Raycast, assistants (MCP) | `main/index.ts:5137-5208` | Answered as upstream answers when absent |
| ZenNotes Cloud, a remote ZenNotes server | `main/index.ts:3323-3580`, `:3629-3660` | Off: no network is declared |
| Spelling and grammar (Harper), custom code languages, Typst and Excalidraw fonts | `main/index.ts:6030-6083` (`zen-excalidraw:`, `zen-typst:`, `zen-harper:` schemes) | Off or without their assets: those URL schemes belong to the desktop program |
| Saving a note | `main/note-creation-metadata.ts:106` calls `crypto.randomInt` inside `writeNote` | Fails until Orivon's Node shim has it (the shim refuses it by name) |
| Deleting a note for good, emptying the trash, deleting a folder | `main/vault.ts:3764, 3793, 3821, 4183` (`fs.mkdtemp`) | Fail until the shim has `fs.promises.mkdtemp` |
| Duplicating a folder, duplicating an attachment | `main/vault.ts:4231` (`fs.cp`), `:3949` (`fs.copyFile`) | Fail until the shim has `fs.promises.cp` and `copyFile` |
| Remembering the notes folder between page loads | `main/index.ts:2246-2268` (`setVault` writes the path into the settings) | The path of a picked folder lasts until the page reloads (orivon-mvp); the folder is chosen again |

## Verdict

**A target.** The bridge is upstream's own preload plus answers for its calls: 800 lines across
fourteen files (about 330 of them logic), none over 130 lines, most of the rest one line per channel. The folder the
person picks works through the stand-in path, so the notes stay ordinary files in it. Not a target
would have been a bridge written member by member over `orivon.fs.userSelected` (about 60 members
with logic upstream keeps in a 4,577-line module), and this port avoids that by running the module.
