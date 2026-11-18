# Upstream: pkc-js

| | |
|---|---|
| Source | `https://github.com/pkcprotocol/pkc-js` |
| Pinned commit | `4427bb0ea4db1a03f9684ab7ccbd27737a8b44aa` (v0.0.132, the version 5chan v0.10.4 and seedit v0.6.3 pin) |
| Licence | GPL-3.0-or-later |

Bitsocial Node is written in this repository; pkc-js, Bitsocial's protocol library, is what it hosts
communities with (`upstream.library` in [`recipe.json`](recipe.json)). The Bitsocial project did not make
Bitsocial Node and does not endorse it.

## What crosses into this repository

**Nothing of pkc-js's.** The clone lives in `bitsocial-node/source/` in the build folder and everything
built from it in `out/bitsocial-node/static/`, neither tracked. pkc-js is never changed: it talks to a
kubo node over kubo's HTTP RPC, and [`node/kubo/`](node/kubo/) answers that RPC from Orivon's own IPFS node.

What is ours, and written from scratch:

- [`node/kubo/`](node/kubo/): the kubo RPC facade, the mutable file system (MFS) it needs and the gateway
  handler. [`node/kubo/SURFACE.md`](node/kubo/SURFACE.md) lists every call pkc-js 0.0.132 makes on a kubo
  client, read from its published `dist/node`.
- [`node/worker/`](node/worker/): the Worker that runs pkc-js's RPC server over the facade and Orivon's IPFS node, with
  the key guard on the RPC's door and what it carries for gaps in Orivon's shim.
- [`test/plain-browser.mjs`](test/plain-browser.mjs): a check that 5chan and seedit, built, run as their web versions in a
  browser with no Orivon, at a site's root and under a gateway's `/ipfs/<cid>/` path. It drives a headless browser and is never served.
- [`page/`](page/) and [`build/`](build/): the page, the module that starts the Worker, and the build. The build changes
  four places in pkc-js's installed bundle (text patches in `build/gap-*.mjs`, each stated and each failing when its text is
  gone), in the bundle it writes and never in a file kept here.

pkc-js and `@bitsocial/bso-resolver` (the `.bso` name resolver the Bitsocial desktop clients use) are installed from
[`node/package-lock.json`](node/package-lock.json) at the versions those clients pin, as are the facade's dependencies
(`@ipld/dag-pb`, `ipfs-unixfs`, `ipfs-unixfs-importer`, `multiformats`; and `kubo-rpc-client` for its tests) and the
build's `esbuild`; none of their code is committed here. The bundle `build/` writes holds pkc-js's code, so whoever
distributes it owes pkc-js's licence (GPL-3.0-or-later): its notices are kept in the bundle, and the sources are the pinned
commit above.

## Also bundled into the Worker

| | `@bitsocial/5chan-board-manager` | `@pkcprotocol/active-page-sort` |
|---|---|---|
| Source | `https://github.com/bitsocialnet/5chan-board-manager` | `https://github.com/pkcprotocol/active-page-sort` |
| Pin | commit `8e7a3959381bbc34af5bc669a2f3c32b78e45ec1` (v0.2.36), a tarball of that commit in `node/package.json`, its sha-512 in the lockfile | `0.0.7`, from npm, in `node/package.json` and the lockfile |
| Licence | GPL-3.0-or-later | GPL-3.0-or-later |

Both are installed from [`node/package-lock.json`](node/package-lock.json) and neither is changed or committed here; whoever
distributes the bundle owes their licence as it owes pkc-js's.

- **The board manager** is 5chan's moderation worker: it archives a board's oldest thread at the board's capacity, purges an
  archived thread after a delay and applies a bump limit. The Worker bundles its TypeScript (`worker/board-manager-entry.js` names
  the four modules it uses) and runs it as an RPC client of the Worker's own server, one per board. What the build changes is in
  [`build/board-manager.mjs`](build/board-manager.mjs): four imports resolved to something the Worker has (the bundled pkc-js
  entry whose chunks the RPC server already holds, [`worker/board-manager-logger.js`](node/worker/board-manager-logger.js) for
  its logger, [`worker/workarounds/process-lock.js`](node/worker/workarounds/process-lock.js) for its lock library, an empty folder set for `env-paths`) and one text patch
  for the version it reads from its own `package.json`, which fails the build when the text is gone. Its folder watcher
  (chokidar) and its multi-board runner are not used: [`worker/board-managers.js`](node/worker/board-managers.js) starts and
  restarts the managers instead.
- **The page sort** is the sort the manager's bump limit lives in. `worker/pkc-options.js` registers it under
  `@pkcprotocol/active-page-sort`, the name the manager writes into a board's settings; a board with no such sort behaves
  as without it.

## The anti-spam challenges

Nine packages the Bitsocial projects publish for board owners, installed from [`node/package-lock.json`](node/package-lock.json) at the versions in
[`node/worker/challenges.js`](node/worker/challenges.js) (a test checks that list against the installed packages and `package.json`). None is
changed or committed here, and whoever distributes the bundle owes their licence (GPL-3.0-or-later) as it owes pkc-js's.

| Package | Version | Source | Licence |
|---|---|---|---|
| `@bitsocial/ai-moderation-challenge` | 0.5.1 | `https://github.com/bitsocialnet/ai-moderation-challenge` | GPL-3.0-or-later |
| `@bitsocial/base64-challenge` | 0.1.1 | `https://github.com/bitsocialnet/base64-challenge` | GPL-3.0-or-later |
| `@bitsocial/captcha-canvas-challenge` | 0.1.5 | `https://github.com/bitsocialnet/captcha-canvas-challenge` | GPL-3.0-or-later |
| `@bitsocial/evm-contract-challenge` | 0.1.7 | `https://github.com/bitsocialnet/evm-contract-challenge` | GPL-3.0-or-later |
| `@bitsocial/flags-challenge` | 0.1.3 | `https://github.com/bitsocialnet/flags-challenge` | GPL-3.0-or-later |
| `@bitsocial/r9k-challenge` | 0.1.1 | `https://github.com/bitsocialnet/r9k-challenge` | GPL-3.0-or-later |
| `@bitsocial/spam-blocker-challenge` | 0.1.7 | `https://github.com/bitsocialnet/spam-blocker` | GPL-3.0-or-later |
| `@bitsocial/voucher-challenge` | 0.1.4 | `https://github.com/bitsocialnet/voucher-challenge` | GPL-3.0-or-later |
| `@bitsocial/wordfilter-challenge` | 0.3.1 | `https://github.com/bitsocialnet/wordfilter-challenge` | GPL-3.0-or-later |

One challenge is ours: `@orivon/id-challenge` ([`node/orivon-id-challenge/`](node/orivon-id-challenge/), AGPL-3.0-only, as the rest of this repository; its
`LICENSE` is the notice). It has no dependency and wraps no upstream code; it calls only the `authorIdentityMatcher` pkc-js hands every challenge. The
Worker's name resolvers are [`worker/pkc-options.js`](node/worker/pkc-options.js)'s own, so the challenge adds no network client.

`@bitsocial/mintpass-challenge` (1.5.0, GPL-3.0-or-later) is not bundled: it keeps its cooldowns and bindings in sqlite3 through
`@keyv/sqlite`, a native module, and the dashboard's list says so. What the build changes is in
[`build/challenges.mjs`](build/challenges.mjs): four imports resolved to something the Worker has and one font read into the bundle, and no package's
own file is edited (so no upstream note is owed):

- `skia-canvas` (MIT), which `captcha-canvas` (Apache-2.0) imports, becomes [`worker/workarounds/pure-canvas.js`](node/worker/workarounds/pure-canvas.js),
  ours, over `pureimage` (MIT), `pngjs` (MIT), `opentype.js` (MIT) and `jpeg-js` (BSD-3-Clause), direct dependencies of `node/package.json`. `skia-canvas`
  stays in the lockfile as the captcha's dependency, never built and never loaded: `orivon-port build` installs without scripts, so
  its binary is not fetched.
- The captcha is drawn in DejaVu Sans, from `dejavu-fonts-ttf` 2.37.3 (a development dependency; the Bitstream Vera licence with public-domain
  changes), whose bytes go into the bundle with its licence text as a legal comment, because the licence asks that its notice go with every copy.
- `@pkcprotocol/pkc-logger`, from a challenge package, becomes [`worker/challenge-logger.js`](node/worker/challenge-logger.js); `i18n-iso-countries`, from a
  challenge package, takes its `index.js` (the entry its `browser` field names), because its `main` entry registers every language file and
  spam-blocker only calls `isValid`.

`viem` and `cborg` are development dependencies, for the stand-in services of [`node/tools/challenge-services.js`](node/tools/challenge-services.js):
the challenges depend on them already, and the tools import them directly.

## What to re-check when the pin moves

- `node/package.json`: pkc-js's version, which the build requires to equal the clone's.
- [`build/gap-lock.mjs`](build/gap-lock.mjs), [`gap-dns.mjs`](build/gap-dns.mjs), [`gap-uuid.mjs`](build/gap-uuid.mjs), [`gap-lru-storage.mjs`](build/gap-lru-storage.mjs): each
  patches text of pkc-js's bundled chunks and fails the build when the text moved; `node/test/build-workarounds.test.ts`
  says which.
- [`node/worker/pkc-options.js`](node/worker/pkc-options.js): the desktop clients' HTTP routers and name resolvers
  (`electron/pkc-rpc-options.js` in 5chan and seedit).
- [`node/worker/challenges.js`](node/worker/challenges.js): each challenge's version, licence, hosts and options; a new release of one is a new line,
  and `node/test/challenges.test.ts` fails on a list that no longer matches the install. `node node/tools/challenges.js` runs every one.

- [`node/kubo/SURFACE.md`](node/kubo/SURFACE.md): list pkc-js's kubo calls again from the new `dist/node`
  (`grep -rnE "_client\.|kuboRpcClient\.|fetch\("` over `runtime/node/`, `util.js`, `clients/`, `pkc/`) and
  compare each row.
- `kubo-rpc-client`: `node/package.json` pins the version pkc-js depends on; the conformance test only means
  something against the same one.
- The error texts pkc-js matches in a kubo answer (`file does not exist`, `is not pinned`, `not pinned`,
  `Already subscribed to`, an HTTP 500 from `key/import` for a key that exists): each is in `SURFACE.md`.

- `node/orivon-id-challenge/index.js`: the matcher's shape (`wireName`, `matchesIdentity`, `nameFailure.reason`) and what pkc-js checks about an author name before
  a challenge runs (`author-identity.js`, `publication-validation.js` `checkAuthorIdentity`: capital letters, the 30-minute resolution cache, the reason texts);
  `node/test/orivon-id-challenge.test.ts` runs the challenge against pkc-js's own `createAuthorIdentityMatcher` and fails when either moved.
- `node/package.json`: the board manager's commit and the page sort's version, and the version of pkc-js that the manager's
  own `package.json` requires (the bundle shares the Worker's copy of pkc-js, so the two must still agree on the RPC).
- `node/worker/board-managers.js`: `MANAGER_DEFAULTS` repeats the manager's defaults (`src/defaults.ts`: threads per page,
  pages, bump limit, purge delay) so the dashboard can show what a board gets when it sets nothing; compare them.
- [`build/board-manager.mjs`](build/board-manager.mjs): its four import rewrites and its one text patch; the build says which no
  longer matches. `node/test/board-manager-build.test.ts` bundles the manager and checks what it exports and what it leaves out.
- The manager's state file (`state.json`) keeps the keys it signs moderation with, in the open: it is read and written by the
  manager's own code, which has no hook for the app's sealed store.
