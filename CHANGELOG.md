# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The executor: `run`, `fetch`, `build`, `serve`, `test`, `list`, `new`, `recon`, `doctor`.
- `apps/freetube/`: upstream FreeTube as an Orivon app, pinned at v0.25.3.
- Gates: `check:no-upstream`, `check:pinned`, `check:licences`, `check:manifest`, `check:size`,
  `check:comments`, `check:secrets`.
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

### Changed

- `serve` and `run` rewrite `out/names.json` and `out/orivon-names.pac` from every recipe before
  their servers start, so the map the shell reads can no longer outlive the recipes that produced
  it. All declared names go in whether or not they are being served, and a failed rewrite is
  reported loudly without stopping the servers.
- `apps/freetube/` is ported onto the kits: 34 members as 86 lines of declaration plus the two
  that carry a decision, and a build wrapper of 89 lines rather than 143.
