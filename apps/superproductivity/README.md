# `apps/superproductivity/`: Super Productivity as an Orivon app

## About this build

**A community build by Orivon of Super Productivity, not the official Super Productivity.** Super Productivity is a to-do list and time tracker with a planner, a schedule and issue and calendar integrations. This directory holds the recipe that builds it to run in Orivon; the upstream project did not make this build. Status: early access.

| | |
|---|---|
| Official project | [github.com/super-productivity/super-productivity](https://github.com/super-productivity/super-productivity) |
| Official downloads | <https://super-productivity.com/download/> |
| Pinned upstream | 20.0.0 (v20.0.0), commit `4db0e11236bc` |
| This build's version | 20.0.0; a published build adds a build number (20.0.0.2) |
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
- **Pasting or dropping an image into a note is not supported**, because the desktop app saves it as a file on disk and this build refuses that.
- **Jira, the local REST API, assistant access (an MCP endpoint) and plugin OAuth are not available.** The two switches in Settings, General, for the REST API and for assistant access stay greyed out.
- **Plugins that run Node scripts cannot be turned on**: App Auto Track and sync.md. Their switch in Settings, Plugins turns itself back off without a message, because the desktop app's script runner is not part of this build.
- **Plugins run their own code in the app's own policy, with the app's permissions.** A plugin's page (Automations, Procrastination Buster, Yesterday's Tasks, Doc Mode, AI Command, AI Productivity Prompts and the Todoist and TickTick imports) opens in its page or in the side panel and its controls work, and a plugin's settings survive a restart. The bundled issue providers and calendars open their setup form and none was driven against a real service. How the pages run, and what a plugin page may not do, is in Design notes, Plugin pages.
- **Dropbox and OneDrive sync** need an app key the build does not carry. The sync dialog still lists them; they were not driven.
- **Notifications** are denied by Orivon.

The sections below are for people working on the build.

**What this is.** Super Productivity's desktop renderer is, byte for byte, the Angular build its web app is made of (`npm run buildFrontend:prod:es6`, which Electron's packaging step takes its `index.html` from). Two things make that build the *desktop* app at run time, and `src/app/app.constants.ts` tests both: the user agent contains ` electron/`, and `window.ea` exists. This port supplies both inside Orivon: [`bridge/members.json`](bridge/members.json) and [`bridge/superproductivity.js`](bridge/superproductivity.js) stand in for `electron/preload.ts` and the main process, and the bridge adds the token to the user agent only when it runs inside Orivon.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Where upstream is, at which commit, upstream's own build script, `extraFiles` (upstream's licence as `/LICENSE`) and `icon` |
| [`orivon.json`](orivon.json) | The manifest: one capability, `net.https.connect` for any public site |
| [`hooks.mjs`](hooks.mjs) | Two edits to the built `index.html` for the served policy (its three inline scripts move to files, a deferred stylesheet applies at once), the page a second tab is sent to, and the script a plugin's page runs with (`orivon/plugin-frame.js`, copied from `bridge/plugin-frame.js`) |
| [`bridge/members.json`](bridge/members.json) | 74 of the 80 `window.ea` members, each with the reason it is answered the way it is |
| [`bridge/superproductivity.js`](bridge/superproductivity.js) | The other 6, the Electron token on the user agent, the single-instance guard and the rewrite of a plugin page's document |
| [`bridge/plugin-frame.js`](bridge/plugin-frame.js) | The script a plugin's page runs its inline scripts and event handlers with |
| [`bridge/superproductivity.test.ts`](bridge/superproductivity.test.ts), [`bridge/hooks.test.ts`](bridge/hooks.test.ts), [`bridge/plugin-frame.test.ts`](bridge/plugin-frame.test.ts) | The roster, every bucket, the hand-written members, the user agent, the guard, the hook, the rewrite and the runner |
| [`UPSTREAM.md`](UPSTREAM.md) | The pin, the licence, what never crosses into this repository |

## Running it

```bash
orivon-port run superproductivity      # clone at the pinned commit, build, prepare, serve on 127.0.0.1:8883
orivon-port test superproductivity     # or: npx vitest run apps/superproductivity
```

The build runs `npm ci` and upstream's `buildFrontend:prod:es6` in the clone, with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and a 3.5 GB Node heap so it fits the machine's build cap. The first build takes several minutes, and needs Node 22.22.3 or newer (24.15.0 or newer on the 24 line): the Angular CLI at this pin refuses an older one, and upstream's `.nvmrc` names 22.23.3. None of the optional keys `tools/load-env.js` reads (Dropbox, OneDrive, Google Drive, Unsplash) is set.

Open `http://127.0.0.1:8883` in Orivon and accept the prompt. It reads *"Unlimited network access: load anything from any website, without the browser's usual limits"* and nothing else. `superproductivity.orivonstack.eth` works too once the shell is launched with `orivon-port names`' output (the top-level [`README.md`](../../README.md), "Opening it by name instead of by port").

## The seam

`electron/preload.ts` exposes one object, `window.ea`, of 80 members. How this port answers them:

| Bucket | Count | Members |
|---|:--:|---|
| The browser does it | 1 | `setZoomFactor` (the page's `zoom`), plus `getZoomFactor`, `reloadMainWin`, `openExternalUrl` and `isLinux` in the hand-written file |
| Inert: record the callback, never fire it | 3 | `onSwitchTask`, `onPluginOAuthCb`, `onLocalRestApiRequest` |
| Inert: accept and answer nothing | 20 | tray, task widget, global shortcuts, progress bar, due-task badge, title bar, window-close hooks, settings mirror, `on`, `openDevTools` |
| Constants, the answer upstream already handles | 21 | platform flags, `getDistChannel`, `consumeJiraApi` and `consumePluginNodeExecutionApi` (both `null`), first-run answers for backups, sync folder and clipboard |
| Refused by name | 29 | host paths, folders, the OS session, local-folder sync, clipboard image files, plugin OAuth, the local REST API, assistant access |
| Never answers | 2 | `getBackupPath`, `getAssistantAccessState` |

None needs a capability beyond the manifest's `net.https.connect`: the 80 members are all either the page's own, inert, or refused. **0 of 80 call `orivon.*`.** WebDAV and calendar requests are not bridge members at all; they are the renderer's own `fetch` and `XMLHttpRequest`, which Orivon routes.

A refusal of a member whose preload version returns a promise (`"async": true` in `members.json`) rejects instead of throwing, because several call sites run in a component constructor with no `try`. `getAssistantAccessState` never answers instead: Settings, General reads it when it opens and turns a rejection into a "could not save" message, and with no answer the switch stays greyed out. `getLocalRestApiState` is refused, because the page there only logs the rejection.

## Design notes

**The Electron token.** `navigator.userAgent` gets ` Electron/0.0.0` appended when `window.orivon` exists, so `IS_ELECTRON` is true and the renderer calls the bridge. Without it the same page takes its browser branches (a service worker, the "calendar will likely fail in a browser" warning, a multi-tab check) and never calls `window.ea`. In another browser the token is not added, so the page is upstream's web app, which is why the hint is tier 1.

**One tab only.** Electron's main process is single-instance and the renderer skips the web app's multi-tab check in Electron mode. A browser tab has neither, so the bridge takes a Web Lock for the life of the document and sends a second tab to `orivon/already-open.html`, a static page the hook writes. Two tabs writing one IndexedDB is the failure this prevents.

**Why the hook.** Upstream's `index.html` has three inline scripts (the launch screen that paints the app's frame before any bundle runs, the splash screen's tips with a browser check, and the one-liner Angular's builder adds to switch a deferred stylesheet from print to all media) and the critical-CSS pattern `<link media="print" data-beasties-media="all">`. The served policy admits no inline script, so each script moves byte for byte to `orivon/inline-script-1.js`, `-2.js` and `-3.js`, loaded where it stood, and the stylesheet loses the two attributes so it applies at once. The third script is then left with nothing to do, but it is moved rather than dropped so no upstream byte is edited. Without the second edit the page is unstyled.

**Plugin pages.** A plugin's own page (Automations, Procrastination Buster, Doc Mode, the two import tools, AI Command and Yesterday's Tasks have one) is `<iframe data-plugin-iframe sandbox="allow-scripts allow-same-origin ...">` whose `srcdoc` the app assembles as one string: the plugin's `index.html`, the theme's CSS and an inline `<script>` that carries the plugin API. A `srcdoc` frame has the app's origin and the app's policy, which admits files from the app and string evaluation but no inline script, so the frame would stay blank. The bridge wraps the `srcdoc` setter of a frame that has `data-plugin-iframe` and rewrites that string before the frame reads it: each inline `<script>` stays in the document as an inert `<script type="text/plain" data-orivon-inline>` and a `<script src=".../orivon/plugin-frame.js">` follows it. That file, which the hook copies from `bridge/plugin-frame.js`, evaluates the text before it, where it stood: a classic script by indirect evaluation (so `var` and function declarations are global, and a `DOMContentLoaded` listener it adds still fires), a module script as a deferred async function. It also takes each inline event-handler attribute (`onclick="..."`) off its element and compiles it itself, because the policy refuses those too. The frame keeps `allow-same-origin`, as upstream built it; the plugin's code runs with the app's permissions, as it does in the desktop app, and is as open as the plugin's source (see [`UPSTREAM.md`](UPSTREAM.md)). Not done, and each a place a plugin written differently would stop: a top-level `let`, `const` or `class` is private to its own script, not shared with the frame's other scripts; an inline module may not `import` or `export`; a `javascript:` link does nothing. Rejected: editing the app's bundle (the port ships upstream's build byte for byte, and the hook only moves scripts) and a more permissive policy for the app (the policy is Orivon's, not this port's).

**WebDAV and calendar are upstream's own code.** `WebDavHttpAdapter` calls `fetch` with `PROPFIND`, `PUT`, `GET`, `MKCOL`, `Depth` and `If-Match`, and on desktop marks every `PUT` with `X-SuperProductivity-WebDAV-Upload` so the main process can set `Connection: close`. Orivon's routed request already sends `Connection: close`, and the marker header itself reaches the server, which servers ignore. The calendar uses Angular's `HttpClient`, which is `XMLHttpRequest`; Orivon routes that too. Both run in the page's top frame, where routing applies; the app's one Worker (reminders) makes no network request.

**Layout.** `isGnomeWayland` and `isMacOS` answer `false`. The app draws its own title bar and reserves 140 px for window controls Orivon's tab does not have; the strip is cosmetic.

**Every build has its own hash, and only the clock makes it.** Angular's service worker writes `ngsw.json` with `"timestamp": Date.now()` (`@angular/service-worker`'s `config.mjs`, switched on by `serviceWorker` in the production configuration of `angular.json`), so two builds of this commit differ in that one file and in the declaration made from it. Nothing else depends on when or where the tree was built: Angular names each component-style source map `angular:styles/component:css;<content hash>;<absolute path of the component>`, and the clone is always built in the build folder (`/tmp/orivon-ports-build/superproductivity/source/`, `docs/recipe-format.md` section Where a build runs), so those 26 `*.css.map` files, the chunks that import them and `index.html` are the same bytes from any checkout. A hook does not edit a build's files, so `release` and `hash --check` hold for the tree that recorded `published.json`, and a rebuild reports a changed tree. Two builds from different checkouts are byte for byte identical once `timestamp` is set to the same number. What would settle it, as a change to this recipe: a `build.also` step that sets `timestamp` from the pinned commit's date, or `serviceWorker: false` for the production build, which drops the service worker.

## What it needs from orivon-mvp

Catalogue ids from `test/app-behaviours/catalogue.md` that this port relies on; a red `[app:<id>]` test is this port's breakage:

- `routed-fetch-reaches-granted-hosts`: WebDAV and calendar requests reach a granted host with no CORS check and keep `Authorization`.
- `routed-fetch-sends-webdav-methods`: `PROPFIND` with `Depth` and a readable `207`.
- `routed-fetch-follows-redirects`: calendar feeds redirect (`not covered` in the catalogue).
- `indexeddb-survives-restart` and `localstorage-survives-restart`: the task database and the settings.
- `blob-download-saves-without-dialog`: export.
- `window-open-noopener-opens-tab`: `openExternalUrl`.
- `srcdoc-frame-runs-served-script`: a plugin page is a same-origin `srcdoc` frame that refuses inline script, runs a script the app serves, and reaches the parent and `parent.orivon` from code that script evaluates.

Two behaviours the catalogue does not state yet are relied on: a Web Lock held by one tab of an app is refused to a second tab of the same app, and a page can redefine `navigator.userAgent` on its own `navigator`. Neither has a row.
