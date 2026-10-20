# Upstream: AirGap Vault

| | |
|---|---|
| Source | `https://github.com/airgap-it/airgap-vault` |
| Pinned commit | `5bae09fae68f1a6d53c6f363aac2529f0bd1aad3` (`v3.35.0`) |
| Licence | MIT |

The pin is a release tag rather than a branch tip: for a wallet, what upstream shipped to its own
users is the defensible thing to build.

## What crosses into this repository

**Nothing of AirGap Vault's.** The clone lives in `out/airgap-vault/source/` and the build output
in `out/airgap-vault/static/`, both gitignored and both reproducible from
[`recipe.json`](recipe.json). `npm run check:no-upstream` fails the build if either is ever
tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json)
- [`hooks.mjs`](hooks.mjs), one attribute rewrite -- see [`README.md`](README.md)'s Design notes

There is no bridge. Upstream's `electron/` directory is a vestigial Capacitor 2 wrapper with no
`contextBridge` and no named preload members; the renderer imports no `electron` and no Node
builtin. The renderer this port ships is upstream's own Electron target, unmodified except for the
one attribute `hooks.mjs` rewrites after the build.

## What we never do

- **Edit AirGap Vault's source.** This port needed zero app edits.
- **Fork its build config.** There is nothing to patch: the recipe runs upstream's own
  `build:electron:prod` script unmodified.

## Redistribution

MIT, so redistribution of a build carries only the notice requirement. This repository
distributes none of AirGap Vault in any case; a build of `out/airgap-vault/static` served to other
people is yours to ship, and upstream's copyright notice and licence text travel with it.
