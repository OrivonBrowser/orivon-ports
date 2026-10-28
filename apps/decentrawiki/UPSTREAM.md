# Upstream: TiddlyWiki 5

| | |
|---|---|
| Source | `https://github.com/TiddlyWiki/TiddlyWiki5` |
| Pinned commit | `d391595836e2aead565480763f9bf9eb52e29e75` (v5.4.1) |
| Licence | BSD-3-Clause |

DecentraWiki is written in this repository; TiddlyWiki, by Jeremy Ruston and the TiddlyWiki
community, is what it is built on (`upstream.library` in [`recipe.json`](recipe.json)). The
TiddlyWiki project did not make DecentraWiki and does not endorse it.

## What crosses into this repository

**Nothing of TiddlyWiki's.** The clone lives in `out/decentrawiki/source/` and everything built
from it in `out/decentrawiki/static/`, both gitignored. The build runs TiddlyWiki's own command line
in the clone, which needs no install.

What is ours, and written from scratch:

- [`page/`](page/): the editor page, its library, its publishing, and its IPFS code (CIDs, CAR
  files, gateway reads, pinning).
- [`wiki/plugins/orivon/decentrawiki/`](wiki/plugins/orivon/decentrawiki/): the plugin every
  published wiki carries: the pen, and the hand-over to the editor.
- [`wiki/plugins/orivon/decentrawiki-frame/`](wiki/plugins/orivon/decentrawiki-frame/): the plugin
  of the editing frame only.
- [`wiki/frame/`](wiki/frame/) and [`wiki/home/`](wiki/home/): two TiddlyWiki editions, the
  editing frame and the DecentraWiki guide published at `decentrawiki.eth`.
- [`build/build.mjs`](build/build.mjs): the build.

Every published wiki ships TiddlyWiki's core beside it, unchanged and unminified, as
`tiddlywikicore-<version>.js`, under TiddlyWiki's licence, whose text the core file carries.

## The IPFS node the editor ships

The editor also ships Orivon's IPFS node in `bin/` (`bin/ipfs-node.p2/`, with its `LICENSE-MIT` and
`LICENSE-APACHE`): a WebAssembly build, transpiled by jco, of
[`OrivonBrowser/orivon-ipfs-node`](https://github.com/OrivonBrowser/orivon-ipfs-node) at commit
`b2240f6`, made by that repository's `orivon-wasm.yml` workflow. It is MIT OR Apache-2.0. The build
fetches the published folder by its CID (`IPFS_NODE` in [`build/build.mjs`](build/build.mjs)) and
checks every block of it; nothing of the node is committed here. Only the editor ships it: a
published wiki never carries the node.

## What to re-check when the pin moves

- The external-core template: the build renders `$:/core/save/offline-external-js`, and
  `page/src/publish/publish.js` and `wiki/plugins/orivon/decentrawiki-frame/frame-sync.js` read
  the store areas it writes (`<script class="tiddlywiki-tiddler-store" type="application/json">`)
  and the `<script src="tiddlywikicore-<version>.js">` that loads the core. A changed template is
  a changed published format.
- The boot hooks the frame uses: `$tw.boot.suppressBoot`, `$tw.preloadTiddlers` and
  `$tw.boot.boot(callback)` in `boot/boot.js`.
- The navigator hooks the pen uses: `th-editing-tiddler` (cancels editing when it answers false)
  and `th-new-tiddler`, in `core/modules/widgets/navigator.js`.
- The button classes the published-wiki stylesheet hides: `tc-btn-` plus the URI-encoded button
  title (`core/ui/PageControls.tid`, `core/ui/ViewToolbar/more-tiddler-actions.tid`).
- A new core version gives the core file a new name, so every wiki published after the move loads
  the new file while wikis published before keep the one beside them. Nothing needs migrating.
