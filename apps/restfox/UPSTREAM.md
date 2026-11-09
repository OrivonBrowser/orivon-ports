# Upstream: Restfox

| | |
|---|---|
| Source | `https://github.com/flawiddsouza/Restfox` |
| Pinned commit | `e776d9e3685771e5c3884e55943fd4ca0ff36767` (tag v0.42.0) |
| Licence | MIT |

## What crosses into this repository

**Nothing of Restfox's.** The clone lives in `restfox/source/` in the build folder and the build output in
`out/restfox/static/`, neither tracked and both reproducible from [`recipe.json`](recipe.json).
`npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json)
- [`bridge/members.json`](bridge/members.json), which names the 44 members of `window.electronIPC`
  and says how each is answered, and [`bridge/restfox.js`](bridge/restfox.js), which implements
  the six that carry a decision. Together they re-create the *shape* of `window.electronIPC` --
  member names and arity -- backed by the page's own `fetch` instead of IPC. They contain none of
  Restfox's code: the names are read off its call sites, which is a fact about its interface.

## What we never do

- **Edit Restfox's source.** The port needs no app edits: the renderer is Restfox's own
  `desktop-electron` build, and its preload API is already handle-free.
- **Fork its build config.** The build is the command Restfox's own scripts name
  (`build-desktop-electron` in `packages/ui/package.json`), run unchanged.

## What to re-check when the pin moves

- **The tag in `recipe.json`'s `install`.** Restfox's build reads the latest tag with
  `git describe --tags` for the version Settings shows, and a pinned-commit clone has no tags, so
  `install` fetches the pin's tag. Change the tag there to the new release's tag.
- **The `ipcFunctions` list in `packages/electron/src/preload.js`.** A name added there is a
  member `bridge/members.json` must declare (the roster test in `bridge/restfox.test.ts` lists
  them).
- **The `sendRequest` contract**: the fields of its argument and the messages
  `packages/electron/src/request.js` pushes (`head`, `data`, `end`, `bodyError`, `responseError`),
  and where `packages/ui/src/helpers.ts` (`fetchWrapper`) reads them. The bridge's
  `onRequestEvent` and `sendRequest` implement exactly that.
- **The gRPC members** in the preload (`grpc*` and `onGrpcEvent`) and how
  `packages/ui/src/utils/grpc-transport.ts` calls them: a refused member must return a rejected
  promise wherever the UI chains a `catch`, and `isGrpcAvailable` reads whether
  `window.electronIPC.grpcStartCall` is a function, so the gRPC panel is offered and says why a
  call cannot run.
- **What the page still sends on its own** (`packages/ui/src/utils/analytics.ts`, the star count in
  `App.vue`), against the manifest.

## Redistribution

This repository distributes none of Restfox, so its licence does not reach the recipe. A build of
`out/restfox/static` served to other people carries Restfox's MIT licence text: the recipe's
`extraFiles` puts it in the served tree as `/LICENSE`.
