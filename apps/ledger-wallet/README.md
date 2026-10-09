# `apps/ledger-wallet/`: upstream Ledger Wallet, unmodified, as an Orivon app

**What lives here.** A recipe, a manifest, a build wrapper and a bridge. Ledger Wallet (the
desktop app once called Ledger Live) is cloned at a pinned commit, its own rspack renderer build
runs through [`rspack.orivon.config.cjs`](rspack.orivon.config.cjs), and the part of its Electron
main process the page needs is re-created in [`bridge/ledger-wallet.js`](bridge/ledger-wallet.js).
**No Ledger source and no build output is in this repository**; [`UPSTREAM.md`](UPSTREAM.md) has
the licence, the pin and what to re-check when the pin moves.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Where upstream is, how pnpm, nx and rspack build it |
| [`orivon.json`](orivon.json) | The manifest: what the consent prompt shows |
| [`rspack.orivon.config.cjs`](rspack.orivon.config.cjs) | Upstream's renderer config, patched for a tab; every patch asserts it hit |
| [`tsc-wrapper.config.mjs`](tsc-wrapper.config.mjs) | Install-time shims for `tsc` in the clone, so the library build fits and finishes |
| [`bridge/`](bridge/) | `window.api`, and the object the renderer's `import ... from "electron"` becomes |
| [`hooks.mjs`](hooks.mjs) | The tab icon link |
| [`test/emulated-ledger.ts`](test/emulated-ledger.ts) | One command: Speculos plus a virtual Nano X, with its unit test |
| [`test/speculos-responder.ts`](test/speculos-responder.ts) | The virtual Nano X's brain: Ledger HID framing to Speculos, with its unit test |

## Running it

```bash
node src/cli.ts run ledger-wallet        # clone, install, build, serve on http://127.0.0.1:8892
```

Open the address in Orivon and accept the prompt. By name: `ledgerwallet.orivonstack.eth`, once
`orivon-port names` has written `out/names.json` and Orivon was started with
`ORIVON_ETH_NAMES_FILE` (the root README has the command).

Build notes:

- **Node 24 or later** (upstream's `engines`). pnpm 10.24.0 is installed into `out/ledger-wallet/pnpm`
  by the recipe; the machine's own pnpm is not used.
- **`ORIVON_MVP_ROOT`** names an orivon-mvp checkout, `../orivon-mvp` by default. The wrapper reads
  the Node shim's alias table from it and compiles the shim into the bundle, as the-lounge does. The
  build stops naming the variable when the table is not there.
- It builds 179 workspace libraries first (`nx run ledger-live-desktop:build-lib-deps`, one at a
  time so the build stays under 5 GB), which is most of the time. A warm nx cache makes a rebuild
  take the renderer's 20 seconds.
- **Linux, macOS and Git Bash are what it was driven on.** `tsc-wrapper.config.mjs` also writes
  `.cmd` and `.ps1` shims for pnpm on Windows; those are not run anywhere yet.
- The output is 595 files and 86 MB, mostly the renderer's chunks. Source maps are not emitted.

## The seam

Ledger Wallet's renderer talks to its main process through `ipcRenderer` (36 channels), through a
three-function preload (`window.api`) and through four `electron` members it imports directly.

| Piece | Where it is answered |
|---|---|
| `window.api` (4 members) | Declared in [`bridge/members.json`](bridge/members.json): `openWindow` inert, three in the bridge |
| `electron` (`ipcRenderer`, `clipboard`, `shell`, `webFrame`) | The wrapper maps `electron` to `window.ledgerElectron`, which the bridge installs before the bundle's first line |
| The ipcMain channels | One table in the bridge, `invokeChannels` and `sendChannels`, below |
| Devices | **Not the bridge.** Ledger's transport kit uses WebHID in the page; see [The device path](#the-device-path) |

### Channels

| Channel | Answer | Why |
|---|---|---|
| `getKey`, `setKey` | Storage, `userData/<ns>.json` in the app's files | Upstream's `db/index.ts`, same file shape, same key allow-list, same dotted key paths |
| `hasEncryptionKey`, `setEncryptionKey`, `removeEncryptionKey`, `isEncryptionKeyCorrect`, `hasBeenDecrypted` | Same | A password-protected `accounts`, `trustchain` and `wallet` use upstream's exact format (aes-256-cbc, PBKDF2-SHA512, IV-salted) over WebCrypto, so a locked file stays locked and opens with the same password |
| `resetAll`, `reload`, `cleanCache` | Same | Remove `app.json`, drop the in-memory state, null the countervalues |
| `reloadRenderer`, `app-reload`, `app-relaunch` | Reload the tab | A relaunch after a hard reset is a reload of the page |
| `show-save-dialog`, `export-operations`, `save-logs`, `save-png` | A browser download | A tab cannot write to a path. The renderer only tests the dialog's `filePath` for truthiness and hands the object back, so it carries the file name and the bytes become a download (the escape test passes without a faked path) |
| `activate-keep-screen-awake`, `deactivate-keep-screen-awake` | `navigator.wakeLock`, an id handed back | Upstream hands out a power-save-blocker id |
| `deep-linking` (send) | Echoed to the listeners | Upstream's main sends a deep link the renderer raised back to the renderer |
| `show-app`, `ready-to-show`, `set-background-color`, `setEnv`, `webview-dom-ready`, `updater` (`init`) | Inert | There is no window, no second process and no updater to tell. The updater finding nothing keeps the app mounted |
| `getPathUserData`, `getPathHome`, `sendSync('electron-store-get-data')` | `/orivon/app` | The one root every Node-shaped path in a tab agrees on, which `orivon.fs` maps onto the app's files. The renderer's small obfuscated `electron-store` (`lld.json`) asks for it synchronously |
| `openUserDataDirectory` | Refused, `shell-owned` | A page is not given the host path of its data |
| `show-open-dialog` | Refused, `not-built` | Returns host paths, which `orivon.fs.userSelected` never does; nothing in the renderer calls it |
| `app-quit` | Refused, `shell-owned` | A tab does not quit the browser |
| `internalCrashTest`, `updater` (`quit-and-install`) | Refused, `excluded` | A debug crash of the main process; an update Orivon installs itself |
| `transport:open`, `exchange`, `close`, `listen`, `listen:unsubscribe` | Refused, `not-built` | These serve Speculos and an HTTP proxy for developers. Real devices use WebHID |
| `lock`, `updater` events | Listeners accepted, never fired | They come from the native menu and the updater |

An `invoke` on a channel upstream does not handle rejects `No handler registered for '<name>'`, as
Electron does.

### What the stand-in `electron` members do

- `clipboard.writeText` writes with `navigator.clipboard`; `readText` returns what this page last
  wrote, because a page cannot read the system clipboard synchronously. Its one caller compares the
  read with what it wrote to warn that another program changed the clipboard, so that warning
  cannot appear here.
- `shell.openExternal` opens a new tab. Orivon decides what to ask for non-web schemes.
- `webFrame.setVisualZoomLevelLimits` does nothing; `getResourceUsage` answers `{}`, and only goes
  into exported logs.

## The device path

Ledger Wallet reaches a Ledger through its Device Management Kit, which uses **WebHID in the page**
(`navigator.hid.getDevices()` filtered to vendor `0x2c97`, plus `connect` and `disconnect` events).
Upstream's main process only picks the device for it. The bridge carries no device code; the
manifest declares `devices.hid: [{ "vendorId": 11415 }]`, Orivon's hardware grant, and Orivon asks the
person again for each specific device. Until that runtime has shipped, the loader may not accept
the manifest, and no device is visible to the page.

## What it needs from orivon-mvp

Rows of orivon-mvp's `test/app-behaviours/catalogue.md` this port relies on:

- Consent and grants: `consent-question-holds-the-page`, `loopback-manifest-hint-grants-the-origin`,
  `granted-capabilities-are-reported`.
- Network: `routed-fetch-reaches-granted-hosts`, `routed-fetch-delivers-whole-body`,
  `concurrent-sockets-limit-holds` (Ledger's backends are REST and the script runner is a
  `wss:` socket over the same host grant).
- Storage: `app-files-survive-restart`, `fs-quota-refuses-past-limit`, `localstorage-survives-restart`,
  `indexeddb-survives-restart`.
- Page: `secure-context-on-app-origin` (WebCrypto for the password format), `pagehide-fires-on-tab-close`
  (the bridge writes pending storage), `wake-lock-request-settles`, `clipboard-write-without-prompt`,
  `window-open-noopener-opens-tab`, `page-declared-favicon-shows`.
- Embedding: `webview-shows-local-pattern` for the element itself, `app-media-declared-is-asked-once`
  for the recipient QR scanner.
- Hardware: `devices.hid`, which the catalogue marks not covered until its runtime merges.

Behaviours nothing proves yet, handed to orivon-mvp as prompts in the pull request description:
a Blob download link saving a file, a `<webview>` showing a remote site with the app's embed script
and `contentWindow.postMessage` answering, and a per-element guest preload.

## What this port does not do

- **Devices before the hardware grant's runtime lands.** See [The device path](#the-device-path).
- **Analytics and telemetry.** The manifest grants none of Segment, Datadog, Braze or Sentry, nor
  Ledger's button-tracking endpoint (`ledgerb.api.ledger.com`). The renderer starts them (the
  first-run drawer asks the person first, and "Refuse all" works) and their requests are refused by the
  page's content policy, whatever was answered.
- **Feature flags do reach Google.** Swap, Yield and the new home screen are switched on by Ledger's
  Firebase remote config, so the manifest grants `firebaseremoteconfig.googleapis.com` and
  `firebaseinstallations.googleapis.com`; without them Swap shows "Network Error" because its Live App
  manifest id comes from a flag. The installation call gives Google an installation id. Dropping both
  hosts keeps the id away at the cost of those features.
- **Dapp browser.** Ledger's Live Apps run in a `<webview>` whose guest script is installed as the
  embed script, which answers `window.ElectronWebview.postMessage` (the Wallet API). The
  second guest script, which injects an Ethereum provider into a dapp page, is not installed: one
  embed script serves every page the app shows, and a provider would reach every Live App.
- **Automatic updates and the native menu.** Orivon updates itself; there is no menu to Lock from.
- **Opening the data folder.** A page is not given its host path.
- **Importing a Ledger Live data folder or reading data from before 2020.** Blobs written with
  Node's removed `createDecipher` are refused with a message saying so.
- **A short consent line.** With 130 named hosts, Orivon's prompt says "Connect to a large number of
  sites" and "more than can be weighed individually". The list is exact on purpose; a shorter one
  loses coin families.
- **Origins.** The Live App catalogue is served remotely, so `web.embed` is `["*"]`: any public
  site, as the prompt says.

## Testing with an emulated Ledger

The hardware path (the `devices.hid` grant, the per-device question, WebHID I/O) runs against a Nano X emulated
by [Speculos](https://github.com/LedgerHQ/speculos), with Ledger's Ethereum app 1.22.5. Ledger Wallet needs
Ethereum 1.22.5 or later (its `config_nanoapp_ethereum`); an older app makes it report an outdated app and quit
it to look for an update, which needs Ledger's servers. This works on Linux with Docker, `/dev/uhid` and an
orivon-mvp checkout with the virtual HID tool (`../orivon-mvp`, or `ORIVON_MVP_ROOT`).

```bash
node apps/ledger-wallet/test/emulated-ledger.ts
```

It builds the app once into `out/speculos/app-1.22.5-nanox.elf` (Ledger's source at tag
`nanox_2.7.1_1.22.5_sdk_v26.6.2`, in Ledger's builder image, a few minutes), restarts a Speculos container on
`127.0.0.1` with `--restart on-failure`, and plugs a virtual Nano X (USB `2c97:4011`) in front of it until Ctrl+C
or `ORIVON_SPECULOS_HOURS` (8). Settings, with defaults: `ORIVON_SPECULOS_NAME` (`orivon-speculos`),
`ORIVON_SPECULOS_APDU_PORT` (`9999`), `ORIVON_SPECULOS_REST_PORT` (`5000`), `ORIVON_SPECULOS_MODEL` (`nanox`, the
only one), `ORIVON_SPECULOS_SERIAL` (`0001`). Ctrl+C unplugs the device and leaves the container running;
`docker rm -f <name>` removes it. Two emulators at once need different names, ports and serials.

Then, in Ledger Wallet running in Orivon (hardware grants allowed; Orivon asks to connect "Nano X": Allow):

1. Turn on developer mode: Settings > About, click the version several times (Settings > Developer once shown).
2. Set the feature-flag override `ldmkConnectApp` to off (the flags button in the top bar). Ledger's remote
   configuration turns it on, and its connect path then uses the secure channel.
3. Add account > Ethereum finds the Speculos seed's accounts; the first is
   `0xDad77910DbDFdE764fC21FCD4E74D71bBACA6D8D`.
4. Receive with Verify shows the address on the emulated screen. Press the buttons on Speculos' web UI at
   `http://127.0.0.1:5000`, or `curl -s -X POST -d '{"action":"press-and-release"}' 127.0.0.1:5000/button/right`
   (`left`, `right`, `both`).
5. Send needs funds, and Speculos' seed holds none on mainnet (and its mnemonic is public, so never put real
   funds on it). A Hoodi-testnet account seeded the way Ledger's own end-to-end tests seed accounts, with
   `DISABLE_TRANSACTION_BROADCAST` set, reaches the device and is signed there.

`docker logs orivon-vhid-*` (the virtual device's container) carries the responder's `apdu >` and `apdu <` lines.

**What the responder does.** The host picks the HID channel, so the responder answers on the one the first packet
used. It emulates the dashboard, because Ledger Wallet quits the open app (`B0A7`) before anything else and
Speculos exits when its app quits: `B001`, `E001`, `B0A7`, `E004` and `E0D8` (open `Ethereum`) are answered
there and the rest goes to Speculos. A real Ledger leaves the USB bus and returns after it opens or quits an
app, and Ledger Wallet waits for that, so the device unplugs and plugs back in after `B0A7` and `E0D8`.
`test/speculos-responder.test.ts` covers the framing and these answers.

**Limits.** No emulator passes these, because Ledger's server authenticates the device's factory key (`E050`,
the secure channel):
- Onboarding's device picker and its genuine check.
- My Ledger: app installs and firmware updates.
- Ledger's device-kit connect path, which is what `ldmkConnectApp` on selects.

Two more are Orivon's and Ledger Wallet's, not the emulator's:
- Sign message is offered only to dapps and Live Apps, and dapps opened from Discover get no Ethereum provider
  in Orivon yet.
- The new asset picker omits testnets.

## Design notes

**The renderer is built from upstream's Electron target, switched to a page.** `target:
electron-renderer` compiles every Node builtin to `require("fs")`; a tab has no `require`. The
wrapper changes the target to `["web", "es2020"]`, answers 15 builtins from Orivon's shim, and maps
`electron` to a global. Nothing else in the config changes, so Ledger's `DefinePlugin` flags, the
`.web.ts` extension order and the code splitting are upstream's. Where upstream's config assumes
Node at run time, the wrapper changes exactly that: the production rule that emits animation JSON
and loads it with `__non_webpack_require__(path.join(__dirname, ...))` is dropped, so the 58 files are
bundled as JSON modules (10 MB), the way upstream's development build bundles them.

**`@ledgerhq/icons-ui` is aliased to the workspace package.** `react-ui` lists it as an injected
dependency, which pnpm copies at install time, before the library build produced the icon
components, so the copy has none. The wrapper asserts the built package exists before aliasing.

**A relaunch is a reload and an update never arrives.** Reloading is the honest equivalent of what
`app-relaunch` is for, and answering `updater` with silence is what an up-to-date app does. Refusing
either would break a flow that works in a tab.

**One write timer per namespace.** Upstream debounces storage writes by 500 ms with one timer
shared by every namespace, so a pending write of one is replaced by a write of another. The bridge
keeps a timer per namespace and flushes on `pagehide`.

**Library type errors do not stop the build.** Two coin modules fail type checking at the pin with
TypeScript 7 and 6 alike, and `tsc` still emits. The `tsc` shim passes every status through except 2
(diagnostics present, outputs written), and adds `--singleThreaded` for TypeScript 7 native, whose
default checkers exceed 5 GB on the UI library. The shim lives in the gitignored clone.

**The renderer script is written by the bridge, once the page has `process`.** Ledger's renderer
reads the global `process` while it loads, and Orivon installs `process` (with `Buffer`, `global`
and `setImmediate`) only in an app tab, which a page becomes after the person allows the app. Before
that, or in an Orivon that refuses the manifest, the renderer would throw and Ledger would show its
own crash screen. `hooks.mjs` takes the renderer's `<script defer src="./renderer.bundle.js">` out of
`index.html`; the bridge, a classic script that blocks parsing and runs first, writes the identical
tag with `document.write` when `typeof process !== 'undefined'`, so the renderer is still a
parser-inserted deferred script, only listed before Orivon's `hint.js` instead of after it (both run
before `DOMContentLoaded`). Without `process` it shows a centred message in Ledger's dark style
instead. The page is never stopped or aborted, so it still parses to `DOMContentLoaded` with the
`orivon-manifest` link, which is how Orivon discovers the app and asks for consent. A document no
longer being parsed is left alone, because a write then would replace the page. The hook fails the
build when the tag is missing, so an upstream change to that tag cannot leave a gate that does
nothing.
