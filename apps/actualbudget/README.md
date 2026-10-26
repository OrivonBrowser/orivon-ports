# Actual Budget

## About this build

**A community build by Orivon of Actual Budget's desktop app, not the official Actual Budget.** Actual is a local-first personal finance app: envelope budgeting, accounts, transactions, rules, schedules and reports, with every budget kept as a database on the person's own device. This directory holds the recipe that builds it to run in Orivon; the upstream project did not make this build. Budgets are kept in the app's own folder, so a budget survives reloading the tab and restarting Orivon.

| | |
|---|---|
| Official project | [github.com/actualbudget/actual](https://github.com/actualbudget/actual) |
| Official downloads | <https://actualbudget.org/docs/install/desktop-app/> |
| Pinned upstream | v26.10.0, commit `2bebdbaae0b7` |
| This build's version | 26.10.0 (upstream 26.10.0, no build number yet) |
| Licence | MIT, upstream's own, served at `/LICENSE`; see [`UPSTREAM.md`](UPSTREAM.md) |
| Status | Early access |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| In another browser | This page shows a landing instead of the app, because the app runs its backend inside Orivon, which another browser cannot. |
| Updates | When upstream releases a new version, the pin is moved and the build is redone ([maintaining a port](../../.claude/skills/orivon-porting/maintain.md)); there is no schedule. |
| Problems | [Report a problem with this build](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=Actual%20Budget): it goes to this repository's issue form, not to the upstream project's tracker. |

What works: budgets, accounts, transactions, search, filters, rules, schedules, reports, importing files, exporting a budget (Settings, Export data saves a zip in a folder you pick), saving an account's transactions as a CSV file, putting a new budget on a sync server, and downloading a budget that is already on one and keeping it in sync, both ways.

Known gaps in this build:

- **Interface languages other than English** are not in the build: upstream fetches its translations from a separate repository when it packages the desktop app, and this build does not.
- **Hosting a sync server from the app, an OpenID sign-in that returns to the app, moving the budgets' folder, showing a file in the file manager and the app's own update check** are refused by name: each belongs to Electron's main process (see Design notes).
- **A sync server with a self-signed certificate** cannot be used: the desktop app's certificate picker is not offered, and Orivon checks a server's certificate against its own trust store.
- **Only one tab of the app runs the backend.** A second tab shows Actual's fatal-error screen, with the reason under Show Error.
- **Orivon's file picker does not filter by file type.** Choosing a file of the wrong kind gives Actual's own parse error.
- **Actual's update check and news feed** call GitHub from the page; where that is unreachable each prints one line to the console.

The sections below are for people working on the build.

**What lives here.** Actual's desktop app as an Orivon app: a recipe, a manifest, a build that bundles upstream's own backend for Orivon's Node shim, a small entry for that backend, the page's side of the backend (which forks it), and the 23-member `window.Actual` bridge. **No Actual source and no build output is in this repository**: see [`UPSTREAM.md`](UPSTREAM.md) for its licence and pin. The recon is [`docs/actualbudget-recon.md`](../../docs/actualbudget-recon.md).

## Running it

```bash
orivon-port run actualbudget
```

Then open `http://127.0.0.1:8888` in Orivon and accept the prompt, or `actualbudget.orivonstack.eth` with the names file (the repository [`README.md`](../../README.md), Opening it by name). The build runs upstream's yarn scripts, so it needs `ORIVON_MVP_ROOT` (see the end of this page) and about 5 GB of memory; the first build installs upstream's whole monorepo.

## How it works

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Pin, install, upstream's own desktop build steps, then `esbuild.orivon.config.mjs` |
| [`esbuild.orivon.config.mjs`](esbuild.orivon.config.mjs) | Copies upstream's renderer as its `update-client` does, bundles the backend and the page's side of it, writes the install tree |
| [`bridge/server-entry.js`](bridge/server-entry.js) | What upstream's `desktop-electron/server.ts` does, in a forked child: starts the engine, imports upstream's `bundle.desktop.js` unchanged, calls `initApp` |
| [`bridge/parent-port.js`](bridge/parent-port.js) | `process.parentPort`, the two members upstream's backend uses, over the fork's channel |
| [`bridge/backend-client.js`](bridge/backend-client.js) | The page's side: forks the backend as the page loads, writes the install tree while it boots, relays messages, holds them until both are done, one backend at a time |
| [`bridge/status-line.js`](bridge/status-line.js) | The one-line status shown over the renderer when a start takes more than a moment |
| [`bridge/file-dialogs.js`](bridge/file-dialogs.js) | `openFileDialog` and `saveFile` over Orivon's pickers |
| [`bridge/members.json`](bridge/members.json), [`bridge/actualbudget.js`](bridge/actualbudget.js) | `window.Actual`: 23 members, 10 written by hand, 13 declared |
| [`bridge/plan.js`](bridge/plan.js), [`bridge/build-checks.js`](bridge/build-checks.js) | The decisions the page and the build both rely on, and what the build refuses |
| [`hooks.mjs`](hooks.mjs) | A `<base href="/">` and the page's script, added to the renderer's HTML |

Upstream runs the renderer in a window and the backend (`packages/loot-core`) in an Electron utility process, and the two talk through `window.Actual.ipcConnect` and `process.parentPort`. Here the renderer is upstream's own Electron renderer build, the backend is upstream's own Electron backend bundle (CommonJS, built by upstream's scripts), and Orivon's Node shim stands in for Node: `better-sqlite3` is Orivon's adapter over SQLite compiled to WebAssembly, and the budget database is a file in the app's folder. The five SQL functions Actual registers (`UNICODE_LOWER`, `UNICODE_UPPER`, `UNICODE_LIKE`, `REGEXP`, `NORMALISE`) run through the adapter's `db.function`, which is what makes search case- and accent-insensitive and a rule's regular expression match.

**Where data lives.** In the app's own files, never in the served tree: `actual-documents/Actual/<budget>/db.sqlite` (one folder per budget), `actual-data/` (Actual's global preferences), `actual-install/<stamp>/` (the database template and the migrations the backend reads beside its bundle, written by the page from one served `install/pack.bin`), and `actual-imports/` (copies of the files the person picked). Clearing the app's site data removes all of it.

## What it is granted, and why

[`orivon.json`](orivon.json) is what the consent dialog renders. `consentGranularity` is `all-or-nothing`. The prompt reads, in Orivon's words (captured from a run):

- "⚠ Unlimited network access: load anything from any website, without the browser's usual limits"
- "Store files in a private folder for this app on this device"

| Grant | Value | Why |
|---|---|---|
| `crossOriginIsolated` | `true` | The backend runs in a Worker, and its synchronous file calls (the database) need a cross-origin isolated app |
| `net.https.connect` | `*:*` | The host of the person's own sync server is typed at run time, so no host can be named. A `*:*` pattern never reaches a loopback or private address |
| `fs.quotaBytes` | 512 MiB | The budgets, the install tree, the copies of picked files |

No listener, no embedded page, no device.

## Design notes

**The backend is upstream's, unchanged.** Upstream's desktop build already produces one CommonJS file with everything bundled except `better-sqlite3` (`vite.desktop.config.mts`). The build re-bundles that file with esbuild and orivon-mvp's plugin, which points every Node builtin and `better-sqlite3` at the shim. The one thing the file asks of its location is `path.basename(__filename) === 'bundle.desktop.js'`, to find the files beside it (`fs/index.electron.ts`), so `esbuild.orivon.config.mjs` gives that file its `__dirname` and `__filename` on its first line, under the install tree in the app's files. Not one character of upstream's text is changed. The shim is part of the bundle: the build reads it from `ORIVON_MVP_ROOT` and the bundle carries it, so the SQL functions work on the Orivon that runs the bundle without the browser itself having them built.

**The page forks the backend; there is no launcher page.** The renderer is the app's page. A classic script (`orivon/actual-backend.js`, bundled from `bridge/backend-entry.js` with the shim's `child_process`, `fs` and `fetch`) is added to the renderer's HTML, and the bridge's `ipcConnect` hands the renderer's messages to it. The backend starts when that script loads, while the renderer is still loading, not at the renderer's first message; messages wait until the backend has said `initApp` has returned (a message sent to a child before its listener exists is lost) and the install tree is written.

**The install tree is written while the backend boots.** `initApp` reads nothing from the install tree: the database template and the migrations are read when a budget is created or opened, and no message reaches the backend before both halves are done. The tree is one `install/pack.bin` and an `install/install.json` (stamp, names, sizes), so a first start fetches two files, and it is written by eight lanes held to 60 broker calls a second (the broker's limit per origin is 100). A later start finds the marker `install.json` in the app's files, written last, and fetches nothing.

**A page without the `fs` grant starts nothing.** On a first visit the page runs as an ordinary website until the person answers, and then reloads as the app. The backend script's first call to the app's files is the check: refused, it holds no lock, forks nothing and reports nothing until the renderer's first message, which gets a failure that says the page has not been allowed to keep files. A later message tries again, so a grant that arrives without a reload is used.

**A status line, outside the renderer's root.** `bridge/status-line.js` shows "Starting Actual…" or "Setting up Actual on this device… (n of N files)" on the document element once a start has taken 1.5 seconds, and removes it at ready or at a failure. It is not part of Actual's page and changes none of its source.

**One backend at a time.** Two backends would each hold the budget's database open, and Orivon's SQLite has no locking between connections. The page holds a Web Lock for its life and ends the backend when the page is hidden; a second page gets the failure upstream's renderer already knows how to show. A reload waits briefly for the lock the previous page held.

**A file dialog returns a path the backend can read, not a host path.** `showOpenDialog` hands upstream's renderer host paths that it sends back to the backend to read, and `orivon.fs.userSelected` never returns a path (`docs/porting-guide.md`, the escape test). The bridge copies the picked file into the app's own folder and answers that path, a real path in the backend's own file system, with the file's name and extension kept (the renderer reads the extension). Folders are never picked. `saveFile` takes contents and a name, so the picked folder's handle stays in the bridge. A save is called after the backend built the file, which can be seconds after the click, and Orivon's picker needs a recent click: a refusal for that shows a button of the page's own, and the pick happens inside its click.

**The renderer's user agent is not Electron's.** Orivon removes the `Electron/` token, so Actual's `isElectron()` is false and the renderer shows the screens of its browser build for choosing a server (connect to a server, use the current domain), while still talking to the backend through `ipcConnect`. The settings screens that exist only in the desktop app (the embedded server, the budget folder, backups) are not offered; the bridge refuses their members by name in case a build offers them.

**`<base href="/">`.** The renderer is history-routed, so a tab can be reloaded at `/accounts/<id>`, and every URL `prepare` injects is relative to the entry document. The hook puts the base before `<head>`, which makes it the head's first child, ahead of the injected scripts. Without it a reload at a route two segments deep loses the bridge and shows the fatal-error screen.

**Upstream's build steps, with the heap capped.** `recipe.json` runs `crdt`, `plugins-service`, `core build:node` and `web build --mode=desktop` as `bin/package-electron` does, each with `--max-old-space-size=3584`: `heavy`'s 5 GB cap kills a larger heap. The sync-server and Electron packaging steps are not run.

## What it needs from orivon-mvp

Catalogue rows (`../orivon-mvp/test/app-behaviours/catalogue.md`) the port relies on:

- `fork-runs-module-in-worker`, `forked-child-ends-with-last-page`
- `node-sqlite-in-worker`, `sqlite-user-functions`, `sqlite-backup-to-app-files`, `sqlite-database-from-bytes`
- `node-fs-writes-land-at-app-root`, `node-fs-ancestors-of-the-files-root-exist`, `app-files-survive-restart`, `fs-confined-to-app-root`, `fs-quota-refuses-past-limit`
- `user-picked-file-and-folder-handles`, `electron-dialog-paths-read-and-write-the-pick`
- `cross-origin-isolated-when-declared`, `blob-worker-runs`, `web-lock-if-available-follows-the-holder`, `pagehide-fires-on-tab-close`
- `loopback-manifest-hint-grants-the-origin`, `plain-http-grant-is-session-scoped`, `routed-fetch-reaches-granted-hosts`

Also, with no catalogue row yet:

- a forked child's `fetch` to a host granted on `https.connect`, with a custom request header and a request body, answered with the server's own CORS headers. A sync to a local server was run with a certificate that Chromium was told to trust, because a Worker's request is dialled by Chromium's network stack, not by Node's;
- `child_process.fork(..., { serialization: 'advanced' })` carrying a `Uint8Array` both ways.

At build time, an esbuild plugin at `$ORIVON_MVP_ROOT/src/shim/bundler/esbuild-plugin.ts` exporting `orivonShimPlugin()`, `shimAssets()` and `virtualRoot`.
