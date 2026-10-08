# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `apps/ledger-wallet/`: upstream Ledger Wallet 4.23.0 (the desktop app once called Ledger Live) as an Orivon app: its own rspack
  renderer build wrapped for a tab, its preload and `ipcMain` re-created in a bridge (a password-protected data file stays
  compatible), and a `devices.hid` grant for Ledger devices over WebHID.
- `apps/element/`: declares `media.camera`, `media.microphone` and `media.screen`, so calls ask for the camera and
  microphone in the tab's panel and a screen share meets Orivon's picker.
- `run`, `fetch`, `build` and `test` take several app ids, and every app command takes `--all`
  (`orivon-port run --all --rebuild`). Apps are done one at a time; one that fails is reported,
  the rest still run, and the command exits 1. `run` and `serve` serve every app that built or
  started. `--all` beside named apps is refused rather than silently ignored.
- Every `apps/*/orivon.json` names its `domain` (a subname of `orivonstack.eth`, such as `freetube.orivonstack.eth`) and `check:manifest`
  requires it, with `bisq-fake` exempt by name. Ported apps' versions are `<upstream>.<build>`.
- The Orivon hint (`src/orivon-hint/`): `build` and `run` add a panel to every app that asks a
  visitor in another browser to open it in Orivon. `--no-orivon-hint` leaves it out.
- The executor: `run`, `fetch`, `build`, `serve`, `test`, `list`, `new`, `recon`, `doctor`.
- `apps/freetube/`: upstream FreeTube as an Orivon app, pinned at v0.25.3.
- `apps/freetube/`: moved to upstream `development` at `60e9d7f` (63 commits past the previous pin;
  v0.25.3-beta is the latest release). The build kit's `retargetOutput` now also polices
  `output.copy`.
- `serve` warns when an app's build is from a commit other than its recipe's pin.
- Gates: `check:no-upstream`, `check:pinned`, `check:licences`, `check:manifest`, `check:size`,
  `check:comments`, `check:secrets`, and `check:skill`, which fails when the porting skill cites a
  path or a command that no longer exists, or leaves an app out of its shapes table.
- `docs/porting-guide.md` and `docs/recipe-format.md`.
- The bridge kit (`src/bridge/`): a port declares its members in `apps/<id>/bridge/members.json`
  and the executor composes the served bridge. Seven behaviours, five buckets, a required `why`
  on each, and apps that expose more than one global.
- The build kit (`src/build/webpack-kit.cjs`): `patchPlugins`, `retargetOutput`,
  `addBrowserFallbacks` and `requireFromClone`, which close both traps in the porting guide.
- The bridge test harness (`src/testing/bridge-harness.ts`): the composed bridge in a fresh
  `node:vm` realm per test.
- `orivon-port recon <clone> --emit <app> [--global <name>]`, which writes the member list into a
  declaration with every name unclassified, merging rather than replacing what is already there.
- `bridge.members` in `recipe.json`.
- `apps/freetube/hooks.mjs`: a tab icon for the port. Upstream's Electron renderer declares no
  favicon, so `recipe.json` copies `_icons/iconColor.png` out of the clone and the hook points the
  page at it; a browser tab no longer falls back to a globe.
- `apps/asgardex/hooks.mjs`: the same, for a renderer whose favicon is declared but never emitted.
  Upstream points at a root-absolute `/favicon.ico` that the Vite build leaves out of
  `build/renderer`; the hook rewrites it to the relative copy `recipe.json` makes from
  `resources/icons/128x128.png`.
- `eth` in `recipe.json`: a fake `.eth` name for an app, validated and unique across apps
  (`check:pinned`). `orivon-port names` turns every declared name into a name→port map and a
  PAC; `serve.ts` refuses a request whose authority names a different declared app with 421.
  The name is not ENS and gets a session-scoped grant like any other plain-`http` origin.
- `site` in `recipe.json`: an app written in this repository rather than ported. `run` and
  `build` prepare its directory directly, with no clone and no build, and `fetch` refuses it.
  `check:no-upstream` admits the hand-written `.html`, `.css`, `.js` and `.svg` files under a
  declared site and nothing else there; its allowlist moved to `scripts/app-files.ts`, with tests.
- `apps/bisq-fake/`: a static mock of Bisq's *Buy BTC* offer book, served as `bisq.eth`, for
  filming the shell. It is not Bisq, runs no Bisq code and opens no socket; its manifest declares
  what Bisq itself would need so the consent dialog shows a realistic request.
- A list of app ids on `orivon-port serve` (`serve <app> <app> ...`): each already-built app is
  served on the port its recipe declares. `--port` stays single-app, and `--all` still serves
  every app.
- `apps/airgap-vault/`: upstream AirGap Vault as an Orivon app, pinned at v3.34.4. No preload to
  route — the renderer imports no `electron` and no Node builtin — so this port ships no bridge,
  only `hooks.mjs` rewriting the base href for history routing on a root-mounted origin.
- `apps/element/`: Element Desktop as an Orivon app, pinned at `v1.12.29`. `window.electron` is a
  generic forwarder over a 19-channel allowlist plus two nested `{id,name,args}` protocols
  (`ipcCall`, `seshat`), not named members, so the whole surface is 3 `hand` members and 2
  refusals in `bridge/members.json`. The bridge reproduces Element Web's own pickle-key scheme so
  upstream's unmodified service worker can still serve authenticated media; see the app's README
  for what that means and the orivon-mvp hand-off it links.
- `.wasm` in `src/serve.ts`'s MIME table (`application/wasm`), so
  `WebAssembly.instantiateStreaming` works against a served port — needed by `apps/element/`'s
  bundled crypto.
- The prepared tree's declaration (`src/declare.ts`, `src/bundle-hash.ts`): `prepare` generates
  the served manifest's `assets` list from the finished tree and writes
  `.well-known/orivon-ddoc.json`, the Orivon bundle hash and every per-path leaf, computed the way
  the client recomputes it and pinned by its frozen vectors. `orivon-port hash <dir> [--check]`
  declares or verifies a tree; `build` and `run` declare an already-built tree that has no ddoc
  file; `check:manifest` refuses a committed manifest that carries `assets`; the `build-ports` CI
  job checks FreeTube's declaration.

- `apps/the-lounge/`: The Lounge v4.5.2 as an Orivon app, running upstream's own Node server,
  unmodified, in a Worker of the app through orivon-mvp's Node shim. The build bundles the server's
  TypeScript sources with esbuild, gates the bundle (a `require` nobody answers, a module loaded by a
  computed name that is missing, Vite in the graph) and writes the install tree the server reads;
  a launcher page writes it into the app's files, forks the server, makes the first account with
  upstream's `add` command and shows the server's page in a `<webview>`. Needs `ORIVON_MVP_ROOT`.
- `apps/<id>/launcher/` in `scripts/app-files.ts`: hand-written `.html`, `.css`, `.js`, `.svg` and
  their unit tests, for a port with no `site/`.
- "Node server apps" in `docs/porting-guide.md`, and a `server` shape in `docs/port-candidates.md`.

### Changed

- Every published app's development `eth` name is the `domain` its manifest names
  (`thelounge.orivonstack.eth`, `freetube.orivonstack.eth`, ...), so a Web3 Score provider's
  judged level counts in development as it does at the published name; `check:manifest` fails a
  recipe whose `eth` differs from its `domain`. A recipe `eth` name may carry several labels.
  Element gains one. `bisq-fake` keeps `bisq.eth`: it has no home.
- `apps/explore/`: the Orivon app cards link each app's `.orivonstack.eth` name and list the
  builds that name their home.
- `build` and `run` prepare a built app again, without rebuilding it, when anything in its recipe
  directory changed since it was prepared (a manifest field, a bridge), and `serve` says when the
  tree it serves predates such a change. A tree prepared before this records nothing, so it is
  prepared again once.
- `serve` and `run` rewrite `out/names.json` and `out/orivon-names.pac` from every recipe before
  their servers start, so the map the shell reads can no longer outlive the recipes that produced
  it. All declared names go in whether or not they are being served, and a failed rewrite is
  reported loudly without stopping the servers.
- `apps/freetube/` is ported onto the kits: 34 members as 86 lines of declaration plus the two
  that carry a decision, and a build wrapper of 89 lines rather than 143.
