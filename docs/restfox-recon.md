# Restfox port reconnaissance

Read against **flawiddsouza/Restfox** at `0fffd36d2f95dc6c5efd890469f2f1a6433ff433` (tag v0.41.0,
MIT). Line numbers are that revision's. `orivon-port recon` does not give the answer here: it was
pointed at `packages/electron` and found a forwarder with no traceable members, and at
`packages/ui` and found no preload at all. The preload is in one package and the renderer in the
other, so this note counts by hand.

## The shape: a Vue page over a narrow preload

| Fact | Evidence |
|---|---|
| A monorepo: `packages/ui` is the page, `packages/electron` the desktop shell | `package.json` scripts (`ui:build-desktop`, `electron:build`) |
| The renderer has an Electron build mode of its own, `desktop-electron` | `packages/ui/package.json:10` (`build-desktop-electron`), `packages/ui/vite.config.js:141` |
| That mode is what the desktop app loads: it copies the build into `packages/electron/ui` | `packages/ui/vite.config.js:141-143`, `packages/electron/src/app.js` (`loadURL` of `../ui/index.html`) |
| The preload publishes one global, `electronIPC`, built from a list of 34 names plus `workspaceChanged` | `packages/electron/src/preload.js:3-49` |
| 34 `ipcMain` handlers answer them | `packages/electron/src/app.js` (`ipcMain.handle`) |
| The renderer reads the mode at 19 places (`import.meta.env.MODE`, tests left out) and calls `electronIPC.<member>` at 14 | `packages/ui/src/db.ts:63`, `helpers.ts:457,656,692,696`, `App.vue:77-87,479-504`, `NavBar.vue:342-352`, `AddWorkspaceModal.vue:171` |
| The renderer imports no Node builtin and no `electron` | `orivon-port recon packages/ui`: none |

## What Electron changes for the user

In the Electron build the page does not call `fetch` for a request. It marshals the request and
calls `electronIPC.sendRequest` (`packages/ui/src/helpers.ts:656-715`), and the main process sends
it with undici (`packages/electron/src/request.js:144-229`). That is the reason to port this build
and not the web one: the web build's `fetch` is a browser request, which refuses `Cookie`,
`Origin` and any server that sends no CORS headers (`helpers.ts:2562`, the app's own message: "use the Restfox CORS Helper extension or the desktop app"), and
its maintainer points users to a browser extension for it.

Orivon's routed `fetch` is the same job under the app's own grant: it keeps the headers the page
sets and does no CORS check (`orivon-mvp` `src/preload/routed/README.md`). So the bridge's
`sendRequest` is a `fetch` call.

## The members, by bucket

35 names: 34 in the preload's list and `workspaceChanged`.

| Bucket | Count | Members |
|---|--:|---|
| Hand-written | 4 | `sendRequest`, `cancelRequest`, `setCACertificates`, `setProxy` |
| Inert | 4 | `workspaceChanged` (a listener), `updateElectronApp` (nothing to update), `setDisableSSLVerification` (nothing to switch), `getInstallInfo` (a constant) |
| Refused, `not-built` | 27 | the file workspace set: 24 database members, `openFolderSelectionDialog`, `openFolder`, `readFile` |

Capability ratio: 1 member (`sendRequest`) needs a capability, `net`. The other three hand-written
members hold state in the bridge and call nothing.

### The escape test, for the file workspaces

A file workspace keeps a workspace in a folder on disk. `openFolderSelectionDialog` resolves to a
host path string, which Restfox stores as the workspace's `location` and passes back on every read
and write (`NavBar.vue:349-362`, `AddWorkspaceModal.vue:171`, `db.ts:195-260`). The value escapes
into app code, and `orivon.fs.userSelected` hands out handles, never paths. So the set is refused
by name, and the port does not make up a path-shaped string. Every other workspace is IndexedDB,
which the page owns (`db.ts` gates each `fileIPC` call on `workspace._type === 'file'`).

### Settings main applied to its own HTTP client

| Member | Main does | The page can |
|---|---|---|
| `setDisableSSLVerification` | turns off certificate checks in undici | not: a routed `fetch` has no TLS option (`orivon-mvp` catalogue `routed-fetch-refuses-untrusted-certificate`). The member does nothing, and `sendRequest` says so when a certificate is refused |
| `setCACertificates` | adds roots to undici | not. The Settings flow saves a file only when this answers without an error (`SettingsModal.vue:376-383`), so the answer is an error |
| `setProxy` | routes undici and Chromium through a proxy | not. A request fails with the reason while the mode is Custom, because sending it direct would leak the address the user meant to hide |

## What else the page does on its own

- It reports a page view to `https://umami.artelin.dev/api/collect` on start, unless
  `Restfox-DisablePageViewAnalyticsTracking` is `true` (`utils/analytics.ts:3,27`, `App.vue:398-410`).
  The bridge sets that key on a new profile; Settings shows the box ticked.
- It asks `api.github.com` for the star count on start (`App.vue:390`). Nothing switches that off.
- It runs request scripts in QuickJS compiled to WebAssembly and inlined in the bundle
  (`@jitl/quickjs-singlefile-browser-release-asyncify`), which needs the app CSP's
  `wasm-unsafe-eval`.

## Verdict

**Portable, with one whole feature refused.** The main job (sending a request with the headers the
user typed) is one bridge member over the routed `fetch`. The bridge is about 120 lines. The file
workspaces are 27 of 35 members and are refused rather than rebuilt over `orivon.fs`: they would
need Restfox's own storage format and a handle-shaped redesign of `location`, which is the
app's change to make, not the port's.
