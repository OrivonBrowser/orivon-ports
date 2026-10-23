# Upstream: Super Productivity

| | |
|---|---|
| Source | `https://github.com/super-productivity/super-productivity` |
| Pinned commit | `466a426700e7402f8628bc80ce499d3de6160dbb` (release `v19.2.0`) |
| Licence | MIT |

## What "Electron" means for this port

Super Productivity's desktop renderer is, byte for byte, the Angular build its web app is made of:
`npm run buildFrontend:prod:es6` (`ng build --configuration production`) is what the Electron
packaging step takes its `index.html` from, and the web release differs only by output folder. What
makes that build the *desktop* app is a run-time decision in `src/app/app.constants.ts`:
`navigator.userAgent` contains ` electron/` and `window.ea` exists. This recipe builds the renderer
with upstream's own script, and [`bridge/superproductivity.js`](bridge/superproductivity.js) and
[`bridge/members.json`](bridge/members.json) supply both halves of that decision inside Orivon, in
place of `electron/preload.ts` and the main process.

## What crosses into this repository

**Nothing of Super Productivity's.** The clone lives in `out/superproductivity/source/` and the
build output in `out/superproductivity/static/`, both gitignored and both reproducible from
[`recipe.json`](recipe.json). `npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json)
- [`bridge/members.json`](bridge/members.json), which names the 73 members of `window.ea` and says
  how each is answered, and [`bridge/superproductivity.js`](bridge/superproductivity.js), which
  implements the five that carry a decision, adds the Electron token to the user agent and guards
  against a second tab. They re-create the *shape* of `window.ea`: member names and arity read off
  `electron/electronAPI.d.ts` and the renderer's call sites, backed by the page instead of IPC.
  None of upstream's code is copied.
- [`hooks.mjs`](hooks.mjs), which edits the built `index.html` so that one inline script runs from a
  file and a stylesheet loses its `onload` handler, and writes one static page beside the app. The
  script's bytes come from `out/`; none are written here.

## What we never do

- **Edit Super Productivity's source.** The port needs zero app edits; that is what keeps it
  repeatable against the next release.
- **Fork its build.** The recipe runs upstream's own `buildFrontend:prod:es6` script.
- **Ship its secrets.** The build sets none of the optional keys `tools/load-env.js` reads (Dropbox,
  OneDrive, Google Drive, Unsplash). The sync dialog still lists Dropbox and OneDrive; a provider that
  needs one of those keys is not expected to work.

## Redistribution

This repository distributes none of Super Productivity, so its MIT notice does not reach the recipe.
A built tree is a copy of an MIT work: it carries upstream's licence text as `/LICENSE`
(`extraFiles` in the recipe), and each copy keeps it.

## When the pin moves

Re-read `electron/preload.ts` at the new commit against `bridge/members.json` (a new member is
invisible to `orivon-port recon --emit`), check `src/app/app.constants.ts` still decides
`IS_ELECTRON` from the user agent and `window.ea`, and check `src/index.html` still has exactly one
inline script and the `media="print"` stylesheet pattern (`hooks.mjs` throws when it does not).
