# Upstream: Fluux Messenger

| | |
|---|---|
| Source | `https://github.com/processone/fluux-messenger` |
| Pinned commit | `6ab4fa2c4d83c8d0fe3d390c824af2bf57c15f0e` (release `v0.18.2`) |
| Licence | AGPL-3.0-or-later |

## Which build this is

Fluux Messenger's desktop app is a Tauri program (a Rust shell around the system webview), not an
Electron one, so there is no Electron renderer to keep. Upstream also ships the same React
application as a static web bundle (the `-web.zip` on its releases page, which its README says any
web server can serve). This recipe builds that bundle the way upstream's own release workflow does:
`npm ci`, then `npm run build` at the repository root (the SDK package, then the app), and serves
`apps/fluux/dist`. Nothing is added to it, and no part of the Tauri program is built or used.

## What crosses into this repository

**Nothing of Fluux's.** The clone lives in `fluux/source/` in the build folder and the build output in
`out/fluux/static/`, neither tracked and both reproducible from [`recipe.json`](recipe.json).
`npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json).
- [`hooks.mjs`](hooks.mjs), which moves the one inline script in upstream's built `index.html` into
  a file (the shell's CSP admits no inline script) and writes `/SOURCE` into the served tree (the
  upstream repository, the pinned tag and commit, and this recipe), and its test.
- [`docs/fluux-recon.md`](../../docs/fluux-recon.md), the measurement the port was committed on.

## What we never do

- **Edit Fluux's source.** The clone on disk is never edited. The build runs upstream's own
  `npm run build` unmodified.
- **Fork its build.** There is no wrapper around its Vite configuration.

## Redistribution

This repository distributes none of Fluux Messenger. A tree a build produces does: upstream's
application as it built it, with upstream's `LICENSE` (the GNU AGPL, version 3) copied to `/LICENSE`
in the served tree, and a link to the source in the app's own README. A build served to other
people is a conveyed AGPL work, and the licence's network-use clause applies to whoever serves it.

## Re-check when the pin moves

- The tag and commit written in `hooks.mjs`'s `SOURCE` text.
- Whether `apps/fluux/index.html` still carries the inline `process.nextTick` script
  (`hooks.mjs` fails loudly when it does not).
- Whether the build still writes `sw.js` at the root of `apps/fluux/dist`, and whether `registerServiceWorker` (`apps/fluux/src/utils/serviceWorkerUpdate.ts`) still waits for `load` while `apps/fluux/src/boot.ts` still imports `main` after it.
- Whether upstream has started to ship an Electron build (this recipe would then build that
  renderer instead).
- Whether an encrypted attachment is still fetched with `fetch` and saved from a `blob:` link
  (`apps/fluux/src/utils/mediaCache.ts`, `apps/fluux/src/utils/download.ts`).
