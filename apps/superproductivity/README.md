# `apps/superproductivity/`: Super Productivity as an Orivon app

## About this build

**A community build by Orivon of Super Productivity, not the official Super Productivity.** Super Productivity is a to-do list and time tracker with a planner, a schedule and issue and calendar integrations. This directory holds the recipe that builds it to run in Orivon; the upstream project did not make this build. Status: early access.

| | |
|---|---|
| Official project | [github.com/super-productivity/super-productivity](https://github.com/super-productivity/super-productivity) |
| Official downloads | <https://super-productivity.com/download/> |
| Pinned upstream | 19.2.0 (v19.2.0), commit `466a426700e7` |
| This build's version | 19.2.0 (upstream 19.2.0; the first published build is 19.2.0.1) |
| Licence | MIT, upstream's own; the licence text is served at `/LICENSE`, see [`UPSTREAM.md`](UPSTREAM.md) |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| In another browser | The app runs there as upstream's own web app, with a small corner notice that can be closed. The Electron token and the single-instance guard (below) are off there. |
| Updates | When upstream releases a new version, the pin is moved and the build is redone ([maintaining a port](../../.claude/skills/orivon-porting/maintain.md)); there is no schedule. The app's own update notice is left as upstream wrote it, so it names the official desktop download, not this build. |
| Problems | [Report a problem with this build](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=Super%20Productivity): it goes to this repository's issue form, not to the upstream project's tracker. |

What this build changes for the person using it: upstream's web app documents that WebDAV sync and calendar links are likely to fail in a browser because the server has to allow cross-origin requests. This build is upstream's desktop renderer, and Orivon makes those requests without that rule, the way the desktop app's own main process does.

Known gaps in this build:

- **Needs a public https server.** WebDAV and calendar addresses on a home network or on `localhost` are not reachable, because a host typed at run time must be public and use https.
- **No idle detection, no reminders while Orivon is closed, no tray, no global shortcuts, no task widget window.** Those belong to the desktop app's main process.
- **No local-folder sync and no automatic file backups.** Export and the other sync providers work.
- **Pasting or dropping an image into a note fails**, because the desktop app saves it as a file on disk.
- **Jira, plugins that run Node scripts, the local REST API and plugin OAuth are not available.**
- **Dropbox, OneDrive and Google Drive sync** need an app key the build does not carry.
- **Notifications** are denied by Orivon.

The sections below are for people working on the build.

**What this is.** Super Productivity's desktop renderer is, byte for byte, the Angular build its web app is made of (`npm run buildFrontend:prod:es6`, which Electron's packaging step takes its `index.html` from). Two things make that build the *desktop* app at run time, and `src/app/app.constants.ts` tests both: the user agent contains ` electron/`, and `window.ea` exists. This port supplies both inside Orivon: [`bridge/members.json`](bridge/members.json) and [`bridge/superproductivity.js`](bridge/superproductivity.js) stand in for `electron/preload.ts` and the main process, and the bridge adds the token to the user agent only when it runs inside Orivon.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Where upstream is, at which commit, upstream's own build script, `extraFiles` (upstream's licence as `/LICENSE`) and `icon` |
| [`orivon.json`](orivon.json) | The manifest: one capability, `net.https.connect` for any public site |
| [`hooks.mjs`](hooks.mjs) | Two edits to the built `index.html` for the served policy, and the page a second tab is sent to |
| [`bridge/members.json`](bridge/members.json) | 68 of the 73 `window.ea` members, each with the reason it is answered the way it is |
| [`bridge/superproductivity.js`](bridge/superproductivity.js) | The other 5, the Electron token on the user agent and the single-instance guard |
| [`bridge/superproductivity.test.ts`](bridge/superproductivity.test.ts), [`bridge/hooks.test.ts`](bridge/hooks.test.ts) | The roster, every bucket, the hand-written members, the user agent, the guard and the hook |
| [`UPSTREAM.md`](UPSTREAM.md) | The pin, the licence, what never crosses into this repository |

## Running it

```bash
orivon-port run superproductivity      # clone at the pinned commit, build, prepare, serve on 127.0.0.1:8883
orivon-port test superproductivity     # or: npx vitest run apps/superproductivity
```

The build runs `npm ci` and upstream's `buildFrontend:prod:es6` in the clone, with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and a 3.5 GB Node heap so it fits the machine's build cap. The first build takes several minutes. None of the optional keys `tools/load-env.js` reads (Dropbox, OneDrive, Google Drive, Unsplash) is set.

Open `http://127.0.0.1:8883` in Orivon and accept the prompt. It reads *"Unlimited network access: load anything from any website, without the browser's usual limits"* and nothing else. `superproductivity.orivonstack.eth` works too once the shell is launched with `orivon-port names`' output (the top-level [`README.md`](../../README.md), "Opening it by name instead of by port").

## The seam

`electron/preload.ts` exposes one object, `window.ea`, of 73 members. How this port answers them:

| Bucket | Count | Members |
|---|:--:|---|
| The browser does it | 1 | `setZoomFactor` (the page's `zoom`), plus `getZoomFactor`, `reloadMainWin`, `openExternalUrl` and `isLinux` in the hand-written file |
| Inert: record the callback, never fire it | 3 | `onSwitchTask`, `onPluginOAuthCb`, `onLocalRestApiRequest` |
| Inert: accept and answer nothing | 19 | tray, task widget, global shortcuts, progress bar, title bar, window-close hooks, settings mirror, `on`, `openDevTools` |
| Constants, the answer upstream already handles | 21 | platform flags, `getDistChannel`, `consumeJiraApi` and `consumePluginNodeExecutionApi` (both `null`), first-run answers for backups, sync folder and clipboard |
| Refused by name | 24 | host paths, folders, the OS session, local-folder sync, clipboard image files, plugin OAuth, the local REST API |
| Never answers | 1 | `getBackupPath` |

None needs a capability beyond the manifest's `net.https.connect`: the 73 members are all either the page's own, inert, or refused. **0 of 73 call `orivon.*`.** WebDAV and calendar requests are not bridge members at all; they are the renderer's own `fetch` and `XMLHttpRequest`, which Orivon routes.

A refusal of a member whose preload version returns a promise (`"async": true` in `members.json`) rejects instead of throwing, because several call sites run in a component constructor with no `try`.

## Design notes

**The Electron token.** `navigator.userAgent` gets ` Electron/0.0.0` appended when `window.orivon` exists, so `IS_ELECTRON` is true and the renderer calls the bridge. Without it the same page takes its browser branches (a service worker, the "calendar will likely fail in a browser" warning, a multi-tab check) and never calls `window.ea`. In another browser the token is not added, so the page is upstream's web app, which is why the hint is tier 1.

**One tab only.** Electron's main process is single-instance and the renderer skips the web app's multi-tab check in Electron mode. A browser tab has neither, so the bridge takes a Web Lock for the life of the document and sends a second tab to `orivon/already-open.html`, a static page the hook writes. Two tabs writing one IndexedDB is the failure this prevents.

**Why the hook.** Upstream's `index.html` has an inline script (the splash screen's tips and a browser check) and Angular's critical-CSS pattern `<link media="print" onload="this.media='all'">`. The served policy admits no inline script or handler, so the script moves to `orivon/splash-script.js` byte for byte and the stylesheet loses the two attributes. Without the second edit the page is unstyled.

**WebDAV and calendar are upstream's own code.** `WebDavHttpAdapter` calls `fetch` with `PROPFIND`, `PUT`, `GET`, `MKCOL`, `Depth` and `If-Match`, and on desktop marks every `PUT` with `X-SuperProductivity-WebDAV-Upload` so the main process can set `Connection: close`. Orivon's routed request already sends `Connection: close`, and the marker header itself reaches the server, which servers ignore. The calendar uses Angular's `HttpClient`, which is `XMLHttpRequest`; Orivon routes that too. Both run in the page's top frame, where routing applies; the app's one Worker (reminders) makes no network request.

**Layout.** `isGnomeWayland` and `isMacOS` answer `false`. The app draws its own title bar and reserves 140 px for window controls Orivon's tab does not have; the strip is cosmetic.

## What it needs from orivon-mvp

Catalogue ids from `test/app-behaviours/catalogue.md` that this port relies on; a red `[app:<id>]` test is this port's breakage:

- `routed-fetch-reaches-granted-hosts`: WebDAV and calendar requests reach a granted host with no CORS check and keep `Authorization`.
- `routed-fetch-sends-webdav-methods`: `PROPFIND` with `Depth` and a readable `207`.
- `routed-fetch-follows-redirects`: calendar feeds redirect (`not covered` in the catalogue).
- `indexeddb-survives-restart` and `localstorage-survives-restart`: the task database and the settings.
- `blob-download-saves-without-dialog`: export.
- `window-open-noopener-opens-tab`: `openExternalUrl`.

Two behaviours the catalogue does not state yet are relied on: a Web Lock held by one tab of an app is refused to a second tab of the same app, and a page can redefine `navigator.userAgent` on its own `navigator`. Neither has a row.
