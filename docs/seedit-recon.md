# seedit port reconnaissance

Read against a local clone of **bitsocialnet/seedit** at `546cf6797a52ad763f9fc61d4ef5f4419de922cb`
(tag v0.6.3, GPL-3.0-or-later, `package.json:7`). Line numbers are that revision's. The repository
holds the web app (Vite, React, HashRouter), its Electron shell in `electron/`, and an Android
shell (Capacitor). The desktop renderer is the web app's `vite build` output in `build/`, loaded
from `file://`. `orivon-port recon` counts nothing here: the preload is ESM
(`electron/preload.mjs`), which it reads as no preload, so the member counts below are by hand.
seedit and 5chan (`docs/5chan-recon.md`) share the Bitsocial stack and most of `electron/`; this
page says what differs and repeats what a reader needs to decide.

## The one-line answer

**Portable as the desktop build with a bridge, and the bridge is small; the node is the cost.**
The renderer is a static page whose Electron contract is 17 members, 9 of them static, dead or
refused. It needs a Bitsocial node on loopback (`ws://localhost:9138`, a Kubo gateway on 6473)
that `electron/main.js` spawns, not the preload. Without `isElectron` the same bundle runs an
in-page libp2p mode and uses neither.

## The shape

| Fact | Evidence |
|---|---|
| Renderer is `vite build` output in `build/`, loaded from `file://` | `electron/main.js:247` (start URL), `vite.config.js` (`outDir`) |
| The preload is a separate Vite build | `package.json:60` (`build:preload`, `electron/vite.preload.config.js`) |
| Main spawns the node: Kubo, then a pkc RPC server | `electron/main.js` (requires `start-ipfs.js`, `start-pkc-rpc.js`) |
| The runtime is picked by `isElectron` | `src/lib/p2p-browser-config.ts:135-137` (`isElectronRuntime`, `canUsePureP2PBrowser = !isElectronRuntime`) |
| `src/lib/p2p-browser-config.ts` is the same file as 5chan's, except for the storage key `seedit:pure-p2p-browser-enabled` | `diff` against 5chan |
| Pure P2P in the page is the default when `isElectron` is absent | `src/index.tsx` (`configureP2PBrowserPkcOptions()` runs before the hooks create the default account) |
| `getP2PRuntimeMode` returns `browser-libp2p`, `electron-kubo-rpc` or `full-node-rpc` | `src/lib/p2p-runtime.ts:54` |
| The hooks package reads `window.defaultPkcOptions` on every account load; default (equal) options are not stored, so they follow the current defaults | `@bitsocial/bitsocial-react-hooks` 0.2.2 `account-generator.js:71-91`, `accounts-database.js:93-96, 297-301` |

Versions: `@pkcprotocol/pkc-js` 0.0.132, `@bitsocial/bitsocial-react-hooks` 0.2.2,
`@bitsocial/bso-resolver` 0.0.10, Electron 44.10.1, `vite-plugin-pwa` 2.0.0, zustand 4.5.7
(`package.json`). seedit has no `@bitsocial/pubsub-voting`.

## a. The preload contract

`electron/preload.mjs` (61 lines). Four globals, `window.electron` of two members and
`window.electronApi` of eleven: 17 in all.

| Member | Preload line | Channel and what `ipcMain` does |
|---|---|---|
| `window.isElectron = true` | `:10` | Static |
| `window.defaultPkcOptions` | `:5-8, :11` | Static: `{pkcRpcClientsOptions: ['ws://localhost:9138'], httpRoutersOptions: ['https://peers.pleb.bot', 'https://routing.lol', 'https://peers.forumindex.com', 'https://peers.plebpubsub.xyz']}` |
| `window.defaultMediaIpfsGatewayUrl = 'http://localhost:6473'` | `:12` | Static |
| `window.pkcRpcAuthKey` | `:15-16` | `send('get-pkc-rpc-auth-key')` (`main.js:53`), answered on `pkc-rpc-auth-key`. Nothing in `src/` reads it |
| `window.electron.invoke(channel, ...args)` | `:20-26` | Whitelist of four channels: `get-notification-permission-status`, `get-platform`, `test-notification-permission`, `copy-to-clipboard`; any other throws `Unauthorized IPC channel` |
| `window.electron.sendNotification(n)` | `:27-29` | `send('show-notification')` |
| `electronApi.isElectron` | `:41` | Static |
| `electronApi.getNotificationStatus()` | `:42` | `get-notification-permission-status` (`main.js:85`) |
| `electronApi.getPlatform()` | `:43` | `get-platform` (`main.js:557`): the object `{platform, arch, version}` |
| `electronApi.getNodeReachability()` | `:44` | `get-node-reachability` (`main.js:554`) |
| `electronApi.testNotification()` | `:45` | `test-notification-permission` (`main.js:112`) |
| `electronApi.showNotification(n)` | `:46` | `send('show-notification')` (`main.js:65`) |
| `electronApi.copyToClipboard(text)` | `:47` | `copy-to-clipboard` (`main.js:542`) |
| `electronApi.automateUploadMedia({provider, file})` | `:49-53` | The preload turns the `File` into a path with `webUtils.getPathForFile` and rejects `File path unavailable` when it has none, then `automate-upload-media` with `{provider, filePath}` (`main.js:492`) |
| `electronApi.isFileOnDisk(file)` | `:54` | `Boolean(getPathForFile(file))`. No IPC |
| `electronApi.automateUploadGeneratedMedia(options)` | `:55` | `automate-upload-generated-media` (`main.js:516`) |
| `electronApi.getForgeTurnstileToken(sitekey)` | `:56-60` | `get-forge-turnstile-token` (`main.js:533`): main resolves `{token}` or `{error}`; the preload throws `Error(error)` or returns the token |

There is no updater member and no `downloadAndInstallUpdate`: a new version is a link to the
release page (`src/views/settings/settings.tsx:40-42`).

### Handlers, grouped by what Orivon needs

**Static or inert:** `isElectron`, `defaultPkcOptions`, `defaultMediaIpfsGatewayUrl`,
`getPlatform`, `pkcRpcAuthKey` (never read).

**A page API covers it:** `copyToClipboard` (`{success: true}` or `{success: false, error}`; the
renderer falls back to `navigator.clipboard`, `src/lib/utils/clipboard-utils.ts:6-8`).

**Notifications:**

- `show-notification` (`main.js:65-83`, `send`): when `Notification.isSupported()`, it shows
  `new Notification({title, body})`; when the payload has a `url`, a click calls
  `shell.openExternal(url)`. It is fire and forget.
- `get-notification-permission-status` (`main.js:85-110`) returns one of `'not-supported'`,
  `'denied'`, `'granted'`, `'not-determined'`, `'unknown'`. On macOS it reads
  `systemPreferences.getNotificationSettings().authorizationStatus` (`denied`, `authorized` is
  `granted`, else `not-determined`); on every other platform it answers `'granted'`; a throw
  answers `'unknown'`.
- `test-notification-permission` (`main.js:112-`) shows a "Seedit Test" notification and returns
  `{success: true}` or `{success: false, reason: 'denied' | 'not-supported'}`. The renderer never
  calls it (`testNotification` is typed in `src/globals.d.ts:22` and unused).
- The renderer's push layer prefers `electronApi.showNotification`, then
  `window.electron.sendNotification`, then `window.electron.invoke('show-notification', ...)`
  (`src/lib/push/electron.ts:25-52`). The last is unreachable: `show-notification` is not on the
  whitelist. With `electronApi` present only the first runs.

**Reads the node:** `getNodeReachability` (`electron/node-reachability.js:3, 177-192`) POSTs
`http://127.0.0.1:50019/api/v0/swarm/addrs/autonat` with a 5 s timeout and returns the lowercased
`reachability` when it is `'public'` or `'private'`, else `'unknown'`: the shape is the string
union `'public' | 'private' | 'unknown'` (`src/globals.d.ts:21`). The page polls it every 60 s
(`src/hooks/use-node-reachability.ts:13`) and
`src/components/community-reachability-alert/community-reachability-alert.tsx` shows a warning
only for `'private'` and only when the account's RPC port is 9138.

**No equivalent today:**

- `getForgeTurnstileToken(sitekey)`: `electron/forge-turnstile.js`, the same file as 5chan's. A
  hidden 340x120 `BrowserWindow` in the in-memory partition `forge-turnstile` loads
  `http://localhost/forge-turnstile?sitekey=<sitekey>`, which `ses.protocol.handle('http')` serves
  (that path only). The page loads `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`
  and calls `turnstile.render` with `appearance: 'interaction-only'`, `retry: 'never'`,
  `refresh-expired: 'never'`. Main reads `window.turnstileResult` through
  `mainFrame.executeJavaScript`, and shows the window only on `before-interactive-callback`.
  Timeouts: script 15 s, token 30 s, interactive 120 s, window 180 s. The sitekey comes from the
  renderer (`src/lib/media-hosting/forge-images-config.ts`, default `0x4AAAAAAFScwbbNFZtx0XVP`) and
  is validated against `^[0-9A-Za-z_-]{1,100}$`. Cloudflare issues a token only for a hostname the
  sitekey allows, so a `file://` page cannot get one (`main.js:531-532` says so).
- `automateUploadMedia` and `automateUploadGeneratedMedia`
  (`electron/media-upload-automation.js`, `media-upload-recipes.js`). Not HTTP: a hidden
  sandboxed `BrowserWindow` in the isolated partition `media-upload-automation`, with
  `setWindowOpenHandler` denying popups (`:74`), the CDP debugger attached, the provider's upload
  page loaded, `DOM.setFileInputFiles` with the host path, a click on submit, and a poll of the
  DOM every 500 ms for a direct media URL (it must pass `isDirectMediaUrl`). A recipe's
  blocked-indicator selector (captcha, login) fails at once. The result is `{url, provider}`.
  `main.js:492-514` checks `Object.hasOwn(MEDIA_UPLOAD_RECIPES, provider)`, an absolute path and
  `stat.isFile()` (so a device file cannot be read without end), runs `prepareStrippedUploadFile`
  on a temp copy, and removes the temp directory. `main.js:516-531` takes `{provider, fileName,
  bytes}` (the renderer also sends `mimeType`), writes the bytes to a temp directory and runs the
  same path. Recipes are the same three as 5chan's (`media-upload-recipes.js:294-339`): catbox
  `https://catbox.moe` (30 s), imgur `https://imgur.com/upload` (45 s) and imgbb
  `https://imgbb.com/` (60 s).

### Not preload, but the same contract

`electron/main.js` also does these to the main window:

| Behaviour | Evidence |
|---|---|
| Sets the window User-Agent to a Chrome string | `:56-62` |
| For XHR and fetch (not iframes): sets the UA to `seedit/<version>`, removes `sec-ch-ua*`, `Sec-Fetch-*` and `Origin` | `:209-245` (`onBeforeSendHeaders`) |
| Replaces the response CORS headers with `Access-Control-Allow-Origin: *` | `:209-245` (`onHeadersReceived`) |
| `file://` start URL (dev: `http://localhost:3000`); DevTools only in dev | `:247` |
| Denies every permission request; intercepts `will-navigate` and `window.open`: only `https:` and exactly `http://localhost:50019/webui/` reach `shell.openExternal` | `main.js` (same handlers as 5chan) |
| Linux ozone and GTK environment hardening; the tray is skipped on Wayland unless `SEEDIT_ENABLE_TRAY=1` | `main.js` |

`electron/src/main.ts`, `electron/src/preload.ts` and `electron/src/plugins/file-uploader.ts` are
legacy: `package.json`'s `main` and the preload build do not reference them. The renderer's
`src/hooks/use-media-upload.ts` imports a Capacitor `FileUploader` plugin for Android only.

## b. Every read of the Electron globals in `src/`

| File:line | Global | Gates |
|---|---|---|
| `src/lib/p2p-browser-config.ts:135-161` | `electronApi.isElectron`, `isElectron`, `defaultPkcOptions` | Runtime choice: Electron (RPC) against pure P2P in the page |
| `src/lib/p2p-runtime.ts:54` | `isElectron` | `getP2PRuntimeMode` |
| `src/lib/utils/account-import-utils.ts:144-236` | `isElectron` | `processImportedAccount`: an imported account's `pkcOptions` become the Electron defaults (`ws://localhost:9138`) |
| `src/views/settings/account-settings/account-settings.tsx:13, 39` | `isElectronRuntime(window)` | The import transform |
| `src/views/settings/advanced-settings/advanced-settings.tsx:218, 371` | `electronApi.isElectron` | The "p2p data path" section (`P2pDataPathSettings`) |
| `src/views/settings/settings.tsx:40, 177-181` | `electronApi.isElectron` | The update text (a releases link); the node-stats link (c) |
| `src/views/settings/notifications-settings/notifications-settings.tsx:35-198` | `electronApi.getNotificationStatus`, `getPlatform`, `isElectron` | Permission status, the denied-message text; see the trap below |
| `src/lib/push/index.ts:10`, `src/lib/push/electron.ts:25-52` | `electronApi.isElectron`, `getNotificationStatus`, `showNotification`, `window.electron.*` | Local notifications |
| `src/hooks/use-node-reachability.ts:13` | `electronApi.getNodeReachability` | 60 s poll |
| `src/lib/analytics/shared.ts:9-15` | `isElectron`, `electronApi.isElectron` | Analytics off; also only on `seedit.app` |
| `src/lib/media-hosting/runtime.ts:6` | `electronApi.isElectron`, `isElectron` | `getMediaHostingRuntime()` returns `'electron'`, `'android'` or `'web'`; the `'electron'` runtime lists all four providers, `'web'` lists only Forge (`providers.ts:30, 43, 51, 59`) |
| `src/lib/media-hosting/upload-orchestrator.ts:56-66` | `electronApi.automateUploadMedia`, `isFileOnDisk`, `automateUploadGeneratedMedia` | imgur and imgbb |
| `src/lib/media-hosting/forge.ts:157` | `electronApi.getForgeTurnstileToken` | Forge token; falls back to the in-page widget |
| `src/lib/utils/clipboard-utils.ts:6-8` | `electronApi.copyToClipboard` | Copy; falls back to `navigator.clipboard` |
| `src/components/faq/faq.tsx:60` | `electronApi.isElectron` | The words "in the desktop app" in the FAQ |
| `src/globals.d.ts:18-50` | all | Types only |

**A trap in upstream's own contract.** `getPlatform` resolves an object
`{platform, arch, version}` (`main.js:557-563`), but `src/globals.d.ts:20` types it
`Promise<NodeJS.Platform>` and `notifications-settings.tsx:68-75` stores the result as a string
and compares `platform === 'darwin'` (`:196`). With the real preload the macOS branch of the
denied message never runs and the generic one prints `[object Object]`. A bridge reproduces the
object, as the preload does; it is upstream's bug, not the bridge's.

`window.pkcRpcAuthKey` is never read in `src/`. `testNotification` is declared and never called.

## c. The Electron-only link to the node

```tsx
{window.electronApi?.isElectron && (
  <a className={styles.fullNodeStats} href='http://localhost:50019/webui/' target='_blank' rel='noreferrer'>
    {t('node_stats')}
  </a>
)}
```

`src/views/settings/settings.tsx:177-181`, in the version row of the settings page. It is a plain
anchor with `target='_blank'`, not `window.open` and not the router. Electron's
`setWindowOpenHandler` and `will-navigate` special-case exactly `http://localhost:50019/webui/`
and send it to `shell.openExternal`, so the system browser opens the Kubo web UI. It is not an
`https:` URL, so in Orivon the bridge decides what the click does.

## d. Media

seedit has settings for external media, with defaults that load everything.

| Setting | Values and default | Evidence |
|---|---|---|
| `thumbnailDisplayOption` | `'show'` (default), `'hide'` ("Don't show thumbnails next to links"), `'community'` (shown disabled, "not available yet") | `src/stores/use-content-options-store.ts`, `src/views/settings/content-options/content-options.tsx:23-55`; `src/components/post/post.tsx:280` renders the thumbnail only when `'show'` |
| `mediaPreviewOption` | `'autoExpandAll'` (default), `'autoExpandExceptComments'`, `'community'` | `use-content-options-store.ts`; `post.tsx:190-192` |
| `blurNsfwThumbnails` | `true` | `use-content-options-store.ts` |
| `hideNsfwCommunities` | `true` | `use-content-options-store.ts` |

There is no switch that stops a remote image or video from loading under the defaults, and `'hide'`
only removes the thumbnail, not the expando. Media renders by URL from any host:
`<img src={thumbnail || url}>`, `<video src={url}#t=0.001>`
(`src/components/thumbnail/thumbnail.tsx:87-131`). A linked page's thumbnail is fetched by `fetch`
with `Accept: text/html` when the community does not supply one (`src/lib/utils/media-utils.ts:159`),
which needs CORS; YouTube and Streamable thumbnails come from `img.youtube.com` and
`cdn-cf-east.streamable.com` (`media-utils.ts:57, 61`).

## e. How default subscriptions and directories are loaded

By URL at run time, with a vendored copy as the initial snapshot. Not through pkc.

```ts
// src/lib/utils/starter-community-list.ts:4
const STARTER_COMMUNITIES_URL = 'https://raw.githubusercontent.com/bitsocialnet/lists/master/seedit-default-subscriptions.json';
// :87-96
return fetch(STARTER_COMMUNITIES_URL, { cache: 'no-cache', signal: controller.signal })
```

The timeout is 10 s. `src/hooks/use-default-subscriptions.ts:3, 20` imports the bundled
`src/data/seedit-starter-communities.json` and uses it as the initial snapshot
(`{list: vendoredList, loading: true}`), then revalidates hourly (`:12`) and on
`visibilitychange` (`:32-72`).

Directories: `src/lib/utils/directory-registry.ts:9`
`DIRECTORY_DEFAULTS_URL = 'https://raw.githubusercontent.com/bitsocialnet/lists/master/seedit-directories/seedit-directories-defaults.json'`
(cached in `localStorage` under `seedit-directory-defaults-cache`), and
`src/hooks/use-directory-list.ts:7` the template
`.../seedit-directories/seedit-{code}-directory.json`. The bundled copies are in
`src/data/seedit-directories/` (12 files) and `src/data/5chan-directories/` (4 files).

## f. Outbound endpoints hard-coded in `src/`

"Electron build" says whether the Electron renderer reaches it.

| Host | File:line | Purpose | Electron build |
|---|---|---|---|
| `raw.githubusercontent.com` | `starter-community-list.ts:4`, `directory-registry.ts:9`, `use-directory-list.ts:7` (all under `src/lib/utils/` or `src/hooks/`) | Default subscriptions, directory lists | Yes |
| `raw.githubusercontent.com/bitsocialnet/seedit/master/package.json` | `src/views/settings/settings.tsx:34` | Manual "check for updates" | Yes, when clicked |
| `api.github.com/repos/bitsocialnet/seedit/commits?per_page=1&sha=development` | `settings.tsx:56` | Latest development commit | Only when `VITE_COMMIT_REF` is set |
| `github.com/bitsocialnet/seedit/releases/latest` | `settings.tsx:40-42` | A link in the update text | Yes (a link) |
| `api.seeditarchive.org` | `src/lib/search-providers.ts:9-15` (`VITE_SEEDITARCHIVE_API_URL`), `src/lib/search-indexer.ts:142` | Search | Yes; its CORS allow-list covers `https://seedit.localhost` and the `*.seedit.localhost` dev origins, so a `file://` or an Orivon origin relies on the CORS rewrite of main |
| `s.seedit.app`, `seedit.eth.limo` | `src/lib/utils/community-route-utils.ts:56`, text | Share-link text | Yes (text, not fetched) |
| `img-api.bitsocialforge.com`, `forgeimg.net` | `src/lib/media-hosting/forge-images-config.ts` (`VITE_FORGE_IMAGES_API_ORIGIN`, `VITE_FORGE_IMAGES_MEDIA_ORIGIN`) | Forge upload API and media origin | Yes |
| `challenges.cloudflare.com` | `electron/forge-turnstile.js`, the in-page widget | Turnstile script | Yes (in the main-owned window) |
| `catbox.moe`, `files.catbox.moe` | `src/lib/media-hosting/catbox.ts`, `providers.ts` | Upload and probe | Yes |
| `imgur.com`, `i.imgur.com`, `s.imgur.com`, `imgbb.com`, `i.ibb.co` | `electron/media-upload-recipes.js`, `providers.ts` | Upload pages and probes | Yes |
| `img.youtube.com`, `cdn-cf-east.streamable.com` | `src/lib/utils/media-utils.ts:57, 61` | Video thumbnails | Yes |
| `api.country.is`, `api.ipify.org`, `free.freeipapi.com` | `src/lib/peer-geo.ts:35-37` | Peer location in the P2P stats UI | Yes, when that UI is open |
| `localhost:50019` (`/api/v0`, `/webui/`) | `src/lib/p2p-stats.ts:117, 948`, `settings.tsx:177-181` | Kubo API and web UI | Electron only |
| Pubsub, gateway and router defaults (`pubsubprovider.xyz`, `plebpubsub.xyz`, `rannithepleb.com`, `ipfsgateway.xyz`, `gateway.plebpubsub.xyz`, `gateway.forumindex.com`, `peers.pleb.bot`, `routing.lol`, `peers.forumindex.com`, `peers.plebpubsub.xyz`, `routerofbitsocial.xyz`, `bsotracker.online`) | `src/lib/p2p-browser-config.ts` (the same lists as 5chan) and `electron/preload.mjs:7` | Browser mode providers; routers for the node | Browser mode only, except the four routers the node uses |
| `ethrpc.xyz` | `src/lib/utils/account-import-utils.ts` | Default chain provider on an imported account | Yes (the account stores it) |
| Vercel analytics | `src/lib/analytics/shared.ts:9-15` | Page analytics | No: off in Electron and off any host but `seedit.app` |
| Embed hosts | `src/components/` embeds | Iframes opened on click | Yes |

seedit has no `stats.bitsocial.net` and no directory-voting RPCs. The Electron main process adds
its own set (j), the same as 5chan's.

## g. Routing, inline scripts, service worker, manifest

| Fact | Evidence |
|---|---|
| `HashRouter` | `src/index.tsx:6`; `src/static-shell.tsx` too |
| One executable inline script in `index.html`: when the protocol is not `file:`, the path is neither `/` nor ends in `/index.html` and there is no hash, it runs `window.location.replace('/#' + pathname + search)`. An absolute-root redirect, a trap under a path-prefixed host | `index.html:13-25` |
| Source hrefs are absolute: `/apple-touch-icon.png`, `/manifest.json`, `/src/bootstrap.ts`; `PUBLIC_URL=./` rewrites the build's own assets | `index.html`, `vite.config.js:195` (`base`) |
| `staticShellPlugin` and `dynamicEntryPreloadPlugin` add inline scripts and startup CSS to the built HTML | `vite.config.js` |
| Service worker: `registerSW({immediate: true})` from `virtual:pwa-register` unless the build is the profiling mode, for every runtime; VitePWA `sw.ts` | `src/index.tsx:20-35`, `vite.config.js:43` |
| Manifest: `public/manifest.json`, plus `public/redirect.html` | `index.html`, `public/` |
| No CSP: `vercel.json` has none, and the `file://` page has none | `vercel.json` |
| `import.meta.env` and `process.env.VITE_COMMIT_REF` are defined at build | `vite.config.js:202` |
| Target is `esnext` unless `ELECTRON` is set | `vite.config.js:184` |

## h. Build

| Fact | Evidence |
|---|---|
| Node 22.17.0 | `.nvmrc` |
| Package manager `yarn@4.17.1` (no hash in the pin; corepack fetches exactly that release) | `package.json` (`packageManager`) |
| Install runs scripts (`enableScripts: true`, `nodeLinker: node-modules`, `npmMinimalAgeGate: 0`): electron, sharp and better-sqlite3 download or build; `ELECTRON_SKIP_BINARY_DOWNLOAD` skips the Electron binary | `.yarnrc.yml` |
| `build` = `cross-env NODE_ENV=production PUBLIC_URL=./ GENERATE_SOURCEMAP=false vite build`: no corepack and no network pre-step | `package.json:59` |
| Upstream's release workflow runs `CI='' NODE_ENV=production yarn build` | `.github/workflows/release.yml:59, 139, 233` |
| `sync:directories` is a separate script, not part of `build` | `package.json:58` |
| The preload: `cross-env NODE_ENV=production vite build --config electron/vite.preload.config.js` | `package.json:60` |
| `vite.config.js` runs no git or child process; `VITE_COMMIT_REF` is read as given | `vite.config.js:202`, `src/components/version/version.tsx:4`, `settings.tsx:23` |

Environment, with the value when unset:

| Variable | Default when unset |
|---|---|
| `VITE_COMMIT_REF` | unset: the UI shows the plain version. Set, it shows `version#sha` and `settings.tsx:56` queries GitHub. Leave it unset |
| `VITE_SEEDITARCHIVE_API_URL` | `https://api.seeditarchive.org` |
| `VITE_FORGE_IMAGES_API_ORIGIN` | `https://img-api.bitsocialforge.com` |
| `VITE_FORGE_IMAGES_MEDIA_ORIGIN` | `https://forgeimg.net` |
| `VITE_FORGE_IMAGES_TURNSTILE_SITEKEY` | `0x4AAAAAAFScwbbNFZtx0XVP` |

Network beyond the install: none for `vite build`. For a packaged app only, the Kubo download from
GitHub releases (`electron/before-pack.js:16-38`, Kubo 0.43.0).

## i. The pkc client side

| Fact | Evidence |
|---|---|
| `@pkcprotocol/pkc-js` 0.0.132, `@bitsocial/bitsocial-react-hooks` 0.2.2 | `package.json` |
| In Electron the renderer connects to `ws://localhost:9138` through `pkcRpcClientsOptions` | `electron/preload.mjs:5-8` |
| The URL goes to `new WebSocketClient(url)` unchanged, so `ws://localhost:9138/<authKey>` is accepted | `pkc-js` `dist/node/rpc/src` client |
| The server accepts a keyless connection only from loopback with no `X-Forwarded-For`; otherwise the URL path must be `/<authKey>` | `pkc-js dist/node/rpc/src/index.js:116-135` |
| The hooks package defaults an account's six HTTP routers and `chainProviders` for `eth` and `matic`, and overrides `{resolveAuthorNames: false, resolveAuthorAddresses: false, validatePages: false}` | `account-generator.js:27-44` |
| `defaultMediaIpfsGatewayUrl` defaults to `https://ipfs.io` | `account-generator.js:98` |
| Name resolvers run server-side under RPC; the RPC client has none | `electron/pkc-rpc-options.js` |

## j. The main process's node

The same code as 5chan's, apart from file structure (`electron/start-ipfs.js`,
`start-pkc-rpc.js`, `pkc-rpc-options.js`, `proxy-server.js`, `pkc-paths.js`):

- **Kubo 0.43.0.** `ipfs init`, `ipfs repo migrate`, gateway
  `/ip4/127.0.0.1/tcp/6473`, API `/ip4/127.0.0.1/tcp/50019` (dev: 50029 behind a CORS proxy on
  50019), `ipfs daemon --migrate --enable-pubsub-experiment --enable-namesys-pubsub`. Everything
  else is Kubo's defaults, including its bootstrap peers. `IPFS_PATH` is `<pkcDataPath>/ipfs`.
- **pkc RPC.** Port 9138, auth key read or generated at `<dataPath>/auth-key` (40 characters),
  `PKCRpc.PKCWsServer({port, pkcOptions, authKey})`, listening on all interfaces.
- **Options** (`pkc-rpc-options.js`): `kuboRpcClientsOptions: [{url: 'http://localhost:50019/api/v0'}]`,
  `httpRoutersOptions: ['https://routing.lol', 'https://peers.pleb.bot', 'https://peers.plebpubsub.xyz', 'https://peers.forumindex.com']`,
  and six `BsoResolver` name resolvers keyed `eth-<hostname>` over `ethereum-rpc.publicnode.com`,
  `eth.drpc.org`, `ethereum.publicnode.com`, `rpc.mevblocker.io`, `1rpc.io/eth` and
  `eth-pokt.nodies.app`. No `chainProviders`; no challenge is registered by main (pkc-js 0.0.132's
  built-in challenges are `text-math`, `fail`, `blacklist`, `whitelist`, `question` and
  `publication-match`).
- Data dir `EnvPaths('pkc', {suffix: false}).data`; in dev `<root>/.pkc`, which
  `electron:before` deletes.

## k. Verdict and capability ratio

**A port with a bridge, behind one gate: a node.**

| Class | Members | Count |
|---|---|---|
| Static, set by the bridge | `isElectron`, `electronApi.isElectron`, `defaultPkcOptions`, `defaultMediaIpfsGatewayUrl`, `getPlatform` | 5 |
| Dead or unreached in the renderer | `pkcRpcAuthKey`, `testNotification`, `window.electron.invoke`, `window.electron.sendNotification` | 4 |
| A page API covers it | `copyToClipboard` | 1 |
| Inert, or answered by the node | `getNodeReachability` (`'unknown'` without a node) | 1 |
| Needs a notification capability, or a page API | `getNotificationStatus`, `showNotification` | 2 |
| Needs an `orivon.*` capability, or has none | `getForgeTurnstileToken`, `automateUploadMedia`, `automateUploadGeneratedMedia`, `isFileOnDisk` | 4 |

Ratio: **4 of 17 members need a capability with no equivalent today**, three decisions
(Turnstile; automation; `isFileOnDisk` goes with automation), and 7 of 17 counting notifications
and clipboard. Both providers behind the two `automate*` members have no HTTP path, so those
decide whether imgur and imgbb exist in an Orivon port. catbox is an HTTP upload
(`src/lib/media-hosting/catbox.ts`) that needs main's CORS rewrite. The page still works without all of them: the
upload controls shrink to the providers that run.

What the page needs from a node, none of it a member: `ws://localhost:9138` accepting a keyless
loopback connection (or a path with the key), `http://localhost:6473` as the IPFS gateway for
media, `http://localhost:50019/api/v0` for stats and reachability, and the loopback link in
section c. A page started without `isElectron` runs the in-page libp2p mode and needs none of it;
there Forge is the only uploader.

## What contradicts "the desktop renderer is plain `yarn build` plus the preload"

1. **The renderer is not the whole contract.** `electron/main.js:209-245` rewrites every
   non-iframe XHR and fetch (UA, no `Origin`, no `Sec-*`, `Access-Control-Allow-Origin: *`). The
   catbox upload, search, the thumbnail fetch and the Kubo API calls depend on it.
2. **The node is not in the preload.** `main.js` spawns Kubo and `PKCWsServer`.
3. **`file://` cannot get a Turnstile token**; the main-owned `http://localhost` window is not
   optional for Forge.
4. **The built `index.html` carries an absolute-root redirect and registers a service worker for
   every runtime**; both only matter off `file:`, which is the case under Orivon.
5. **Upstream's contract has a type bug** (`getPlatform`, section b) and a dead fallback path
   (`window.electron.invoke('show-notification')`).
6. **Unlike 5chan, `yarn build` here has no network or git step**; `VITE_COMMIT_REF` must stay
   unset or the UI links an unreleased commit.

## For orivon-mvp (the blockers, to hand over as a prompt, not to patch here)

- A native node capability: Kubo 0.43.0 and a `PKCWsServer`, or an equivalent that serves the pkc
  RPC on loopback 9138 and a gateway on 6473.
- A fetch with no `Origin` and with CORS open, for arbitrary hosts and for loopback.
- A hidden-window DOM automation capability (CDP `DOM.setFileInputFiles`), or a decision that
  imgur and imgbb are not offered.
- A page whose hostname is `localhost` for Turnstile, or a Turnstile capability.
- A native notification capability that can open a URL on click, or the page `Notification` API.
- Allowing the loopback link `http://localhost:50019/webui/` to reach the system browser.
