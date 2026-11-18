# Upstream: 5chan

| | |
|---|---|
| Source | `https://github.com/bitsocialnet/5chan` |
| Pinned commit | `40ebfcebdfb4b4cac18e8e728d8c8a0cc997694d` (package version `0.10.4`) |
| Licence | GPL-3.0-or-later |

## What "Electron" means for this port

5chan's desktop renderer is, byte for byte, the Vite build its web app is made of: `vite build` with
`PUBLIC_URL=./` is the step `electron:build` runs before Electron's packager takes the folder. What
makes that build the *desktop* app is a run-time decision: the page tests `window.isElectron` and
`window.electronApi` (`src/lib/p2p-browser-config.ts`), and with them present it talks to a
Bitsocial node over a WebSocket RPC instead of running libp2p in the page. `electron/preload.mjs` sets
the four window values and the members of the bridge objects; the node itself is a process
`electron/main.js` starts. This recipe builds the renderer with upstream's own script, and
[`bridge/5chan.js`](bridge/5chan.js) and [`bridge/members.json`](bridge/members.json) supply the preload's
half inside Orivon. The node is the one `apps/bitsocial-node` builds, started by the page
([`bridge/node-start.js`](bridge/node-start.js)) in the place of `electron/main.js`'s.

## What crosses into this repository

**Nothing of 5chan's.** The clone lives in `5chan/source/` in the build folder and the build output in
`out/5chan/static/`, neither tracked and both reproducible from [`recipe.json`](recipe.json).
`npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json)
- [`bridge/members.json`](bridge/members.json) and [`bridge/5chan.js`](bridge/5chan.js), which re-create the
  *shape* of what `electron/preload.mjs` exposes: nine members of `window.electronApi`, backed by the page instead of IPC.
  None of upstream's code is copied.
- [`hooks.mjs`](hooks.mjs), which edits the built `index.html` so that its six inline scripts run
  from files, holds the bundle's module entry until the node answers, and writes the node dashboard page
  beside the app. The scripts' bytes come from `out/`; none are written here, except the redirect, which is
  written again (see the README's Design notes).
- [`bridge/node-start.js`](bridge/node-start.js) and [`bridge/node-dashboard.js`](bridge/node-dashboard.js), which start
  the node, answer the page's calls to the desktop's kubo port from it, and draw its numbers.
- [`build/fetch-node-bundle.mjs`](build/fetch-node-bundle.mjs) and [`build/node-bundle-pin.mjs`](build/node-bundle-pin.mjs),
  which copy the node's own build output (not 5chan's) into the served tree, each file checked by hash.

## What we never do

- **Edit 5chan's source.** The port needs zero app edits; that is what keeps it repeatable against the
  next release.
- **Fork its build.** The recipe runs upstream's own `vite build`, skipping `refresh:generated`'s `sync:directories`, which fetches the board lists from GitHub: the lists are committed in `src/data/5chan-directories/` at the pin, and the build uses those.
- **Ship its secrets.** The build sets none of the optional keys the app's scripts read.

## Redistribution

This repository distributes none of 5chan, so its GPL obligations do not reach the recipe. They do
reach anything built from it: a build of `out/5chan/static` that is given to other people is a conveyed
GPL work. It carries upstream's licence text as `/LICENSE` (`extraFiles` in the recipe), the
corresponding source is upstream's repository at the pinned commit above, and each copy keeps both.

## When the pin moves

Re-read `electron/preload.mjs` at the new commit against `bridge/members.json` (a new member is
invisible to `orivon-port recon --emit`), check `src/lib/p2p-browser-config.ts` still decides the runtime
from `isElectron` and `electronApi.isElectron`, and check the built `index.html` still has exactly
six inline scripts, one of them the `/#` redirect (`hooks.mjs` throws when it does not).
