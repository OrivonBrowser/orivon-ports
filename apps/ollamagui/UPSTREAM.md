# Upstream: Ollama GUI

| | |
|---|---|
| Source | `https://github.com/HelgeSverre/ollama-gui` |
| Pinned commit | `b79a7b8ca537037d1985c69109260ff540b88170` (`v2.0.5`) |
| Licence | MIT |

The pin is the release tag `v2.0.5`, which is also the tip of the default branch. The project
publishes no release assets, so the build is made from the source at the tag.

## What crosses into this repository

**Nothing of Ollama GUI's.** The clone lives in `out/ollamagui/source/` and the build output in
`out/ollamagui/static/`, both gitignored and both reproducible from [`recipe.json`](recipe.json).
`npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch: [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json).
There is no bridge: the app has no Electron preload and no `ipcMain`, so it asks `orivon.*` for
nothing but a network grant.

## What we never do

- Edit the app's source. This port needed zero app edits; the one build option it passes
  (`--base ./`) is Vite's own flag.
- Fork its build config. The recipe runs upstream's own `build` script.

## Redistribution

MIT, so a served build carries upstream's copyright notice and licence text. The recipe copies
`LICENSE.md` to `/LICENSE` in the served tree.

## What to re-check when the pin moves

- `src/ollama/client.ts` `resolveHost()`: the default host must still be `http://localhost:11434`, or
  the manifest's `localhost:11434` stops covering it.
- That `bun.lock` is still read by a `bun` of the version the recipe names.
- That `vite build --base ./` still leaves no root-absolute URL in `index.html`.
