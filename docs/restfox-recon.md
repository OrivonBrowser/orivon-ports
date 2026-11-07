# Restfox port reconnaissance

Read against **flawiddsouza/Restfox** at `e776d9e3685771e5c3884e55943fd4ca0ff36767` (tag v0.42.0,
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
| The preload publishes one global, `electronIPC`, built from a list of 41 names plus three callback registrations (`workspaceChanged`, `onRequestEvent`, `onGrpcEvent`) | `packages/electron/src/preload.js:3-70` |
| 41 `ipcMain` handlers answer them | `packages/electron/src/app.js` (`ipcMain.handle`) |
| The renderer reads the mode at 20 places (`import.meta.env.MODE`, tests left out) and calls `electronIPC.<member>` at 20 | `packages/ui/src/db.ts:64`, `helpers.ts:536,578-582,931,967`, `App.vue:79,109,114,509-518`, `NavBar.vue:342-352`, `AddWorkspaceModal.vue:171`, `utils/grpc-transport.ts:118-267` |
| The renderer imports no Node builtin and no `electron` | `orivon-port recon packages/ui`: none |

## What Electron changes for the user

In the Electron build the page does not call `fetch` for a request. It marshals the request and
calls `electronIPC.sendRequest` (`packages/ui/src/helpers.ts:872-985`), and the main process sends
it with undici (`packages/electron/src/request.js:201-330`). The response reaches the page only as
messages pushed to the callback `onRequestEvent` registered (`head`, `data`, `end`, `bodyError`,
`responseError`); the reply of `sendRequest` carries nothing, so the response panel can show a
stream while it arrives. That is the reason to port this build
and not the web one: the web build's `fetch` is a browser request, which refuses `Cookie`,
`Origin` and any server that sends no CORS headers. The app's own error text names a browser
extension and the desktop app as the ways round that (`helpers.ts:3171`).

A failed request shows "Request failed" and a list of causes, unless the `Error` it was rejected with
carries `cause: 'display-error'`, which makes the response panel print its message instead
(`helpers.ts:1491-1511`). The bridge uses that for the failures only Orivon can explain.

Orivon's routed `fetch` is the same job under the app's own grant: it keeps the headers the page
sets and does no CORS check (`orivon-mvp` `src/preload/routed/README.md`). So the bridge's
`sendRequest` is a `fetch` call that pushes what it reads of the body piece by piece.

## The members, by bucket

44 names: 41 in the preload's list and the three callbacks it registers.

| Bucket | Count | Members |
|---|--:|---|
| Hand-written | 6 | `sendRequest`, `cancelRequest`, `onRequestEvent` (keeps the callbacks `sendRequest` pushes to), `openFolderSelectionDialog` (a message, then a refusal), `setCACertificates`, `setProxy` |
| Inert | 5 | `workspaceChanged` and `onGrpcEvent` (listeners that never fire), `updateElectronApp` (nothing to update), `setDisableSSLVerification` (nothing to switch), `getInstallInfo` (a constant) |
| Refused, `not-built` | 33 | the file workspace set: 24 database members, `openFolder`, `readFile`; the 7 gRPC members |

Capability ratio: 1 member (`sendRequest`) needs a capability, `net`. The other five hand-written
members hold state in the bridge or show a message, and call nothing.

### gRPC

The gRPC engine is `@grpc/grpc-js` in Restfox's main process (`packages/electron/src/grpc.js` and `shared/grpc.js`),
which speaks HTTP/2 with trailers. A page has no HTTP/2 client in Orivon (`orivon-mvp`
compatibility tables, P26: `http2` loads and every function refuses by name), and `fetch` cannot
send gRPC. The seven members are refused as rejected promises, which is what the UI chains a
`catch` to (`utils/grpc-transport.ts:137-267`): a schema load shows the refusal as the reason the
methods could not load, a call ends with it as its error event, and an imported Insomnia gRPC
message is kept as Insomnia wrote it (`helpers.ts:1745-1757`).

### The escape test, for the file workspaces

A file workspace keeps a workspace in a folder on disk. `openFolderSelectionDialog` resolves to a
host path string, which Restfox stores as the workspace's `location` and passes back on every read
and write (`NavBar.vue:349-362`, `AddWorkspaceModal.vue:171`, `db.ts:155-290`). The value escapes
into app code, and `orivon.fs.userSelected` hands out handles, never paths. So the set is refused
by name, and the port does not make up a path-shaped string. Every other workspace is IndexedDB,
which the page owns (`db.ts` gates each `fileIPC` call on `workspace._type === 'file'`).

### Settings main applied to its own HTTP client

| Member | Main does | The page can |
|---|---|---|
| `setDisableSSLVerification` | turns off certificate checks in undici | not: a routed `fetch` has no TLS option (`orivon-mvp` catalogue `routed-fetch-refuses-untrusted-certificate`). The member does nothing, and `sendRequest` says so when a certificate is refused |
| `setCACertificates` | adds roots to undici | not. The Settings flow saves a file only when this answers without an error (`SettingsModal.vue:381-382`), so the answer is an error |
| `setProxy` | routes undici and Chromium through a proxy | not. A request fails with the reason while the mode is Custom, because sending it direct would leak the address the user meant to hide |

## What else the page does on its own

- It reports a page view to `https://umami.artelin.dev/api/collect` on start, unless
  `Restfox-DisablePageViewAnalyticsTracking` is `true` (`utils/analytics.ts:3-27`, `App.vue:385-425`).
  The port leaves it as upstream wrote it: the ping is sent unless the user ticks the box in Settings.
- It asks `api.github.com` for the star count on start (`App.vue:404`). Nothing switches that off.
- It runs request scripts in QuickJS compiled to WebAssembly and inlined in the bundle
  (`@jitl/quickjs-singlefile-browser-release-asyncify`), which needs the app CSP's
  `wasm-unsafe-eval`.

## Verdict

**Portable, with two whole features refused.** The main job (sending a request with the headers the
user typed, and showing its response as it arrives) is one bridge member over the routed `fetch`.
The bridge file is 170 lines. The file workspaces are 26 of 44 members and are refused rather than
rebuilt over `orivon.fs`: they would need Restfox's own storage format and a handle-shaped redesign
of `location`, which is the app's change to make, not the port's. The folder picker, the one of the
26 a user can reach from a default form, shows a message before it refuses. gRPC is 7 more members,
refused because Orivon has no HTTP/2 client for a page.
