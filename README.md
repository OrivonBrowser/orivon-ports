# orivon-ports

**Somebody else's desktop app, running as an Orivon app, without forking it.**

An Electron application is two programs: a web page, and a privileged helper that does what a
web page is not allowed to do. Orivon takes the helper's place and grants those powers to the
page directly, per app, with the user's consent. This repository is how an app gets from
"someone's desktop program" to "a URL you can open".

A port here is **never a fork**. It is a recipe, a manifest, and one bridge file. The app's own
source is cloned at a pinned commit, built by its own toolchain, and never committed.

## Try it

```bash
npm install
npm run doctor              # is this machine able to build and serve?
node src/cli.ts run freetube
```

That clones FreeTube at the commit [`apps/freetube/recipe.json`](apps/freetube/recipe.json)
pins, builds it, and serves it on `http://127.0.0.1:8875`. Open that URL in Orivon and accept
the prompt.

### Opening it by name instead of by port

```bash
node src/cli.ts names
```

writes `out/names.json` — every declared app's fake `.eth` name mapped to its port, e.g.
`{"freetube.eth": 8875}`. It resolves nothing real; see
[`docs/recipe-format.md`](docs/recipe-format.md)'s `eth` field for what it is and is not.
`serve` and `run` rewrite the same files from every recipe before their servers start, so a new
or changed `eth` name needs no separate step.

**The shell only honours it if it is told to**, with one environment variable set *before*
`npm run dev` (in `orivon-mvp`, not here):

```bash
ORIVON_ETH_NAMES_FILE=/absolute/path/to/orivon-ports/out/names.json npm run dev
```

`npm run dev` already sets `ORIVON_DEV_ORIGINS=1` for you; `npm start` does not, and needs it set
alongside `ORIVON_ETH_NAMES_FILE`. With neither set, typing `freetube.eth` is indistinguishable
from typing any other unregistered name — it will not reach this repository's server, and on a
machine where `.eth` happens to resolve to something else, it will silently land there instead.
Restart the shell whenever a port's `eth` name or port changes: the files are rewritten on every
`serve` and `run`, but the shell reads the map once, at its own startup, and watches nothing.

There is no build step for this repository itself — Node runs the TypeScript directly.

## The commands

```
orivon-port run <app>          fetch, build and serve it  (the one command)
orivon-port fetch <app>        clone upstream at the pinned commit
orivon-port build <app>        run the app's own build, then prepare the static tree
orivon-port serve <app>...     serve already-built apps, each on its own port   (--all for every app)
orivon-port test <app>         run the app's bridge tests
orivon-port list               what exists, what is fetched, what is built
orivon-port new <app> [name]   scaffold a new port
orivon-port recon <clone>      measure somebody's app before committing to porting it
orivon-port names              write a name→port map + PAC for every app.eth
orivon-port doctor             check this machine can build and serve
```

`npm link` puts `orivon-port` on your PATH; without it, `node src/cli.ts <command>` is the same
thing.

## Where things are

```
src/          the executor: fetch, build, prepare, serve, scaffold, recon
apps/<app>/   one directory per app: a port's recipe, manifest, bridge and build wrapper,
              or a recipe, a manifest and a site/ written here
out/<app>/    the cache. source/ is their clone, static/ is what it built.
              Never committed, always reproducible from the recipe.
docs/         the porting guide, the recipe format, and the port candidates
```

## Porting something

1. **`orivon-port recon <path-to-their-clone>`** — before committing to an app. It answers the
   one question that separates a cheap port from an open-ended one: does the app's preload
   expose named members, or a single generic forwarder?
2. **`orivon-port new <id>`** — scaffolds the recipe, the manifest, a bridge skeleton and its
   test.
3. Fill in the recipe, write the bridge, run it.

[`docs/porting-guide.md`](docs/porting-guide.md) is the method in full;
[`docs/recipe-format.md`](docs/recipe-format.md) is every field.
[`apps/freetube/`](apps/freetube/) is the worked example, and every number in the guide is
measured there.

## What never enters this repository

No third-party source, no third-party build output, no patches against either. Each port states
its pin and its licence in its own `UPSTREAM.md`, and `npm run check:no-upstream` fails the build
if anything else appears under `apps/`.

This matters beyond tidiness: the apps worth porting are often copyleft, and a repository that
distributes none of their code takes on none of their distribution obligations. A build you serve
to other people is a different question, and that one is yours —
[`apps/freetube/UPSTREAM.md`](apps/freetube/UPSTREAM.md) spells out the shape of it.

## Building somebody's app runs their code

`orivon-port build` runs the app's own install and build scripts on your machine, with your
privileges. There is no way to build an app without running its toolchain. That is why every
recipe pins a commit rather than a branch, and why [`SECURITY.md`](SECURITY.md) says so out loud
rather than leaving it implied.

## Licence

AGPL-3.0-only, the same as the Orivon shell. See [`LICENSE`](LICENSE).
