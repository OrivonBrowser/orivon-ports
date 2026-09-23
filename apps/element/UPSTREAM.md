# Upstream: Element

| | |
|---|---|
| Source | `https://github.com/element-hq/element-web` (Element Desktop lives at `apps/desktop` in this same monorepo -- the standalone `element-hq/element-desktop` repository is archived and now just points here) |
| Pinned commit | `2d90d6b7b601ecb9ccdf81239a43b4396b4b0c9e` (release `v1.12.29`) |
| Licence | AGPL-3.0-only (upstream is dual/triple-licensed AGPL-3.0-only OR GPL-3.0-only OR a commercial licence; most files that this build actually exercises carry only the AGPL-or-commercial pair, so AGPL is the governing term here) |

## What "Desktop" means for this port

Element Desktop's own renderer is, byte for byte, the `apps/web` webpack build packed into an
asar next to a `config.json` -- desktop's release pipeline does exactly that, nothing more. So
this recipe builds `apps/web` the same way desktop's own CI does
(`pnpm --dir apps/web build`), and [`bridge/element.js`](bridge/element.js) supplies
`window.electron` in place of `apps/desktop/src/preload.cts`, which is what actually makes the
build run the desktop code path (`ElectronPlatform`) instead of the plain web one.

## What crosses into this repository

**Nothing of Element's.** The clone lives in `out/element/source/` and the build output in
`out/element/static/`, both gitignored and both reproducible from
[`recipe.json`](recipe.json). `npm run check:no-upstream` fails the build if either is ever
tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json)
- [`bridge/members.json`](bridge/members.json), which declares `window.electron`'s five members
  and refuses two of them by name, and [`bridge/element.js`](bridge/element.js), which implements
  the three that carry a decision: `on`, `send` and `initialise`. Together they re-create the
  *shape* of `window.electron` -- its members, the 19-channel allowlist `apps/desktop/src/
  preload.cts` forwards, and the `ipcCall`/`seshat` names `apps/desktop/src/ipc.ts` and
  `seshat.ts` answer -- backed by web platform APIs instead of Electron IPC. The names and the
  answers upstream gives for a build with Seshat absent are read off its source; none of its code
  is copied.
- [`docs/element-recon.md`](../../docs/element-recon.md), the reconnaissance this port was built
  from.

## What we never do

- **Edit Element's source.** Nothing under `out/element/` is ever written to.
- **Fork the build.** The recipe's `build.command` runs upstream's own `pnpm --dir apps/web
  build`, unmodified. There is no wrapper config to keep in sync with upstream's own.

## Where this port differs from real Element Desktop

**The access-token and message-encryption ("pickle") key sits in this app's own IndexedDB,
exactly where Element Web already keeps it, rather than in the operating system's keyring.**
Electron Desktop encrypts that key with Electron's `safeStorage`, backed by the OS keychain;
Orivon has no equivalent capability for an app today. [`README.md`](README.md)'s "Differs from
Element Desktop" section says what this means in practice and links the orivon-mvp hand-off for
building that capability.

## Redistribution

This repository distributes none of Element, so its AGPL obligations do not reach the recipe.
They do reach anything built from it: a build of `out/element/static` served to other people is a
conveyed AGPL work, and the licence's network-use clause (via the AGPL, not a separate SaaS
clause) applies to whoever serves it.
