# Upstream: WebTorrent Desktop

| | |
|---|---|
| Source | `https://github.com/webtorrent/webtorrent-desktop` |
| Pinned commit | `6c91af345d4bd62603d7063ea02a50394d64af0d` (the master branch after 0.24.0, with its Electron 27 upgrade and a lockfile) |
| Licence | MIT |

The pin is master, not the 0.24.0 tag: the tag has no lockfile and asks for `webtorrent >=0.108.6`,
so it cannot be rebuilt the same way twice.

## What crosses into this repository

**Nothing of WebTorrent Desktop's.** The clone lives in `out/webtorrent/source/` and everything
built from it in `out/webtorrent/static/`, both gitignored and both reproducible from
[`recipe.json`](recipe.json). `npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json).
- [`esbuild.orivon.config.mjs`](esbuild.orivon.config.mjs), which bundles the clone's own Babel output
  at build time, and [`bridge/`](bridge/): the build's decisions as pure functions
  (`build-plan.js`, with its tests), the page's entry (`page-entry.js`, `install.js`), the stand-in
  for upstream's main process (`main-process.js`, `remote.js`, `electron.js`, `context-menu.js`,
  `files.js`), and the modules that answer for a dependency (`application-config-path.js`,
  `no-cast-devices.js`, `no-local-discovery.js`). None holds a line of upstream's code.

## What we never do

- Edit the app's source. A port that patches upstream cannot be repeated against its next release.
- Fork its build. Upstream's own `npm run build` (Babel) runs as it is; the bundle is made from its
  output.

## Distributing a build

A build served to other people carries WebTorrent Desktop's code and its dependencies' code under
their licences. Upstream is MIT; `orivon-dist/LICENSE` is copied from the clone into every build, and
esbuild writes the dependencies' notices to `webtorrent-desktop.js.LEGAL.txt` beside the bundle.
