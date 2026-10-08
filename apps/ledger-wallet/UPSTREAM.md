# Upstream: Ledger Wallet

| | |
|---|---|
| Source | `https://github.com/LedgerHQ/ledger-live`, the app in `apps/ledger-live-desktop` |
| Pinned commit | `abed962b08ca4b746f20192b28ce5b6c06a6c6a4` (tag `@ledgerhq/live-desktop@4.23.0`) |
| Licence | MIT |

The product was called Ledger Live until its 2026 rename; the repository, the package and the
user-data folder keep the old name. The pin is a release tag's commit, not a branch tip.

## What crosses into this repository

**Nothing of Ledger's.** The clone lives in `out/ledger-wallet/source/` and the build output in
`out/ledger-wallet/static/`, both gitignored and both reproducible from [`recipe.json`](recipe.json).
`npm run check:no-upstream` fails the build if either is ever tracked.

What is ours, and written from scratch:

- [`recipe.json`](recipe.json) and [`orivon.json`](orivon.json)
- [`rspack.orivon.config.cjs`](rspack.orivon.config.cjs), a wrapper that loads upstream's own renderer
  and worker config factories and patches the built objects. Upstream's config is not copied.
- [`tsc-wrapper.config.mjs`](tsc-wrapper.config.mjs), which writes shell shims into the clone's
  gitignored `node_modules/.bin`. It edits no upstream file.
- [`bridge/members.json`](bridge/members.json) and [`bridge/ledger-wallet.js`](bridge/ledger-wallet.js),
  which re-create the *shape* of upstream's preload (`window.api`) and of its main process's `ipcMain`
  handlers over the page and `orivon.fs`.
- [`hooks.mjs`](hooks.mjs), which adds the tab icon link.

## What this port copies rather than re-creates

[`bridge/ledger-wallet.js`](bridge/ledger-wallet.js) carries three configuration snapshots and two
presets. None is program text.

- **The key paths of the `app` namespace** (`APP_NAMESPACE_ALLOWED_KEY_PATHS` and
  `APP_NAMESPACE_KEEP_LEGACY` in `src/main/db/index.ts`). A key outside the list is dropped when the
  file is read and refused when it is written, as upstream does, so a list that lags the pin loses
  data silently. Re-read both when the pin moves.
- **What an empty password-protected path is encrypted as** (`ENCRYPTION_PATH_DEFAULTS`): `accounts`
  `[]`, `trustchain` upstream's `INITIAL_STATE`, `wallet` the exported initial wallet state. They were
  *evaluated from upstream's own slices, never typed by hand*, with esbuild run from the clone's
  `apps/ledger-live-desktop` over an entry file that imports `accountNamesSlice`,
  `starredAccountsSlice`, `walletSyncSlice`, `nonImportedAccountsSlice`, `recentAddressesSlice`,
  `contactsInitialState` and `INITIAL_STATE`, calls each slice's reducer with `{ type: "@@INIT" }`,
  shapes the result as `exportWalletState` does (`wallet.core.ts`) and prints JSON. A field added to
  that state upstream turns an empty protected file into one the renderer reads with a missing field.
- **The encryption presets** (`src/main/db/crypto.ts`): aes-256-cbc, a 16-byte IV, PBKDF2 over SHA-512
  with 10000 iterations, salted with the IV read as UTF-8. They are the file format; changing them locks
  a person out of their data. `bridge/ledger-wallet.test.ts` checks both directions against Node's own
  crypto doing what upstream does.
- **`EXPORT_MAX_LOGS`**, 5000 (`shared/env/src/definitions/team-platform`), and the app version
  `4.23.0` the bridge answers `electron-store` with (`apps/ledger-live-desktop/package.json`).

## What to re-check when the pin moves

| What | Why |
|---|---|
| Every `ipcRenderer.invoke` and `ipcRenderer.send` channel in `apps/ledger-live-desktop/src` | A new channel answers `No handler registered`, the same as Electron with no handler. `grep -rhoE 'ipcRenderer\.(invoke\|send)\("[^"]+"' src` lists them |
| Every `from "electron"` in the renderer | The stand-in object has four members: `ipcRenderer`, `clipboard`, `shell`, `webFrame` |
| The three snapshots above | See the list above |
| `tools/rspack/rspack.renderer.ts` | The wrapper asserts every patch it makes; a build that fails there says which one no longer matches |
| The library build (`tsc` exits 2 on two coin modules) | See `tsc-wrapper.config.mjs` |
| The hosts in `orivon.json` | `grep -oE '(https?\|wss?)://[a-z0-9.-]+' ` over the built bundle, minus analytics |

## What we never do

- Edit Ledger's source. This port needed no app edits: the one path that leaves the renderer, the
  save dialog's result, is only tested for truthiness and handed back, so it carries a file name.
- Fork its build config. The wrapper requires it and patches the object.
- Send anything to Ledger's analytics, error-reporting or in-app messaging services; see the README.

## Redistribution

MIT, so redistribution of a build carries only the notice requirement. This repository distributes
none of Ledger Wallet; a build of `out/ledger-wallet/static` served to other people is yours to ship,
and upstream's copyright notice and licence text travel with it.
