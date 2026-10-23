# Upstream: Actual Budget

| | |
|---|---|
| Source | `https://github.com/actualbudget/actual` |
| Pinned commit | `2bebdbaae0b701120a8cad9d56aafd64fa04c577`, the tag `v26.10.0` (see `upstream.ref` in [`recipe.json`](recipe.json)) |
| Licence | MIT (`LICENSE.txt` in the upstream tree, served at `/LICENSE`) |

## What crosses into this repository

**Nothing of theirs.** The clone lives in `out/actualbudget/source/` and the build output in
`out/actualbudget/static/`, both gitignored and both reproducible from `recipe.json`.
`npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch: the recipe, the manifest, the build wrapper
(`esbuild.orivon.config.mjs`), the HTML hook, and the files in `bridge/`. The bridge re-creates the
*shape* of the app's own preload API (member names and arity) and contains none of its code. The
backend that runs in the app is upstream's own `bundle.desktop.js`, built by upstream's scripts and
bundled unchanged with `bridge/server-entry.js`.

## What to re-check when the pin moves

- `ACTUAL_VERSION` in `bridge/plan.js` and in `bridge/actualbudget.js`, and `version` in
  `orivon.json`: the build compares the first with `packages/desktop-electron/package.json`.
- The members of `window.Actual` in `packages/desktop-electron/preload.ts` against
  `bridge/members.json` and the roster in `bridge/actualbudget.test.ts`.
- `packages/desktop-electron/server.ts` and `packages/loot-core/src/platform/server/` (`fs`,
  `sqlite`, `connection`, `fetch`): the backend's entry, the five SQL functions it registers, its
  export, the files it reads beside its bundle.
- `packages/desktop-electron/bin/package-electron` and `bin/update-client`: the build steps and
  what is removed from the renderer.
- `packages/loot-core/migrations`: the install tree copies them by name.

## What we never do

- Edit the app's source. A port that patches upstream cannot be repeated against its next
  release, which is the property that makes a port worth having.
- Fork its build config. Wrap it.
