# 5chan port reconnaissance

Read against a local clone of **bitsocialnet/5chan** at `40ebfcebdfb4b4cac18e8e728d8c8a0cc997694d`
(tag v0.10.4, GPL-3.0-or-later, `package.json:8`). Line numbers are that revision's. The repository
holds the web app (Vite, React, HashRouter) and its Electron desktop shell in `electron/`. The
desktop renderer is the web app's `vite build` output in `build/`, loaded from `file://`.
`orivon-port recon` counts nothing here: the preload is ESM (`electron/preload.mjs`), which the
recon reads as no preload, so the member counts below are by hand.

## The one-line answer

**Portable as the desktop build with a bridge, and the bridge is small; the node is the cost.** The
renderer is a static page whose Electron contract is 13 members, 9 of them static, inert or
refused. What the page cannot do without the desktop shell is talk to a node: `ws://localhost:9138`
(the pkc RPC) and `http://localhost:6473` (the Kubo gateway) are loopback services that
`electron/main.js` spawns, not the preload. Without `isElectron` the same bundle switches to an
in-page libp2p mode and uses neither.

## The shape

| Fact | Evidence |
|---|---|
| Renderer is `vite build` output in `build/`, loaded from `file://` | `electron/main.js:173` (`startURL`), `vite.config.js:531-533` (`outDir: 'build'`) |
| Dev loads `http://localhost:3000` | `electron/main.js:173` (`isDev`) |
| The preload is a separate Vite build into `build/electron/preload.cjs` | `package.json` (`build:preload`), `electron/main.js:116-129` |
| Main spawns the node: Kubo, then a pkc RPC server | `electron/main.js:11-12` (requires `start-ipfs.js`, `start-pkc-rpc.js`) |
| The runtime is picked by `isElectron` | `src/lib/p2p-browser-config.ts:135-137` (`isElectronRuntime`, `canUsePureP2PBrowser = !isElectronRuntime`) |
| Pure P2P in the page is the default when `isElectron` is absent | `src/index.tsx:31` (`configureP2PBrowserPkcOptions()`), `src/lib/p2p-browser-config.ts` (`BROWSER_PURE_P2P_DEFAULT_ENABLED = true`) |
| The hooks package reads `window.defaultPkcOptions` on every account load | `@bitsocial/bitsocial-react-hooks` 0.2.2 `account-generator.js:71-91`, `accounts-database.js:93-96, 297-301` |
| Default (equal) options are not stored, so they follow the current defaults | `accounts-database.js:297-301` |

Versions: `@pkcprotocol/pkc-js` 0.0.132 (pinned again in `resolutions`), `@bitsocial/bitsocial-react-hooks`
0.2.2 (a devDependency, bundled), `@bitsocial/bso-resolver` 0.0.10, `@bitsocial/pubsub-voting` 0.7.8,
Electron 44.10.1, Vite 8.3.5 (`package.json`).

## a. The preload contract

`electron/preload.mjs` (36 lines) uses `contextBridge.exposeInMainWorld` and `ipcRenderer`. Four
globals and one object of nine members: 13 in all.

| Member | Preload line | Channel and what `ipcMain` does |
|---|---|---|
| `window.isElectron = true` | `:8` | Static |
| `window.defaultPkcOptions` | `:3-6, :9` | Static: `{pkcRpcClientsOptions: ['ws://localhost:9138'], httpRoutersOptions: ['https://peers.pleb.bot', 'https://routing.lol', 'https://peers.forumindex.com', 'https://peers.plebpubsub.xyz']}` |
| `window.defaultMediaIpfsGatewayUrl = 'http://localhost:6473'` | `:10` | Static, the Kubo gateway main configures |
| `window.pkcRpcAuthKey` | `:13-14` | `ipcRenderer.send('get-pkc-rpc-auth-key')`, answered on `pkc-rpc-auth-key` with the key read from `<pkcDataPath>/auth-key` (`main.js:46-49`). Nothing in `src/` reads it |
| `electronApi.isElectron` | `:17` | Static |
| `electronApi.copyToClipboard(text)` | `:18` | `copy-to-clipboard` (`main.js:396`): returns `{success: true}` or `{success: false, error}` |
| `electronApi.getPlatform()` | `:19` | `get-platform` (`main.js:410`): `{platform, arch, version}` |
| `electronApi.getNodeReachability()` | `:20` | `get-node-reachability` (`main.js:407`), see below |
| `electronApi.automateUploadMedia(options)` | `:21` | `automate-upload-media` (`main.js:419`), see below |
| `electronApi.automateUploadGeneratedMedia(options)` | `:22` | `automate-upload-generated-media` (`main.js:438`), see below |
| `electronApi.getForgeTurnstileToken(sitekey)` | `:23-27` | `get-forge-turnstile-token` (`main.js:455`): main resolves `{token}` or `{error}`; the preload throws `Error(error)` or returns the token |
| `electronApi.downloadAndInstallUpdate(options)` | `:28` | `download-and-install-update` (`main.js:463`), see below |
| `electronApi.getPathForFile(file)` | `:29-35` | `webUtils.getPathForFile`, `null` on error. No IPC |

There is no `window.electron` and no event channel from main to the page other than
`pkc-rpc-auth-key`.

### Handlers, grouped by what Orivon needs

**Static or inert (no host work):** `isElectron`, `defaultPkcOptions`, `defaultMediaIpfsGatewayUrl`,
`getPlatform` (read only by the updater, `src/lib/app-update.ts:137`), `pkcRpcAuthKey` (never read).

**A page API covers it:** `copyToClipboard`. The renderer falls back to `navigator.clipboard` when
`electronApi` is absent (`src/lib/clipboard-utils.ts:6,8`).

**Reads the node:** `getNodeReachability` (`electron/node-reachability.js:3, 177-192`). It POSTs
`http://127.0.0.1:50019/api/v0/swarm/addrs/autonat` with a 5 s timeout and returns the lowercased
`reachability` field when it is `'public'` or `'private'`, else `'unknown'`: the return shape is
the string union `'public' | 'private' | 'unknown'`. The page polls it every 60 s
(`src/hooks/use-node-reachability.ts:13`) and shows `src/components/board-reachability-alert/board-reachability-alert.tsx` only when the
RPC URL list is `ws://localhost:9138`.

**No equivalent today, decides the upload feature:**

- `getForgeTurnstileToken(sitekey)`, `electron/forge-turnstile.js`. Main opens a hidden 340x120
  `BrowserWindow` in the in-memory partition `forge-turnstile`, and serves
  `http://localhost/forge-turnstile?sitekey=<sitekey>` from `ses.protocol.handle('http')` (that
  path only, any other 404s). The page loads
  `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` and calls
  `turnstile.render` with `appearance: 'interaction-only'`, `retry: 'never'`,
  `refresh-expired: 'never'`. Main reads `window.turnstileResult` through
  `mainFrame.executeJavaScript` and shows the window only on `before-interactive-callback`.
  Timeouts: script 15 s, token 30 s, interactive 120 s, window 180 s. The sitekey comes from the
  renderer (`FORGE_IMAGES_TURNSTILE_SITEKEY`, default `0x4AAAAAAFScwbbNFZtx0XVP`,
  `src/lib/forge-images-config.ts:13`) and main validates it against `^[0-9A-Za-z_-]{1,100}$`.
  The window exists because Cloudflare issues a token only for a hostname the sitekey allows
  ("5chan.app and localhost" in the site's configuration), so a `file://` page cannot get one.
- `automateUploadMedia({provider, filePath})`, `electron/media-upload-automation.js`,
  `media-upload-recipes.js`. This is not HTTP. Main requires a `provider` and a `filePath`, runs
  `prepareStrippedUploadFile` (`electron/strip-media-metadata.js`), then opens a hidden sandboxed
  `BrowserWindow` in the default session, attaches the CDP debugger, loads the provider's upload
  page, runs `DOM.setFileInputFiles` with the host path, clicks submit, and polls the DOM every
  500 ms for a direct media URL (it must pass `isDirectMediaUrl`, an extension list). A recipe's
  blocked-indicator selector (captcha, login) fails at once. It resolves `{url, provider}` and
  removes the temp copy. Recipes (`media-upload-recipes.js:294-339`):

  | Provider | Upload page | Timeout | Success extractor |
  |---|---|---|---|
  | catbox | `https://catbox.moe` | 30 s | Defined, but the renderer uploads catbox by HTTP instead |
  | imgur | `https://imgur.com/upload` | 45 s | `a[href*="i.imgur.com"]` and similar |
  | imgbb | `https://imgbb.com/` | 60 s | `input[name="html-embed-medium"]` and similar; `prepareSubmitJs` sets the expiration to `''` |

- `automateUploadGeneratedMedia({provider, fileName, bytes})`: main writes the bytes (at most
  20 MiB) to a temp directory, then runs the same path. It exists for a file the page made (a
  drawing) that has no path.

**Refused or inert in Orivon:** `downloadAndInstallUpdate({url, fileName})`
(`electron/app-updater.js`). Trusted hosts are `github.com`, `githubusercontent.com` and
`*.githubusercontent.com` (`:200`); main downloads with `fetch` to `<tmp>/5chan-updates/<fileName>`;
a macOS `.zip` is unpacked with `ditto` and a replacement script, a Linux `.AppImage` replaces the
running file, anything else goes to `shell.openPath`. The update check is in the renderer
(`src/lib/app-update.ts:24-59`, `src/lib/app-update-config.ts:3`: GET
`https://api.github.com/repos/bitsocialnet/5chan/releases/latest`, and the asset must be under
`https://github.com/bitsocialnet/5chan/releases/download/`). An Orivon port answers "nothing newer".

### Not preload, but the same contract

`electron/main.js` also does these to the main window, which the bundle depends on:

| Behaviour | Evidence |
|---|---|
| Sets the window User-Agent to a Chrome string | `:132` |
| For XHR and fetch (not iframes): sets the UA to `5chan/<version>`, removes `sec-ch-ua*`, `Sec-Fetch-*` and `Origin` | `:135-152` (`onBeforeSendHeaders`) |
| Replaces the response CORS headers with `Access-Control-Allow-Origin: *` and allows every method and header | `:155-171` (`onHeadersReceived`) |
| `webSecurity: true`, `nodeIntegration: false`, `contextIsolation: true`, `devTools: true` | `:116-129` |
| Denies every permission request | `:264-267` |
| Intercepts `will-navigate` and `window.open`: only `https:` and exactly `http://localhost:50019/webui/` reach `shell.openExternal` | `:204-231`, `:235-261` |
| Tray, with close to tray (not macOS, not dev) | `:275-317` |

## b. Every read of the Electron globals in `src/`

| File:line | Global | Gates |
|---|---|---|
| `src/lib/p2p-browser-config.ts:135, 137` | `electronApi.isElectron`, `isElectron` | Runtime choice: Electron (RPC) against pure P2P in the page |
| `src/lib/p2p-browser-config.ts:46-47, 151, 160` | `window.defaultPkcOptions` | Whether options are the Electron defaults or the browser ones |
| `src/lib/p2p-runtime.ts:6, 54` | `isElectron` | `getP2PRuntimeMode`: `browser-libp2p`, `electron-kubo-rpc` or `full-node-rpc` |
| `src/lib/utils/account-import-utils.ts:144-231` | `isElectron` | `processImportedAccount(content, isElectron)`: an imported account's `pkcOptions` become `getDefaultElectronConfig` (`ws://localhost:9138`) |
| `src/components/settings-modal/account-settings/account-settings.tsx:8, 52, 117, 154` | `isElectron` | The import transform and the host label "this desktop app" |
| `src/components/settings-modal/advanced-settings/advanced-settings.tsx:257, 409` | `isElectron` | `P2pDataPathSettings`: the RPC `pkcOptions.dataPath` field, disabled unless the RPC state is `connected` |
| `src/components/version/version.tsx:7, 27-35` | `isElectron` | The node-stats link to the Kubo web UI (c) |
| `src/hooks/use-node-reachability.ts:13` | `electronApi.getNodeReachability` | 60 s poll, only when the RPC URLs are `localhost:9138` |
| `src/lib/analytics/shared.ts:5` | `window.isElectron` | Analytics off; also off on any host other than 5chan.app |
| `src/lib/app-update.ts:6, 46, 137, 251-255` | `isElectron`, `electronApi.getPlatform`, `downloadAndInstallUpdate` | The in-app updater |
| `src/lib/media-hosting/show-upload-controls.ts:4-5, 10` | `isElectron` | Runtime `electron` lists all four providers; the web runtime lists only Forge |
| `src/lib/media-hosting/upload-orchestrator.ts:50, 73, 83` | `electronApi.*` | Picks automation for imgur and imgbb |
| `src/lib/utils/clipboard-utils.ts:6, 8` | `electronApi.copyToClipboard` | Copy; falls back to `navigator.clipboard` |
| `src/lib/utils/forge-utils.ts:178` | `electronApi.getForgeTurnstileToken` | Forge token; falls back to the in-page widget (`turnstile-utils.ts:1`) |
| `src/lib/p2p-stats.ts:122, 981` | none (a constant URL) | In `electron-kubo-rpc` mode the page POSTs `http://localhost:50019/api/v0` (`id`, `swarm/peers`, `stats/bw`) itself |
| `src/globals.d.ts:22-45` | all | Types only |

`window.pkcRpcAuthKey` is never read in `src/`. `window.defaultPkcOptions` and
`window.defaultMediaIpfsGatewayUrl` are read by the hooks package, not by 5chan's own code, which
only sets the first in `configureP2PBrowserPkcOptions`. `getPathForFile` is read by the upload
orchestrator to find the path an automated upload needs.

Directory voting needs the in-page Helia node (`src/hooks/use-pubsub-voter.ts`,
`src/lib/browser-libp2p-account.ts`), so voting on directories is unavailable in the Electron and RPC mode.

## c. The Electron-only link to the node

```tsx
{isElectron && (<a href='http://localhost:50019/webui/' target='_blank' rel='noreferrer'>{t('node_stats')}</a>)}
```

`src/components/version/version.tsx:27-35`, shown in the settings (`src/components/settings-modal/interface-settings/interface-settings.tsx:63`) and
the footer (`src/components/site-legal-meta/site-legal-meta.tsx:33`). It is a plain anchor with `target='_blank'`, not
`window.open` and not the router. Electron's `setWindowOpenHandler` and `will-navigate`
(`main.js:204-261`) special-case exactly that URL and send it to `shell.openExternal`, so the
system browser opens the Kubo web UI. In Orivon the bridge decides what the anchor does (the
loopback link is not an `https:` URL). There is no other entry point to the node in the UI; the
P2P stats section (`p2p-stats.ts:122`) reads the Kubo API from the page.

## d. Media

There is no setting to stop external media loading, and no click-to-load thumbnail in 5chan.

- Post media renders by URL, from any host: `<img src={thumbnail || url}>`, `<video src={url}#t=0.001>`,
  `<audio src>` (`src/components/comment-media/comment-media.tsx:99-140`).
- A GIF's first frame is fetched by XHR and drawn into a canvas
  (`GifFirstFrameCanvas`, `src/hooks/use-fetch-gif-first-frame.ts:22`), so it needs CORS.
- Probes that need CORS against post-linked hosts: a HEAD on a YouTube thumbnail
  (`src/lib/utils/media-utils.ts:171`), a GET of a linked HTML page for a thumbnail (`:384`), and a
  HEAD for `Content-Length` (`:619`, `use-media-file-size-store`). The Electron main process's
  CORS rewrite is what makes these work.
- Embeds (YouTube, Twitter, Reddit, TikTok, Instagram, Twitch, Vimeo, Spotify, SoundCloud,
  Streamable, Odysee, BitChute, Stack Overflow) are iframes created on click (`src/components/embed/embed.tsx`).
  Expanded media loads on click.

## e. How directories are loaded

By URL at run time, with a vendored copy as the fallback. Not through pkc.

```ts
// src/hooks/use-directories.ts:35-36
.../bitsocialnet/lists/master/5chan-directories/5chan-{code}-directory.json
.../bitsocialnet/lists/master/5chan-directories/5chan-directories-defaults.json
```

(host `https://raw.githubusercontent.com`.) The GET uses `cache: 'no-cache'` and a 10 s timeout and
the result is kept in `localStorage` for an hour (`5chan-directories-cache` and sibling keys).
`src/hooks/use-directory-list.ts:22` uses the same template. The fallback is
`src/lib/utils/vendored-directory-lists.ts:13`:
`import.meta.glob('../../data/5chan-directories/*.json', {eager: true})`, 68 committed files in
`src/data/5chan-directories/`. The voting criteria are fetched from
`.../bitsocialnet/lists/master/5chan-directory-criteria.jsonc`
(`src/lib/directory-vote-criteria.ts:6, 115`) with `src/data/5chan-directory-criteria.jsonc` as the
copy. `scripts/sync-directories.js` refreshes the committed copies at build time (h).

## f. Outbound endpoints hard-coded in `src/`

"Electron build" says whether the Electron renderer reaches it.

| Host | File:line | Purpose | Electron build |
|---|---|---|---|
| `raw.githubusercontent.com` | `src/hooks/use-directories.ts:35-36`, `src/hooks/use-directory-list.ts:22`, `src/lib/directory-vote-criteria.ts:6, 115` | Directory lists, defaults and criteria | Yes |
| `api.github.com` | `src/lib/app-update-config.ts:3` | Latest release (updater) | Yes (Electron runtime only) |
| `stats.bitsocial.net` | `src/lib/stats-providers.ts:18, 21`, an inline script in `index.html` | Board statistics | Yes |
| `api.5archive.org`, `5archive.org` | `src/lib/search-providers.ts:22, 25` | Archive search | Yes |
| `api.country.is`, `api.ipify.org`, `free.freeipapi.com` | `src/lib/peer-geo.ts:35-37` | Peer location in the P2P stats UI | Yes, when that UI is open |
| `img-api.bitsocialforge.com` | `src/lib/forge-images-config.ts:22` (`VITE_FORGE_IMAGES_API_ORIGIN`) | Forge upload API | Yes |
| `forgeimg.net` | `src/lib/forge-images-config.ts:23` (`VITE_FORGE_IMAGES_MEDIA_ORIGIN`) | Forge media origin | Yes |
| `challenges.cloudflare.com` | `electron/forge-turnstile.js:40`, `src/lib/utils/turnstile-utils.ts:1` | Turnstile script | Yes (in the main-owned window) |
| `catbox.moe`, `files.catbox.moe` | `src/lib/utils/catbox-utils.ts:1, 14`, `src/lib/media-hosting/providers.ts:32` | Upload and availability probe | Yes |
| `imgur.com`, `i.imgur.com`, `s.imgur.com` | `electron/media-upload-recipes.js:43`, `src/lib/media-hosting/providers.ts:40` | Upload page and probe | Yes |
| `imgbb.com`, `i.ibb.co`, `simgbb.com` | `electron/media-upload-recipes.js:55`, `src/lib/media-hosting/providers.ts` | Upload page and probe | Yes |
| `img.youtube.com`, `cdn-cf-east.streamable.com`, `vimeo.com/api/oembed.json` | `src/lib/utils/media-utils.ts:85, 235, 715` | Thumbnails for linked videos | Yes |
| Embed hosts (YouTube, Twitter, Reddit, TikTok, Instagram, Twitch, Vimeo, Spotify, SoundCloud, Streamable, Odysee, BitChute, Stack Overflow) | `src/components/embed/embed.tsx` | Iframes opened on click | Yes |
| `localhost:50019` (`/api/v0`, `/webui/`) | `src/lib/p2p-stats.ts:122`, `src/components/version/version.tsx:27-35` | Kubo API and web UI | Electron only |
| `pubsubprovider.xyz`, `plebpubsub.xyz`, `rannithepleb.com` | `src/lib/p2p-browser-config.ts:4-13` | Pubsub providers | Browser mode only |
| `ipfsgateway.xyz`, `gateway.plebpubsub.xyz`, `gateway.forumindex.com` | `src/lib/p2p-browser-config.ts:4-13` | IPFS gateways | Browser mode only |
| `peers.pleb.bot`, `routing.lol`, `peers.forumindex.com`, `peers.plebpubsub.xyz`, `routerofbitsocial.xyz`, `bsotracker.online` | `src/lib/p2p-browser-config.ts:35`, `electron/preload.mjs:5` | HTTP routers (the preload carries the first four) | Routers only through the node in Electron mode |
| `base-sepolia.drpc.org`, `sepolia.base.org`, `sepolia-preconf.base.org`, `eth.drpc.org`, `mainnet.gateway.tenderly.co`, `1rpc.io/eth`, `eth-mainnet.public.blastapi.io`, `testnet-5chan-pass.netlify.app` | `src/lib/pubsub-voter.ts:5-12, 33` | Directory voting chain RPCs | Browser mode only |
| `ethrpc.xyz` | `src/lib/utils/account-import-utils.ts:88, 102` | Default chain provider on an imported account | Yes (the account stores it) |
| Vercel analytics | `src/lib/analytics/shared.ts:5` | Page analytics | No: off in Electron and off any host but 5chan.app |
| `/version.json` of the page's own origin | `src/lib/app-update.ts` | Web update check | Web only |
| A board's spam-blocker server | read from board data, not hard-coded | Challenge precheck | Yes |

The Electron main process adds its own outbound set (j): the six Ethereum RPC URLs, the four HTTP
routers and Kubo's default bootstrap peers. There is no Google Fonts and no external CSS.

### The Forge and catbox upload flows

- **Forge** (`src/lib/utils/forge-utils.ts:197-260`). `getToken` returns
  `window.electronApi.getForgeTurnstileToken(sitekey)` in Electron, else the in-page widget. Then
  `postFormData` (`src/lib/utils/upload-request-utils.ts`, XHR) POSTs multipart `FormData` with the fields
  `turnstile` then `file` to `${FORGE_IMAGES_API_ORIGIN}/api/upload`. The response is
  `{url, status: 'pending' | 'live', mime}`, and `url` must start with
  `${FORGE_IMAGES_MEDIA_ORIGIN}/`. A pending image is polled by `<img>` load or HEAD for up to 60 s;
  a video or SWF for up to 120 s, then `awaitingReview`. A 403 means blocked.
- **catbox** (`src/lib/utils/catbox-utils.ts:1, 14`). A renderer `fetch` POST to
  `https://catbox.moe/user/api.php` with `reqtype=fileupload` and `fileToUpload`; the response text
  is the URL. It needs the CORS rewrite of the main process, which only Electron has.
- **imgur and imgbb**: `electronApi.automateUploadMedia`, with a path from `getPathForFile`, or
  `automateUploadGeneratedMedia` for page-made bytes. The provider list is
  `src/lib/media-hosting/providers.ts:15-50`.

## g. Routing, inline scripts, service worker, manifest

| Fact | Evidence |
|---|---|
| `HashRouter` | `src/index.tsx:6` |
| One executable inline script in `index.html`: when the protocol is not `file:`, the path is neither `/` nor ends in `/index.html` and there is no hash, it runs `window.location.replace('/#' + pathname + search)`. That is an absolute-root redirect, a trap under a path-prefixed host | `index.html:60-70` |
| A JSON-LD block (not executed) and the module entry `/src/bootstrap.ts` | `index.html` |
| Icon hrefs in the source are absolute (`/favicon.ico?variant=nsfw`); `PUBLIC_URL=./` rewrites the build's own assets | `index.html`, `vite.config.js:27, 560` (`base: publicBase`) |
| Plugins that add inline scripts to the built HTML: `statsProviderPrefetchPlugin` (fetches `https://stats.bitsocial.net/...` at load), `translationPrefetchPlugin`, `dynamicEntryPreloadPlugin`, `staticShellPlugin` | `vite.config.js` |
| `verifyVercelCspHashesPlugin` fails the build when `vercel.json`'s CSP lacks a hash for an inline script; it lists 11 sha256 hashes (the index scripts and three Ruffle frame scripts) | `vite.config.js:348-367`, `vercel.json` |
| CSP is only in `vercel.json` (`connect-src 'self' https: http: wss: ws: blob:`, `frame-src https: http://localhost:* ...`); the `file://` desktop page has none | `vercel.json` |
| Service worker: VitePWA `injectManifest` from `src/sw.ts`, `registerType: 'autoUpdate'`, `injectRegister: 'script-defer'` (a generated `registerSW.js`) | `vite.config.js:392-400, 65` |
| Manifest: `public/manifest.json`, plus the VitePWA one | `vite.config.js:392-495` |
| Translations load from a relative path `./translations/{{lng}}/{{ns}}.json` | `src/lib/constants.ts:17` |

## h. Build

| Fact | Evidence |
|---|---|
| Node 22.22.3 | `.nvmrc` |
| Package manager: `yarn@4.17.1+sha512` (the pin carries a hash, so corepack resolves exactly it) | `package.json` (`packageManager`) |
| Install runs scripts (`enableScripts: true`, `nodeLinker: node-modules`): electron, sharp and better-sqlite3 download or build. `ELECTRON_SKIP_BINARY_DOWNLOAD` skips the Electron binary | `.yarnrc.yml` |
| `build` = `corepack yarn refresh:generated && cross-env PUBLIC_URL=./ GENERATE_SOURCEMAP=false vite build` | `package.json` |
| `refresh:generated` = `sync:directories` then `generate:assets` | `package.json` |
| Upstream's release workflow runs `CI='' NODE_ENV=production yarn build` | `.github/workflows/release.yml:50, 93, 167` |
| `sync:directories` fetches the directory lists from GitHub, best effort, 5 s timeout, and keeps the committed copy on failure. `DIRECTORIES_SOURCE_PATH` names a local directory instead | `scripts/sync-directories.js` |
| `vite.config.js` runs `git rev-parse HEAD`, `git rev-list -n 1 v<ver>` and `git ls-remote --tags origin`. When the build commit differs from the release commit it bakes in `VITE_COMMIT_REF` and the UI shows a "#sha unreleased commit" link. Setting `VITE_COMMIT_REF` and `VITE_LATEST_RELEASE_COMMIT_REF` to the pin makes it deterministic | `vite.config.js:81-143` |
| The renderer target is `esnext` unless `ELECTRON` is set (`electron-renderer`) | `vite.config.js:537` |
| The preload is a separate build, `vite build --config electron/vite.preload.config.js`, into `build/electron/preload.cjs` | `package.json` (`build:preload`) |

Environment, with the value when unset (`import.meta.env`, read in `src/`):

| Variable | Default when unset |
|---|---|
| `VITE_FORGE_IMAGES_API_ORIGIN` | `https://img-api.bitsocialforge.com` |
| `VITE_FORGE_IMAGES_MEDIA_ORIGIN` | `https://forgeimg.net` |
| `VITE_FORGE_IMAGES_TURNSTILE_SITEKEY` | `0x4AAAAAAFScwbbNFZtx0XVP` |
| `VITE_APP_UPDATE_RELEASE_API_URL` | `https://api.github.com/repos/bitsocialnet/5chan/releases/latest` |
| `VITE_APP_UPDATE_ALLOWED_DOWNLOAD_HOSTS` | the GitHub release host list |
| `VITE_APP_DISTRIBUTION` | unset; `fdroid` disables updates and analytics |
| `VITE_APP_VERSION`, `VITE_COMMIT_REF` | derived from `package.json` and `git` (see above) |
| `VITE_E2E_START_HASH` | unset; a test hook |

Network beyond the install: `sync:directories` (best effort), `git ls-remote origin` (in
`vite.config.js`), and, for a packaged app only, the Kubo download from GitHub releases
(`electron/before-pack.js:13-15`, Kubo 0.43.0). A port wraps the underlying commands directly
rather than `yarn build`, so no git remote and no corepack are needed.

## i. The pkc client side

| Fact | Evidence |
|---|---|
| `@pkcprotocol/pkc-js` 0.0.132, `@bitsocial/bitsocial-react-hooks` 0.2.2 | `package.json` |
| In Electron the renderer connects to `ws://localhost:9138` through `pkcRpcClientsOptions` | `preload.mjs:3-6` |
| The URL goes to `new WebSocketClient(url)` unchanged, so `ws://localhost:9138/<authKey>` is accepted | `pkc-js` `dist/node/rpc/src` client |
| The server accepts a keyless connection only from loopback with no `X-Forwarded-For`; otherwise the URL path must be `/<authKey>` | `pkc-js dist/node/rpc/src/index.js:116-135` |
| The hooks package fills an account's defaults: six `DEFAULT_HTTP_ROUTER_URLS`, `chainProviders` for `eth` (the public RPC list plus `"ethers.js"`, chain id 1) and `matic` (`https://polygon-rpc.com`) | `account-generator.js:27-44` |
| It overrides `{resolveAuthorNames: false, resolveAuthorAddresses: false, validatePages: false}` | `account-generator.js` (`overwritePkcOptions`) |
| `defaultMediaIpfsGatewayUrl` defaults to `https://ipfs.io` | `account-generator.js:98` |
| Name resolvers run server-side under RPC; the RPC client has none | `electron/pkc-rpc-options.js` |

## j. The main process's node

`electron/start-ipfs.js` (Kubo) and `electron/start-pkc-rpc.js` (pkc RPC), started from
`electron/main.js:11-12`.

**Kubo** (0.43.0, downloaded by `electron/before-pack.js:13-15`):

| Step | Command |
|---|---|
| Init | `ipfs init`, then `ipfs repo migrate` |
| Gateway | `ipfs config --json Addresses.Gateway "/ip4/127.0.0.1/tcp/6473"` (`:125`) |
| API | `ipfs config Addresses.API /ip4/127.0.0.1/tcp/50019` (`:131-136`); in dev, Kubo uses 50029 behind a CORS proxy on 50019 |
| Daemon | `ipfs daemon --migrate --enable-pubsub-experiment --enable-namesys-pubsub` (`:140`) |

Everything else is Kubo's defaults, including its bootstrap peers. `IPFS_PATH` is
`<pkcDataPath>/ipfs`; a restart check runs every second. Kubo refuses a request carrying a
non-allowed `Origin`, which is why main strips `Origin` from the renderer's requests.

**pkc RPC** (`electron/start-pkc-rpc.js`, `electron/pkc-rpc-options.js:3-35`):

- Port 9138 (`:15`). The auth key is read or generated at `<dataPath>/auth-key`, 40 characters
  (`:21-30`).
- `PKCRpc.PKCWsServer({port, pkcOptions, authKey})`. It logs `ws://localhost:9138` (local use) and
  `ws://localhost:9138/<authKey>` (remote use). It listens on all interfaces. It retries every
  second.
- `createDefaultPkcOptions`:
  `{dataPath, kuboRpcClientsOptions: [{url: 'http://localhost:50019/api/v0'}],
  httpRoutersOptions: ['https://routing.lol', 'https://peers.pleb.bot', 'https://peers.plebpubsub.xyz',
  'https://peers.forumindex.com'], nameResolvers: <six BsoResolver>}`.
- The six resolvers are `BsoResolver` keyed `eth-<hostname>` over
  `ethereum-rpc.publicnode.com`, `eth.drpc.org`, `ethereum.publicnode.com`, `rpc.mevblocker.io`,
  `1rpc.io/eth` and `eth-pokt.nodies.app`. `.bso` names resolve through a `bitsocial` TXT record.
- No `chainProviders` and no challenge is registered by main. pkc-js 0.0.132's built-in challenges
  are `text-math`, `fail`, `blacklist`, `whitelist`, `question` and `publication-match`.
- The data directory is `EnvPaths('pkc', {suffix: false}).data` (`electron/pkc-paths.js`); in dev it
  is `<root>/.pkc`.

## k. Verdict and capability ratio

**A port with a bridge, behind one gate: a node.** Everything the page asks of the shell is in the
table in section a.

| Class | Members | Count |
|---|---|---|
| Static, set by the bridge | `isElectron`, `electronApi.isElectron`, `defaultPkcOptions`, `defaultMediaIpfsGatewayUrl`, `getPlatform` | 5 |
| Dead in the renderer | `pkcRpcAuthKey` | 1 |
| A page API covers it | `copyToClipboard` | 1 |
| Inert or refused | `getNodeReachability` (a bridge answers `'unknown'`, or the node answers), `downloadAndInstallUpdate` (nothing newer), `getPathForFile` (`null` unless uploads exist) | 3 |
| Needs an `orivon.*` capability, or has none | `getForgeTurnstileToken`, `automateUploadMedia`, `automateUploadGeneratedMedia` | 3 |

Ratio: **3 of 13 members need a capability with no equivalent today**, 4 of 13 counting the
optional clipboard. Both providers behind the two `automate*` members have no HTTP path to fall
back to, so those two decide whether imgur and imgbb exist in an Orivon port; Forge needs
`getForgeTurnstileToken` or a page on a `localhost` hostname. The page still works without all
three: the upload controls shrink to the providers that run.

What the page needs from a node, none of it a member: `ws://localhost:9138` accepting a keyless
loopback connection (or a path with the key), `http://localhost:6473` as an IPFS gateway for
media, `http://localhost:50019/api/v0` for the stats and reachability, and the loopback link in
section c. A page started without `isElectron` runs the in-page libp2p mode instead and needs
none of them; there the Forge provider is the only uploader, and directory voting works (it needs
the in-page Helia node).

## What contradicts "the desktop renderer is plain `yarn build` plus the preload"

1. **The renderer is not the whole contract.** `electron/main.js` rewrites every non-iframe XHR and
   fetch of the main window (UA, no `Origin`, no `Sec-*`, `Access-Control-Allow-Origin: *`).
   catbox upload, the GIF first-frame XHR, size and thumbnail probes, the Kubo API calls and the
   GitHub and archive APIs depend on it.
2. **`yarn build` is not offline or hermetic.** It runs `corepack yarn refresh:generated` (network,
   best effort) and `vite.config.js` shells out to git, including `git ls-remote origin`.
3. **The node is not in the preload.** It is spawned by `main.js` (Kubo, then `PKCWsServer`).
4. **`file://` cannot get a Turnstile token.** The main-owned `http://localhost` window is not
   optional for Forge.
5. **The built `index.html` carries an absolute-root redirect and registers a service worker.**
   Both only matter off `file:`, which is the case under Orivon.
6. **Two members are inert in practice:** `pkcRpcAuthKey` is never read, and `getPlatform` is read
   only by the updater.

## For orivon-mvp (the blockers, to hand over as a prompt, not to patch here)

- A native node capability: Kubo 0.43.0 and a `PKCWsServer`, or an equivalent that serves the pkc
  RPC protocol on loopback 9138 and a gateway on 6473.
- A fetch from a `file:`-like page with no `Origin` and with CORS open, for arbitrary hosts and for
  loopback (the three behaviours main gives the window).
- A hidden-window DOM automation capability (CDP `DOM.setFileInputFiles`), or a decision that
  imgur and imgbb are not offered.
- A way to serve a page whose hostname is `localhost` for Turnstile, or a Turnstile capability.
- Allowing the loopback link `http://localhost:50019/webui/` to reach the system browser.
