# `apps/asgardex/`: upstream ASGARDEX, unmodified, as an Orivon app

**What lives here.** A recipe, a manifest, and the bridge that stands in for the Electron main
process ASGARDEX expects. **No ASGARDEX source and no ASGARDEX build output is in this
repository** — see [`UPSTREAM.md`](UPSTREAM.md) for its licence and where it goes instead.

**What this measures.** ASGARDEX is this repository's second port, and it is deliberately a
different shape from the first. FreeTube is a page with a few privileged extras; ASGARDEX is a
page with a filing cabinet bolted to it. What it tests is whether the porting method holds when
most of a preload turns out to be a file store rather than a set of odd jobs.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Where upstream is, at which commit, and how to build it |
| [`orivon.json`](orivon.json) | The manifest — what the consent dialog shows a person |
| [`bridge/members.json`](bridge/members.json) | The fourteen globals and sixty-nine members, each with the reason it is answered the way it is |
| [`bridge/asgardex.js`](bridge/asgardex.js) | The forty members that carry a decision rather than a shape |
| [`bridge/asgardex.test.ts`](bridge/asgardex.test.ts) | 82 tests over the composed bridge, byte for byte what the browser is served |

[`docs/asgardex-recon.md`](../../docs/asgardex-recon.md) is the measurement this port was
committed to on.

## Running it

```bash
orivon-port run asgardex
```

Then open `http://127.0.0.1:8876` in Orivon and accept the prompt -- or `asgardex.eth` instead,
once the shell is launched with `orivon-port names`' output pointed at
(`ORIVON_ETH_NAMES_FILE=.../out/names.json npm run dev`, run from `orivon-mvp` -- the top-level
[`README.md`](../../README.md)'s "Opening it by name instead of by port" has the exact command; it
resolves to nothing without this). That name is fake, not ENS, and gets a session-scoped grant
like any other plain-`http` origin (`docs/recipe-format.md`'s `eth` field).

No build wrapper, and no `.env`. Upstream's `electron-vite` renderer target is the target this
port wants, so the recipe runs upstream's own `build` script unmodified; every `VITE_*` value the
app reads falls back to a working public endpoint (`src/shared/utils/env.ts`'s `envOrDefault`), so
an unconfigured build talks to the same services the packaged app does.

Two notes on the toolchain, both of which the recipe encodes:

- Upstream vendors Yarn 4 at `.yarn/releases/yarn-4.17.0.cjs`, so the recipe runs it through
  `node` rather than through a `yarn` on `PATH`. On a Debian-family machine `/usr/bin/yarn` is
  frequently cmdtest's unrelated program of the same name, and it fails in a way that does not
  look like the wrong binary.
- `--mode=skip-build` skips upstream's `postinstall`, which is `electron-builder install-app-deps`
  — a native rebuild of `node-hid` and `usb` plus the Electron binary download. A renderer bundle
  needs none of it.

## The seam

Fourteen `contextBridge.exposeInMainWorld` globals, sixty-nine members.

| Bucket | Count | What it means |
|---|--:|---|
| Needs a capability (`orivon.fs`) | 33 | The seven JSON stores, the keystore wallet file, and the three file-exchange members |
| Refused by name | 21 | Ledger's six device members and MPC's fifteen vault and signing members |
| Constant | 7 | An SDK that reports itself not up, no vaults, no Ledger addresses, no newer release |
| Hand-written, no capability | 6 | MPC's event listeners |
| Inert | 1 | `apiLang.update` |
| The browser already does it | 1 | `apiUrl.openExternal` |

**The capability ratio is the result worth keeping.** FreeTube needed a capability for 3 of 34
members; ASGARDEX needs one for 33 of 69. The porting guide's expectation that a bigger app is
mostly more inert members does not generalise — what a bridge costs depends on what the preload
was *for*, and ASGARDEX's exists almost entirely to reach the filesystem. The cost did not track
the ratio either: all 33 land on one capability through one factory, so the bridge is 320 lines.

The seven storage globals are one implementation with seven names, not seven implementations:
`fileStore(owner, fileName)` in [`bridge/asgardex.js`](bridge/asgardex.js) is called once per
store — looking its default up from `STORE_DEFAULTS` by that same file name — and differs only in
which file it reads. That is why 28 of the 69 members cost almost nothing.

### The escape test

Upstream's three file-exchange members go through Electron's native dialogs, which is the shape
the porting guide warns about — a dialog hands the renderer a host path, and `orivon.fs`
deliberately never does. All three pass anyway, because upstream keeps the path inside its main
process: `load` resolves the **parsed keystore**, and `exportKeystore` and `saveBalancesJson`
resolve **void**. So each is rebuilt over `orivon.fs.userSelected` with the handle kept inside the
bridge's closure, and the port needed **zero app edits**.

## What this port does not do

Both are refused by name, with a reason a person reading the console can act on.

- **Ledger.** Upstream drives the device from its main process through
  `@ledgerhq/hw-transport-node-hid-singleton`. Chromium has WebHID, so the power is not missing
  from the browser — but reaching it would mean writing a Ledger transport into this bridge, which
  is the porting guide's own "when to stop". `getLedgerAddresses` answers an empty list rather
  than refusing, so the wallet view mounts showing no Ledger accounts instead of failing to load.
- **Vultisig MPC vaults.** `@vultisig/sdk` runs in the main process against Node, and vault
  material lives outside the app's own directory. `listVaults` answers an empty list for the same
  reason.
- **The in-app updater.** A port's version is its pinned commit, so `api.github.com` is
  deliberately absent from [`orivon.json`](orivon.json) and nothing here reaches GitHub. The
  check answers "nothing newer" rather than refusing, because `hooks/useAppUpdate.ts` passes the
  call's result straight into `Rx.from` — a synchronous throw escapes its own `catchError` and
  surfaces as an uncaught error during mount. For a pinned commit, "checked, nothing newer" is
  also simply true.

The keystore wallet path — create, unlock, hold, export, import — is whole, and that is what most
people use ASGARDEX for.

## Design notes

**Why the tab icon is a rewrite rather than an injection.** Upstream's renderer already declares
`<link rel="icon" href="/favicon.ico" />`, but that file is Electron's stock placeholder, not
ASGARDEX's mark, and the Vite build does not copy `public/` into `build/renderer`, so it is absent
from the served tree anyway and a browser tab falls back to a globe. The root-absolute href is
also the one URL here that would not survive a path-gateway mount. [`hooks.mjs`](hooks.mjs)
rewrites that one attribute to a path relative to the document, and `recipe.json`'s `extraFiles`
copies the app's real branding icon, `resources/icons/128x128.png` (8 KB, under Orivon's 32 KB
favicon cap), into the served tree. Nothing of upstream's is tracked.

**Why the bridge carries a copy of upstream's default settings.** It is the one piece of
configuration this port reproduces rather than re-creates, and it is load-bearing.

Upstream's main process merges every settings read and every settings write against
`DEFAULT_STORAGES.common` (`src/shared/const.ts`), so a save always resolves a **complete**
record. The renderer then replaces its whole in-memory settings state with whatever came back
(`src/renderer/services/storage/common.ts:161`) and reads each field through
`O.map(…)` then `O.getOrElse(() => DEFAULT_…)`.

Those two halves are safe together and unsafe apart, because the renderer sends **partial** saves
— `modifyStorage(O.some({ midgard }))` is a real call site. A store that merged only against what
it had on disk would hand back `{ midgard }` alone, and fp-ts would not rescue it: `O.map` over a
missing key yields `Some(undefined)`, not `None`, so `getOrElse` never fires. Every other chain
endpoint would become `undefined`, each client would issue requests against a relative URL, and
the app would 404 quietly against its own origin with no exception anywhere. That is the failure
shape this repository has a rule about, and no test of the bridge's own members would have caught
it.

The copy is fifteen keys, it was evaluated from upstream's own source rather than transcribed, and
[`UPSTREAM.md`](UPSTREAM.md) says it must be re-evaluated when the pin moves.
[`bridge/asgardex.test.ts`](bridge/asgardex.test.ts) pins the key set so a field added upstream
fails a test; only re-evaluating catches a changed value.

**Why all seven stores carry a default.** The bridge reproduces upstream's own contract
(`src/main/api/fileStore.ts`'s `getFileContent`): a read never rejects, and with nothing stored it
resolves that store's own default. `STORE_DEFAULTS` in [`bridge/asgardex.js`](bridge/asgardex.js)
holds one entry per store, keyed by file name, and `fileStore` looks a store's default up rather
than taking one as an argument — a store with no entry throws at install, before the app's bundle
runs, rather than at the first unlucky read.

The tempting shortcut is to give only `common` and `pools` a default and let the other five
**reject** instead, on the theory that a rejected read puts the renderer's own state at `O.none`
and lets its own current default apply. That is true of `common.ts` alone — it is the only storage
service whose *read* streams fall back per field, with `O.getOrElse(() => DEFAULT_MIDGARD_URLS)`
and friends. The other five put `O.getOrElse(() => [])` in their read streams, and reach the
upstream default only from their *write* paths (`addChain`/`removeChain` and siblings). A rejected
read there means **empty**, not **default** — and `observableState`'s `BehaviorSubject` is seeded
`O.none`, so the empty answer is the only one the stream ever gives.

That is not hypothetical: it is the bug this port shipped with. `userChains` rejecting left
`userChains$` emitting `[]` forever, so every chain read as disabled —
`components/swap/Swap.tsx`'s swap screen reported every asset's chain unavailable, and every
`Rx.combineLatest([])` fed by an empty chain list (`hooks/usePoolShares.ts`'s LP shares,
`views/wallet/history/WalletHistoryView.tsx`'s history, and every TCY balance in
`services/wallet/balances.ts`) emits nothing and completes, so those screens never left their
loading state. `userAssets` rejecting meant the wallet's own default stablecoin list never
appeared.

`pools` keeps its own second, independent reason: its reader
(`services/storage/pools.ts`) calls `.then()` with no rejection handler, so a rejected read there
would be an unhandled rejection rather than a caught one. Upstream's own empty watchlists are the
answer regardless.

Three of the seven — `userNodes`, `userBondProviders` and `userAddresses` — default to empty
collections upstream, so rejecting them was harmless, by coincidence rather than by reasoning; they
carry a default now only to keep the contract uniform rather than because their store would
otherwise misbehave. [`UPSTREAM.md`](UPSTREAM.md) grades which of the seven can actually go stale
when the pin moves.

**Why the six MPC listeners are hand-written rather than declared.** Each returns its own
unsubscribe, which the app calls from a React effect teardown; the kit's `listeners` recorder
returns `undefined`, and an unmount would fail with `cleanup is not a function`. "Record the
callback, return an unsubscribe" is the standard Electron `on`/`removeListener` shape and will
appear again — when a second port wants it, it has earned a place in the kit's catalog rather than
in one app's file.

**Why the manifest declares `*:*` next to twenty-four literal hosts.** The literals are every
endpoint the app's own `src/shared/*/const.ts` defaults to. Nothing narrower than `*:*` is honest
alongside them: the settings screen lets a person point any chain at any RPC URL, and several
chain clients carry their own endpoint defaults inside their `@xchainjs/*` packages rather than in
the app's source. A person reading the dialog should see that this app can reach the network
generally, because it can.

**`consentGranularity` is `all-or-nothing`.** ASGARDEX has no code path for a capability it
declared being refused, and the manifest contract says silence means exactly this. Declining is
the whole decision; there is no smaller version of a wallet that cannot reach its own storage.
