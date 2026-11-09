# `apps/ledger-wallet/`: upstream Ledger Wallet, unmodified, as an Orivon app

## About this build

**A community build by Orivon of Ledger Wallet, not the official Ledger Wallet.** Ledger Wallet is the desktop app for managing crypto with a Ledger device, once called Ledger Live. This directory holds the recipe that builds it to run in Orivon; the upstream project did not make this build.

| | |
|---|---|
| Official project | [github.com/LedgerHQ/ledger-live](https://github.com/LedgerHQ/ledger-live) |
| Official downloads | <https://www.ledger.com/ledger-wallet> |
| Pinned upstream | 4.26.1 (`@ledgerhq/live-desktop@4.26.1`), commit `8b363b1bfba6` |
| This build's version | 4.26.1.1 (upstream 4.26.1, build 1) |
| Licence | MIT, upstream's own; see [`UPSTREAM.md`](UPSTREAM.md) |
| Recipe | [`recipe.json`](recipe.json), [`orivon.json`](orivon.json) |
| In another browser | This page shows a landing instead of the app, because the build needs parts Orivon provides, a device connection and a file store. |
| Updates | When upstream releases a new version, the pin is moved and the build is redone ([maintaining a port](../../.claude/skills/orivon-porting/maintain.md)); there is no schedule. The app's own update checker is left as upstream wrote it. |
| Problems | [Report a problem with this build](https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=Ledger%20Wallet): it goes to this repository's issue form, not to the upstream project's tracker. |

Known gaps in this build:

- **The dapp browser's Ethereum provider** is not installed.
- **Importing a Ledger Live data folder** or data from before 2020 is not supported, and a data folder cannot be opened from the app.
- **Zcash** accounts cannot be added: the Zcash engine is a native addon that the desktop app runs in a process of its own.
- **Analytics** requests are refused by the page's content policy; **feature flags** do reach Google (Firebase remote config).
- **Lottie animations** do not play: the player's WebAssembly file is fetched from `cdn.jsdelivr.net`, which the build does not grant. Orivon's consent prompt covers 132 hosts and calls them "a large number of sites".

The sections below are for people working on the build.

**What lives here.** A recipe, a manifest, a build wrapper and a bridge. Ledger Wallet (the
desktop app once called Ledger Live) is cloned at a pinned commit, its own rspack renderer build
runs through [`rspack.orivon.config.cjs`](rspack.orivon.config.cjs), and the part of its Electron
main process the page needs is re-created in [`bridge/ledger-wallet.js`](bridge/ledger-wallet.js).
Upstream builds its renderer as a page already, which reads one typed bridge, `window.lld`; the
port answers that bridge and changes nothing in the build but where the output goes.
**No Ledger source and no build output is in this repository**; [`UPSTREAM.md`](UPSTREAM.md) has
the licence, the pin and what to re-check when the pin moves.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Where upstream is, how pnpm, nx and rspack build it |
| [`orivon.json`](orivon.json) | The manifest: what the consent prompt shows |
| [`rspack.orivon.config.cjs`](rspack.orivon.config.cjs) | Upstream's renderer and worker configs, output moved, source maps off; every fact it relies on is asserted |
| [`tsc-wrapper.config.mjs`](tsc-wrapper.config.mjs) | Install-time shims for `tsc` in the clone, so the library build fits and finishes |
| [`bridge/`](bridge/) | `window.api` and `window.lld`, the bridge the renderer reads |
| [`hooks.mjs`](hooks.mjs) | Two edits to the built `index.html`: the bundler workaround script out, the renderer script handed to the bridge's gate |
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

- **Node 24 or later** (upstream's `engines`). pnpm 12.15.0 is installed into `out/ledger-wallet/pnpm`
  by the recipe; the machine's own pnpm is not used.
- It builds the workspace libraries first (`nx run ledger-live-desktop:build-lib-deps`, one at a
  time so the build stays under 5 GB), which is most of the time. A warm nx cache makes a rebuild
  take the renderer's 20 seconds. pnpm 12 verifies the lockfile against its supply-chain policy
  before it installs, and that step alone reaches about 4 GB.
- **Linux, macOS and Git Bash are what it was driven on.** `tsc-wrapper.config.mjs` also writes
  `.cmd` and `.ps1` shims for pnpm on Windows; those are not run anywhere yet.
- The output is about 630 files and 85 MB, with no source maps.

## The seam

Ledger Wallet's renderer is a page. It reads two globals, both installed by the bridge before the
bundle's first line, and nothing else of Electron's: `window.api` (three members) and `window.lld`,
the typed bridge of upstream's `src/bridge/contract.ts` (bridge version 7, bootstrap version 2). The
wrapper asserts both versions, the 14 members of `LedgerBridge` and the 33 channels of the contract,
so a release that changes any of them fails the build before it makes an app whose bridge is another
contract's.

| Piece | Where it is answered |
|---|---|
| `window.api` (`appDirname`, `appLoaded`, `reloadRenderer`) | Declared in [`bridge/members.json`](bridge/members.json), written in the bridge |
| `window.lld` (14 members) | The same: every member is written in the bridge, listed below |
| Devices | **Not the bridge.** Ledger's transport kit uses WebHID in the page; see [The device path](#the-device-path) |

### The members of `window.lld`

| Member | Answer | Why |
|---|---|---|
| `version`, `bootstrap` | `7`, and a frozen object read before the renderer starts: Linux, the one root `/orivon/app`, no environment, distribution `direct`, and the store | The renderer reads it synchronously at module load. A tab reports `linux` on every host, as `process.platform` does, so the app draws its own title bar. No host path or environment variable is handed to a page |
| `db.getKey`, `db.setKey` | Storage, `userData/app.json` in the app's files | Upstream's `db/index.ts`: same file shape, same key allow-list, same dotted key paths. Only the `app` namespace exists for a renderer |
| `db.hasEncryptionKey`, `db.setEncryptionKey`, `db.removeEncryptionKey`, `db.isEncryptionKeyCorrect`, `db.hasBeenDecrypted` | Same | A password-protected `accounts`, `trustchain` and `wallet` use upstream's exact format (aes-256-cbc, PBKDF2-SHA512, IV-salted) over WebCrypto, so a locked file stays locked and opens with the same password. Unlocking is atomic, replacing or removing a held key needs the current one, and attempts are throttled as upstream's are (five free, then one second doubling to thirty) |
| `db.resetAll`, `db.reload`, `db.cleanCache` | Same | Remove `app.json`, drop the in-memory state, null the countervalues |
| `store.set`, `store.clear` | `lld.json` in the app's files, read before the renderer starts | The renderer's small obfuscated `electron-store`; the file is in `electron-store`'s own format (a fixed password, the same cipher as the db) |
| `files.saveLogs`, `files.exportOperations`, `files.savePng` | A browser download, answered `saved` | A tab cannot write to a path; the bytes become a Blob download named by the save request. The outcome `canceled` cannot be told apart from a saved file in a download, so it is never answered |
| `files.openUserDataDirectory` | Refused, `shell-owned` | A page is not given the host path of its data |
| `power.keepScreenAwake`, `power.release` | `navigator.wakeLock`, an id handed back | Upstream hands out a power-save-blocker id |
| `deeplink.open`, `deeplink.onOpen` | Echoed to the listeners | Upstream's main sends a deep link the renderer raised back to the renderer |
| `app.reload`, `app.relaunch`, `window.api.reloadRenderer` | Reload the tab | A relaunch after a hard reset is a reload of the page |
| `app.quit` | Refused, `shell-owned` | A tab does not quit the browser |
| `app.show` | Inert | There is no window to show |
| `updater.init`, `updater.onStatus` | Accepted, never fired | There is no updater to tell. The updater finding nothing keeps the app mounted |
| `updater.quitAndInstall` | Refused, `excluded` | An update Orivon installs itself |
| `shell.openExternal` | A new tab without an opener, for `http`, `https`, `mailto`, `ledgerlive` and `ledgerwallet` | Main's own scheme check, again; Orivon decides what to ask for non-web schemes |
| `system.clipboardMatchesText` | `null` unless the page may already read the clipboard, else the comparison | The renderer warns only on `false`; a page that reads the clipboard without being asked would be a hole, and Orivon does not prompt for `clipboard-read` |
| `system.setVisualZoomLevelLimits`, `system.getResourceUsage` | Inert; `undefined` | The second only goes into exported logs |
| `webview.onMessage` | A Live App's message, when it came from the guest's main frame on an origin of the manifest's domains | See [Live Apps](#live-apps) |
| `webview.onDomainCheckViolation` | Accepted, never fired | The check that would report is upstream's main process, which a tab does not have |
| `zcash.invoke` | Refused, `not-built` | The engine is a native addon in a process of its own. `zcash.subscribe` returns a no-op unsubscribe |
| `cardSession.takeBootstrap` | `null` | Upstream hands it over only in development and end-to-end runs |

### Live Apps

Ledger's Live Apps (Swap, Earn, the catalogue) run in a `<webview>`. Upstream's guest preload exposes
`window.ElectronWebview.postMessage`; the bridge installs the same in every page the app shows,
as the app's embed script (`orivon.web.setEmbedScript`), which sends the message to the `<webview>`
element as an `ipc-message`. The bridge hears those events on the document, and hands the app
a message only when upstream's main would: the element is a `<webview>`, the channel is
`webviewToParent` or `dappToParent`, the guest's current address is an `http` or `https` origin, and that origin is
one the element's `webpreferences` allow (`ledgerLiveAllowedOrigins`, a list of the manifest's domains
with upstream's matching, or `unrestricted`). A missing or malformed list allows nothing. The script
reaches a page's top frame only, so a frame inside a Live App cannot speak. Replies go to
`webview.contentWindow.postMessage`, which the page does itself.

## The device path

Ledger Wallet reaches a Ledger through its Device Management Kit, which uses **WebHID in the page**
(`navigator.hid.getDevices()` filtered to vendor `0x2c97`, plus `connect` and `disconnect` events).
Upstream's main process only picks the device for it. The bridge carries no device code; the
manifest declares `devices.hid: [{ "vendorId": 11415 }]`, Orivon's hardware grant, and Orivon asks the
person again for each specific device; the page sees a device only after the person allowed it.

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
- Page, continued: `blob-download-saves-without-dialog` (exports are Blob downloads),
  `permission-query-reads-prompt-when-a-request-would-ask` (the bridge reads a clipboard permission
  before it compares), `process-is-node-shaped` (the renderer reads `process`, and Linux is what it
  is told).
- Embedding: `webview-shows-local-pattern` for the element itself,
  `webview-remote-site-talks-to-the-app` for the Live Apps (a remote site's message, `getURL()`,
  `getWebContentsId()` and `contentWindow.postMessage`), `app-media-declared-is-asked-once` for the
  recipient QR scanner.
- Hardware: `app-hid-declared-opens-the-chooser`, `app-hid-device-asked-and-announced`,
  `app-hid-approved-device-is-remembered`.

## What this port does not do

- **A genuine check on an emulated device.** See [Testing with an emulated Ledger](#testing-with-an-emulated-ledger).
- **Lottie animations.** Their player is fetched as a WebAssembly file from `cdn.jsdelivr.net` (and `unpkg.com` as a second source); neither is granted, so the page shows no animation where upstream shows one.
- **Analytics and telemetry.** The manifest grants none of Segment, Datadog, Braze or Sentry, nor
  Ledger's button-tracking endpoint (`ledgerb.api.ledger.com`). The renderer starts them (the
  first-run drawer asks the person first, and "Refuse all" works) and their requests are refused by the
  page's content policy, whatever was answered.
- **Feature flags do reach Google.** Swap, Yield and the new home screen are switched on by Ledger's
  Firebase remote config, so the manifest grants `firebaseremoteconfig.googleapis.com` and
  `firebaseinstallations.googleapis.com`; without them Swap shows "Network Error" because its Live App
  manifest id comes from a flag. The installation call gives Google an installation id. Dropping both
  hosts keeps the id away at the cost of those features. The realtime endpoint
  (`firebaseremoteconfigrealtime.googleapis.com`), which pushes a flag change to a running app, is not
  granted: a flag changes on the next load.
- **Dapp browser.** Ledger's Live Apps run in a `<webview>` whose guest script is installed as the
  embed script, which answers `window.ElectronWebview.postMessage` (the Wallet API). The
  second guest script, which injects an Ethereum provider into a dapp page, is not installed: one
  embed script serves every page the app shows, and a provider would reach every Live App.
- **Navigation limits of a Live App.** Upstream's main process pins a Live App's main frame to its
  manifest's domains and adds a content policy to the guest's responses; a tab has neither. The
  bridge answers a Live App's messages only from the allowed origins, and drops the rest, so a Live
  App that navigates elsewhere goes silent without being stopped.
- **Zcash.** Its engine is a native addon the desktop app runs in a utility process; the bridge refuses
  it by name.
- **Automatic updates and the native menu.** Orivon updates itself; there is no menu to Lock from.
- **Opening the data folder.** A page is not given its host path.
- **Importing a Ledger Live data folder or reading data from before 2020.** Blobs written with
  Node's removed `createDecipher` are refused with a message saying so.
- **A short consent line.** With 132 named hosts, Orivon's prompt says "Connect to a large number of
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

Then, in Ledger Wallet running in Orivon (hardware grants allowed), plug the emulator in before the app's tab
loads or reload the tab: Orivon asks to connect "Nano X" (Allow), and the page's `getDevices()` then lists it,
opens it and exchanges APDUs with the responder (`B001`, `E001`, `E004`). Home > Receive > Ethereum reaches
this step. Ledger Wallet then asks Ledger's server to authenticate the device's factory key (`E050`), which
Speculos cannot answer, and the flow ends in a "SecureChannelError" screen (the onboarding's connect path ends
at its authenticity check). Adding an account, Receive with Verify and Send therefore need a real Ledger:
Ledger Wallet has no setting that connects without the secure channel.

`docker logs orivon-vhid-*` (the virtual device's container) carries the responder's `apdu >` and `apdu <` lines.

**What the responder does.** The host picks the HID channel, so the responder answers on the one the first packet
used. It emulates the dashboard, because Speculos exits when its app quits: `B001`, `E001`, `B0A7`, `E004`
and `E0D8` (open `Ethereum`) are answered there and the rest goes to Speculos. A real Ledger leaves the USB
bus and returns after it opens or quits an app, so the device unplugs and plugs back in after `B0A7` and `E0D8`.
`test/speculos-responder.test.ts` covers the framing and these answers.

**Limits.** No emulator passes these, because Ledger's server authenticates the device's factory key (`E050`,
the secure channel):
- Onboarding's device picker and its genuine check.
- My Ledger: app installs and firmware updates.
- Ledger's device-kit connect path, which Ledger Wallet always uses for Add account, Receive and Send.

Two more are Orivon's and Ledger Wallet's, not the emulator's:
- Sign message is offered only to dapps and Live Apps, and dapps opened from Discover get no Ethereum provider
  in Orivon yet.
- The new asset picker omits testnets.

## Design notes

**The renderer is upstream's own page build, unpatched.** Upstream builds its renderer for a
context-isolated page: target `web`, a `process` shim of its own (`src/renderer/bootstrap/process.ts`),
browser fallbacks for the Node builtins, and no `electron` import. The wrapper asserts exactly that
(no `ElectronTargetPlugin`, no `electron` external) instead of patching it in, so a release that goes
back to a Node-shaped renderer fails the build, and nothing of Orivon's Node shim is bundled. What it
does change: the output folder (never upstream's own `.webpack`), source maps off (they would be most
of the served tree), and the icons alias below.

**The wrapper asserts the contract.** `src/bridge/contract.ts` is the typed list of what the renderer
can ask of its host. The wrapper reads it and fails the build, naming the difference, when the bridge
or bootstrap version, the set of `LedgerBridge` members, or the set of channels is not the one the
bridge answers. A new member is then bucketed in `bridge/members.json` and written, or refused by
name, before the app builds.

**`@ledgerhq/icons-ui` is aliased to the workspace package.** `react-ui` lists it as an injected
dependency, which pnpm copies at install time, before the library build produced the icon
components, so the copy has none. The wrapper asserts the built package exists before aliasing.

**A relaunch is a reload and an update never arrives.** Reloading is the honest equivalent of what
`app.relaunch` is for, and answering `updater` with silence is what an up-to-date app does. Refusing
either would break a flow that works in a tab.

**One namespace, one write timer.** A renderer reaches the `app` namespace only, so storage has one
file and one debounce (500 ms, as upstream's). The bridge flushes what is pending on `pagehide`.

**Library type errors do not stop the build.** Two coin modules fail type checking at the pin with
TypeScript 7 and 6 alike, and `tsc` still emits. The `tsc` shim passes every status through except 2
(diagnostics present, outputs written), and adds `--singleThreaded` for TypeScript 7 native, whose
default checkers exceed 5 GB on the UI library. The shim lives in the gitignored clone.

**Linux on every host.** `bootstrap.os` says `Linux`, the same as `process.platform` in an Orivon tab.
The renderer draws its own title bar and window buttons for `darwin` and `win32`; a tab has the
browser's, so the Linux layout is the one that fits.

**The renderer script is added by the bridge, once the page is an app tab and the store is read.**
The renderer needs the app tab's grants (storage through `orivon.fs`, the device) and the bootstrap
the bridge builds from the store file, which it reads synchronously at module load. Orivon gives a
page `process` (with `Buffer`, `global` and `setImmediate`) only in an app tab, after the person
allows the app, so `typeof process` is the bridge's signal that the grants are there. Before that, or
in an Orivon that refuses the manifest, the renderer would fail on its first storage read and show
Ledger's own crash screen. `hooks.mjs` takes the renderer's `<script defer src="./renderer.bundle.js">`
out of `index.html`; the bridge, a classic script that runs first, reads the store file and then
appends a script for the same file when `process` exists. Without it, it shows a centred message in
Ledger's dark style instead. The page is never stopped or aborted, so it still parses to
`DOMContentLoaded` with the `orivon-manifest` link, which is how Orivon discovers the app and asks
for consent. The hook fails the build when the tag is missing, so an upstream change to that tag
cannot leave a gate that does nothing.

**A Live App speaks through the page, so the gate is the page's.** Upstream's main process decides
which guest messages reach the app: only the guest's main frame, only on an origin of the manifest's
domains. In a tab the message arrives as an event on the `<webview>` element, so the bridge applies
the same decision to that event, with upstream's own domain matching (`isUrlAllowedByManifestDomains`)
and its fail-closed treatment of a missing or malformed list. A frame inside a Live App never speaks,
because the embed script reaches a page's top frame only.
