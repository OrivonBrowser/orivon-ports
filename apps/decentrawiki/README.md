# DecentraWiki

## About this app

**DecentraWiki is a wiki anyone can edit, published on IPFS.** It is written in this repository,
on [TiddlyWiki 5](https://tiddlywiki.com/). It has two halves:

- **Every published wiki** is a TiddlyWiki page beside the TiddlyWiki core it runs on, at an IPFS
  address of its own. It reads like any wiki, and carries a pen: the page's pen, and the pencil
  of every tiddler, open the editor with a copy of the wiki.
- **The editor**, at `editor.decentrawiki.eth`, keeps every wiki a person edits in their browser,
  edits it in TiddlyWiki itself, and publishes it: it builds the static page, computes its IPFS
  address, pins it with the person's own node or pinning service, and accepts the pin only when
  the service reports that same address.

`decentrawiki.eth` is the DecentraWiki guide, a wiki published exactly as the editor publishes
every wiki; this build makes it too.

| | |
|---|---|
| Built on | [TiddlyWiki](https://github.com/TiddlyWiki/TiddlyWiki5) 5.4.1, commit `d391595836e2`; DecentraWiki is not made or endorsed by the TiddlyWiki project |
| Version | 0.1.1 |
| Licence | This repository's; TiddlyWiki is BSD-3-Clause, see [`UPSTREAM.md`](UPSTREAM.md) |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| Names | `editor.decentrawiki.eth` (the editor), `decentrawiki.eth` (the guide) |
| In another browser | Both work there, through a gateway such as `eth.limo`; the editor adds a small notice that can be closed. |
| Problems | [Report a problem](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=DecentraWiki) |

Known gaps:

- **Publishing needs a node or a service that pins.** The editor runs no pinning service of its
  own: a person publishes with their own IPFS node (IPFS Desktop, Kubo), Filebase, Pinata or any
  Kubo-compatible service, or downloads the wiki as a CAR file to pin anywhere.
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
| [`test/`](test/) | Unit tests. Never served |

## Running it

```bash
orivon-port run decentrawiki     # clones TiddlyWiki, builds, serves the editor on 127.0.0.1:8895
```

The guide is built beside it, in `out/decentrawiki/source/decentrawiki-home/`; serve that
directory with any static server to read it. A published wiki opens the editor at
`editor.decentrawiki.eth`, over `https:` or, for a developer name, over `http:`; a wiki that sets
`$:/config/DecentraWiki/EditorURL` opens that address instead.

## What it needs from orivon-mvp

DecentraWiki is a website: its page names no manifest to install, so Orivon grants it nothing and
it calls no `orivon.*` member. What it counts on is the web platform as Orivon serves it:

| Behaviour | orivon-mvp catalogue row |
|---|---|
| A website's `window.open` of a page on another site keeps `window.opener`, so the pen hands the wiki over with `postMessage` | `website-popup-to-another-site-keeps-opener` |
| A website's `sandbox="allow-scripts"` frame of its own page runs it with an opaque origin, cannot read the website's IndexedDB, and exchanges messages with it | `website-sandboxed-frame-runs-served-script` |
| A website's IndexedDB survives a restart: the library | `website-indexeddb-survives-restart` |
| `eval` and `new Function`, which TiddlyWiki builds its modules with, run in a website's pages | none needed: no Orivon policy applies to a website's scripts |

## Design notes

**A website, not an installed app.** Orivon opens a page from another origin into an installed app
as a new tab with no opener (orivon-mvp `src/main/shell/popups.ts`), and the pen's hand-over needs
the opener. An installed app would also serve its page under a policy with no inline script and
`connect-src` limited to declared hosts, which would leave out the person's own choice of pinning
service. So the recipe sets `website`: the manifest ships for its name and version, and the page
names it nowhere, so Orivon never installs it. It declares no capability, so it is never asked
about.

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

**Lineage.** A published wiki carries `$:/DecentraWiki/Lineage`: an id shared by every version of
one wiki, and the address the version was made from. The editor reads it to recognise a version of
a wiki the library already holds, and writes it again at each publish; it never keeps it among the
tiddlers being edited.
