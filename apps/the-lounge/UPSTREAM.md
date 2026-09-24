# Upstream: The Lounge

| | |
|---|---|
| Source | `https://github.com/thelounge/thelounge` |
| Pinned commit | `14590bfda615b3f3ee0ee8301a404d79a8076743` (release `v4.5.2`) |
| Licence | MIT |

## What this upstream is

A self-hosted web IRC client: a Node server that owns the IRC connections, and a Vue page it
serves. It ships no Electron app — `orivon-port recon` reads zero preloads, zero `electron`
imports, zero `ipcMain` handlers, and that is the true reading. The porting method still applies,
one level up: the page in `client/` is what gets kept, and the server is the privileged helper
Orivon replaces — with `orivon.net` raw TCP and TLS where the server had Node sockets. The full
evidence and the scope decisions are in [`docs/the-lounge-recon.md`](../../docs/the-lounge-recon.md).

## What crosses into this repository

**Nothing of The Lounge's.** The clone lives in `out/the-lounge/source/` and the build output in
`out/the-lounge/static/`, both gitignored and both reproducible from [`recipe.json`](recipe.json).
`npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json)
- [`hooks.mjs`](hooks.mjs) — the four serve-time injections upstream's own
  `server/plugins/html-config.ts` would have made into the built `index.html` (public body class,
  websocket-only transports, the theme stylesheet link, the theme colour), plus the engine script
  tag. No placeholder of theirs is answered by anything else.
- [`bridge/`](bridge/) — the in-page engine: a socket.io v4 server shim, an IRC client over
  `orivon.net`, and the translation between them and the client's events. Its wire shapes are
  reproduced from the typed contracts in upstream's `shared/types/` and the handlers in
  `server/plugins/`; none of its code is copied.
- [`docs/the-lounge-recon.md`](../../docs/the-lounge-recon.md), the reconnaissance this port was
  built from.

## What we never do

- **Edit The Lounge's source.** Nothing under `out/the-lounge/` is ever written to except its own
  build output directory, which is where the build and the engine bundle land.
- **Fork the build.** The recipe's `build.command` runs upstream's own `vite build`, unmodified —
  no wrapper config, unlike the webpack-era ports. The engine is bundled afterwards by the
  clone's own esbuild.

## Where this port differs from real The Lounge

It runs in upstream's own public mode, served without its server. Networks, credentials and
scrollbacks live for the session only; there is no login, no SQLite history and no
cross-device sync, because there is no server to keep any of it. Link previews, file uploads,
push notifications, message search and upstream's changelog checker are not built and are not
faked. [`README.md`](README.md) carries the user-facing list.

## Redistribution

This repository distributes none of The Lounge, so its MIT licence does not reach the recipe or
the engine. The licence reaches the build: `out/the-lounge/static/` is MIT work served from a
build anyone can reproduce from the pinned commit, and whoever serves it to other people carries
the licence's attribution terms with it.
