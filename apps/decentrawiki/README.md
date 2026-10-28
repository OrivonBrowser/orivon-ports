# DecentraWiki

## About this app

**DecentraWiki is a wiki anyone can edit, published on IPFS.** It is written in this repository,
on [TiddlyWiki 5](https://tiddlywiki.com/). It has two halves:

- **Every published wiki** is a TiddlyWiki page beside the TiddlyWiki core it runs on, at an IPFS
  address of its own. It reads like any wiki, and carries a pen: the page's pen, and the pencil
  of every tiddler, open the editor with a copy of the wiki.
- **The editor**, at `editor.decentrawiki.eth`, keeps every wiki a person edits in their browser,
  edits it in TiddlyWiki itself, and publishes it: it builds the static page and computes its IPFS
  address. In Orivon it runs an IPFS node in the page, Orivon's own, and by default hosts the newest
  version of each wiki from it to anyone on IPFS while the editor is open; free pinning, also on by
  default, has Orivon's node read each new version from there and keep it for 30 days. Settings, under
  Publishing, has a switch for each. It also pins with a node or pinning service of the person's, and
  accepts a pin only when it reports that same address.
- **Every wiki is published under an address of its own**, an IPNS name (`ipns://k51…`) that keeps
  showing the wiki's newest version. The editor makes the name in the page, keeps its key in the
  browser, signs a record that points the name at each version it publishes, and has Orivon's node
  keep the name up for 30 days after each publish. The key and the public record are offered as
  downloads, and Import takes a key, an `ipns://` address or an `ipfs://` one.

`decentrawiki.eth` is the DecentraWiki guide, a wiki published exactly as the editor publishes
every wiki; this build makes it too.

| | |
|---|---|
| Built on | [TiddlyWiki](https://github.com/TiddlyWiki/TiddlyWiki5) 5.4.1, commit `d391595836e2`; DecentraWiki is not made or endorsed by the TiddlyWiki project |
| Version | 0.1.10 |
| Licence | This repository's; TiddlyWiki is BSD-3-Clause, see [`UPSTREAM.md`](UPSTREAM.md) |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| Names | `editor.decentrawiki.eth` (the editor), `decentrawiki.eth` (the guide) |
| In another browser | Both work there, through a gateway such as `eth.limo`; the editor adds a small notice that can be closed. |
| Problems | [Report a problem](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=DecentraWiki) |

Known gaps:

- **Free pinning keeps a version for 30 days.** With nothing set up, Publish uses free pinning by
  Orivon, which keeps each version once, for 30 days, and takes wikis up to about 9 MB. In Orivon,
  with hosting on, the wiki leaves from the page's own IPFS node; with hosting off, or in another
  browser, which gives a page no node, it is uploaded. Free pinning is a switch in Settings, under
  Publishing. A wiki kept longer is published with
  IPFS Desktop or Kubo, Filebase, Pinata or any Kubo-compatible service, or downloaded as a CAR file
  to pin anywhere. Free pinning answers at `telemetry.orivonstack.com/decentrawiki`, on Orivon's
  server; *provisional*: it shares the telemetry server's name until it has one of its own.
- **Orivon's node keeps an address up for 30 days after each publish**, with free pinning off as
  well: it reads the version from the person's computer or from the IPFS network. Past that, the address needs
  a node that republishes its record: any IPFS node can republish the public record (`ipfs routing
  put`), or take the key (`ipfs key import`) and publish from it. Settings sends the saved record to
  Orivon's node again while some node still pins the version.
- **The keys of the addresses are in the browser's storage too.** A backup holds the wikis and which
  address each uses, never the keys; a person downloads each key. A key lost is an address nobody can
  update again.
- **Hosting stops with the editor.** With hosting on (the default in Orivon), the page's node
  serves the newest version of each wiki published from it to anyone on IPFS only while the editor
  is open, and stops with its last tab; what keeps a wiki up afterwards is a pin. Turning hosting off
  stops the announcing at once, and ends the node only when this tab started it. The node holds
  about 200 MiB of wikis in one run, and a wiki whose newest version was published with hosting off is
  hosted from its next publish. People who open a wiki, the nodes that look it up, and Orivon's relay can see the
  computer's IP address. Hosting needs Orivon, with the editor allowed to accept network
  connections; the relay's 512 places are shared with Orivon Share, and a computer behind a router
  that refuses connections is reachable only while it holds one.
- **The editor keeps wikis in the browser's storage for its origin**: clearing that site's data
  deletes them. Settings offers a backup of every wiki in one file.
- **A wiki very large to hand over** (more than about 500 KB once compressed) cannot travel in the
  address the pen opens. In Orivon the editor is an app, whose tab keeps no link back to the wiki, so
  such a wiki goes by file: "download a copy" in the wiki's sidebar, then Import in the editor.
  Another browser hands it over through the link between the two tabs.

The sections below are for people working on the app.

## How it works

| Part | What it is |
|---|---|
| [`page/`](page/) | The editor page: [`src/main.js`](page/src/main.js) routes; the library, Settings, Import and Publish dialogs are in `src/views/` and `src/ui/` |
| [`page/src/workspace.js`](page/src/workspace.js), [`page/frame-boot.js`](page/frame-boot.js) | A wiki being edited runs in a frame sandboxed to an opaque origin of its own, booted with the wiki's tiddlers; the frame sends every change and the page keeps it in IndexedDB ([`page/src/store.js`](page/src/store.js)), which also holds the newest published version of each wiki as a CAR, for hosting it |
| [`page/src/receive.js`](page/src/receive.js) | The editor's half of the pen |
| [`page/src/import.js`](page/src/import.js) | What a TiddlyWiki file, a pen or a backup becomes in the library, and how two versions of a wiki differ |
| [`page/src/publish/`](page/src/publish/) | Building the published page, the pin, and the check of the address the service reports; [`page-node.js`](page/src/publish/page-node.js) publishes from the page's own node |
| [`page/src/publish/node-link.js`](page/src/publish/node-link.js), [`hosting.js`](page/src/publish/hosting.js) | The page's link to its node (the key, starting or joining it, a call with a refusal said in words), and hosting wikis on it: the stored newest version of each wiki given to the node as CAR batches, announced, polled every 30 seconds, taken back when a wiki is deleted or hosting is turned off |
| [`page/src/node/launch.js`](page/src/node/launch.js) | Starts the page's IPFS node, `bin/ipfs-node`, through Orivon's Node shim, with the flags of a node that hosts or of one that only publishes, and ends a node this page started; the one file bundled, into `node-launch.js` |
| [`page/src/ipfs/`](page/src/ipfs/) | CIDs (byte-for-byte Kubo's `add -r --cid-version=1`), CAR files, and gateway reads checked block by block; [`ipns.js`](page/src/ipfs/ipns.js) and [`wire.js`](page/src/ipfs/wire.js) make IPNS names and signed records the way Kubo does, check them, and read and write key files |
| [`page/src/names.js`](page/src/names.js) | The addresses (IPNS names) whose keys the browser holds, kept in the settings store under one key: making one, signing a record for a version, the sequence rule, importing a key. The pure helpers are tested without a store |
| [`page/src/name-files.js`](page/src/name-files.js), [`page/src/name-lookup.js`](page/src/name-lookup.js) | The key file (JSON that holds a Kubo key) and the public record; reading an `ipns://` address in its forms, and finding what a name shows among Orivon's node and two trustless gateways, keeping the newest record that verifies |
| [`page/src/version-fetch.js`](page/src/version-fetch.js) | Fetching one version by its IPFS address from gateways, every block checked, and reading it as a wiki |
| [`page/src/publish/relay-names.js`](page/src/publish/relay-names.js), [`name-step.js`](page/src/publish/name-step.js) | The two calls free pinning answers about an address (`name/keep`, `name/record`), and the step after a pin that signs the record, saves it and sends it |
| [`wiki/plugins/orivon/decentrawiki/`](wiki/plugins/orivon/decentrawiki/) | The plugin of every published wiki: the pen, the hand-over, and the published look |
| [`wiki/plugins/orivon/decentrawiki-frame/`](wiki/plugins/orivon/decentrawiki-frame/) | The plugin of the editing frame only |
| [`wiki/frame/`](wiki/frame/), [`wiki/home/`](wiki/home/) | The editing frame's edition, and the guide's |
| [`build/build.mjs`](build/build.mjs), [`build/sorted-readdir.mjs`](build/sorted-readdir.mjs) | TiddlyWiki's own command line renders both editions beside one core file, with every directory listed in byte order |
| [`relay/`](relay/) | Free pinning and kept addresses, on Orivon's server: [`relay.mjs`](relay/relay.mjs) answers a Kubo-compatible `add`, `pin-from`, `name/keep` and `name/record` and pins on Orivon's Filebase account, [`rules.mjs`](relay/rules.mjs) is what it accepts, [`names.mjs`](relay/names.mjs) is the record of kept addresses and the rules for keeping one, [`republish.mjs`](relay/republish.mjs) puts the addresses back every 4 hours, [`expire.mjs`](relay/expire.mjs) unpins what is 30 days old once a day and carries out takedowns. Never served |
| [`test/`](test/) | Unit tests. Never served |

## Running it

```bash
orivon-port run decentrawiki     # clones TiddlyWiki, builds, serves the editor on 127.0.0.1:8895
```

The build fetches the page's IPFS node by its CID from trustless gateways (`IPFS_NODE` in
[`build/build.mjs`](build/build.mjs)), every block checked, and writes the features that node has
(`serve`, `listen`, `provide`, `relay`) to `build.json`, where the page reads them.
`DECENTRAWIKI_IPFS_NODE_DIR=<folder>` takes a
local copy instead: one that makes that CID is the published node (for a network whose resolver hijacks
the gateways), any other a trial build the build names as one. It
bundles `page/src/node/launch.js` with orivon-mvp's Node shim (`ORIVON_MVP_ROOT`, default
`../orivon-mvp` beside this repository).

The guide is built beside it, in `out/decentrawiki/source/decentrawiki-home/`; serve that
directory with any static server to read it. A published wiki opens the editor at
`editor.decentrawiki.eth`, over `https:` or, for a developer name, over `http:`; a wiki that sets
`$:/config/DecentraWiki/EditorURL` opens that address instead.

Free pinning runs on the server behind `telemetry.orivonstack.com`, as the systemd units in
[`relay/`](relay/). To deploy it from a checkout there:

```bash
sudo install -d -m 700 /etc/decentrawiki-relay   # then write FILEBASE_KEY=<IPFS RPC key> to secrets.env, mode 600
sudo sh apps/decentrawiki/relay/install.sh       # copies the relay to /opt, starts it on 127.0.0.1:8092
```

`install.sh` also starts `decentrawiki-relay-republish.timer` (15 minutes after boot, then every 4
hours), which needs no Filebase key, only the Kubo node at `KUBO_RPC` (default `127.0.0.1:5001`).

Caddy sends `/decentrawiki/*` of the server's site to it, with the body limit raised to 12 MiB for
that path:

```
@dwpin path /decentrawiki/*
request_body @dwpin {
	max_size 12MiB
}
handle_path /decentrawiki/* {
	reverse_proxy 127.0.0.1:8092
}
```

## What it needs from orivon-mvp

In Orivon the editor is an app: its manifest declares one capability, `net`, so that its page can run
an IPFS node. HTTPS to any host on port 443 (the pinning services, the gateways, free pinning), TCP to
any host on any port (its node to Orivon's node, to the IPFS network and to Orivon's relay) and to two
loopback addresses, IPFS Desktop's API and its own node, which listens on a local port. The node looks up
the IPFS network's entry points with DNS over TCP to 1.1.1.1 and 1.0.0.1, which the manifest names on
port 53 because Orivon's wildcard grant never covers that port. A node that hosts wikis also accepts
IPFS connections on every interface, on 4811 to 4820. It calls no other `orivon.*` member.

| Behaviour | orivon-mvp catalogue row |
|---|---|
| The page spawns its node, a WASI 0.2 component shipped as jco's output, which dials Orivon's node and listens on a local port the page reaches | `wasi-component-dials-and-serves` |
| A node that hosts wikis listens on every interface in the granted range | `tcp-listen-any-interface-accepts-connections` |
| The page's `fetch` to its node's loopback port, and to IPFS Desktop's | `routed-fetch-loopback-grant-covers-both-spellings` |
| The page's `fetch` to the HTTPS services it publishes with, through its `https.connect` grant | `routed-fetch-reaches-granted-hosts` |
| A wildcard grant never reaches loopback, so the two loopback addresses are named | `wildcard-host-never-reaches-loopback` |
| A published wiki's pen opens the editor at the whole address it named: the wiki travels in the fragment | `website-popup-to-app-keeps-the-address` |
| The editing frame: an app's `sandbox="allow-scripts"` frame runs its served pages, `new Function` included, with an opaque origin that cannot read the library | `app-sandboxed-frame-runs-served-script` |
| The library: an app's IndexedDB survives a restart | `indexeddb-survives-restart` |
| The first visit asks before the page runs as the app | `consent-question-holds-the-page` |
| The page makes Ed25519 keys and signs and checks IPNS records with `crypto.subtle`, which needs the app's origin to be a secure context | `secure-context-on-app-origin` |
| The key file, the public record, the CAR file and the backup are saved from a Blob the page made, with no dialog | `blob-download-saves-without-dialog` |
| "Open it" on a published wiki's `ipns://` address (and its `ipfs://` one) opens the wiki | `ipfs-url-opens` |

## Design notes

**An app, so that the page can run an IPFS node.** A page gets sockets in Orivon only through the
grants its manifest declares, so the editor declares `net`, and Orivon holds it as an app. Two
things follow. A page that a website opens arrives in an app as a new tab with no opener (orivon-mvp
`src/main/shell/popups.ts`), so the pen hands the wiki over in the address it opens, in the fragment,
which never reaches a server; a wiki too large for that goes by file. And an app's own `fetch`
reaches only the hosts its grant names, which is why the grant names any host on port 443: the
pinning service is the person's choice. In another browser the editor is an ordinary page, with no
node, and the pen hands over larger wikis through the link between the two tabs.

**Publishing from the page's own node.** The node is Orivon's own IPFS node, the one Orivon reads
`ipfs://` with, built for WebAssembly with a serving mode, and shipped in `bin/ipfs-node.p2/`. The
page spawns it with `--serve --routing-mode offline` to publish when it does not host (hosting off, or
a node that lacks the hosting features): it looks nothing up, never listens on the network, and
answers Bitswap requests only from the blocks the page handed it, held in memory, never from what it
read for anyone. Its local API takes a key the page keeps, so no other program on the
computer can use it. A program that took the node's port first would be sent that key when the page looks
for its node, and gain only the use of the page's own node; publishing then fails. To publish, the page hands it the wiki as a CAR, asks free pinning where
Orivon's node is (`/api/v0/node`), has its node dial it, and asks free pinning to pin the wiki from
its peer id (`/api/v0/pin-from`): Orivon's node reads the blocks over the connection the page's node
opened, and the relay checks them as it checks an upload. No HTTP request carries the wiki.

**Hosting from this computer, and free pinning.** Settings, under Publishing, has two switches. The
first, hosting, is the `hostWikis` setting; the second, free pinning, is `freePinning`. Both count as
on when absent, and each default is one constant:
`HOST_WIKIS_DEFAULT` in `hosting.js` and `FREE_PINNING_DEFAULT` in `page-node.js`, both *provisional*
until the project confirms them. Hosting is on only where the page can run a node that listens; outside
Orivon the first switch is shown off and disabled. The Publish dialog reads both once when it opens,
and what it does for each combination:

| Hosting | Free pinning | Publish |
|---|---|---|
| on | on | Orivon's node reads the version from this computer (`pin-from`) and pins it, this computer announces it, and the address is kept |
| on | off | this computer announces the version and nothing pins it ("Only this computer: online while the editor is open"); the page connects its node to Orivon's node, which reads the version from it to keep the address |
| off | on | uploads the wiki to the relay's `/api/v0/add`, the request the Filebase and RPC targets also make; no node starts |
| off | off | the person's own services, or a CAR file to download |

A service of the person's is offered in every row; when chosen it pins the version, and with hosting
on this computer announces it as well. A failure to host never fails a publish that was pinned
elsewhere, but fails one that only this computer hosts, and then the wiki's kept version is put back as it was
(a cancelled one too), so the next load announces nothing the person was told failed. Orivon's node keeps an address up after each publish whatever the switches say;
with free pinning off it reads the version from this computer through the `peer` parameter of
`name/keep`, so no pin of Orivon's is needed. A failed publish writes one
`[decentrawiki] publish failed at the <step> step, <route>` line to the console, with any node key
cut out, and hosting writes `[decentrawiki] hosting …` lines the same way, because in this build of
Orivon only an app page's error lines reach `orivon://report`. The status line in Settings shows the
node's own report, which the page polls every 30 seconds: starting, hosting N wikis reachable directly
or through Orivon's relay, not reachable (a router that refuses connections and no place on the relay,
whatever the node announced), or that the node would not take some wikis because it is full. Turning
hosting off and on again is done in order: the switch changes wait for the node to end.

**Hosting wikis from the page's node.** With hosting on, the page starts the node as a host instead: `--routing-mode auto`, `--p2p-port` 4811 to 4820 (one for each API
port), and `--relay` to Orivon's circuit relay, the one Orivon Share uses, so that a computer behind a
home router keeps a place on it. Dropping `offline` is what gives the node the DHT, and so
`POST /provide`. At each publish the page keeps the version's CAR in IndexedDB (`hosted`, one row for
each wiki, replaced by the next version), gives the node its blocks as CAR batches of at most 32 MiB
and has it announce the address; at load it gives the node every stored version again, the newest
first, until 200 MiB have been handed over in the run, because the node holds blocks in memory
(256 MiB), never lets one go, and a replaced version stays in memory until the node ends. That count
is this page's own: a node shared with another tab, or kept across a reload, may hold more, and when
it answers 507 the page hands it nothing more in the run and writes a console line saying the node is
full. It polls the node's `/status` every 30 seconds for the reachability and the relay place: a
version is unreachable only when the node's AutoNAT says private and no relay place is held. A failed
status call does not end the page's hold on the node while `/health` still answers, because the node
keeps announcing whatever the page gave it. The page starts the node only
when the build's `build.json` and the node's own `/health` header both list `listen`, `provide` and
`relay`. Turning hosting off, or deleting a wiki, takes back the announcements from the node found on
the port the editor last used, whichever tab placed them, and ends the node only when this page
started it; a node another tab started ends with the editor's last tab. A delete is confirmed as soon
as the wiki is gone from this browser and the node is told after, because a node that is starting
can take a minute to answer. A tab still handing the node a wiki that another tab deleted, or a
version that another tab replaced, reads the stored row again before it announces it and after, and
takes the announcement back itself when the row has gone or changed. A node running for publishing
only is ended and started again as a host when this page started it in the run; one that no page can
end now (another tab's, or this page's before a reload) is left running and the host starts on the
next port. Every failure is a `[decentrawiki] hosting …` console.error line, which a bug report
carries; the node's own lines are console.warn, which one does not. Nothing here is kept in a backup:
the stored CARs are a copy of what a publication already holds.

**The wiki runs sandboxed, the editor does not trust it.** A wiki brings its own scripts and
plugins. They run in a frame with an opaque origin, which cannot read the editor's IndexedDB, where
the publishing keys are; the frame only posts changes, and the page keeps a change only for a
title it does not reserve (`isDropped` in `page/src/import.js`). The published-wiki plugin is the
editor's own: an import drops any copy a wiki carries, and Publish refuses a page whose copy of it
differs from the editor's, so a wiki cannot point its pen anywhere else.

**The frame keeps only real tiddlers.** TiddlyWiki reports a plugin's shadow tiddlers as changes when
it unpacks them, its `$:/info/` ones included (the screen size, the language, the frame's own address),
so the frame plugin sends a change only for a tiddler that really exists or was deleted, and the
editor drops `$:/info/` and what the core file sets on every page at import and at publish as well.

**The frame edits on a plain textarea.** TiddlyWiki's toolbar editor writes into an iframe it makes
inside the page, which a frame sandboxed without `allow-same-origin` may not touch. The frame plugin's
engine (`engine.js`) edits a textarea in the page instead, and gives the toolbar what TiddlyWiki's
framed engine gives it: the text operation every toolbar button sends, which TiddlyWiki's simple engine
leaves out (each button would fail with "Internal JavaScript Error"), the toolbar's keyboard shortcuts,
and a file dropped or pasted into the editor, handed on from the textarea's parent because the editor's
dropzone ignores one aimed at a textarea. Fields with no toolbar keep the simple engine.
The published-wiki plugin switches the PUT saver off, so no page probes its own address.

**The core sits beside the page, unchanged.** Every published wiki is `index.html` plus
`tiddlywikicore-<version>.js`, TiddlyWiki's external-core layout. The core file is the same bytes
for every wiki of one version, so it has one CID across all of them, and a page carries no inline
script beyond its tiddler store. TiddlyWiki writes the core in the order it reads the files, which Node
takes from the system, so the build lists every directory in byte order (`build/sorted-readdir.mjs`) and
a Windows build makes the same core as a Linux one.

**The address is computed here.** `page/src/ipfs/unixfs.js` builds the directory exactly as Kubo's
`ipfs add -r --cid-version=1` does (its tests hold CIDs Kubo printed), so the editor knows the
address before it uploads and refuses a pin that reports another one.

**The public gateway link is a subdomain gateway.** After publishing, "Open on a public gateway"
opens `<name>.ipns.dweb.link` (a name fits one DNS label), or `<cid>.ipfs.dweb.link` for a version
published with no address; either gives each wiki an origin of its own. Filebase's gateway answers
a whole TiddlyWiki page with a "Content Blocked" page of its own, though it serves the page's
blocks (Orivon, and the editor's import, read blocks), so it is used only for those.

**Free pinning pins wikis, not files.** Read from a node, the folder's own block is checked first: its
names, the sizes its links declare, and the core by its known CID, and only then are the page and the
icon fetched, each bounded. Uploaded or read, the relay takes one folder holding `index.html`, a
TiddlyWiki core it knows by its SHA-256, and at most a `favicon.ico` that is an image. The page must
be the editor's shape: valid UTF-8, one tiddler store carrying the DecentraWiki plugin, and no script
but the store and the core, so a wiki whose page carries scripts of its own is published elsewhere.
Anything else is refused before it reaches Filebase. The relay never forwards the bytes it was sent:
it rebuilds the upload from the files it checked, so Filebase cannot read the body another way. It
computes the CID with the editor's own `page/src/ipfs/unixfs.js` and keeps a CID once: a version it
already kept for 30 days is refused, so free pinning cannot hold a file up for good by uploading it
again. A CID the account pinned before the relay saw it is never unpinned, and an unclear answer to
that question refuses the upload. Its record (`pins.jsonl`) is only ever appended to: the pin line is
written before the upload, an end or a failed upload is a line of its own, and a pin that failed
half-way is unpinned. It writes down the CID, the time and the size, never an address. It counts
uploads per client in memory only: 60 requests and 20 pins a day from one address (an IPv6 address by
its /64), 300 pins a day in all, two uploads at once, and at most 512 MiB a day and 2 GiB kept at once
(`DAY_BYTES`, `LIVE_BYTES`), because it shares the Filebase account with Orivon's own pins. Like any
target, its answer must name the CID the editor computed; it also says until when it keeps it, which
the editor shows. `node relay/expire.mjs <cid>...` ends the named free pins at once.

**Addresses are IPNS names made in the page.** The name's Ed25519 key is made with WebCrypto in the
page and never leaves the browser: the editor sends Orivon's node a signed record, never a key. A
record is laid out as Kubo writes it (V2 signature, with the V1 fields Kubo adds by default), so
Kubo, gateways and any IPFS node accept it, and `ipfs routing put /ipns/<name> <file>` republishes
the file the editor offers. A record is valid for ten years, so anyone holding the file can
republish it, and lives five minutes in a resolver's cache (its TTL). The sequence of a new record
is the larger of the last one signed plus one and the clock in seconds, so a key used from two
browsers still moves forward. An address shows one wiki at a time: publishing wiki B under the name
wiki A used takes the name from A. The keys stay out of the backup, so a backup shared with someone
shares no right to update an address. Importing reads the key file the editor writes, a Kubo key
file and Kubo's PEM, and asks Orivon's node and two trustless gateways (`ipfs.orbitor.dev`,
`ipfs.filebase.io`, both with CORS) for the newest record; a record counts only when it verifies
against the name, and the highest sequence wins.

**Free pinning keeps a wiki's address for 30 days after each publish, whoever pins the version.**
`/api/v0/name/keep` takes the raw record (`application/vnd.ipfs.ipns-record`, at most 10 KiB). It
must be signed by the name, stay valid at least 30 days, and say exactly `/ipfs/<CIDv1 of one dag-pb
folder>`. A version the relay keeps as a free pin is known; any other version is first read through
the Kubo node beside the relay and checked as an upload is, so the relay keeps addresses of wikis,
never of arbitrary files. The read is from the IPFS network, or, when the request names the editor
page's IPFS node in the optional `peer` parameter (its peer id), from that node, over the same
temporary peering `pin-from` uses: a version only that node holds is found through the network only
after minutes, if at all. A `peer` that is not a node id is refused with 400. A node Kubo is not
connected to within 10 seconds is given up on, and the version is read from the network within 90
seconds in all, so a version pinned elsewhere keeps its name; one the network does not find either is
refused with 409, and one it finds that is not a wiki with 400. A version the relay already knows is
never read, so `peer` is then not used. Kubo then puts the record (`routing/put`), and `names.jsonl`
records it, only ever appended to, like the pins. `republish.mjs` puts every kept address back every 4 hours,
because the network forgets a record in about two days, and ends it when its 30 days, its record or
its version are over. A newer record of the address starts its 30 days again, and the same record
sent again is answered as already kept. A lower sequence than any the relay kept for that address, or
another record at the same sequence, is refused, also after the address lapsed, because records are
public and an old one must not bring a stale version back. It keeps 20 addresses a day from one
client and 500 at once. `/api/v0/name/record` answers the newest record it holds for an address,
which the editor reads after a person imports a key. `node relay/expire.mjs <cid>...` also blocks
each CID, so no address may point at it again, and ends the addresses pointing at it; `--name
<name>...` ends addresses at once.

**Lineage.** A published wiki carries `$:/DecentraWiki/Lineage`: an id shared by every version of
one wiki, the IPFS address of the version it was made from, and the address (the IPNS name) the
version is published under, when it has one. The editor reads it to recognise a version of a wiki
the library already holds, and, when the browser holds the key of that name, to link the wiki it
takes in to it; it writes it again at each publish, with the address chosen for that publish, and
never keeps it among the tiddlers being edited.
