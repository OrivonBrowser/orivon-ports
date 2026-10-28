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
  and exported as a CAR file. A box on the Send page, off unless the person ticks it, also keeps a copy on
  Orivon's server for 30 days (below).
- **Receive.** The link opens the share: public files with Preview and Download, "Download all"
  as a zip, a public website through `ipfs://<address>/` in Orivon (a gateway elsewhere); a
  protected share asks for its password, decrypts in the page, and a protected website opens
  inside the page in Orivon.
- **My shares.** What was sent from this browser: put it offline or online, keep it with a
  service, save a CAR file, stop and delete it from this computer.

Orivon stores nothing for a share unless the person asks for a copy on Orivon's server, which is optional,
off by default and ends after 30 days ([`copy/`](copy/README.md)). There is no account. Its circuit relay
([`relay/`](relay/README.md)) passes encrypted traffic and keeps none of it.

| | |
|---|---|
| Built on | [typage](https://github.com/FiloSottile/typage) 0.3.1, commit `38b8b10cb224` (BSD-3-Clause), for age encryption; Orivon Share is not made or endorsed by the age or typage projects |
| Version | 0.1.7 |
| Licence | This repository's; typage is BSD-3-Clause, see [`UPSTREAM.md`](UPSTREAM.md) |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| Name | `share.orivonstack.eth` |
| In another browser | It works there, through a gateway such as `eth.limo`; it adds a small notice that can be closed. Protected websites are downloaded as a zip there: the viewer needs Orivon. |
| Problems | [Report a problem](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=Orivon%20Share) |

Known gaps:

- **A share is online only while Share is open on the sender's computer**, unless it is also kept with a
  service or, when the person ticked the box, on Orivon's server (next item). Page to page (WebRTC),
  two computers whose routers both refuse direct connections cannot reach each other, and no relay
  carries those connections. In Orivon, the page's IPFS node reaches around that for shares of
  200 MiB or less in all (below). A larger share, or one made in another browser, is kept with a
  pinning service or sent as a CAR file.
- **A copy on Orivon's server is optional, public when the share has no password, and ends after 30 days.**
  When the person ticks "Keep a copy on Orivon's server for 30 days", the page sends the share's CAR to the
  [copy service](copy/README.md) after it has made the share. The service checks every block against its
  address, pins the share on Orivon's own IPFS node and on Orivon's Filebase account for 30 days, and answers
  with the address it kept; the page accepts that only when it is the address computed on this computer. The
  share's IPFS address and gateway link then open from anywhere, also with this computer off. **A share
  without a password is a public file on Orivon's server**: anyone with the address reads it from the node,
  Filebase and the gateways. A protected share is the locked file there, so the password protects it; the
  server never receives the files or the password. The result page says until when the copy is kept, or why it
  was refused, with a button to try again; the page's console carries one `[share-copy]` line per attempt, which a
  bug report includes. The limits are *provisional*: a copy is a CAR of 200 MiB or less, the service keeps
  1 GiB of copies at once and takes 512 MiB a day from one address, because the Filebase account is shared with
  Orivon's own pins and its plan size is unknown. A month of real use and the plan size would settle them. A
  larger share, or one made in another browser, is kept with a service of the person's own or sent as a CAR file.
- **Introductions come from public WebTorrent trackers**, a list of four in
  [`serve/tracker.js`](page/src/serve/tracker.js). They see a hash of the share's address and IP
  addresses, never an address or a byte. They are third parties' servers: *provisional*; a
  tracker run for Share would settle it. A computer reachable from the internet, or one that
  holds a place on Orivon's relay, is also found through the IPFS network's own routing (below).
- **Orivon's own IPFS node announces a share when this computer is reachable from the internet,
  or when the node holds a place on Orivon's relay.** The node asks other IPFS peers whether its
  port answers; behind a router that refuses incoming connections it asks Orivon's relay
  ([`relay/`](relay/README.md)) for a place and announces the address through it. Every byte of a
  fetch through the relay passes it, so the relay's bandwidth bounds the speed. When the relay
  cannot be reached, nothing is announced and a share travels page to page only.
- **The node announces at most 1024 addresses in all, across every share it holds.** For each
  share it announces the root first, then the share's folders and the first block of each file,
  breadth first, while its table has room. A new share's root always gets a place: when the table
  is full, the root pushes out files and folders that other shares listed (never a root), from the
  share that lists the most first and its deepest levels first, and that share is announced only as
  far as what is left. A share added to a full table is announced as its root alone. Room that a
  deleted share frees goes back to the shares that were cut, the one with the fewest entries first.
  A visitor who already fetches a share finds the rest through that connection. One who opens a
  later file by its own address, after the first connection has closed, finds it only while that
  file is in the table; for a share that was cut, the share's address and its folder listing still
  find the node, and the file opens through them. Only 1024 shares, each named by its root, fill
  the table with roots; the next one then travels page to page only. The page's `[share-node]` line
  says how many files and folders the node holds under the roots, how full its table is and how
  many shares it cut short when it took them.
- **A brand-new share opens by its address within seconds.** The node announces the root of a small
  share in about half a minute and the rest of it within about a minute. A visitor on Orivon opens the
  folder listing a few seconds after that and each file in a few seconds, also after the connection
  has idled; a plain IPFS client with the default routing lists the share and fetches its files in
  about as long.
- **The node announces a new share's root at once, even behind a big share.** It announces about one
  address every two to five seconds, four at a time. A root that no announcement has reached has the
  next free place, ahead of every folder and file waiting; the folders and first file blocks of all
  the shares then take turns, the share served longest ago first, and while first announcements wait
  one place in five goes to a renewal. A share of a thousand entries is announced over more than an
  hour. A share made while that backlog waits had its root announced 13 to 88 seconds after it was
  made (Linux, Windows and macOS), and 25 to 40 seconds when it was made 38 minutes into the
  backlog; a visitor on Orivon then opened its listing in 3 to 7 seconds and a file in 1 to 2.
- **A node that stops answering is started again by the page**, on the next free port, and the
  shares are announced again. On macOS a node that was announcing a thousand entries for 40
  minutes has stopped this way, reporting that it had no file descriptors left; on Linux and Windows
  the same backlog was announced for 40 minutes without a stop, and a node with fewer entries has
  not stopped on any of the three.
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
| [`page/src/publish/`](page/src/publish/), [`page/src/node/`](page/src/node/) | Keeping a share with a service or on Orivon's server ([`orivon-copy.js`](page/src/publish/orivon-copy.js)), and Orivon's IPFS node in the page |
| [`relay/`](relay/README.md) | The circuit relay that runs on Orivon's server: a Node service on js-libp2p, its systemd unit, its install script and its tests. Never served |
| [`copy/`](copy/README.md) | The copy service that runs on Orivon's server: a Node service that checks a share's CAR and pins it on Orivon's node and Filebase for 30 days, its systemd units, its install script and its tests. Never served |
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
website in place. It calls no `orivon.*` member beyond what those grants allow. The manifest declares
`net.concurrentSockets: 384`: the node opens at most 128 connections and accepts at most 64 (32 more are being set
up), all counted against the page's origin with its listeners, its calls to the node's API and its tracker sockets,
and Orivon's ceiling is 512. The node looks up the IPFS network's entry points with DNS over TCP to 1.1.1.1 and 1.0.0.1, which the manifest names
on port 53 because Orivon's wildcard grant never covers that port.

| Behaviour | orivon-mvp catalogue row |
|---|---|
| The page spawns Orivon's IPFS node, a WASI 0.2 component, which dials and listens | `wasi-component-dials-and-serves` |
| The page's `fetch` to its node's loopback port, and to IPFS Desktop's | `routed-fetch-loopback-grant-covers-both-spellings` |
| The page's `fetch` to gateways and services, through its `https.connect` grant | `routed-fetch-reaches-granted-hosts` |
| The page's `fetch` sends the share's CAR, a Blob, to Orivon's copy service | `routed-fetch-reaches-granted-hosts`, `routed-fetch-sends-formdata` |
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
relay carries these connections.

**Why the CAR goes to Orivon, and why the page asks first.** The page makes the CAR from the bytes it
keeps, so the copy is exactly the share whose address it computed, and a protected share's copy is the
locked file. Before it sends a byte it asks the service whether the share is already kept, or would be
refused (too large, a budget full, taken down), because a refusal sent while 200 MiB are still on the wire
may reach the page as a dropped connection. The copy service is its own service, apart from DecentraWiki's
free pinning ([`copy/README.md`](copy/README.md) says why), so Share has its own budgets.

**Why the node holds a place on Orivon's relay.** A share made behind a home router is announced by
the page's IPFS node with an address that goes through [Orivon's relay](relay/README.md), so that
`ipfs://<address>` and gateways reach it without the sender opening a port. The node asks for the
place when it starts (`--relay` in [`launch.js`](page/src/node/launch.js)), keeps it while it runs,
and `/status` lists it as `relays`. The relay sends no byte or time limit, because Kubo and
gateways refuse to fetch blocks over a connection that has one, and it cannot read what it passes:
the two ends run Noise between them and every block is checked against its address. The page logs
the node's reachability, the places held, how full the node's table of announced addresses is and when it
refuses a share, as `[share-node]` lines, which a bug report carries.

**Why no library for the trackers.** The WebTorrent tracker protocol is a few messages over a
WebSocket, and a second pinned upstream for that, beside typage, would cost more than it saves.
