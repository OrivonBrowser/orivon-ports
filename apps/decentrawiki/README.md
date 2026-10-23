# DecentraWiki

## About this app

**DecentraWiki is a wiki anyone can edit, published on IPFS.** It is written in this repository,
on [TiddlyWiki 5](https://tiddlywiki.com/). It has two halves:

- **Every published wiki** is a TiddlyWiki page beside the TiddlyWiki core it runs on, at an IPFS
  address of its own. It reads like any wiki, and carries a pen: the page's pen, and the pencil
  of every tiddler, open the editor with a copy of the wiki.
- **The editor**, at `editor.decentrawiki.eth`, keeps every wiki a person edits in their browser,
  edits it in TiddlyWiki itself, and publishes it: it builds the static page, computes its IPFS
  address, pins it with the person's own node, a pinning service or free pinning by Orivon, and
  accepts the pin only when the service reports that same address.

`decentrawiki.eth` is the DecentraWiki guide, a wiki published exactly as the editor publishes
every wiki; this build makes it too.

| | |
|---|---|
| Built on | [TiddlyWiki](https://github.com/TiddlyWiki/TiddlyWiki5) 5.4.1, commit `d391595836e2`; DecentraWiki is not made or endorsed by the TiddlyWiki project |
| Version | 0.1.3 |
| Licence | This repository's; TiddlyWiki is BSD-3-Clause, see [`UPSTREAM.md`](UPSTREAM.md) |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| Names | `editor.decentrawiki.eth` (the editor), `decentrawiki.eth` (the guide) |
| In another browser | Both work there, through a gateway such as `eth.limo`; the editor adds a small notice that can be closed. |
| Problems | [Report a problem](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=DecentraWiki) |

Known gaps:

- **Free pinning keeps a version for 30 days.** With nothing set up, Publish uses free pinning by
  Orivon, which keeps each version once, for 30 days, and takes wikis up to about 9 MB. A wiki kept
  longer is published with the person's own IPFS node (IPFS Desktop, Kubo), Filebase, Pinata or any
  Kubo-compatible service, or downloaded as a CAR file to pin anywhere. Free pinning answers at
  `telemetry.orivonstack.com/decentrawiki`, on Orivon's server; *provisional*: it shares the
  telemetry server's name until it has one of its own.
- **The editor keeps wikis in the browser's storage for its origin**: clearing that site's data
  deletes them. Settings offers a backup of every wiki in one file.
- **A wiki very large to hand over** (more than about 500 KB once compressed) goes from the pen to
  the editor only while the browser keeps the link between the two tabs; the pen offers a file to
  import otherwise.

The sections below are for people working on the app.

## How it works

| Part | What it is |
|---|---|
| [`page/`](page/) | The editor page: [`src/main.js`](page/src/main.js) routes; the library, Settings, Import and Publish dialogs are in `src/views/` and `src/ui/` |
| [`page/src/workspace.js`](page/src/workspace.js), [`page/frame-boot.js`](page/frame-boot.js) | A wiki being edited runs in a frame sandboxed to an opaque origin of its own, booted with the wiki's tiddlers; the frame sends every change and the page keeps it in IndexedDB ([`page/src/store.js`](page/src/store.js)) |
| [`page/src/receive.js`](page/src/receive.js) | The editor's half of the pen |
| [`page/src/import.js`](page/src/import.js) | What a TiddlyWiki file, a pen or a backup becomes in the library, and how two versions of a wiki differ |
| [`page/src/publish/`](page/src/publish/) | Building the published page, the pin, and the check of the address the service reports |
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

DecentraWiki is a website: its page names no manifest to install, so Orivon grants it nothing and
it calls no `orivon.*` member. What it counts on is the web platform as Orivon serves it:

| Behaviour | orivon-mvp catalogue row |
|---|---|
| A website's `window.open` of a page on another site keeps `window.opener`, so the pen hands the wiki over with `postMessage` | `website-popup-to-another-site-keeps-opener` |
| A website's `sandbox="allow-scripts"` frame of its own page runs it with an opaque origin, cannot read the website's IndexedDB, and exchanges messages with it | `website-sandboxed-frame-runs-served-script` |
| A website's IndexedDB survives a restart: the library | `website-indexeddb-survives-restart` |
| A site opened by its `ipfs://` address with no `orivon.json` at its root stays a website, and a popup it opens on another such site keeps `window.opener`: the published pen and editor | `published-website-popup-keeps-opener` |
| `eval` and `new Function`, which TiddlyWiki builds its modules with, run in a website's pages | none needed: no Orivon policy applies to a website's scripts |

## Design notes

**A website, not an installed app.** Orivon opens a page from another origin into an installed app
as a new tab with no opener (orivon-mvp `src/main/shell/popups.ts`), and the pen's hand-over needs
the opener. An installed app is also served under a policy with `connect-src` limited to declared
hosts, which would leave out the person's own choice of pinning service. Orivon installs a published
site whose root holds `.well-known/orivon.json` (orivon-mvp `src/main/app-setup/first-visit-hook.ts`),
so the recipe sets `website`: the tree keeps its record in `.well-known/orivon-website.json`, and
the page names no manifest. It declares no capability, so it is never asked about.

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

**Free pinning pins wikis, not files.** The relay takes one folder holding `index.html`, a
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
