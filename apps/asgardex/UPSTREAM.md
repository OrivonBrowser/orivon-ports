# Upstream: ASGARDEX

| | |
|---|---|
| Source | `https://github.com/asgardex/asgardex-desktop` |
| Pinned commit | `bc7b037d9875e6cfb1721bea577a16f72e1e02ea` (v1.45.3) |
| Licence | MIT |

`asgardex/asgardex-desktop` is the maintained continuation of `thorchain/asgardex-electron`,
which is archived. The pin is a release tag rather than a branch tip: for a wallet, what upstream
shipped to its own users is the defensible thing to build.

## What crosses into this repository

**Nothing of ASGARDEX's.** The clone lives in `out/asgardex/source/` and the build output in
`out/asgardex/static/`, both gitignored and both reproducible from [`recipe.json`](recipe.json).
`npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json)
- [`bridge/members.json`](bridge/members.json), which names the fourteen globals upstream's
  preload exposes and says why each of the sixty-nine members is answered the way it is
- [`bridge/asgardex.js`](bridge/asgardex.js), the forty members that carry a decision rather than
  a shape. It re-creates the *shape* of upstream's preload API — member names and arity — over
  `orivon.*`, and contains none of ASGARDEX's code.

There is no build wrapper. Upstream's own `electron-vite` renderer target is the target this port
wants, so the recipe runs upstream's own `build` script unmodified.

## What this port copies rather than re-creates

[`bridge/asgardex.js`](bridge/asgardex.js) carries `STORE_DEFAULTS`, a snapshot of upstream's own
`DEFAULT_STORAGES` (`src/shared/const.ts` at the pinned commit) — one entry per JSON store, seven
in total. It is configuration, not program text, and it is here because the renderer cannot supply
it — see [`README.md`](README.md)'s Design notes for what a store without it costs. Every entry
was **evaluated from upstream's own source, never transcribed by hand**, with this command, run
from the clone:

```bash
cd out/asgardex/source && ./node_modules/.bin/esbuild --bundle --format=cjs --platform=node \
  --loader:.wasm=binary --define:import.meta.env='{}' --log-level=error <<'EOF' > /tmp/d.cjs
export { DEFAULT_STORAGES as d } from './src/shared/const.ts'
EOF
node -e "const {d}=require('/tmp/d.cjs');for (const k of Object.keys(d)) console.log(k, JSON.stringify(d[k]))"
```

`--loader:.wasm=binary` gets past the Cardano serialization lib upstream's import graph pulls in;
`--define:import.meta.env='{}'` gets past `envOrDefault`'s `VITE_*` reads.

**Re-evaluate whenever `upstream.ref` moves, but the risk is not even across the seven:**

| Store | What can change | Cost of staleness |
|---|---|---|
| `common` | fourteen live endpoint URLs | High — a retired endpoint, silently |
| `userChains` | which chains are enabled | High — a chain upstream newly enables reads as user-disabled. The bug this port shipped with |
| `userAssets` | list membership; `AssetType.TOKEN`'s numeric ordinal | Medium — contract addresses don't move, the enum value can |
| `userNodes`, `userBondProviders`, `userAddresses`, `pools` | `version` only | Near zero — a one-glance diff |

`bridge/asgardex.test.ts` pins both the `common` key set and every store's `version`, so a field or
version added upstream fails a test rather than going missing at runtime; it cannot catch a changed
*value*, and only re-evaluating can.

**One divergence the bridge does not correct.** Upstream stores each file as
`<name>-<version>.json` (`src/main/utils/file.ts`'s `buildJsonFilePath`) and bumps the version
specifically to abandon a file whose shape it no longer wants. This bridge stores `<name>.json`,
with no version in the path, so a `StorageVersion` bump upstream would have this bridge keep
merging a file upstream would have discarded. Left as-is: it is a `getFilePath` concern, separate
from the `getFileContent` contract this port just fixed, and it only matters at a version bump —
which the table above already grades and the version pin above already catches. Encode the version
into the path then, not before.

**The bridge does not seed the file on first read.** Upstream's `getFileContent` writes the default
to disk before returning it; this bridge only resolves the default. Safe, because nothing in the
renderer calls a store's `exists()` to notice the difference (`grep -rn '\.exists()' src/renderer`
at the pinned commit is empty).

## What we never do

- **Edit ASGARDEX's source.** This port needed zero app edits. Upstream keeps host paths inside
  its main process — `load` resolves parsed JSON and the two export members resolve void — so
  nothing had to be re-designed around opaque handles.
- **Fork its build config.** There is nothing to patch: the recipe calls upstream's own build.

## Redistribution

MIT, so redistribution of a build carries only the notice requirement. This repository distributes
none of ASGARDEX in any case; a build of `out/asgardex/static` served to other people is yours to
ship, and upstream's copyright notice and licence text travel with it.
