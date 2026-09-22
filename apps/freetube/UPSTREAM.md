# Upstream: FreeTube

| | |
|---|---|
| Source | `https://github.com/FreeTubeApp/FreeTube` |
| Pinned commit | `e910be68e49015a61af9d6de71632ae3bfc65ba0` (v0.25.3) |
| Licence | AGPL-3.0-or-later |

## What crosses into this repository

**Nothing of FreeTube's.** The clone lives in `out/freetube/source/` and the build output in
`out/freetube/static/`, both gitignored and both reproducible from
[`recipe.json`](recipe.json). `npm run check:no-upstream` fails the build if either is ever
tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json)
- [`webpack.orivon.config.cjs`](webpack.orivon.config.cjs), which `require`s upstream's own
  `_scripts/webpack.web.config.js` at build time and patches the objects it returns
- [`bridge/members.json`](bridge/members.json), which names the 34 members of `window.ftElectron`
  and says how each is answered, and [`bridge/ft-electron.js`](bridge/ft-electron.js), which
  implements the two that carry a decision. Together they re-create the *shape* of
  `window.ftElectron` -- 34 member names and their arity -- backed by `orivon.*` instead of IPC.
  They contain none of FreeTube's code: the names are read off its call sites, which is a fact
  about its interface rather than a copy of its implementation.

## What we never do

- **Edit FreeTube's source.** The port needed zero app edits, and that is the property that makes
  it repeatable against the next release. It was luck rather than design: FreeTube's own preload
  API is already handle-shaped, so nothing had to be re-designed around opaque handles.
- **Fork its build config.** [`webpack.orivon.config.cjs`](webpack.orivon.config.cjs) requires
  upstream's and patches it, with an assertion per patch that fails loudly if upstream's config
  changes shape.

## Redistribution

This repository distributes none of FreeTube, so its AGPL obligations do not reach the recipe.
They do reach anything built from it: a build of `out/freetube/static` served to other people is
a conveyed AGPL work, and the licence's network clause applies to whoever serves it.
