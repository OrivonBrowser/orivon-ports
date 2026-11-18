# Upstream: seedit

| | |
|---|---|
| Source | `https://github.com/bitsocialnet/seedit` |
| Pinned commit | `546cf6797a52ad763f9fc61d4ef5f4419de922cb` (package version `0.6.3`) |
| Licence | GPL-3.0-or-later |

## What "Electron" means for this port

seedit's desktop renderer is, byte for byte, the Vite build its web app is made of: `vite build` with
`PUBLIC_URL=./` is the step `electron:build` runs before Electron's packager takes the folder. What
makes that build the *desktop* app is a run-time decision: the page tests `window.isElectron` and
`window.electronApi` (`src/lib/p2p-browser-config.ts`), and with them present it talks to a
Bitsocial node over a WebSocket RPC instead of running libp2p in the page. `electron/preload.mjs` sets
the four window values and the members of the bridge objects; the node itself is a process
`electron/main.js` starts. This recipe builds the renderer with upstream's own script, and
[`bridge/seedit.js`](bridge/seedit.js) and [`bridge/members.json`](bridge/members.json) supply the preload's
half inside Orivon. The node is the one `apps/bitsocial-node` builds, started by the page
([`bridge/node-start.js`](bridge/node-start.js)) in the place of `electron/main.js`'s.

## What crosses into this repository

**Nothing of seedit's.** The clone lives in `seedit/source/` in the build folder and the build output in
`out/seedit/static/`, neither tracked and both reproducible from [`recipe.json`](recipe.json).
`npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json)
- [`bridge/members.json`](bridge/members.json) and [`bridge/seedit.js`](bridge/seedit.js), which re-create the
  *shape* of what `electron/preload.mjs` exposes: two members of `window.electron` and eleven of `window.electronApi`, backed by the page instead of IPC.
  None of upstream's code is copied.
- [`bridge/webview-upload.js`](bridge/webview-upload.js) and [`bridge/webview-embeds.js`](bridge/webview-embeds.js): the upload
  steps, selectors, messages and timeouts follow what `electron/media-upload-recipes.js` does in its hidden window (the
  recipes are data of upstream's behaviour, written here again as plain selector lists); the metadata removal is written
  from the JPEG, PNG and WebP container formats. Neither file holds any of seedit's code.
- [`hooks.mjs`](hooks.mjs), which edits the built `index.html` so that its two inline scripts run
  from files, holds the bundle's module entry until the node answers, and writes the node dashboard page
  beside the app. The scripts' bytes come from `out/`; none are written here, except the redirect, which is
  written again (see the README's Design notes). It also makes one text edit in a built script, the first
  state of the hook that reports the RPC connection (see the README's Design notes, "The create-community
  page"): a match written here, applied to `out/`, never a copy of upstream's code.
- [`bridge/node-start.js`](bridge/node-start.js) and [`bridge/node-dashboard.js`](bridge/node-dashboard.js), which start
  the node, answer the page's calls to the desktop's kubo port from it, and draw its numbers.
- [`build/fetch-node-bundle.mjs`](build/fetch-node-bundle.mjs) and [`build/node-bundle-pin.mjs`](build/node-bundle-pin.mjs),
  which copy the node's own build output (not seedit's) into the served tree, each file checked by hash.

## What we never do

- **Edit seedit's source.** The port needs zero source edits; that is what keeps it repeatable against the
  next release. The one edit it makes is to the built code, and it fails the build when upstream's code no
  longer has the shape it matches.
- **Fork its build.** The recipe runs upstream's own `vite build` with its own `build` environment.
- **Ship its secrets.** The build sets none of the optional keys the app's scripts read.

## Redistribution

This repository distributes none of seedit, so its GPL obligations do not reach the recipe. They do
reach anything built from it: a build of `out/seedit/static` that is given to other people is a conveyed
GPL work. It carries upstream's licence text as `/LICENSE` (`extraFiles` in the recipe), the
corresponding source is upstream's repository at the pinned commit above, and each copy keeps both.

## When the pin moves

Re-read `electron/preload.mjs` at the new commit against `bridge/members.json` (a new member is
invisible to `orivon-port recon --emit`), check `src/lib/p2p-browser-config.ts` still decides the runtime
from `isElectron` and `electronApi.isElectron`, and check the built `index.html` still has exactly
two inline scripts, one of them the `/#` redirect, and the built scripts still have exactly one `usePkcRpcSettings` hook starting in `initializing` and exactly one effect on `createdCommunity` (`hooks.mjs` throws when they do not). Read `src/views/community-settings/community-settings.tsx`: when the page no longer sends the person home from its first effect, the first edit can go; when the effect on `createdCommunity` no longer lists `subscribe` (or `useSubscribe` keeps one function between renders), the second can.
Compare `electron/media-upload-recipes.js` with the recipe table of `bridge/webview-upload.js` (upload address, file
input, submit and result selectors, timeouts), and every `<iframe>` of `src/components/embed/embed.tsx` with
`EMBED_ORIGINS` and `WIDGET_SCRIPTS` of `bridge/webview-embeds.js` and with `web.embed.origins` in `orivon.json`
(`bridge/grants.test.ts` fails when the last two differ).
