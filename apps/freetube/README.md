# `apps/freetube/`: upstream FreeTube, unmodified, as an Orivon app

FreeTube is the reference port for the webpack shape: upstream's own **Electron renderer**, built by
its own toolchain, with `window.ftElectron` rebuilt over `orivon.*`. This page is how this one
works; [`docs/porting-guide.md`](../../docs/porting-guide.md) is the general method and is not
repeated here. **No FreeTube source and no build output is tracked**: it is AGPL-3.0-or-later and
lives in `out/freetube/`, which is gitignored ([`UPSTREAM.md`](UPSTREAM.md)).

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Where upstream is, at which commit, how to build it, and `icon`, the tab icon copied out of the clone |
| [`orivon.json`](orivon.json) | The manifest, including `web.contexts: ["https://www.youtube.com"]` (see [How `generatePoToken` uses `web.context`](#how-generatepotoken-uses-webcontext)) |
| [`webpack.orivon.config.cjs`](webpack.orivon.config.cjs) | The build wrapper: requires upstream's own web config and patches it |
| [`hooks.mjs`](hooks.mjs) | Two edits to the built `index.html`: the sigFrame's script moved out to a file (see [The sigFrame](#the-sigframe)), and a static `<title>FreeTube</title>` where upstream's page ships an empty one |
| [`bridge/members.json`](bridge/members.json) | 32 of the 34 `window.ftElectron` members upstream's renderer calls, each with the reason it is answered the way it is |
| [`bridge/ft-electron.js`](bridge/ft-electron.js) | The other 2, `generatePoToken` and `getNavigationHistory`, and the line that points the sigFrame at its served script |
| [`bridge/ft-electron.test.ts`](bridge/ft-electron.test.ts) | The roster and the two hand-written members |
| [`bridge/sig-frame.test.ts`](bridge/sig-frame.test.ts) | The hook, the served script's guard, and the bridge's rewrite of the frame |
| [`UPSTREAM.md`](UPSTREAM.md) | The pin, the licence, and what never crosses into this repository |

## Running it

```bash
orivon-port run freetube      # clone at the pinned commit, build, prepare, serve on 127.0.0.1:8875
orivon-port test freetube     # or: npx vitest run apps/freetube
```

Open `http://127.0.0.1:8875` in Orivon and accept the consent prompt. It lists `https.connect` and
*"Run code as www.youtube.com, in a private, empty session"* (`web.context`). A video, from the
Trending tab or `#/watch/<id>`, plays. `freetube.orivonstack.eth` works too once the shell is
launched with `orivon-port names`' output (the top-level [`README.md`](../../README.md), "Opening
it by name instead of by port"); that name is a file in this repository, not ENS, and its grant
lasts one session like any plain-`http` origin.

Preparing the app adds three things and nothing else: `.well-known/orivon.json`, a
`<link rel="orivon-manifest">` and the bridge `<script>` first in `<head>`, all relative; the
recipe's `icon` adds a fourth, one `<link rel="icon">`. The server reads files off disk and rewrites
nothing, so what works here works on any static host.

The real-window check lives in the shell repository (`test/ported-apps/e2e-freetube-real.test.ts`,
driven from a checkout beside this one: see its header for the command). Its playback assertion
(`<video>.currentTime` past 3 s and still advancing 2 s later) is on whenever the prepared build's
manifest declares `web`; `ORIVON_FREETUBE_REAL_PLAYBACK=0` or `=1` forces it either way. It also
asserts the sigFrame guard.

## Why the Electron renderer, not the web build

Upstream compiles its web target with `SUPPORTS_LOCAL_API: false` and `externals: {'youtubei.js':
'{}'}`: a browser cannot reach YouTube directly (CORS, and headers a page may not set), so the
Local API is stripped and the only backend left is Invidious. That wall is what Orivon removes.
Re-enabling the Local API is not enough: the web build also compiles `IS_ELECTRON` to `false`,
which removes the only code that mints a PoToken (`local.js`'s `window.ftElectron.generatePoToken`),
and without one YouTube's SABR stream cannot start (`base64ToU8(undefined)` throws in the player's
`setup()`, so no `<video>` mounts although the metadata loads). Compiling with `IS_ELECTRON: true`
restores that path and makes the renderer call `window.ftElectron.*` for everything privileged,
which the bridge supplies. It is still the renderer source FreeTube ships in its desktop app.

## What the build wrapper changes

[`webpack.orivon.config.cjs`](webpack.orivon.config.cjs) patches upstream's web config through
[`src/build/webpack-kit.cjs`](../../src/build/webpack-kit.cjs), which counts what it patched and
fails if upstream's config shape changes. Output goes to `dist/orivon-electron-web`, never
`dist/web`, which `pack:web` owns.

- **`SUPPORTS_LOCAL_API` and `IS_ELECTRON` true** in the one `DefinePlugin`. `index.ejs` reads the
  same define, so the template renders upstream's real sigFrame markup.
- **`templateParameters` set to upstream's `sigFrameTemplateParameters`**, which that markup needs.
  Without it the build fails at `HtmlWebpackPlugin` time.
- **`externals` deleted**, so `youtubei.js` is bundled.
- **Every Node builtin set to `false` in `resolve.fallback`**: `youtubei.js` checks for them on its isomorphic paths rather than assuming them.
- **Locales named `.json.br` but left as plain JSON** (`ProcessLocalesPlugin.compress = true`,
  `compressLocale` replaced by identity). With `IS_ELECTRON` true, `i18n/index.js` fetches
  `${locale}.json.br`; any other name 404s every locale fetch and `#app` never leaves Vue's initial
  `<!---->` placeholder, with zero console errors (the failing dispatch is never awaited). See
  [Why the locales are named `.br` and are not compressed](#why-the-locales-are-named-br-and-are-not-compressed).
- **Copy rules retargeted into this build's directory** (`retargetOutput`). Upstream copies
  `static/`, `pwabuilder-sw.js` and the Shaka locales through `output.copy` with `to:` relative to
  `output.path`. A rule naming `dist/web` is rewritten, and one pointing outside the output
  directory throws: it would overwrite another target's output, and a missing copy leaves
  `/static/invidious-instances.json`, `/static/geolocations/*.json` and
  `/static/external-player-map.json` to 404, each an unawaited Vuex action throwing on mount.
- **The entry stays upstream's single `main.js`.** With `IS_ELECTRON` true, `local.js` posts to
  `#sigFrame` for n/sig deciphering itself, so no `orivon-sig-eval.js` is added.

`recipe.json` also runs `pnpm run pack:botGuardScript` and serves its output at
`/orivon/botGuardScript.js`, and its `extraFiles` ship upstream's licence as `/LICENSE`.

## The sigFrame

`local.js` deciphers a stream URL's `n` and `sig` by posting the cipher code to
`<iframe id="sigFrame" sandbox="allow-scripts">` and waiting for the frame's `message` reply.
Upstream's frame carries its script inline in a `data:` URL, with a `csp` attribute naming the
script's hash. Upstream's Electron top document has no CSP, so that works there. Here every granted
origin's document carries the app CSP, whose `script-src` has no `'unsafe-inline'`, and a `data:`
frame inherits the CSP of its creator. The inline script is refused, the frame never installs its
listener, and every decipher hangs with nothing thrown. The shell's policy is not changed; the port
does three things:

1. [`hooks.mjs`](hooks.mjs), at prepare time, reads the script out of the built `index.html`'s
   `data:` URL and writes it byte for byte to `orivon/sig-frame.js` behind a one-line guard, and
   removes the frame's `src` and `csp` attributes. The bytes come from `out/`, so none are tracked.
2. The guard throws unless the script runs in a frame whose origin is opaque (`self.origin ===
   'null'`, which only a sandboxed frame without `allow-same-origin` has) and whose parent is a
   different window. The script evaluates whatever it is posted and does not check the sender, so a
   script tag added to the app's own document (by an extension, say) would otherwise turn it into a
   way to run code as the page. With the guard it installs nothing there, nor in any same-origin
   frame.
3. [`bridge/ft-electron.js`](bridge/ft-electron.js) sets the frame's `csp`, then its `src`, when the
   document is parsed: a `data:` document holding only `<script src>` naming the served file, and
   `default-src 'none'; script-src <that URL> 'unsafe-eval'`. The URL is resolved against
   `document.baseURI` at run time, because the same build is served from `127.0.0.1:8875`, from
   `freetube.orivonstack.eth` and from a gateway path, and `'self'` inside a `data:` document means
   its opaque origin. The frame keeps `sandbox="allow-scripts"` and `default-src 'none'`: no network
   and no storage.

Rejected: restoring `'unsafe-inline'` in the shell's CSP, which would let any injected inline
script run in every app; and a same-origin `sig-frame.html`, which would need the frame's `csp`
attribute dropped, since a framed same-origin page is only allowed under a required CSP when its
response carries `Allow-CSP-From`, which a plain static host does not send.
[`bridge/sig-frame.test.ts`](bridge/sig-frame.test.ts) covers the three parts.

## How `generatePoToken` uses `web.context`

`generatePoToken` is written against `OrivonWeb.openContext` (ADR-0019). It fetches and caches
`botGuardScript.js` once, rewrites its `export{X as default};` tail into a call carrying this mint's
arguments (the rewrite `src/main/poTokenGenerator.js` does upstream), opens a context at
`https://www.youtube.com`, evaluates the script, closes the context in a `finally`, and queues
mints one at a time as upstream does. `getLocalVideoInfo` mints before it fetches either the player
response or the `/next` metadata (which needs `contentPoToken`), so a working mint gates the whole
video, not only the stream. A mint takes about half a second; the granted origin holds both
`https.connect` and the `web.context` grant for `https://www.youtube.com`.

**The video id is JSON-encoded, not spliced.** `context`, `initialAttestationData` and `ytConfig`
arrive already `JSON.stringify`d from FreeTube's call site, so splicing them reproduces upstream.
The video id traces back to the URL (`#/watch/<id>`), so a bare `"${videoId}"` splice would let a
crafted id break out of the string literal and inject script into the youtube.com context.
`JSON.stringify(videoId)` closes that; `ft-electron.test.ts` has a hostile-id test proving the
payload lands as one inert string argument.

**Why the mint retries.** About half of all mints stall inside BotGuard on the headless harness
(Xvfb, no GPU): the interpreter loads, `GenerateIT` answers `200`, and then Google's obfuscated
script never yields again (a heartbeat injected into the context does not tick). It is not a slow
server or a stuck request, and nothing in the routed fetch, `openContext`, `evaluate` or the WebRTC
guard is implicated. So each attempt gets 15 s; on the deadline the bridge closes the context, which
also ends the blocked renderer, and retries in a fresh one, up to 3 attempts, one at a time. A real
rejection is never retried. When every attempt stalls it throws `PoTokenMintStalledError`. Whether a
real desktop with a GPU stalls as often is not measured.

### Why the token is minted at youtube.com and not in an isolated child

An opaque-origin child with no `orivon.*`, talking to its parent by `postMessage`, cannot mint the
token. BotGuard runs to completion there, but Google's server declines to issue the token: it is
bound to the document origin, and only a document at `https://www.youtube.com` gets one. Upstream
gets that origin by loading a `data:` URL with `baseURLForDataURL: 'https://www.youtube.com/'` into
a `WebContentsView`, a privilege of the embedding application. A web page cannot put a document at
another site's origin, so no child Orivon could hand an app (sandbox page, `srcdoc` frame, worker,
child at the app's own origin) reaches it. A token can only come from Orivon creating a document at
a foreign origin on the app's behalf, which is a capability of its own (`web.context`), not a missing
piece of a sandbox page. Two further facts: BotGuard's interpreter calls `eval` itself (it fails
with `EGOU: BotGuard unavailable` without `'unsafe-eval'`), and a CSP `sandbox` directive on a
response makes a page opaque on both the installed path and a live origin.

## Members

The 34 `window.ftElectron` members upstream's renderer calls, by how each is answered
([`members.json`](bridge/members.json) holds every name and reason; the mechanism is the kit's, in
[`src/bridge/`](../../src/bridge/)):

| Bucket | Count | What |
|---|---|---|
| `behaviours` | 10 | Fullscreen, picture in picture, zoom, system locale, wake lock, the player cache, picked-folder downloads: a browser API under FreeTube's own name for it |
| `listeners` | 10 | `handle*` members that record the callback and never fire it: one window, no second process to sync with |
| `noop` | 4 | Setters for state this port does not keep, beside getters that answer a constant |
| `constants`, `asyncConstants` | 3 | `isWaylandPlatform`, `getReplaceHttpCache`, `getDisableHardwareAcceleration`: always `false` |
| `refused` | 5 | `openInExternalPlayer`, `relaunch`, `openInNewWindow`, `enableProxy`, `disableProxy`: the browser owns windows, proxies and other programs |
| `hand` | 2 | `generatePoToken`, `getNavigationHistory` (answers one active entry from `document.title`, so `TopNav.vue` never sees `undefined`) |

`ft-electron.test.ts` runs the **composed** bridge, byte for byte what the browser is served, in a
fresh `node:vm` realm per test against a fake `window`/`document`/`fetch`/`orivon`
([`src/testing/bridge-harness.ts`](../../src/testing/bridge-harness.ts)). It asserts the roster of 34
and covers the two hand-written members; the generated ones are covered once for every port in
[`src/bridge/`](../../src/bridge/).

## What works and what does not

- **Works, against live YouTube:** the app mounts and renders its real chrome (top nav, side nav,
  Subscriptions, Trending, History, Settings); a watch page fills in; `<video>` plays; n/sig
  deciphering works behind the shell's current app CSP; the update check reaches `api.github.com`
  through the routed fetch (`*:*` covers any public host) and shows no banner while the pinned
  version is the latest release.
- **Expected console error:** a `fetchInvidiousInstances` JSON-parse error. The bundled Invidious
  instances are not the backend here; the Local API is.
- **Refused, by design:** external players, relaunch, new windows and proxy settings
  (the `refused` bucket above). Each is reached only from a user action in FreeTube's own chrome,
  never during page mount.
- **Not measured:** the data layer beyond watching (subscriptions, playlists, history) and playback
  on a real desktop with a GPU.

## Design notes

**Why the tab icon is a PNG copied from the clone.** FreeTube's Electron build emits no
`<link rel="icon">`, and the icon links upstream ships are the PWA manifest's SVG and the window
icon main sets from `_icons/iconColor.png`. A tab would fall back to a globe. `recipe.json`'s `icon`
names that PNG, so the tab shows what the desktop window shows; `prepare` copies it and writes the
one `<link>`, relative to the document so the tree stays host-agnostic.

**Why preparing injects rather than the server.** A server that rewrites what it serves is
executing app logic; an app's host is a plain static file server. Injection is a build step, serving
is a file read, so nothing depends on which host answers.

**Why the locales are named `.br` and are not compressed.** The renderer's fetch path is hardcoded,
so the 50 locale files must be called `${locale}.json.br`; nothing says they must hold brotli.
`ProcessLocalesPlugin`'s `compress` flag picks both the name and the bytes, and the wrapper takes the
name and drops the bytes. Brotli bytes parse only when the response carries `Content-Encoding: br`,
and an IPFS gateway or object store derives no such header from a file it merely hands back, so a
compressed locale works on this repository's server and nowhere else, as a blank page with no
console error. `Response.json()` ignores `Content-Type`, so plain JSON parses everywhere. The cost
is the locale directory at 3.0 MB instead of 773 KB (61 KB instead of 15 KB for the one locale a
session fetches). [`src/portable.ts`](../../src/portable.ts) refuses to prepare an app that still
holds compressed bytes.

**Why the manifest declares `*:*` next to sixteen literal hosts.** Video bytes come from
googlevideo.com hosts whose names rotate per video and request (`rr1---sn-4g5ednsk.googlevideo.com`),
and a connect pattern cannot be a sub-glob, so nothing narrower than `*:*` reaches them. The sixteen
literals are every other host FreeTube is known to reach: the seven Invidious instances, YouTube's
API and image hosts, SponsorBlock and Return YouTube Dislike. On a live origin no Orivon CSP
applies, so the wildcard costs nothing. On the installed path the served CSP omits it, which costs
the app its images: a wildcard in a served CSP would be one the user never read in the consent
dialog.

**`consentGranularity` is `all-or-nothing`.** FreeTube has no code path for a declared capability
being refused, and silence in the manifest contract means exactly this. An app written for Orivon
declares `per-capability` because it was built to degrade.

**Why the mechanical members are declared rather than written.** 32 of the 34 are a name plus a
reason, and both are in `members.json`. The two in `ft-electron.js` are the ones where a decision
lives in the code.

**Why `generatePoToken` stays hand-written.** It carries the BotGuard script rewrite, the
`JSON.stringify(videoId)` decision, a 15-second per-attempt deadline, a retry in a fresh context and
a one-at-a-time queue. A declaration cannot hold that.
