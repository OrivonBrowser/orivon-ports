# Super Productivity: recon

The measurement `apps/superproductivity/` was committed on. Every `path:line` is in
`super-productivity/super-productivity` at `4db0e11236bc784d3184a9e252930b4bd53df823` (v20.0.0).

## Shape

An Angular application with an Electron shell. The shell is `electron/`: a main process
(`electron/main.ts`, `main-window.ts`, `ipc-handlers/`) and a context-isolated preload that
exposes one object. The renderer is the same `ng build` output the web app ships:

| Fact | Evidence |
|---|---|
| The Electron frontend build is `buildFrontend:prod:es6`, `ng build --configuration production`, output `.tmp/angular-dist/browser` | `package.json` scripts `buildAllElectron:prod`, `buildFrontend:prod:es6`; `angular.json` `outputPath` |
| Web and Electron differ only by output folder (`production` against `productionWeb`) | `angular.json` configurations |
| The renderer decides it is the desktop app at module load, from the user agent and `window.ea` | `src/app/app.constants.ts:7` |
| One preload object, `ea`, 80 members, no generic forwarder | `electron/preload.ts:324` (`contextBridge.exposeInMainWorld('ea', ea)`), `electron/electronAPI.d.ts` |
| The renderer imports no Node builtin and no `electron` | `orivon-port recon`: 0 renderer files importing `electron`; the two builtin importers are `src/assets/create-test-plugin-zip.js` and `src/karma.conf.js`, neither in the bundle |

## The two paths the port rests on

**WebDAV.** `WebDavHttpAdapter.request` calls the page's `fetch` with the method, headers and body
it was given (`packages/sync-providers/src/file-based/webdav/webdav-http-adapter.ts:136-151`), in the
top frame. On desktop the main process makes that work by injecting `Access-Control-Allow-*: *` on
every response and forcing every `OPTIONS` to 200 (`electron/main-window.ts:326-336`), and by turning a
marker header into `Connection: close` on a `PUT` (`webdav-http-adapter.ts:57,143`). Orivon's routed
`fetch` needs neither: it has no CORS check, and `Connection: close` is what it always sends.

**Calendar.** `CalendarIntegrationService` reads the feed with Angular's `HttpClient`
(`src/app/features/calendar-integration/calendar-integration.service.ts:415,457`), which is
`XMLHttpRequest`. Orivon routes `XMLHttpRequest` in the top frame as it does `fetch`.

Both need `net.https.connect` for a host typed at run time, so the manifest declares `*:*`. A host
on a home network or `localhost` is out of reach unless the manifest names it literally.

## The 80 members

| Bucket | Count |
|---|:--:|
| The browser does it (`setZoomFactor`, `getZoomFactor`, `reloadMainWin`, `openExternalUrl`, `isLinux`) | 5 |
| Inert: record a callback | 3 |
| Inert: accept and answer nothing | 20 |
| Constants, answers upstream already handles on a first run | 21 |
| Refused by name | 29 |
| Never answers (`getBackupPath`, `getAssistantAccessState`) | 2 |

Capability ratio: 0 of 80 need an `orivon.*` call. The hand-written file is about 110 lines, the
declaration about 280. Well under the 500-line line.

## What decided the harder members

- **Host paths.** `getUserDataPath`, `showOpenDialog`, `openPath`, `pickDirectory` and the
  clipboard-image and local-folder-sync members return or take host paths, and the renderer joins
  them (`src/app/util/get-default-clipboard-images-path.ts`) and builds `file:///` URLs from them
  (`src/app/core/clipboard-image/clipboard-image.service.ts:18`). That is the escape test failing:
  they are refused, never answered with a made-up path.
- **First-run answers.** `checkBackupAvailable`, `listBackups`, `getSyncFolderPath` and
  `commitPickedDirectory` are read at start-up and must resolve to upstream's empty answer, or the
  restore dialog or the sync form misbehaves.
- **Refusals that must reject.** `config-page.component.ts:282` calls `getBackupPath()` in a
  constructor and chains `.then` with no catch, so a synchronous throw ends the Settings page. A
  member that returns a promise in the preload rejects when refused; `getBackupPath` never settles,
  so the page simply has no backup section.
- **The two Settings switches that need a listener.** The local REST API and assistant access (an MCP
  endpoint) are servers the main process runs on a loopback port. Each switch is disabled while its
  state is empty (`formly-local-rest-api-settings.component.html`,
  `formly-assistant-access-settings.component.html`). `getLocalRestApiState` is read inside a `try`
  that only logs, so it is refused; `getAssistantAccessState` is read by a helper that shows an error
  snackbar on a rejection (`formly-assistant-access-settings.component.ts`, `_run`), so it never
  settles, and the page opens with both switches greyed out. The members that change them are refused.
- **The due-task badge.** `setDueTaskBadge` is sent only once a badge was ever enabled
  (`src/app/features/tasks/store/task-electron.effects.ts:142-175`) and sets the taskbar or dock
  icon, so it is inert.
- **`openDevTools`** is called from inside the global error handler
  (`src/app/core/error-handler/global-error-handler.util.ts:242`); a refusal there is a second
  error, so it is inert.
- **Single instance.** The renderer skips the web app's multi-tab check when `IS_ELECTRON`
  (`src/app/core/startup/startup.service.ts:129`), because Electron's main process holds the lock.
  A tab has no main process, so the bridge takes a Web Lock.

## Build

`npm ci` runs `prepare` (husky, ts-patch, `env`, four package builds). `ELECTRON_SKIP_BINARY_DOWNLOAD=1`
skips the 100 MB Electron download. `ng build` needs a Node heap above the default and below the
5 GB build cap: 3584 MB. The output ships source maps.

The built `index.html` carries three inline scripts (the launch screen, the splash screen's browser
check, and the builder's restorer of a deferred stylesheet's media), which `hooks.mjs` moves to files.

## Verdict

Portable, cheap. A bridge of 74 declared members and six hand-written ones, no new capability, one
manifest line.
