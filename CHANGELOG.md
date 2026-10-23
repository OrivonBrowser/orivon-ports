# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `apps/decentrawiki/`: DecentraWiki, wikis anyone can edit, published on IPFS, written here on TiddlyWiki
  5.4.1. The editor (`editor.decentrawiki.eth`) keeps a library of wikis in the browser, edits each in a
  sandboxed TiddlyWiki frame, and publishes it: it computes the IPFS address itself, pins with the person's own
  node, Filebase, Pinata, any Kubo-compatible service or free pinning by Orivon, and accepts only the address it
  computed. Free pinning (`apps/decentrawiki/relay/`) is a Kubo-compatible `add` on Orivon's server that takes
  published DecentraWiki wikis only and keeps each version pinned on Orivon's Filebase account for 30 days, once. Every
  published wiki carries a pen that hands it to the editor. The build also makes the DecentraWiki guide,
  published at `decentrawiki.eth`.
- `recipe.json` takes `website: true` for an app Orivon must serve as an ordinary website: its page names no
  `orivon-manifest` link, and its tree holds its record in `.well-known/orivon-website.json` instead of
  `orivon.json`, because Orivon installs a `.eth` or `ipfs://` site whose root holds `orivon.json`. `hash`, `release`
  and `verify` read either. It declares no capability (`check:manifest`). DecentraWiki uses it, because Orivon opens a
  page from another site into an installed app with no `window.opener`.
- `apps/restfox/`: Restfox v0.41.0 as an Orivon app: upstream's own `desktop-electron` renderer build, unwrapped, and a
  bridge for the 35 members of `window.electronIPC`. `sendRequest` is a call to the page's `fetch`, so the headers a
  user types, `Cookie` and `Origin` included, go out as written with no browser extension. The manifest asks for https
  to public hosts and plain http to ten named `localhost` ports. A custom proxy, a CA file and a refused certificate fail
  with a message instead of being ignored, and the file workspaces are refused by name.
- `recipe.json` takes `website: true` for an app Orivon must serve as an ordinary website: the manifest still
  ships, but the page names it in no `orivon-manifest` link, so Orivon never installs it, and it declares no
  capability (`check:manifest`). DecentraWiki uses it, because Orivon opens a page from another site into an
  installed app with no `window.opener`.
- `apps/ollamagui/`: upstream Ollama GUI (v2.0.5) as an Orivon app. A web build with no bridge; the manifest declares
  one connection, `localhost:11434`. Listed in Explore as not yet published.
- `orivon-port release <app>` raises a published app's version by itself: it builds the app and compares the
  tree with `apps/<app>/published.json`, the record of the last release. A tree that differs gets its last version
  number raised by one (in `orivon.json`, the built tree and the record); the same tree keeps its version, so
  republishing the same bytes is not an update. `hash --check` refuses a changed tree that still has its
  published version, and `check:version` keeps each record at or below its manifest's version.
- `prepare` writes `support.issues` into every manifest: the `port-problem.yml` form address the Orivon hint's
  report link opens, built once in `src/report-url.ts` and written to the hint's script tag as `data-report-url`.
  A manifest that already names a `support` keeps it. Orivon builds that read the field offer it as "Report a
  problem" in the site panel; older builds ignore it. It reaches an app when that app is next republished.
- The Orivon hint says something true about each app. `recipe.json` takes a `hint` (`tier`, `name`,
  `officialUrl`, optional `text` and `notice`). A tier 2 app, one that needs Orivon to work at all (The
  Lounge, WebTorrent, ASGARDEX, Ledger Wallet, FreeTube, AirGap Vault), shows a landing instead of the
  app in another browser, decided before any of the app's scripts run, with Get Orivon, the official
  downloads, a report link and a way on to the app anyway. A tier 1 app (Element, Explore, Status) shows a
  small pill that can be closed. Inside Orivon nothing shows, except AirGap Vault's notice that this build
  has no secure storage.
- `.github/ISSUE_TEMPLATE/port-problem.yml`: problems with a community build are reported here, not to the
  upstream project. Every `apps/<id>/README.md` opens with what the build is, its pin, licence, known gaps and
  where problems go.
- `recipe.json` takes an `icon`: an image in the clone that `prepare` copies to `orivon/<id>-icon.<ext>`
  and names in the entry document's one `<link rel="icon">`, replacing any link the build wrote. ASGARDEX,
  FreeTube, Ledger Wallet and WebTorrent use it, and their hand-written icon code is gone (ASGARDEX's
  `hooks.mjs` with it).
- `src/build/esbuild-kit.mjs`, for an esbuild config that bundles for the Orivon shim: `loadShimPlugin`,
  `checkMetafile`, `readFiles` and `stampOf`, and `printWarnings` and `printBuildFailure`. The Lounge and
  WebTorrent use it; their bundles are byte for byte what they were. A WebTorrent build that needs a Node
  builtin the shim lacks now lists it with its importers, as The Lounge's did.
- `orivon-port recon <clone>` ends with **What Orivon can run**: the Electron exports and members,
  Node modules and members, spawned programs and listed packages the app's source uses. Uses in
  code that runs in Orivon get a verdict (works, works with limits, excluded, missing, not in the
  tables) read from orivon-mvp's compatibility tables when the command runs; uses found only in
  main or preload files, which a port drops, are listed as bridge hints and not counted, and a dependency no scanned file imports is listed apart. The whole clone is read with TypeScript's parser.
  `--mvp <path>` names the checkout (default `ORIVON_MVP_ROOT`, else `../orivon-mvp`); `--json`
  prints the report and verdicts as JSON.
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
- The Orivon hint (`src/orivon-hint/`): `build` and `run` add it to every app, for a visitor in
  another browser. `--no-orivon-hint` leaves it out.
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

- DecentraWiki's editor is an app in Orivon: its manifest declares `net`, so its page runs Orivon's IPFS
  node (a WASI 0.2 component, `OrivonBrowser/ipfs-node`, fetched by its CID at build time into `bin/`) and
  publishes from it. Free pinning reads the wiki from that node through the Kubo node beside the relay
  (`/api/v0/pin-from`, `/api/v0/node`), checking the folder before fetching the rest, so no HTTP request
  carries the wiki; another browser still uploads it. In Orivon a published wiki's pen hands a wiki over in the
  address only, and a wiki too large for that goes by file ("download a copy" in its sidebar).
- `prepare` writes the bridge and a tier 2 Orivon hint right after the page's `<base>` when it has one. Ahead of
  `<base href="/">` their relative URLs resolved against the document, so reloading a client-side route such as
  AirGap Vault's `/tabs/tab-secrets` asked for `/tabs/orivon/hint/hint.js` and the landing and the "no secure
  storage" notice never showed there.
- A build starts clean. `fetch` removes every untracked and ignored file from the clone after the
  checkout (`git clean -ffdx`), and `build` removes `build.output` before it installs, so a file an
  earlier build left behind is not published. FreeTube built twice from a clean clone gives one
  bundle hash.
- FreeTube, ASGARDEX and Element ship upstream's licence as `/LICENSE` (`extraFiles`), and FreeTube's
  page has a static `<title>`.
- `apps/asgardex/` is pinned at upstream v1.46.1 (`1c65abbd`): it fixes a bug that could swap a
  wallet's whole ADA balance. The bridge answers the new `apiExport.saveCsv`.
- `apps/airgap-vault/` is pinned at upstream v3.35.0 (`5bae09fa`): a transaction decoder for Ethereum
  and other EVM chains, a Secure Setup Guide and a confirmation before the vault is wiped. Its
  secure-storage factory is unchanged, so the build still keeps secrets as plain data in browser storage
  and still says so.
- `apps/element/` is pinned at upstream v1.12.32 (`ed0a1239`), which removes support for guest access
  tokens and for starter links in messages. The bridge answers the new `window.electron.x509` as an
  Element Desktop with no PKCS#11 library configured does.
- CI pins each action by commit SHA.
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
