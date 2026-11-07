# Restfox

## About this build

**A community build by Orivon of Restfox, not the official Restfox.** Restfox is an HTTP and socket testing client. This directory holds the recipe that builds its desktop renderer to run in Orivon; the upstream project did not make this build.

| | |
|---|---|
| Official project | [github.com/flawiddsouza/Restfox](https://github.com/flawiddsouza/Restfox) |
| Official downloads | <https://github.com/flawiddsouza/Restfox/releases> |
| Pinned upstream | 0.42.0 (v0.42.0), commit `e776d9e36857` |
| This build's version | see [`orivon.json`](orivon.json) (upstream 0.42.0, build number last) |
| Licence | MIT, upstream's own; the licence text is served at `/LICENSE`, see [`UPSTREAM.md`](UPSTREAM.md) |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| In another browser | This page shows a landing instead of the app, because the app's main job, sending a request with any header to any server, is something a browser page cannot do. |
| Updates | When upstream releases a new version, the pin is moved and the build is redone ([maintaining a port](../../.claude/skills/orivon-porting/maintain.md)); there is no schedule. The app's own update checker is left as upstream wrote it. |
| Problems | [Report a problem with this build](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=Restfox): it goes to this repository's issue form, not to the upstream project's tracker. |

Known gaps in this build:

- **File workspaces are not available.** A workspace kept in a folder on disk needs a host path, which Orivon never hands to a page. Restfox's New Workspace form offers that type first: choose "In Application" instead. Pressing Choose, or Open File Workspace, shows a message saying so. Every other workspace, kept in the browser's storage, works, and so do its backup and restore.
- **Plain `http://` works only for `localhost` on ten ports:** 3000, 3001, 4000, 5000, 5173, 8000, 8080, 8081, 8888 and 9000. Any other `http://` address, a public one included, fails with a message saying so. `https://` works for every public address.
- **Nothing on a private network or on another local port is reachable**, whatever the address: Orivon's permission names the ports above and public hosts, and no more.
- **Certificates are always checked** against the roots the browser trusts. Disable SSL Verification and CA Certificates in Settings change nothing here, and a CA file is refused when it is added. A server with a self-signed certificate cannot be reached.
- **Settings > Proxy set to Custom sends nothing**, with a message saying so. System and Off are the same here: a request goes out the way Orivon sends every connection of an app.
- **A response's `Set-Cookie` header is not listed** in the Header tab: a page's response object cannot carry it. No cookie is kept between requests, as in the desktop app.
- **gRPC requests do not run.** Restfox sends them from its main process with an HTTP/2 client, which a page does not have. New gRPC Request opens, and loading its methods or sending a call says so in the panel; every other kind of request works. An imported Insomnia gRPC request keeps its message as Insomnia wrote it.
- **OpenAPI and OpenAPI URL import fail** with the message "Invalid import file given". Orivon gives an app's tab a Node-shaped `process`, and the converter inside Restfox (`insomnia-importers-browser`, a browser bundle) reads `process.versions.node` and takes a Node path that bundle does not contain. Restfox, Postman, Postman URL, Insomnia and cURL import work.
- **A PDF response shows no preview** in the Preview tab, because Orivon's page policy forbids the embedded viewer it uses; the download link works.
- **A reply compressed with brotli fails** when the server sends it although the request offered only gzip and deflate, which is what this build offers.
- **A WebSocket's `Origin` is the app's own address**, which Restfox cannot change.
- **Restfox's timeline** lists the headers the app set, not every line on the wire: Orivon adds `Host`, `Content-Length` and a few more itself.

The sections below are for people working on the build.

**What lives here.** A recipe, a manifest, and the bridge that stands in for the Electron main
process Restfox expects. **No Restfox source and no Restfox build output is in this repository**;
see [`UPSTREAM.md`](UPSTREAM.md) for the pin, the licence, and where the build actually lands.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Where upstream is, at which commit, and the build script upstream's own `package.json` names for its Electron renderer |
| [`hooks.mjs`](hooks.mjs) | Writes `SOURCE.txt` into the served tree |
| [`orivon.json`](orivon.json) | The manifest -- what the consent dialog shows a person |
| [`bridge/members.json`](bridge/members.json) | `window.electronIPC`'s 44 members: 33 refused by name, 5 inert, 6 `hand` |
| [`bridge/restfox.js`](bridge/restfox.js) | The 6 hand-written members: `sendRequest`, `cancelRequest`, `onRequestEvent`, `openFolderSelectionDialog`, `setCACertificates`, `setProxy` |
| [`bridge/restfox.test.ts`](bridge/restfox.test.ts) | The roster, every refusal, and the six hand-written members against a fake `fetch` |
| [`bridge/hooks.test.ts`](bridge/hooks.test.ts) | `SOURCE.txt` carries the recipe's repository and pinned commit |
| [`UPSTREAM.md`](UPSTREAM.md) | The pin, the licence, what never crosses into this repository, what to re-check when the pin moves |
| [`../../docs/restfox-recon.md`](../../docs/restfox-recon.md) | The reconnaissance this port was built from |

## Running it

```bash
orivon-port run restfox
```

Clones `flawiddsouza/Restfox` at the commit `recipe.json` pins, fetches the pin's tag (the build
reads it for the version Settings shows), runs `npm ci` and upstream's own
`npm run build-desktop-electron` in `packages/ui`, prepares `out/restfox/static`, and serves it on
`http://127.0.0.1:8896`. Open that URL in Orivon and accept the prompt. By name, once
`orivon-port names` has written `out/names.json` and Orivon was started with
`ORIVON_ETH_NAMES_FILE` pointing at it: `restfox.orivonstack.eth`.

## Why the Electron renderer, not the web build

Restfox ships the same Vue app in four builds, and `import.meta.env.MODE` picks what a request
does. In the browser build a request is a page `fetch`, which refuses the `Cookie` and `Origin`
headers and any server that sends no CORS headers. In the `desktop-electron` build a request is
`window.electronIPC.sendRequest`, sent by the Electron main process with no such limit. Orivon's
routed `fetch` has none either, so the bridge answers `sendRequest` with a `fetch` call, and the
app behaves as the desktop app does.

## What the app connects to

Restfox sends an anonymous page-view ping to its developer's analytics (umami.artelin.dev) unless you turn it off in its settings (Settings > Advanced > Disable Page View Analytics Tracking). It also asks `api.github.com` for its star count when it starts, which has no setting. Everything else it connects to is what the user types as a request URL.

## What it is granted, and why

[`orivon.json`](orivon.json) declares two things and nothing else:

- `net.https.connect: ["*:*"]`: any public site over https, on any port. The user types the URL
  of the API they test, so no list of hosts can be written down.
- `net.tcp.connect`: `localhost` on 3000, 3001, 4000, 5000, 5173, 8000, 8080, 8081, 8888 and
  9000, where the development servers of Node, Rails, Flask, Vite, Django and FastAPI listen by
  default. A routed request to plain `http://` is checked against this list. `localhost` here
  covers `127.0.0.1` too. Orivon's own loopback ports stay closed to an app whatever is declared.
  A port outside the list is refused, which is the price of not asking for "every service on this
  computer".

No file, no storage quota, no listener, no `crossOriginIsolated`: workspaces, requests and
responses are IndexedDB, which every app tab has.

## Request headers

Whatever the user types in the Header tab goes out as written, the ones a browser page may not
set included: `Cookie`, `Origin`, `Host`, `Referer`, `User-Agent`, `Accept-Encoding`, `Date`,
`DNT` and `Via` were each sent and read back at a server, along with `Authorization` and custom
headers. Orivon adds `Connection: close` and, when the user set none, `Accept: */*` and an
`Accept-Encoding` of gzip and deflate; it sends no `Origin` or `Referer` of its own. Redirects are
followed (a two-hop redirect from a public site ended on its target with a 200).

## Members

44 names: the 41 in the preload's `ipcFunctions` list and the three callbacks it registers
(`workspaceChanged`, `onRequestEvent`, `onGrpcEvent`).

| Bucket | Members |
|---|---|
| `hand` | `sendRequest`, `cancelRequest`, `onRequestEvent`, `openFolderSelectionDialog`, `setCACertificates`, `setProxy` |
| `noop` | `updateElectronApp`, `setDisableSSLVerification` |
| `listeners` | `workspaceChanged`, `onGrpcEvent` |
| `asyncConstants` | `getInstallInfo` |
| `refused`, `not-built` | the 24 file-workspace database members, `openFolder`, `readFile`, and the 7 gRPC members (`grpcLoadSchema`, `grpcCancelSchemaLoad`, `grpcConvertInsomniaMessage`, `grpcStartCall`, `grpcSendMessage`, `grpcEndCall`, `grpcCancelCall`), each refused as a rejected promise |

`sendRequest` is the one member that needs a capability. Restfox reads a response only from the
messages `onRequestEvent` delivers, and the reply of `sendRequest` carries nothing. The bridge calls
the page's `fetch` with the URL, the method, the headers exactly as the user typed them and the body
(none for GET and HEAD), then pushes `head`, a `data` message for each piece of the body as it
arrives, and `end`; a failure before the head is a `responseError`, one after it a `bodyError`, and
a cancel after the head pushes nothing more. A `File` body and a `FormData` body arrive as plain
data over IPC in the desktop app, so the bridge rebuilds them as the objects `fetch` takes.

## What the served tree carries

`/LICENSE` is Restfox's MIT text (`extraFiles`) and `/SOURCE.txt` names the source repository and
the commit this build is made from (`hooks.mjs` writes it from the recipe).

## What fails closed

Three settings changed what Electron's main process did with every request, and a page cannot
honour them. Ignoring them silently would send requests the user meant to protect, so:

- **Custom proxy**: every request is refused with the reason, until the mode is not Custom.
- **CA certificates**: the file is refused when it is added, so Settings never keeps one.
- **Disable SSL Verification**: changes nothing; a request that fails on a certificate says so.

A failure Restfox would show as its generic "Request failed" list stays that, with the cause in
Logs. The three messages above, and the one for a refused plain-`http://` address, are raised with
Restfox's own `display-error` marker, which makes the response panel print them.

## What it needs from orivon-mvp

Catalogue rows (`../orivon-mvp/test/app-behaviours/catalogue.md`) this port counts on:

- `routed-fetch-reaches-granted-hosts`: a page `fetch` to a granted host keeps the headers the
  app sets, `Cookie` and `Origin` among them, with no CORS check.
- `routed-fetch-sends-formdata`: a routed `fetch` accepts a `FormData` body (marked not covered).
- `routed-fetch-follows-redirects`: a routed `fetch` follows redirects to a granted host (marked
  not covered).
- `routed-fetch-refuses-untrusted-certificate`: why Disable SSL Verification cannot be honoured.
- `routed-fetch-delivers-body-in-pieces`: a response body reaches the page piece by piece as the
  server sends it, which is how a server-sent-events or JSON-lines response shows live and how Stop
  keeps what arrived.
- `process-is-node-shaped`: the cause of the OpenAPI import gap above, not something the port
  asks for.
- `wildcard-host-never-reaches-loopback`: why the localhost ports are named.
- `tcp-connect-never-reaches-orivon-own-loopback-ports`: why naming a port is safe.

Not in the catalogue: a routed `fetch` to plain `http://localhost:<granted port>` is answered and
a neighbouring port is refused. This port relies on it for its development-server use.

## Design notes

- **The bridge answers with `fetch`, not with a socket.** Restfox's request panel needs the
  headers the user typed to go out as typed, which routed `fetch` does and a browser's `fetch`
  does not. No `orivon.net` call is made in the bridge itself.
- **`requestHeadersSent` lists the headers the app handed to `fetch`.** Without it Restfox would
  hide `Cookie` and `Origin` from the timeline as a browser would; with it the timeline shows what
  the user set. `Host`, `Content-Length`, `User-Agent`, `Accept` and `Accept-Encoding` are added
  by Orivon and are not in the list.
- **Restfox's own requests to other hosts are left as upstream wrote them**: the page-view ping
  (setting `Restfox-DisablePageViewAnalyticsTracking`, switched in Restfox's Settings) and the
  star count request to `api.github.com` at start, which has no setting.
- **The build runs unwrapped.** `npm run build-desktop-electron` writes into `packages/ui/dist`
  and copies it into `packages/electron/ui` inside the clone, which is not tracked. The install
  step fetches the pin's tag because `vite-plugin-revision` calls `git describe --tags`, and a
  clone of a pinned commit has none.
