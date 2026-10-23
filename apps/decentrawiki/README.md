# DecentraWiki

## About this app

**DecentraWiki is a wiki anyone can edit, published on IPFS.** It is written in this repository,
on [TiddlyWiki 5](https://tiddlywiki.com/). It has two halves:

- **Every published wiki** is a TiddlyWiki page beside the TiddlyWiki core it runs on, at an IPFS
  address of its own. It reads like any wiki, and carries a pen: the page's pen, and the pencil
  of every tiddler, open the editor with a copy of the wiki.
- **The editor**, at `editor.decentrawiki.eth`, keeps every wiki a person edits in their browser,
  edits it in TiddlyWiki itself, and publishes it: it builds the static page and computes its IPFS
  address. In Orivon it runs an IPFS node in the page, Orivon's own, and publishes the wiki from it;
  Orivon's node reads it from there and keeps it for 30 days. It also pins with a node or pinning
  service of the person's, and accepts a pin only when it reports that same address.

`decentrawiki.eth` is the DecentraWiki guide, a wiki published exactly as the editor publishes
every wiki; this build makes it too.

| | |
|---|---|
| Built on | [TiddlyWiki](https://github.com/TiddlyWiki/TiddlyWiki5) 5.4.1, commit `d391595836e2`; DecentraWiki is not made or endorsed by the TiddlyWiki project |
| Version | 0.1.4 |
| Licence | This repository's; TiddlyWiki is BSD-3-Clause, see [`UPSTREAM.md`](UPSTREAM.md) |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| Names | `editor.decentrawiki.eth` (the editor), `decentrawiki.eth` (the guide) |
| In another browser | Both work there, through a gateway such as `eth.limo`; the editor adds a small notice that can be closed. |
| Problems | [Report a problem](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=DecentraWiki) |

Known gaps:

- **Free pinning keeps a version for 30 days.** With nothing set up, Publish uses free pinning by
  Orivon, which keeps each version once, for 30 days, and takes wikis up to about 9 MB. In Orivon the
  wiki leaves from the page's own IPFS node; in another browser, which gives a page no node, it is
  uploaded. A wiki kept longer is published with IPFS Desktop or Kubo, Filebase, Pinata or any
  Kubo-compatible service, or downloaded as a CAR file to pin anywhere. Free pinning answers at
  `telemetry.orivonstack.com/decentrawiki`, on Orivon's server; *provisional*: it shares the
  telemetry server's name until it has one of its own.
- **The page's node runs while the editor is open.** It serves the wikis published from it to
  Orivon's node only, and stops with the editor's last tab; what keeps a wiki up afterwards is a pin.
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
| [`page/src/workspace.js`](page/src/workspace.js), [`page/frame-boot.js`](page/frame-boot.js) | A wiki being edited runs in a frame sandboxed to an opaque origin of its own, booted with the wiki's tiddlers; the frame sends every change and the page keeps it in IndexedDB ([`page/src/store.js`](page/src/store.js)) |
| [`page/src/receive.js`](page/src/receive.js) | The editor's half of the pen |
| [`page/src/import.js`](page/src/import.js) | What a TiddlyWiki file, a pen or a backup becomes in the library, and how two versions of a wiki differ |
| [`page/src/publish/`](page/src/publish/) | Building the published page, the pin, and the check of the address the service reports; [`page-node.js`](page/src/publish/page-node.js) publishes from the page's own node |
| [`page/src/node/launch.js`](page/src/node/launch.js) | Starts the page's IPFS node, `bin/ipfs-node`, through Orivon's Node shim; the one file bundled, into `node-launch.js` |
| [`page/src/ipfs/`](page/src/ipfs/) | CIDs (byte-for-byte Kubo's `add -r --cid-version=1`), CAR files, and gateway reads checked block by block |
| [`wiki/plugins/orivon/decentrawiki/`](wiki/plugins/orivon/decentrawiki/) | The plugin of every published wiki: the pen, the hand-over, and the published look |
| [`wiki/plugins/orivon/decentrawiki-frame/`](wiki/plugins/orivon/decentrawiki-frame/) | The plugin of the editing frame only |
| [`wiki/frame/`](wiki/frame/), [`wiki/home/`](wiki/home/) | The editing frame's edition, and the guide's |
| [`build/build.mjs`](build/build.mjs) | TiddlyWiki's own command line renders both editions beside one core file |
| [`relay/`](relay/) | Free pinning, on Orivon's server: [`relay.mjs`](relay/relay.mjs) answers a Kubo-compatible `add` and pins on Orivon's Filebase account, [`rules.mjs`](relay/rules.mjs) is what it accepts, [`expire.mjs`](relay/expire.mjs) unpins what is 30 days old, once a day. Never served |
| [`test/`](test/) | Unit tests. Never served |

## Running it

```bash
orivon-port run decentrawiki     # clones TiddlyWiki, builds, serves the editor on 127.0.0.1:8895
```

The build fetches the page's IPFS node by its CID (`IPFS_NODE` in [`build/build.mjs`](build/build.mjs));
`DECENTRAWIKI_IPFS_NODE_DIR=<folder>` takes a local build of that folder instead, to try a new one. It
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
an IPFS node. TCP to any host on port 443 (the pinning services, the gateways, free pinning), to any
host on 4001 (its node to Orivon's node), and to two loopback addresses, IPFS Desktop's API and its
own node, which listens on a local port. It calls no other `orivon.*` member.

| Behaviour | orivon-mvp catalogue row |
|---|---|
| The page spawns its node, a WASI 0.2 component shipped as jco's output, which dials Orivon's node and listens on a local port the page reaches | `wasi-component-dials-and-serves` |
| The page's `fetch` to its node's loopback port, and to IPFS Desktop's | `routed-fetch-loopback-grant-covers-both-spellings` |
| A wildcard grant never reaches loopback, so the two loopback addresses are named | `wildcard-host-never-reaches-loopback` |
| A published wiki's pen opens the editor at the whole address it named: the wiki travels in the fragment | `website-popup-to-app-keeps-the-address` |
| The editing frame: an app's `sandbox="allow-scripts"` frame runs its served pages, `new Function` included, with an opaque origin that cannot read the library | `app-sandboxed-frame-runs-served-script` |
| The library: an app's IndexedDB survives a restart | `indexeddb-survives-restart` |
| The first visit asks before the page runs as the app | `consent-question-holds-the-page` |

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
page spawns it with `--serve --routing-mode offline`: it looks nothing up, never listens on the
network, and answers Bitswap requests only from the blocks the page handed it, held in memory, never
from what it read for anyone. Its local API takes a key the page keeps, so no other program on the
computer can use it. To publish, the page hands it the wiki as a CAR, asks free pinning where
Orivon's node is (`/api/v0/node`), has its node dial it, and asks free pinning to pin the wiki from
its peer id (`/api/v0/pin-from`): Orivon's node reads the blocks over the connection the page's node
opened, and the relay checks them as it checks an upload. No HTTP request carries the wiki.

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
inside the page, which a frame sandboxed without `allow-same-origin` may not touch; the frame plugin
registers the edit-text widget with TiddlyWiki's simple engine for both cases, toolbar included.
The published-wiki plugin switches the PUT saver off, so no page probes its own address.

**The core sits beside the page, unchanged.** Every published wiki is `index.html` plus
`tiddlywikicore-<version>.js`, TiddlyWiki's external-core layout. The core file is the same bytes
for every wiki of one version, so it has one CID across all of them, and a page carries no inline
script beyond its tiddler store.

**The address is computed here.** `page/src/ipfs/unixfs.js` builds the directory exactly as Kubo's
`ipfs add -r --cid-version=1` does (its tests hold CIDs Kubo printed), so the editor knows the
address before it uploads and refuses a pin that reports another one.

**The public gateway link is a subdomain gateway.** After publishing, "Open on a public gateway"
opens `<cid>.ipfs.dweb.link`, which gives each wiki an origin of its own. Filebase's gateway answers
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

**Lineage.** A published wiki carries `$:/DecentraWiki/Lineage`: an id shared by every version of
one wiki, and the address the version was made from. The editor reads it to recognise a version of
a wiki the library already holds, and writes it again at each publish; it never keeps it among the
tiddlers being edited.
