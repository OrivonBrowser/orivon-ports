# DecentraWiki: what TiddlyWiki needs from Orivon

DecentraWiki ([`apps/decentrawiki/`](../apps/decentrawiki/)) is an app written in this repository on
TiddlyWiki 5.4.1 (commit `d391595836e2aead565480763f9bf9eb52e29e75`). TiddlyWiki is a page, not an
Electron app, so `orivon-port recon` has nothing to measure: there is no preload and no main
process, and the capability ratio is 0 of 0. This page is the measurement instead.

## What TiddlyWiki does in a page

| Need | Where | In Orivon |
|---|---|---|
| Builds its modules with `new Function` | `core/templates/tiddlywiki5.js.tid` (`_load`), `boot/boot.js` (`$tw.utils.evalGlobal`) | A website runs it. An installed app's served policy allows `'unsafe-eval'` too |
| Inline `<script>` | The single-file wiki holds its core inline | Avoided: the external-core layout (`$:/core/save/offline-external-js`) loads `tiddlywikicore-<version>.js` by `src`, and the page keeps only its JSON tiddler store, which is data |
| An `onerror` attribute on the core's `<script>` | `core/templates/external-js/tiddlywiki5-external-js.html.tid` | Harmless when refused: it only alerts when the core is missing |
| Inline styles, `<style>` it writes as it renders | everywhere | Allowed for websites and apps |
| `localStorage`, cookies, network | none in the core | Nothing to grant |
| `window.open`, `<a target="_blank">` | links to other sites | Ordinary tabs |
| `beforeunload` warning for unsaved changes | `core/modules/saver-handler.js` | Switched off inside the editing frame, which saves every change as it happens |

## What DecentraWiki adds, and what Orivon must give it

| Need | Why | Orivon today |
|---|---|---|
| A popup on another site keeps `window.opener` | The pen hands the wiki to the editor with `postMessage` | A website's popup is adopted with its opener (`src/main/shell/popups.ts`); a popup into an installed app from another origin is a new tab with none, which is why the editor is a website |
| A `sandbox="allow-scripts"` frame of the page's own file | A wiki's own scripts run apart from the editor's storage | Works for a website |
| IndexedDB that survives a restart | The library | Works for a website |
| `crypto.subtle`, `CompressionStream` | CIDs, the hand-over | Secure contexts: every `.eth` and `ipfs://` page, and a developer `.eth` name through the secure-origin switch |
| `fetch` with CORS to a pinning service | Publish | Pinata and Filebase answer CORS for any origin (measured with a preflight from `https://editor.decentrawiki.eth`); free pinning answers CORS for any origin itself |

## Verdict

A target, built on TiddlyWiki as a library: no bridge, no capability, nothing missing in Orivon.
The rows it needs from orivon-mvp are in [`apps/decentrawiki/README.md`](../apps/decentrawiki/README.md)
section What it needs from orivon-mvp.
