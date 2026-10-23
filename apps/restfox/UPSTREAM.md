# Upstream: Restfox

| | |
|---|---|
| Source | `https://github.com/flawiddsouza/Restfox` |
| Pinned commit | `0fffd36d2f95dc6c5efd890469f2f1a6433ff433` (tag v0.41.0) |
| Licence | MIT |

## What crosses into this repository

**Nothing of Restfox's.** The clone lives in `out/restfox/source/` and the build output in
`out/restfox/static/`, both gitignored and both reproducible from [`recipe.json`](recipe.json).
`npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json)
- [`bridge/members.json`](bridge/members.json), which names the 35 members of `window.electronIPC`
  and says how each is answered, and [`bridge/restfox.js`](bridge/restfox.js), which implements
  the five that carry a decision. Together they re-create the *shape* of `window.electronIPC` --
  member names and arity -- backed by the page's own `fetch` instead of IPC. They contain none of
  Restfox's code: the names are read off its call sites, which is a fact about its interface.

## What we never do

- **Edit Restfox's source.** The port needs no app edits: the renderer is Restfox's own
  `desktop-electron` build, and its preload API is already handle-free.
- **Fork its build config.** The build is the command Restfox's own scripts name
  (`build-desktop-electron` in `packages/ui/package.json`), run unchanged.

## What to re-check when the pin moves

- **The tag in `recipe.json`'s `install`.** Restfox's build reads the latest tag with
  `git describe --tags` for the version Settings shows, and a pinned-commit clone has no tags, so
  `install` fetches the pin's tag. Change `v0.41.0` there to the new release's tag.
- **The `ipcFunctions` list in `packages/electron/src/preload.js`.** A name added there is a
  member `bridge/members.json` must declare (the roster test in `bridge/restfox.test.ts` lists
  them).
- **The `sendRequest` contract in `packages/electron/src/request.js`** (the fields of its
  argument and of the `response` it returns) and where `packages/ui/src/helpers.ts` reads them.
- **What the page still sends on its own** (`packages/ui/src/utils/analytics.ts`, the star count in
  `App.vue`), against the manifest.

## Redistribution

This repository distributes none of Restfox, so its licence does not reach the recipe. A build of
`out/restfox/static` served to other people carries Restfox's MIT licence text: the recipe's
`extraFiles` puts it in the served tree as `/LICENSE`.
