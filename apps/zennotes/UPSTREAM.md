# Upstream: ZenNotes

| | |
|---|---|
| Source | `https://github.com/ZenNotes/zennotes` |
| Pinned commit | `9e2c651c9bddd9dd71dcbd161a4018ce102d96cd` (tag `v2.74.0`) |
| Licence | MIT |

## What crosses into this repository

**Nothing of ZenNotes'.** The clone lives in `out/zennotes/source/` and everything built from it in
`out/zennotes/static/`, both gitignored and both reproducible from [`recipe.json`](recipe.json).
`npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) and [`hooks.mjs`](hooks.mjs).
- [`esbuild.orivon.config.mjs`](esbuild.orivon.config.mjs), which bundles upstream's own preload and
  the main-process modules that read and write notes, at build time.
- [`bridge/`](bridge/): the build's decisions as pure functions (`build-plan.js`, with its tests),
  the answers to the preload's calls (`main-process.js`, `vault-calls.js`, `channels.js`, `ipc-kit.js`
  and `session.js`), the page's entry (`page-entry.js`, `register.js`, `env.js`, `host.js`, `assets.js`, `state.js`) and the
  modules that stand in for a dependency (`electron.js`, `no-watch.js`). None holds a line of
  upstream's code.

## What we never do

- Edit the app's source. A port that patches upstream cannot be repeated against its next release.
- Fork its build. Upstream's own `electron-vite build` runs as it is; the port adds one bundle beside
  its output.

## Distributing a build

A build served to other people carries ZenNotes' code and its dependencies' code under their
licences. Upstream is MIT; `/LICENSE` is copied from the clone into every build, and esbuild writes
the dependencies' notices to `orivon/zennotes.js.LEGAL.txt` beside the bundle.

## When the pin moves

The build fails when upstream's preload sends a channel nothing in `bridge/` names
(`build-plan.js`, `unansweredChannels`), and the bundle fails to start when a channel `bridge/` names is
no longer in `packages/bridge-contract/src/ipc.ts`. Then check that `apps/desktop/src/main/vault.ts`
still exports every function `bridge/vault-calls.js` calls.
