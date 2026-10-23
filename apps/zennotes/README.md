# ZenNotes

## About this build

**A community build by Orivon of ZenNotes, not the official ZenNotes.** ZenNotes keeps notes as ordinary Markdown files in a folder; here the folder is one you pick in Orivon, and upstream's own editor, search, tasks and databases work on those files. This directory holds the recipe that builds it to run in Orivon; the upstream project did not make this build.

| | |
|---|---|
| Official project | [github.com/ZenNotes/zennotes](https://github.com/ZenNotes/zennotes) |
| Official downloads | <https://github.com/ZenNotes/zennotes/releases/latest> |
| Pinned upstream | 2.74.0 (v2.74.0), commit `9e2c651c9bdd` |
| This build's version | 2.74.0; a published build adds a build number (2.74.0.1) |
| Licence | MIT, upstream's own; see [`UPSTREAM.md`](UPSTREAM.md) |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| In another browser | This page shows a landing instead of the app, because the app needs Orivon to pick and write the notes folder. |
| Updates | When upstream releases a new version, the pin is moved and the build is redone ([maintaining a port](../../.claude/skills/orivon-porting/maintain.md)); there is no schedule. The app's own update screen is hidden. |
| Problems | [Report a problem with this build](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=ZenNotes): it goes to this repository's issue form, not to the upstream project's tracker. |

What works, driven in a real Orivon shell on the build from this recipe: choosing a folder; listing, opening and
reading its notes (a first-run welcome, Home, Inbox, Quick Notes, Archive, Trash, Assets, Tasks, Atlas, Help and Settings
screens); preview, split and edit; a note's embedded image; renaming, moving, duplicating, archiving, unarchiving, trashing
and restoring a note; creating, renaming and moving into a folder; pasting an image and renaming and deleting an
attachment (with its undo); deleting a note or a folder for good, emptying the trash, duplicating a folder or an attachment; databases,
templates, tasks and search; the folder's own settings; the demo tour; saving a note, reloading the tab, choosing the folder
again and reading the edit back. These need an Orivon whose Node shim has `crypto.randomInt`, `fs.mkdtemp`, `fs.cp` and
`fs.copyFile`: they are in orivon-mvp `main`, and a released Orivon has them from the first release after v0.0.9. The port
bundles the shim at build time, so a build made against an older orivon-mvp cannot save a note.

Known gaps in this build:

- **A custom theme made with "New theme" did not appear in the theme list** when driven; the cause is not known.
- **The notes folder is chosen again each time the page loads.** Orivon has no way to give a page back a folder it was given in an earlier visit without showing the folder dialog again, so ZenNotes opens on its welcome screen and the person picks the same folder.
- **A change made to a note by another program shows when the app next reads the file**, not at once: the folder watcher needs `fs.watch`, which Orivon's `fs` answers with an error.
- **Dropping a file from the computer into a note** is refused; a pasted image works, and an image already in the folder's `assets/` is shown.
- **ZenNotes Cloud, a remote ZenNotes server, assistants (MCP), the command line tool, Raycast, extra windows, the tray, quick capture, PDF and Word export, spelling and grammar checking, custom code languages and showing a file in the file manager** are not in this build. The screens for most of them are hidden; the Settings pages for assistants and the command line say they are unavailable, and the rest refuse by name.
- **The title bar's window buttons do nothing**: upstream draws its own title bar with minimize, maximize and close, and a tab has no window to act on. "Show window title bar" in Settings turns it off.
- **ZenNotes writes `.zennotes/` into the folder** (`workspace.json`, a note-metadata cache and the vault's own settings), as upstream's own app does.

The sections below are for people working on the build.

The Markdown notes app, as an Orivon app: **upstream's own renderer, its own preload and the
main-process modules that read and write a notes folder run in the page**, and the folder is one the
person picks in Orivon's own folder dialog. This directory holds a recipe, a manifest, an esbuild
config, a hook and a `bridge/` directory (the build's decisions in `build-plan.js`, the answers to
the preload's calls, and two stand-ins).

- Upstream: `ZenNotes/zennotes` v2.74.0, pinned in [`recipe.json`](recipe.json), MIT.
  [`UPSTREAM.md`](UPSTREAM.md) says what crosses into this repository (nothing of theirs).
- Reconnaissance, with `file:line` evidence: [`../../docs/zennotes-recon.md`](../../docs/zennotes-recon.md).
- Served at `http://127.0.0.1:8881` by `orivon-port serve`; the declared name is `zennotes.orivonstack.eth`.

## Running it

It needs a checkout of **orivon-mvp** beside this repository, because the bundle is built against
orivon-mvp's Node and `electron` shims:

```bash
ORIVON_MVP_ROOT=/path/to/orivon-mvp node src/cli.ts run zennotes
```

`ORIVON_MVP_ROOT` defaults to `../orivon-mvp` relative to this repository, and the build stops with a
message naming the variable when `src/shim/bundler/esbuild-plugin.ts` is not there. The build takes
several minutes: it clones upstream, installs the monorepo with `npm ci` (without running install
scripts or downloading Electron), runs upstream's `electron-vite build`, then this port's
[`esbuild.orivon.config.mjs`](esbuild.orivon.config.mjs).

Open the served URL in Orivon and accept the prompt. ZenNotes shows its welcome screen; **Choose vault
folder** opens Orivon's folder dialog, and the folder you pick is the vault. A new, empty folder gets
ZenNotes' usual layout (`inbox`, `quick`, `archive`, `trash`) and a first note. An existing folder of
Markdown files is read as it is.

## What it is granted, and why

[`orivon.json`](orivon.json) is what the consent dialog renders. `consentGranularity` is
`all-or-nothing`. The prompt reads "This app wants to:" with one row, **Store files in a private
folder for this app on this device**, and the buttons Close and Grant all.

| Grant | Value | Why |
|---|---|---|
| `fs.quotaBytes` | 64 MiB | The app's own files: the settings file, custom themes, and the per-note undo history people can turn on. Not the notes |

**The notes folder is not a grant.** It is the answer to Orivon's folder dialog, which the app can
open only after a click or key press and which refuses the home folder itself, a filesystem root and
the browser's own data. The app is given that one folder and nothing around it.

**No network is declared.** Nothing the notes need goes over the network, so a link preview is not
fetched, and an image or video a note embeds from a web address does not load. ZenNotes Cloud and a
remote server need `https.connect`, which this manifest does not ask for.

## How it is built

Upstream's `electron-vite build` runs as it is (`recipe.json` `build.command`) and writes its three
targets; the renderer, `apps/desktop/out/renderer`, is what is served. Then
[`esbuild.orivon.config.mjs`](esbuild.orivon.config.mjs) writes `orivon/zennotes.js` beside it, one classic
script made from:

1. **`bridge/page-entry.js`**, which first imports `register.js` (the answers to the preload's calls),
   then upstream's `apps/desktop/src/preload/index.ts` unmodified, which builds `window.zen`, then
   starts the settings and the app's files.
2. **Upstream's main-process modules**, imported by `bridge/vault-calls.js`, `bridge/main-process.js`
   and `bridge/channels.js` from the clone (`vault.ts`, `app-config.ts`, `tasks.ts`, `templates.ts`,
   `databases.ts`, `workflows.ts`, `workflow-apply.ts`, `custom-themes.ts`, `overrides.ts`,
   `undo-history-store.ts`, `external-urls.ts`).

[`hooks.mjs`](hooks.mjs) puts the bundle first in the built `index.html`'s head and moves the one
`<script type="module">` that starts the renderer to `orivon/zennotes-start.js`, which waits for the
bundle's start-up work. The renderer reads the settings synchronously the moment it starts
(`getConfigSync`), and the settings are read from the app's files, which takes a turn.

The build fails when the preload sends a channel nothing in `bridge/` names, when a module it must
hold is missing, and when a stand-in did not take effect (`build-plan.js`, `bridge/build-plan.test.ts`).

## The main process

Upstream's main process is one 6,343-line file whose `registerIpc` function answers about 200
channels, most of them `fn(requireVault().root, ...args)`. None of that file runs. What answers the
preload's 216 channels instead:

| Where | Channels | What they are |
|---|---|---|
| `bridge/vault-calls.js` | 58 | `vaultCall(IPC.X, upstream.fn)`: upstream's own `vault.ts`, `tasks.ts`, `templates.ts`, `databases.ts`, `workflows.ts` and `workflow-apply.ts` functions, called with the open vault's folder first |
| `bridge/main-process.js` | 51 | 25 with logic of the port's own (which folder is open, the vault's settings, the list-notes stream, workspace state, undo history, the settings file, custom themes and overrides), 7 answered with a value, and 19 refused by name (what leaves the vault, custom code languages, the folder-reveal and settings-reveal calls) |
| `bridge/channels.js` | 109 | Window and tray controls, the updater, the command line, Raycast, assistants, ZenNotes Cloud and a remote server: each answered as upstream answers when the feature is absent or signed out, or refused by name |

`bridge/ipc-kit.js` has the five ways a channel is answered (`handle`, `listen`, `sync`, `answer`,
`refused`). A refusal rejects with an error named `OrivonPortRefusal` and a sentence the app shows as
it shows any failure. `bridge/session.js` is the part of upstream's main process that remembers which
vault is open; it is pure, and `session.test.ts` runs it without upstream's source.

**Which screens are hidden.** The renderer decides what to draw from `getCapabilities()`, which the
preload answers for the desktop program. `bridge/host.js` turns ten flags off (`CAPABILITY_OVERRIDES`):
the updater, native menus, extra windows, a remote workspace, ZenNotes Cloud, the command line tool,
custom code languages, spelling and grammar, assistant edit review and the encrypted backup archive.
`supportsLocalFilesystemPickers`, `supportsCustomTemplates`, `supportsWorkflows` and
`supportsUndoFile` stay on.

## What this port does not do

- **Watch the folder.** `bridge/no-watch.js` stands in for `chokidar`, which watches with `fs.watch`.
- **Show a file in the file manager, or open one in another program.** Refused by name.
- **Export to PDF or Word, or import and export a workflow file.** Refused by name.
- **Run ripgrep or fzf.** The search capabilities answer that neither is installed, and upstream's
  built-in backend searches.
- **Load assets that come through the desktop program's own URL schemes** (`zen-theme:`,
  `zen-excalidraw:`, `zen-typst:`, `zen-harper:`). A note's images, audio and video come through
  `bridge/assets.js` instead.
- **Remember the notes folder** between page loads (see the known gaps above).

## Design notes

**The vault module runs in the page, instead of a member per call.** The preload has 238 members and
the main process keeps the logic for the notes in `vault.ts`, 4,577 lines that use only asynchronous
`fs.promises` calls. A bridge written member by member would be a copy of that module. Bundled for the
page and handed the stand-in path of the folder the person picked (`/orivon/picked/<id>`, which
orivon-mvp's `fs` reads and writes through the pick's handle), it is upstream's behaviour on upstream's
files, and a new upstream release keeps working until it adds a channel.

**Upstream's preload runs too.** It builds `window.zen`, so the renderer's calls and the shapes they
return are upstream's, including the list-notes stream the preload pages through. Its `electron`
imports go to `bridge/electron.js`, which is orivon-mvp's shim plus `contextBridge` (it publishes the
object on `window`) and `webUtils` (it answers no path, because a page is never given the path of a
file dropped on it).

**The part of the main process that answers is split by what a channel does.** A channel whose answer
is "call upstream's function on the vault's folder" is one line in `vault-calls.js`. A channel that
chooses something is in `main-process.js`: `VAULT_PICK` is the only place a folder is picked, and
`session.open` is the only place one becomes the vault. A channel for a feature the build lacks is in
`channels.js`, answered with the value upstream's main returns when the feature is signed out or not
installed, so a screen that asks at start-up can draw it.

**A page reload forgets the folder, on purpose.** Upstream writes the vault's path into its settings
and opens it again next time. A stand-in path lasts until the page reloads, so `session.js` keeps the
vaults opened since the page loaded in memory and writes none of them anywhere; the settings file
holds nothing about the folder. A folder with no name of its own is called "Notes folder", because
the folder dialog gives the page no name for it and the path ends in the pick's id.

**A note's images are swapped in the page.** The preload makes `zen-asset://local?path=<file>`, an address
only the desktop program's URL scheme answers. `bridge/assets.js` watches the page and gives each such
element a `blob:` address of the file's bytes. The element names the `zen-asset:` address for one moment first,
which the page's policy refuses and logs.

**The `electron` stand-in is imported by upstream's code only.** `STAND_INS` in `build-plan.js` is
applied to importers inside the clone, so the stand-in's own import of the shim's `electron` is not
caught by it.

**The renderer starts after the bundle's start-up work.** `hooks.mjs` replaces the document's module
script with a classic script that imports the same module once `globalThis.__zennotesReady` settles. The
import address is read from the document, not from the directory the start script sits in.

**Native modules are refused by name.** `keytar`, `font-list` and `fsevents` resolve to a module that
throws `MODULE_NOT_FOUND`, which is what upstream's own optional-dependency paths expect.

## What it needs from orivon-mvp

- A folder picked with `dialog.showOpenDialog({ properties: ['openDirectory'] })` read and written through its stand-in path
  by `readdir`, `stat`, `readFile`, `writeFile`, `mkdir`, `rename`, `rm`, `access` and `open`. Catalogue
  rows `electron-dialog-paths-read-and-write-the-pick` and `user-picked-file-and-folder-handles`.
- `ipcRenderer.invoke`, `send`, `sendSync` and `on` against `ipcMain` handlers in the same page. Catalogue row
  `electron-ipc-send-sync-answers-from-the-listener`.
- The app's own files, written and read after a reload, within a quota. Catalogue rows `fs-confined-to-app-root`,
  `fs-quota-refuses-past-limit` and `app-files-survive-restart`.
- A module script started from a classic script by a dynamic `import()`, and a classic script first in the head
  running before it.
- `blob:` addresses for images, audio and video in the page, and `blob:` workers (`blob-worker-runs`).
- `crypto.randomInt` (upstream's `note-creation-metadata.ts` calls it on every write to a note), and `fs.promises.mkdtemp`,
  `cp` and `copyFile` on the app's own files and on a path inside a picked folder (`vault.ts` deletes with `mkdtemp`, duplicates a
  folder with `cp` and an attachment with `copyFile`). They are in the Node shim of orivon-mvp `main`; the shim is bundled
  into the port when it is built.

Not yet proven by a catalogue row: `rename`, `rm`, `access` and the write-a-temporary-file-then-rename-over-the-target
sequence on a path inside a picked folder (the row above lists the calls it covers, and these are not among them).
