# `apps/freetube/`: upstream FreeTube, unmodified, as an Orivon app

**What lives here.** A recipe, a manifest, a build wrapper, and the bridge that lets upstream's
own **Electron renderer** run as an Orivon app: `window.ftElectron` rebuilt over `orivon.*`.
**No FreeTube source and no FreeTube build output is in this repository** -- it is
AGPL-3.0-or-later and it lives in `out/freetube/`, which is gitignored
([`UPSTREAM.md`](UPSTREAM.md)).

**What this measures.** Somebody else's real application, built by its own toolchain, with the
manifest, the discovery hint and a bridge script added and **nothing else changed**: how much of
a third-party app works when the only thing done for it is granting its URL the network and
standing in for the Electron main process it expects.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Where upstream is, at which commit, and how to build it |
| [`orivon.json`](orivon.json) | The manifest, including `web.contexts: ["https://www.youtube.com"]` -- see [How `generatePoToken` uses `web.context`](#how-generatepotoken-uses-webcontext) |
| [`webpack.orivon.config.cjs`](webpack.orivon.config.cjs) | Our build wrapper, which requires upstream's own web config and patches it |
| [`bridge/members.json`](bridge/members.json) | 32 of the 34 `window.ftElectron` members upstream's renderer calls, each with the reason it is answered the way it is |
| [`bridge/ft-electron.js`](bridge/ft-electron.js) | The other 2: `generatePoToken` and `getNavigationHistory`, the ones carrying a decision |
| [`bridge/ft-electron.test.ts`](bridge/ft-electron.test.ts) | The roster and the two hand-written members -- see [Testing the bridge](#testing-the-bridge) |
| [`UPSTREAM.md`](UPSTREAM.md) | The pin, the licence, and what never crosses into this repository |

## Setting it up

```bash
orivon-port run freetube
```

That is the whole thing: it clones FreeTube at the commit `recipe.json` pins into
`out/freetube/source`, runs upstream's own build through
[`webpack.orivon.config.cjs`](webpack.orivon.config.cjs), prepares `out/freetube/static`, and
serves it on `http://127.0.0.1:8875`.

Then start Orivon, navigate to that URL, and accept the prompt -- or navigate to `freetube.eth`
instead, once the shell is launched with `orivon-port names`' output pointed at
(`ORIVON_ETH_NAMES_FILE=.../out/names.json npm run dev`, run from `orivon-mvp` -- the top-level
[`README.md`](../../README.md)'s "Opening it by name instead of by port" has the exact command; it
resolves to nothing without this, every launch). That name is fake: it is a file in this
repository, not ENS, and the grant it gets is session-scoped like any other plain-`http` origin,
re-prompted every launch.

Preparing an app means three
additions and nothing else: `.well-known/orivon.json`, a `<link rel="orivon-manifest">` in
`index.html`, and the bridge `<script>` first in `<head>`, every URL of them relative. The server reads files off disk and
does nothing else -- no header it invents, no byte it rewrites, so what works here works on any
static host. FreeTube adds one more of its own through `hooks.mjs`: a `<link rel="icon">`, for the
reason in the Design notes.

## Three builds, because they answer different questions

`recipe.json` builds the third. The other two are what established that the third is the one
worth building, and the table is why.

| Build | What it is | Backend | PoToken |
|---|---|---|---|
| web | `pnpm run pack:web`, verbatim | **Invidious only** | n/a (no Local API) |
| web + Local API | the same build with the Local API left in | YouTube directly, via `youtubei.js` | silently absent; metadata still loads, playback does not (see below) |
| **Electron renderer** | upstream's own renderer, `window.ftElectron` rebuilt over `orivon.*` | YouTube directly | real, minted through `orivon.web.openContext` (ADR-0019); metadata loads and playback works |

**Upstream compiles the web target with `SUPPORTS_LOCAL_API: false` and `externals:
{'youtubei.js': '{}'}`** -- the Local API is stripped, because a browser cannot reach YouTube
directly: CORS refuses the origin and the request needs headers a page is forbidden to set. That
is the exact wall Orivon removes, so the second and third builds ask what removing it buys.

### Why the Electron renderer, not the web build

The web build compiles `IS_ELECTRON` to `false`, and that removes the only code path that mints a
PoToken (`src/renderer/helpers/api/local.js`'s `window.ftElectron.generatePoToken`) -- without
one, YouTube's SABR stream cannot start. Compiling with `IS_ELECTRON: true` restores that path and
makes the renderer call `window.ftElectron.*` for everything privileged, which is what
[`bridge/members.json`](bridge/members.json) and [`bridge/ft-electron.js`](bridge/ft-electron.js) supply. This is **still the same
renderer source FreeTube ships in its desktop app** -- nothing here is a fork.

To reproduce either of the other two, run upstream's own configs inside `out/freetube/source`
after an `orivon-port fetch freetube`; the web + Local API one is a config-level change
(`_scripts/webpack.web-localapi.config.js`, which requires upstream's own config and flips two
settings), not a fork.

### What the build wrapper changes

[`webpack.orivon.config.cjs`](webpack.orivon.config.cjs) changes exactly four things in upstream's
own web config through [`src/build/webpack-kit.cjs`](../../src/build/webpack-kit.cjs), which
counts what it patched and fails loudly if upstream's config shape changes:
`SUPPORTS_LOCAL_API` and `IS_ELECTRON` true in the one `DefinePlugin`; `externals` deleted (so
`youtubei.js` is bundled); a Node-builtin `resolve.fallback` list; and two fixes the plain "flip
two defines" approach does not mention, both found by actually running the build end to end rather
than assumed from reading the source -- see
[What running the build found wrong with that plan](#what-running-the-build-found-wrong-with-that-plan).

`recipe.json` then runs `pnpm run pack:botGuardScript` for `dist/botGuardScript.js`, which it
copies to `/orivon/botGuardScript.js` in the served tree.

The entry list stays upstream's single `main.js`, with no `orivon-sig-eval.js` added: with
`IS_ELECTRON` true, `local.js`'s own branch posts to `#sigFrame` for n/sig deciphering, and that
branch is compiled IN rather than eliminated. The sigFrame markup itself comes from upstream's own
`index.ejs`, which renders it under the same `IS_ELECTRON` define -- so no HTML surgery is needed
for this build.

### What running the build found wrong with that plan

Two things the "flip `IS_ELECTRON` and `SUPPORTS_LOCAL_API`, otherwise reuse the web config as-is"
plan did not anticipate, both discovered by running the build and driving the result in a real
window rather than reading source:

1. **Locales under a different name.** `src/renderer/i18n/index.js` fetches
   `${locale}.json.br` instead of `${locale}.json` once `IS_ELECTRON` is true ("locales are only
   compressed in our production Electron builds" -- its own comment). Upstream reaches that name by
   constructing `ProcessLocalesPlugin` with `compress: true` in its OWN Electron config
   (`_scripts/webpack.renderer.config.js`); the web config's instance is built with `compress:
   false` and constructed before this wrapper ever sees it. `webpack.orivon.config.cjs` patches the
   already-built instance instead of forking the config to construct a new one. A name that does
   not match makes every locale fetch 404 before the renderer ever mounts (`SyntaxError:
   Unexpected token 'o', "not found" is not valid JSON` -- the static server's own 404 body, parsed as
   JSON) -- `#app` never gets past Vue's initial `<!---->` placeholder, with **zero console errors**,
   because the failing dispatch is never awaited by its caller. The bytes under that name are plain
   JSON, not brotli: see "Why the locales are named .br and are not compressed" below.
2. **A second `CopyWebpackPlugin` writes to a HARDCODED path, not `output.path`.** Upstream's web
   config copies `static/` (locales aside), `pwabuilder-sw.js`, and the Shaka Player locale files
   via absolute `to:` paths built from `path.join(__dirname, '../dist/web/...')` -- unlike its
   first `CopyWebpackPlugin` (the swiper CSS, a relative `to:` that DOES follow `output.path`).
   Changing `config.output.path` to this build's own directory does nothing to those hardcoded
   ones. **Caught only because it happened**: an early build here wrote into `dist/web/static`,
   which is another build target's output directory -- a build that silently overwrites one is a
   build whose damage shows up in an unrelated run. `webpack.orivon.config.cjs` now rewrites every `CopyWebpackPlugin`
   pattern whose `to:` starts with the old `dist/web` prefix onto this build's own output path.
   Left unfixed, this build would have `/static/invidious-instances.json`,
   `/static/geolocations/*.json`, and `/static/external-player-map.json` all 404 -- three of the
   Vuex actions `App.vue`'s `onMounted` fires (unawaited) throw as unhandled rejections for each.

## Opening a video works (`dist/orivon-web-localapi`)

Measured 2026-09-17, `dist/orivon-web-localapi`, against live YouTube:

```
url:   http://127.0.0.1:8875/#/watch/dQw4w9WgXcQ
title: Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster) - FreeTube
page:  Published on 25 Oct 2009 - 1,816,738,329 views - 19,394,151 likes
       Rick Astley - Subscribe - 4.5m - full description
```

**That is upstream's own Local API code, calling YouTube's InnerTube through the routed fetch.**
It is the thing upstream compiles OUT of the web build because a browser cannot do it.

Getting there needed three fixes, and only the first was Orivon's:

1. **A routed-fetch bug** (`src/preload/fetch-route.ts`). It read the request URL as
   `typeof input === 'string' ? input : input.url`, which accepts a string and a `Request` but
   **rejects a `URL` object** -- and `youtubei.js` passes one. WHATWG fetch takes
   `Request | USVString` and converts anything that is not a Request with `ToString`, which is why
   `fetch(new URL(...))` works in every browser. Fixed to follow the spec. This was a real
   platform divergence, found only because a third-party library exercised the path.
2. **The n/sig evaluator.** FreeTube sets `Platform.shim.eval` in
   `src/renderer/helpers/api/local.js`, but its working half sits behind
   `if (process.env.IS_ELECTRON)`, which webpack folds to `false` for a web build and eliminates.
   `_scripts/orivon-sig-eval.js` in the clone re-implements exactly that branch.
3. **The `#sigFrame` iframe** it posts to, which `src/index.ejs` also renders only under
   `IS_ELECTRON`. The build this recipe produces sets that define, so upstream renders the frame
   itself, from its own `sigFrameConfig` -- the sandboxed script and its CSP hash are upstream's
   bytes rather than a reimplementation. A web build has to have it injected instead.

Neither 2 nor 3 is an Orivon gap: both are upstream build decisions that follow from "the web
cannot reach YouTube", which is the premise Orivon removes.

### Playback on the web-localapi build: blocked on the PoToken, traced to the exact line

**Not blocked by Orivon.** Measured with an unminified build, the failure is three frames deep:

```
TypeError: Cannot read properties of undefined (reading 'replace')
  at base64ToU8        (googlevideo/dist/src/utils/shared.js)
  at setupSabrScheme   (src/renderer/helpers/player/SabrSchemePlugin.js)
  at setup             (src/renderer/components/ft-shaka-video-player/...)
```

YouTube now serves the Local API path over **SABR** (server-side ABR), and SABR requires a
proof-of-origin token. `Watch.js` takes the SABR branch whenever
`streaming_data.server_abr_streaming_url` exists, passing the `poToken` it was given.
`local.js` only ever produces one inside `if (process.env.IS_ELECTRON)`, by calling
`window.ftElectron.generatePoToken(...)` -- BotGuard, executed in FreeTube's main process. **This
build compiles that block out**, so the token is `undefined`, `base64ToU8(undefined)` throws, and
the throw takes the whole player component's `setup()` with it. **That is why no `<video>`
element exists at all** on this build -- the player never mounts, so only the thumbnail shows.
Metadata (title, description, view count) loads fine first, because it is fetched before the
player component ever runs.

This is the same `GENERATE_PO_TOKEN` handler
[`freetube-port-recon.md`](../../docs/planning/freetube-port-recon.md) listed as *Unassessed*,
and it is now assessed twice over: it is load-bearing, and it is the single thing between this
build and working playback.

### Playback on the Electron-renderer build: it plays

On `dist/orivon-electron`, `IS_ELECTRON` is compiled IN rather than out, so `local.js`'s own
branch actually runs: `window.ftElectron.generatePoToken(...)` -- `bridge/ft-electron.js`'s
own implementation -- opens a private, empty document at `https://www.youtube.com` through
`orivon.web.openContext` (`OrivonWeb`, ADR-0019, `docs/decisions/ADR-0019-*.md`), evaluates
FreeTube's own BotGuard script inside it, and returns the token. `getLocalVideoInfo` calls this
BEFORE it fetches either the player response or the `/next` metadata response (the second needs
`contentPoToken` for `serviceIntegrityDimensions`), so a working mint is load-bearing for the
whole video, not only its stream -- see
[How `generatePoToken` uses `web.context`](#how-generatepotoken-uses-webcontext) for the mechanism.

Measured 2026-09-18, live YouTube, `dist/orivon-electron`, `#/watch/dQw4w9WgXcQ`, through
the shell repository's `test/e2e-freetube-real.test.ts`:

| | |
|---|---|
| Watch page populated (title, description, view count) | yes |
| `generatePoToken` (fetch the script once, open the context, evaluate, close) | ~440-450 ms |
| Minted token length | 132 characters |
| Navigating to `#/watch/...` to `<video>.currentTime > 0` | ~3.2-3.9 s |
| `<video>.currentTime` past 3 s and still advancing 2 s later | yes |

The granted origin carries both the pre-existing `https.connect` grant and a `web.context` grant
for `https://www.youtube.com` (`orivon.app.grants()`, confirmed from the same run) -- the second is
what makes the mint above possible at all.

**About half of all mints stall inside BotGuard, and the bridge retries them.** Measured
2026-09-18 on the headless harness (`scripts/run-headless.mjs`: Xvfb, no GPU), against live YouTube.
In a stalled mint:

- BotGuard fetches its interpreter (`www.google.com/js/th/*.js`, ~150 ms);
- it calls `GenerateIT`, which **answers** (`200`, ~150 ms);
- then its own synchronous code never yields again. A 1-second heartbeat injected into the context
  ticked **zero times in 46 s**, while the context stayed open.

So the stall is a non-yielding block in Google's obfuscated script, after its server answered. It is
not a slow server, and not a stuck request. Nothing in the app tab's routed fetch, the context's
reach-only fetch, `openContext`, `evaluate` or the CORS wrapper showed a defect in stalled or clean
runs. The WebRTC guard is ruled out by an A/B: 10 of 10 mints succeeded with and without it. So is
the environment on its own: `WebGL1 blocklisted`, "No available adapters" and a 0x0 offscreen
viewport appear in clean runs exactly as in stalled ones.

**`generatePoToken` therefore gives each attempt 15 s**, far above the ~0.5 s a clean mint takes.
On the deadline it closes that context, which also ends the blocked renderer, and retries in a fresh
one, up to 3 attempts, one at a time. A real rejection is never retried. When every attempt stalls,
it throws a named `PoTokenMintStalledError`.

Measured over 4 real runs: **4 of 4 played**, 2 needing exactly one retry, none needing a second.
Whether a real desktop, with a GPU and a visible window, stalls as often is not measured.

## What else is measured

**It boots, mounts, and renders its real chrome, on both builds.** The shell repository's `test/e2e-freetube-real.test.ts`
drives the real shell against a prepared build (`ORIVON_FREETUBE_REAL_ROOT` selects which one):
the app is granted from its URL, FreeTube mounts its Vue app inside the resulting app tab, and it
renders its real chrome -- top nav, side nav, Subscriptions/Channels/Trending/Playlists/History/
Settings -- with `document.title` of `Subscriptions - FreeTube` and exactly the two known,
expected console errors below.

**Nothing about its data layer is measured yet beyond that**, and one thing about it is already
known to be broken through no fault of Orivon's: **all seven Invidious instances FreeTube bundles
are down** (measured 2026-09-17: three fail DNS, one 401, two 404, one 502). The stock web build
has no other backend, so it can render and cannot fetch. That is why the Local API builds exist.

Two console errors are present and expected on every build here, both already the capability
boundary working correctly, not a bug:

- `fetch to api.github.com refused` (or, on the Electron build, the same refusal surfacing as a
  JSON-parse error on the refusal body) -- FreeTube's update check. `api.github.com` is **not** in
  [`orivon.json`](orivon.json), left undeclared on purpose: an app asking whether a desktop
  release exists has no business reaching GitHub here.
- A `fetchInvidiousInstances` JSON-parse error -- one of the seven bundled Invidious instances
  answered with a body FreeTube could not parse. Not Orivon's: the instances are down, above.

### Testing the bridge

`bridge/ft-electron.test.ts` runs the **composed** bridge -- byte for byte what the browser is
served -- in a fresh `node:vm` realm per test, against a fake
`window`/`document`/`navigator`/`fetch`/`orivon`
([`src/testing/bridge-harness.ts`](../../src/testing/bridge-harness.ts)). It asserts the roster of
34 and covers the two hand-written members; the generated ones are covered once, for every port,
in [`src/bridge/`](../../src/bridge/).

```bash
orivon-port test freetube      # or: npx vitest run apps/freetube
```

`vitest.config.ts` includes `apps/**/*.test.ts`, so `npm test` runs these too.

### Running the real build against a real window

```bash
orivon-port run freetube       # fetch, build, serve on 8875
```

Then open `http://127.0.0.1:8875` in Orivon and accept the consent prompt -- it lists both
`https.connect` and *"Run code as www.youtube.com, in a private, empty session"* (`web.context`).
Navigate to a video (the Trending tab, or `#/watch/dQw4w9WgXcQ` typed into the page itself) and
it plays.

To drive the same thing headlessly, from a checkout of the shell repository beside this one:

```bash
node scripts/build-ordinary.mjs
ORIVON_PORTS_ROOT=../orivon-ports ORIVON_ORDINARY_BUILD=1 \
  npx vitest run --config test/vitest.e2e.config.ts test/e2e-freetube-real.test.ts
```

The playback assertion (`<video>.currentTime` exceeds 3s and is still advancing 2s later) is
**on by default whenever the prepared build's own manifest declares `web`** -- true for what
`recipe.json` builds. Override either way: `ORIVON_FREETUBE_REAL_PLAYBACK=0` forces it off, `=1`
forces it on regardless of the manifest.

## How `generatePoToken` uses `web.context`

`bridge/ft-electron.js`'s `generatePoToken` is written against `OrivonWeb.openContext`
(`capability-api.ts`, ADR-0019): fetch and cache `botGuardScript.js` once, rewrite its
`export{X as default};` tail into a call carrying this mint's own arguments -- exactly
`src/main/poTokenGenerator.js`'s own rewrite, except the video id is `JSON.stringify`-encoded
rather than spliced as a bare string (below) -- open a context at `https://www.youtube.com`,
evaluate the rewritten script, close the context in a `finally`, and queue mints one at a time as
upstream does. Unit-tested against a fake `orivon.web` (`bridge/ft-electron.test.ts`) and,
end to end against the real capability, measured above.

**The video id is JSON-encoded, not spliced as a literal, unlike `context`/
`initialAttestationData`/`ytConfig`.** Those three arrive already `JSON.stringify`d by FreeTube's
own call site (`local.js`), so splicing them verbatim reproduces upstream's own Electron build
exactly. The video id does not: it traces back to the URL (`#/watch/<id>`, a route a page
navigates FreeTube to, including this app's own address bar), so a bare `"${videoId}"` splice would
let a crafted id break out of the string literal and inject script into the youtube.com context
this runs in. `JSON.stringify(videoId)` closes that -- covered by
`bridge/ft-electron.test.ts`'s hostile-id test, which proves the payload lands as one inert
string argument, not executable code.

## Spike results: can BotGuard run in an isolated child?

Measured 2026-09-18 in Electron 44.0.0 (Chrome 152.0.7977.54) against live YouTube, from a
throwaway harness kept outside this repository because it drives upstream's AGPL script. The
question: can an opaque-origin child with no `orivon.*`, which talks to its parent only by
`postMessage`, mint the proof-of-origin token upstream needs? That child is the shape of a
manifest-declared sandbox page.

**It cannot. The reason rules out every isolation primitive, not only this one.**

| # | Question | Answer |
|---|---|---|
| 1 | Does BotGuard produce a token from an opaque origin? | **No.** The token is bound to the document origin, and only `https://www.youtube.com` gets one |
| 2 | Does BotGuard need `eval`? | **Yes.** The interpreter calls it itself; withholding `'unsafe-eval'` stops it loading |
| 3 | Can a sandbox page be enforced on a live origin? | **Yes, but not through the loader.** A response header added in `onHeadersReceived` works |
| 4 | Is the CSP `sandbox` directive honoured on a `protocol.handle` response? | **Yes**, framed and top-level |
| 5 | Does a `srcdoc` child's meta CSP block requests before the handler sees them? | **Yes** |
| 6 | Are sandboxed iframes process-isolated in Electron 44? | **Yes**, with no flag |
| 7 | Does fingerprinting reject a child that has real dimensions but is out of view? | **Could not be measured.** Question 1 fails first |

### 1: the token is bound to the document origin

Upstream's own `src/botGuardScript.js` was bundled unmodified and run in contexts that change one
thing at a time. Except for the first row, every request went through the same relay: a Node
`fetch` in the main process, which is how Orivon's routed fetch reaches the network.

| Context | Document origin | Network | `GenerateIT` answered | Tokens |
|---|---|---|---|---|
| upstream's `generatePoToken`, reproduced verbatim | `https://www.youtube.com` | Chromium | `["<token>",43200,100]` | 2 of 2 |
| that same view | `https://www.youtube.com` | relay | `["<token>",43200,100]` | 3 of 3 |
| that same view | `https://example.org` | relay | `[null,43200,null,"Mk..."]` | 0 of 3 |
| that same view | opaque, top-level | relay | `[null,43200,null,"Mk..."]` | 0 of 2 |
| sandboxed `srcdoc` child of a live origin, in view | opaque | relay | `[null,43200,null,"Mk..."]` | 0 of 1 |
| the same child, 1920x1080 and positioned off-screen | opaque | relay | `[null,43200,null,"Mk..."]` | 0 of 3 |
| the same child, 1x1 | opaque | relay | `[null,43200,null,"Mk..."]` | 0 of 1 |

The one-variable rows ran alone, each as the first mint in a fresh process, so the result does not
depend on order.

In every row BotGuard ran to completion: the interpreter loaded, the snapshot was taken, and
`GenerateIT` answered `200`. **Google's server declined to issue the token**, and the only thing
that differs between the rows that got one and the rows that did not is the document origin. The
relay is not the cause, since it gets a token for a youtube.com document.

Upstream reaches that origin by loading a `data:` URL with
`baseURLForDataURL: 'https://www.youtube.com/'` into a `WebContentsView`. That is a privilege of
the embedding application. A web page cannot put a document at another site's origin, because
that is the web's origin model working. So no child context Orivon could hand an app reaches it
either: not a sandbox page, not a `srcdoc` frame, not a worker with delegated ports, and not a
child at the app's own origin.

**This is where the isolated-child route stops.** A token could only come from Orivon itself
creating a document at a foreign origin on an app's behalf. That is a different kind of capability
(an app acting as another site, towards that site), not a missing piece of this one.

Whether YouTube then *accepts* a token for playback was not reached, and cannot be checked cheaply.
For the WEB client, `/player` answered `OK` with or without a token, and its formats carried no
direct URLs (SABR only). Any real check has to make a SABR request.

### 2: BotGuard needs `eval`

The interpreter (`www.google.com/js/th/*.js`, 63 KB) evaluates code at runtime from three call
sites: a direct `eval(T)` that is one of its VM instructions, and two Trusted Types
`createScript` -> `.eval` probes. Measured: in a child whose CSP withholds `'unsafe-eval'`, with
the interpreter loaded as a real `<script>` instead of upstream's `new Function`,
`BotGuardClient.create` fails with `EGOU: BotGuard unavailable`. It also creates an iframe of its
own, with `sandbox="allow-same-origin allow-scripts allow-forms allow-popups"`.

### 3 to 6: the platform primitive itself works

- **3.** `src/loader/serve.ts` serves only installed origins, so it can never give a sandbox page on
  a live origin a header. A live origin's responses do pass through
  `session.webRequest.onHeadersReceived`, however: A110 records that the listener never fires for a
  `protocol.handle` response, and a live origin is not one. Adding
  `Content-Security-Policy: sandbox allow-scripts` there made the page opaque, framed and
  top-level. Its `self.origin` read `"null"`, and `localStorage`, `document.cookie` and
  `parent.document` each threw `SecurityError`. The same page without the header kept its real
  origin. The primitive therefore needs two mechanisms: the served header for installed apps, and
  `onHeadersReceived` for live origins. Nothing in `src/` registers `onHeadersReceived` today.
- **4.** A `protocol.handle('https')` response carrying `Content-Security-Policy: sandbox
  allow-scripts` got the same result as 3: opaque, framed and top-level.
- **5.** Under a parent served by `protocol.handle`, a sandboxed `srcdoc` child whose meta CSP was
  `default-src 'none'` had its `fetch` and `<img>` refused in the renderer, with `connect-src` and
  `img-src` violations. **Neither request reached the handler.** The same child without the meta
  CSP reached the handler with both. So without a CSP, a sandboxed child's requests do arrive at
  the handler, which on the installed path is `fetchThirdParty`.
- **6.** Every sandboxed frame, whether `srcdoc` or a URL carrying the CSP `sandbox` header, ran in
  a different OS process from its parent (parent pid 65583, sandboxed children 65611). A
  same-origin, unsandboxed child shared the parent's process. Sandboxed children of one site share
  one process with each other.

### 7: masked by 1

The in-view, off-screen and 1x1 children all failed at the same step, `GenerateIT` answering
`null`, like every other context that was not youtube.com. The origin check fires first, so
dimensions cannot be isolated from an opaque child. Upstream's metric spoofing (DevTools
`Emulation.setDeviceMetricsOverride`) was reproduced in the control rows, but whether it is
necessary was not tested: for an opaque context it cannot change the outcome.

## Design notes

**Why the tab icon is a PNG copied from the clone.** FreeTube's Electron build has no favicon:
`src/index.ejs` emits no `<link rel="icon">`, and the only icon links upstream ships are the PWA
manifest's (`static/manifest.json`, pointing at `/_icons/logoColor.svg`, an SVG) and the window
icon main sets from `_icons/iconColor.png`. So a browser tab on this app falls back to a globe.
Orivon's own favicon capture (`src/main/favicon.ts`) fetches the page's declared icon to a `data:`
URL and refuses SVG outright, which leaves the PNG as the format the page has to name.
[`hooks.mjs`](hooks.mjs) injects that one `<link>`, and `recipe.json`'s `extraFiles` copies the
PNG out of the clone at prepare time -- nothing of upstream's is tracked here, and the path stays
relative so the tree is host-agnostic like every other URL.

**Why preparing injects rather than the server.** A server that rewrites what it serves is
executing app logic, and the owner's standing position is that an app's host is a plain static
file server. Injection is a build step; serving is a file read. Nothing this app needs is
computed at request time, so nothing about it depends on which static host answers.

**Why the locales are named `.br` and are not compressed.** The renderer's fetch path is
hardcoded, so the 50 locale files have to be called `${locale}.json.br`; nothing says they have
to hold brotli. `ProcessLocalesPlugin`'s `compress` flag picks both -- the name and the bytes --
and `webpack.orivon.config.cjs` takes the name by setting the flag and drops the bytes by
shadowing `compressLocale` with identity. Brotli bytes parse only when the response carries
`Content-Encoding: br`, and an IPFS gateway or an object store derives no such header from a file
it is merely handing back, so a compressed locale is one that works on this repository's server
and nowhere else -- as a blank page with no console error, the same failure mode as the 404
above. `Response.json()` ignores `Content-Type`, so plain JSON under an unknown extension parses
everywhere. The cost is the locale directory at 3.0 MB instead of 773 KB, and 61 KB instead of
15 KB for the one locale a session actually fetches. [`src/portable.ts`](../../src/portable.ts)
refuses to prepare an app that still holds compressed bytes.

**Why the manifest declares `*:*` next to sixteen literal hosts.** Video bytes come from
googlevideo.com hosts whose names rotate per video and per request
(`rr1---sn-4g5ednsk.googlevideo.com`). A connect pattern cannot be a sub-glob, so nothing narrower
than `*:*` reaches them. The sixteen literals are every other host FreeTube is known to reach: the
seven Invidious instances, YouTube's API and image hosts, SponsorBlock and Return YouTube Dislike.
On a live origin no Orivon CSP applies, so the wildcard costs nothing there. On the installed path
the served CSP omits it, which costs the app its images: a wildcard in a served CSP would be a
wildcard the user never read in the consent dialog.

**`consentGranularity` is `all-or-nothing` here.** That is the honest setting for an app that
never knew Orivon existed: FreeTube has no code path for a capability it declared being refused,
and the manifest contract says silence means exactly this. An app written *for* Orivon declares
`per-capability` instead, because it was built to degrade.

**Why the mechanical members are declared rather than written.** 32 of the 34 are a name plus a
reason: an inert recorder, a no-op, a constant, a refusal, or a browser API under this app's own
name for it. What is FreeTube's about them is the name and the reason, and both are in
[`members.json`](bridge/members.json); the mechanism is the kit's
([`src/bridge/`](../../src/bridge/)). The two in [`ft-electron.js`](bridge/ft-electron.js) are the
ones where a decision lives in the code itself.

**Why `generatePoToken` stays hand-written.** It is not a shape. It carries the BotGuard script
rewrite, the `JSON.stringify(videoId)` decision against a hostile id, a 15-second per-attempt
deadline, a retry in a fresh context and a one-at-a-time queue -- every one of them measured
against live YouTube rather than derived from an API. A declaration cannot hold that, and should
not try.
