# Orivon Share

## About this app

**Orivon Share shares files, folders and websites straight from your computer, on IPFS, with a
password if you want one.** It is written in this repository; its one upstream is
[typage](https://github.com/FiloSottile/typage), the [age](https://age-encryption.org) encryption
library. A person drops or picks what to share, optionally locks it with a password, and gets a
link. Whoever opens the link reads it from the sender's computer, directly, while Orivon Share is
open there; every block they receive is checked against its IPFS address.

- **Send.** The page computes the share's IPFS address itself, exactly as Kubo's
  `ipfs add -r --cid-version=1` does, keeps the share in this browser's storage and serves it
  from there. A share can also be kept with a service of the person's own (IPFS Desktop or Kubo,
  Filebase, Pinata, any Kubo-compatible service), so that it stays online while Share is closed,
  and exported as a CAR file.
- **Receive.** The link opens the share: public files with Preview and Download, "Download all"
  as a zip, a public website through `ipfs://<address>/` in Orivon (a gateway elsewhere); a
  protected share asks for its password, decrypts in the page, and a protected website opens
  inside the page in Orivon.
- **My shares.** What was sent from this browser: put it offline or online, keep it with a
  service, save a CAR file, stop and delete it from this computer.

Orivon stores nothing for it: no pinning, no account. Its circuit relay ([`relay/`](relay/README.md)) passes
encrypted traffic and keeps none of it.

| | |
|---|---|
| Built on | [typage](https://github.com/FiloSottile/typage) 0.3.1, commit `38b8b10cb224` (BSD-3-Clause), for age encryption; Orivon Share is not made or endorsed by the age or typage projects |
| Version | 0.1.0 |
| Licence | This repository's; typage is BSD-3-Clause, see [`UPSTREAM.md`](UPSTREAM.md) |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| Name | `share.orivonstack.eth` |
| In another browser | It works there, through a gateway such as `eth.limo`; it adds a small notice that can be closed. Protected websites are downloaded as a zip there: the viewer needs Orivon. |
| Problems | [Report a problem](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=Orivon%20Share) |

Known gaps:

- **A share is online only while Share is open on the sender's computer.** Two computers whose
  routers both refuse direct connections cannot reach each other page to page: no relay carries
  those connections, so such a share is kept with a pinning service or sent as a CAR file.
- **Introductions come from public WebTorrent trackers**, a list of four in
  [`serve/tracker.js`](page/src/serve/tracker.js). They see a hash of the share's address and IP
  addresses, never an address or a byte. They are third parties' servers: *provisional*; a
  tracker run for Share would settle it. A computer reachable from the internet is also found
  through the IPFS network's own routing (below).
- **Orivon's own IPFS node announces a share only when this computer is reachable from the
  internet.** The node asks other IPFS peers whether its port answers; behind a router that
  refuses incoming connections it announces nothing, and a share travels page to page only.
- **Someone who receives a share does not pass it on**: only the sender serves, one hop.
- **A share holds at most 1 GiB**, and must fit what the browser lets the page store. Clearing
  this site's data in the browser deletes the shares kept on this computer.
- **A remembered password is kept as it is in the browser's storage**, and only when the person asks.
- **A public website's "Open website" link** needs the share to be on the IPFS network. In Orivon
  "Open it in Share" reads it from the sender's computer instead.

The sections below are for people working on the app.

## How it works

| Part | What it is |
|---|---|
| [`page/`](page/) | The page. [`src/main.js`](page/src/main.js) routes (`#/`, `#/shares`, `#/settings`, `#/about`, `#/<address>`), the views are in `src/views/`, what they share in `src/ui/` |
| [`page/src/store.js`](page/src/store.js) | IndexedDB: the settings (services and their keys), the list of shares sent from here with the password of those the person asked to remember, and the secret that gives each protected website an origin of its own |
| [`page/src/engine.js`](page/src/engine.js), [`runtime.js`](page/src/runtime.js) | The one module the views import from the engine: sharing, reading, keeping, serving, passwords, links; and the parts that live as long as the page (kept shares, tracker sockets, what is being served) |
| [`page/src/viewer/`](page/src/viewer/) | The protected website: `server.js` serves the unlocked files over HTTP from a loopback listener, `view.js` shows them in a `<webview>` |
| [`page/src/ipfs/`](page/src/ipfs/) | Addresses (byte for byte Kubo's `add -r --cid-version=1`), CAR files, and reads checked block by block |
| [`page/src/keep/`](page/src/keep/), [`page/src/serve/`](page/src/serve/) | Where a share is kept on this computer, and how it is served to other pages: tracker introductions, WebRTC, the wire protocol |
| [`page/src/crypto/`](page/src/crypto/), [`page/src/lib/`](page/src/lib/) | age in a Worker; the ZIP inside a protected share, passwords, links, what a selection may be |
| [`page/src/publish/`](page/src/publish/), [`page/src/node/`](page/src/node/) | Keeping a share with a service, and Orivon's IPFS node in the page |
| [`relay/`](relay/README.md) | The circuit relay that runs on Orivon's server: a Node service on js-libp2p, its systemd unit, its install script and its tests. Never served |
| [`build/build.mjs`](build/build.mjs) | Copies `page/`, bundles the Worker with typage and the node launcher with Orivon's Node shim, fetches the IPFS node by its CID |
| [`test/`](test/) | Unit tests. Never served |

## Running it

```bash
orivon-port run share     # clones typage, builds, serves the page on 127.0.0.1:8880
```

The build fetches Orivon's IPFS node by its CID from trustless gateways, every block checked
(`IPFS_NODE` in [`build/build.mjs`](build/build.mjs)); `SHARE_IPFS_NODE_DIR=<folder>` takes a
local copy instead, which must make that CID to be the published node. The build bundles the node
launcher with orivon-mvp's Node shim (`ORIVON_MVP_ROOT`, default `../orivon-mvp` beside this
repository).

## What it needs from orivon-mvp

In Orivon Share is an app: its manifest declares `net`, so that its page can reach introduction
servers and gateways and run an IPFS node, and `web.embed`, so that it can show a protected
website in place. It calls no `orivon.*` member beyond what those grants allow. The node looks up
the IPFS network's entry points with DNS over TCP to 1.1.1.1 and 1.0.0.1, which the manifest names
on port 53 because Orivon's wildcard grant never covers that port.

| Behaviour | orivon-mvp catalogue row |
|---|---|
| The page spawns Orivon's IPFS node, a WASI 0.2 component, which dials and listens | `wasi-component-dials-and-serves` |
| The page's `fetch` to its node's loopback port, and to IPFS Desktop's | `routed-fetch-loopback-grant-covers-both-spellings` |
| The page's `fetch` to gateways and services, through its `https.connect` grant | `routed-fetch-reaches-granted-hosts` |
| Long CAR bodies from a gateway arrive whole | `routed-fetch-delivers-whole-body` |
| A wildcard grant never reaches loopback, so the page names its own node's ports | `wildcard-host-never-reaches-loopback` |
| The page's `WebSocket` to a tracker over `wss://` | `routed-websocket-wss-carries-origin-and-subprotocol` |
| The node listens on every interface in the granted range | `tcp-listen-any-interface-accepts-connections` |
| The viewer's listener accepts connections from the webview | `local-listener-accepts-connections` |
| The viewer takes the first free of four ports | `second-listener-gets-eaddrinuse` |
| A protected website shows in a `<webview>` under the local pattern | `webview-shows-local-pattern` |
| A window or a download the shown site asks for reaches the page, and nothing opens until it decides | `webview-popup-reaches-the-app` |
| "Open in a new tab" opens a tab with no opener | `window-open-noopener-opens-tab` |
| Download buttons save a Blob the page made | `blob-download-saves-without-dialog` |
| The list of shares and the settings survive a restart | `indexeddb-survives-restart` |
| The first visit asks before the page runs as the app | `consent-question-holds-the-page` |
| Two Share pages exchange blocks over a WebRTC data channel | `app-webrtc-data-channel-exchanges-bytes` |
| Kept shares in the origin's private file system survive a restart | `opfs-survives-restart` |

Without a row yet, relied on by this app and checked only by driving it: the page starts a
module `Worker` from a file it serves and passes it Blobs up to 1 GiB.

## Design notes

**Why age.** A protected share has to open without this page: the share must not depend on Share
existing. age is a small, reviewed format with a command-line tool in every package manager, so
a protected share is a directory holding `share.age` and a `HOW-TO-OPEN.txt` that says
`age -d -o share.zip share.age`. The password recipient uses scrypt (work factor 2^18, typage's
default), which takes a second or more, so all of it runs in a Worker.

**Why the ZIP is written here.** What age encrypts is a ZIP archive, so that a person who opens
it with age alone gets the files and their folders. Store-only ZIP is two small record layouts
and CRC-32; the writer and the reader live in [`lib/zip.js`](page/src/lib/zip.js), refuse what the
writer never makes (compression, ZIP64, names with `..`), and check every CRC. A second pinned
upstream for that would cost more than it saves.

**A public share is its content, a protected one is two files.** A public share is exactly what
was picked, nothing added, so its address is the address of the files and any IPFS tool opens it.
A protected one is `share.age` and `HOW-TO-OPEN.txt`, the same two names for every share.

**The link.** `https://share.orivonstack.eth.limo/#/<address>`, so that it opens in every
browser; Orivon turns `*.eth.limo` into the native `.eth` name. A password that travels in the
link is `?key=<base64url of the password>` after the address, in the fragment, which never
reaches a server; the page reads it once and removes it from the address bar.

**Why the viewer serves on loopback.** A protected website needs an origin of its own, or it
would share the page's storage and grants. The page serves the unlocked files over HTTP from a
listener on the first free of four ports, and shows them in a `<webview>` at
`http://<label>.localhost:<port>/`, the label being the first 32 characters of the base32 of an
HMAC of the address under a secret made once and kept in IndexedDB: the same share keeps its own
storage across openings, and no other program on the computer can guess the address. A request
whose `Host` is not a label being shown is refused. The shown site has no `orivon.*`, and a
window or a download it asks for is the page's to decide on.

**Why the page serves from this computer.** Home routers refuse incoming connections, and
WebRTC, which every browser has, gets through most of them with no setup. The page announces a
share in a swarm named by a hash of its address, trackers introduce other pages to it, and the
two connect directly. Only introductions and address discovery (STUN) touch a third party; no
relay carries these connections, since Orivon stores nothing for the app.

**Why no library for the trackers.** The WebTorrent tracker protocol is a few messages over a
WebSocket, and a second pinned upstream for that, beside typage, would cost more than it saves.
