# DecentraWiki: what TiddlyWiki needs from Orivon

DecentraWiki ([`apps/decentrawiki/`](../apps/decentrawiki/)) is an app written in this repository on
TiddlyWiki 5.4.1 (commit `d391595836e2aead565480763f9bf9eb52e29e75`). TiddlyWiki is a page, not an
Electron app, so `orivon-port recon` has nothing to measure: there is no preload and no main
process, and the capability ratio is 0 of 0. This page is the measurement instead.

## What TiddlyWiki does in a page

| Need | Where | In Orivon |
|---|---|---|
| Builds its modules with `new Function` | `core/templates/tiddlywiki5.js.tid` (`_load`), `boot/boot.js` (`$tw.utils.evalGlobal`) | An app's served policy allows `'unsafe-eval'`, in its sandboxed frames too (`app-sandboxed-frame-runs-served-script`) |
| Inline `<script>` | The single-file wiki holds its core inline | Avoided: the external-core layout (`$:/core/save/offline-external-js`) loads `tiddlywikicore-<version>.js` by `src`, and the page keeps only its JSON tiddler store, which is data |
| An `onerror` attribute on the core's `<script>` | `core/templates/external-js/tiddlywiki5-external-js.html.tid` | Harmless when refused: it only alerts when the core is missing |
| Inline styles, `<style>` it writes as it renders | everywhere | Allowed for websites and apps |
| `localStorage`, cookies, network | none in the core | Nothing to grant |
| `window.open`, `<a target="_blank">` | links to other sites | Ordinary tabs |
| `beforeunload` warning for unsaved changes | `core/modules/saver-handler.js` | Switched off inside the editing frame, which saves every change as it happens |

## What DecentraWiki adds, and what Orivon must give it

| Need | Why | Orivon today |
|---|---|---|
| A popup into the editor arrives at the whole address | The pen hands the wiki over in the fragment it opens | A popup into an app from another origin is a new tab of the app with no opener, at the address named (`website-popup-to-app-keeps-the-address`); a wiki too large for the address goes by file |
| A `sandbox="allow-scripts"` frame of the page's own file | A wiki's own scripts run apart from the editor's storage | Works for an app (`app-sandboxed-frame-runs-served-script`) |
| IndexedDB that survives a restart | The library | Works for an app (`indexeddb-survives-restart`) |
| An IPFS node the page runs | Publishing from the person's own node | A WASI 0.2 component the page spawns under its `net` grant dials and listens (`wasi-component-dials-and-serves`); the page reaches it with `fetch` on a loopback port it names (`routed-fetch-loopback-grant-covers-both-spellings`) |
| `crypto.subtle`, `CompressionStream` | CIDs, the hand-over | Secure contexts: every `.eth` and `ipfs://` page, and a developer `.eth` name through the secure-origin switch |
| `fetch` with CORS to a pinning service | Publish | Pinata and Filebase answer CORS for any origin (measured with a preflight from `https://editor.decentrawiki.eth`); free pinning answers CORS for any origin itself |

## Verdict

A target, built on TiddlyWiki as a library: no bridge, one capability (`net`), nothing missing in Orivon.
The rows it needs from orivon-mvp are in [`apps/decentrawiki/README.md`](../apps/decentrawiki/README.md)
section What it needs from orivon-mvp.
