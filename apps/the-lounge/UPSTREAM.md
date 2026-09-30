# Upstream: The Lounge

| | |
|---|---|
| Source | `https://github.com/thelounge/thelounge` |
| Pinned commit | `14590bfda615b3f3ee0ee8301a404d79a8076743` (v4.5.2) |
| Licence | MIT |

## What crosses into this repository

**Nothing of The Lounge's.** The clone lives in `out/the-lounge/source/` and everything built from
it in `out/the-lounge/static/`, both gitignored and both reproducible from
[`recipe.json`](recipe.json). `npm run check:no-upstream` fails the build if either is ever
tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json).
- [`esbuild.orivon.config.mjs`](esbuild.orivon.config.mjs), which bundles the clone's own
  TypeScript sources at build time, and [`bridge/`](bridge/), the four small modules that config
  bundles beside them: an entry, the `require` the server asks for at run time, and two modules
  that refuse a dependency by name. None holds a line of upstream's code.
- [`launcher/`](launcher/), the page that starts the server and shows what it serves. It is
  written here and is not derived from upstream's client, which is served as upstream built it.
  It is a shape of file `scripts/app-files.ts` admits only under `apps/<id>/launcher/`: hand-written
  `.html`, `.css`, `.js` and `.svg`, plus its unit tests. A port with no `site/` has no other place
  for a page of its own, and a font or an image stays refused there as it does everywhere else
  under `apps/`.

## What we never do

- **Edit The Lounge's source.** The server that runs is the one upstream ships, bundled as it is:
  the port changes where each module believes it lives (`__dirname`) and which module a builtin
  or a named dependency resolves to, never a line of what a module says.
- **Fork its build.** Upstream's own `yarn build` runs first, unmodified; the port's step runs after
  it and reads the result.

## Redistribution

This repository distributes none of The Lounge. The tree a build produces does: the client upstream
built, and the server bundled from its sources together with its npm dependencies (MIT, ISC, BSD,
Apache-2.0 and similar), orivon-mvp's Node shim (AGPL-3.0) and SQLite's WebAssembly build,
`sqlite3.wasm` (from `@sqlite.org/sqlite-wasm`, Apache-2.0). The dependencies' legal comments are
extracted to `server.mjs.LEGAL.txt` beside the bundle, and upstream's `LICENSE` is copied into the
served tree. A build served to other people is therefore a conveyed AGPL work as a whole, with
upstream's MIT notice travelling with its part.
