# Port candidates

The apps this repository could port next. Every row ships an Electron desktop app upstream,
which is the precondition for a port here: the method in [`porting-guide.md`](porting-guide.md)
keeps an Electron renderer and replaces its main process, and there is nothing to keep in a Qt,
Tauri or Flutter app, or in a browser extension. Repositories, licences, maintenance state and
renderer shape were read from each upstream on 2026-09-22.

## What Orivon buys, and what it does not

In Orivon, an app is the renderer of somebody else's Electron program, built from a pinned
commit by its own toolchain on the user's machine, served from disk, and granted only what its
manifest declares. Three things the user stops having to trust:

- **The publisher's binary and its update channel.** The built-in updater is gone; the pinned
  commit is the version, and anyone can rebuild it.
- **The hosting of a web frontend.** A hosted DApp interface can be swapped under the user by
  whoever controls the DNS, the CDN or a dependency's npm account. A build served from
  `127.0.0.1` off the user's own disk cannot.
- **The privileged helper.** An Electron main process has all of Node. Orivon replaces it with
  capabilities the user consents to per origin, and the bridge refuses by name whatever the
  manifest does not declare.

What it does not buy: trust in the pinned source itself, or in the remote services the app talks
to. A wallet frontend pinned here still signs against whatever chain endpoint it is pointed at.

Both of those scopes are Orivon's. What this repository adds is only the recipe, the manifest,
the build wrapper and the bridge, so a candidate is judged on how much of it is already a web
page.

## How to read the tables

**Shape** is the porting guide's step 1 answer, before any recon has been run:

- **page** — the renderer talks to remote services or to nothing. The port is the bridge plus
  routed `fetch`. FreeTube is this shape.
- **page + device** — a page that also drives a hardware wallet. Chromium exposes WebUSB and
  WebHID, so when the app's own renderer uses them nothing is missing. When the app does it in
  main through `node-hid`, that group is refused by name until the shell decides on a device
  capability, and the software-wallet path still works.
- **page + native** — the renderer calls an in-process native addon through IPC: SQLCipher, a
  Rust N-API crate. Cheap when the native part is an optional feature (search, biometrics) that
  can be refused by name. Heavy when it is the protocol core.
- **daemon** — the renderer talks to a local helper that main spawns. Portable only when the
  helper speaks HTTP or WebSocket and the user can run it elsewhere; the manifest then declares
  that endpoint and the bridge answers "the helper is not here". Otherwise not a target.

An Electron app that only loads a remote website (Wire, Proton Mail, Jitsi) is not listed:
Orivon gains nothing over a browser tab.

**Cost** is a pre-recon estimate. `orivon-port recon` replaces it with the member count and the
capability ratio, which are the real answer.

**Licence** names the SPDX id, and says **decision** where it is not on the allowlist in
[`scripts/check-licences.ts`](../scripts/check-licences.ts): a person decides, then adds it.

## Wallets, exchanges and chain frontends

| # | App | Upstream | Licence | Status | Shape | Cost | What Orivon buys |
|--:|---|---|---|---|---|---|---|
| 1 | Polkadot-JS Apps | `polkadot-js/apps`, `packages/apps-electron` | Apache-2.0 | active | page; Ledger via WebUSB in the renderer | cheap | The Substrate frontend most signing goes through, currently trusted at `polkadot.js.org` |
| 2 | Alephium wallet | `alephium/alephium-frontend`, `apps/desktop-wallet` | LGPL-3.0 | active | page + device (WebHID/WebUSB in the renderer) | cheap | A wallet whose Ledger path already works without main |
| 3 | Umami | `trilitech/umami-v2`, `apps/desktop` | MIT | releases to 2025-09, pushed 2026-07 | page + device (WebUSB in the renderer) | cheap | Tezos wallet; same property as Alephium |
| 4 | Nault | `Nault/Nault` | MIT | releases to 2023-08, pushed 2026-09 | page; Ledger via `node-hid` in main | cheap | Nano wallet whose hosted copy at `nault.cc` is what users trust today |
| 5 | BitShares UI | `bitshares/bitshares-ui` | MIT | releases to 2023-09, pushed 2026-09 | page (remote WebSocket node) | cheap | A DEX interface; the hosted interface is the attack surface |
| 6 | Anchor | `greymass/anchor` | MIT | active | page + device (`node-hid` in main) | medium | Antelope/EOS wallet and signer |
| 7 | Asgardex Desktop | `asgardex/asgardex-desktop` | MIT | active | page + device (`node-hid` in main) | medium | THORChain swap client, where the client is the thing users had to trust |
| 8 | Symbol Desktop Wallet | `symbol/desktop-wallet` | Apache-2.0 | releases to 2025-09 | page + device (`node-hid` in main) | medium | Electron 11 upstream: an old toolchain to wrap |
| 9 | Sync2 | `vechain/sync2` | LGPL-3.0 | releases to 2024-02, pushed 2026-03 | page + device (`node-hid` in main) | medium | VeChain wallet and dapp signer |
| 10 | Solar Wallet | `satoshipay/solar` | MIT | dormant since 2023 | page (Horizon API only) | cheap | Stellar; the cleanest page shape in this group, but nobody is home upstream |
| 11 | MyMonero | `mymonero/mymonero-app-js` | BSD-3-Clause | releases to 2022-11, pushed 2026-02 | page (remote MyMonero API, WASM core) | cheap | Monero light wallet; dormant |
| 12 | Spark wallet | `shesek/spark-wallet`, `electron/` | MIT | dormant since 2021 | page (the user's own Spark server on Core Lightning) | cheap | The "your own node, this UI" pattern in its simplest form; dormant |
| 13 | Chia GUI | `Chia-Network/chia-blockchain-gui` | Apache-2.0 | active | daemon (`chia` Python daemon, WebSocket RPC) | heavy | Only against a daemon the user runs elsewhere |
| 14 | Daedalus | `input-output-hk/daedalus` | Apache-2.0 | active | daemon (`cardano-node` + `cardano-wallet` REST) + device | heavy | Only against a `cardano-wallet` the user runs elsewhere |
| 15 | Decrediton | `decred/decrediton` | ISC | active | daemon (`dcrd`/`dcrwallet` gRPC) + device | heavy | gRPC from a page needs a proxy the app does not have |
| 16 | Verus Desktop | `VerusCoin/Verus-Desktop` | MIT | active | daemon (`verusd`; has a lite mode) | heavy | Lite mode first, native mode never |
| 17 | Neuron | `nervosnetwork/neuron`, `packages/neuron-wallet` | MIT | active | daemon (bundled `ckb` light client) + device | heavy | CKB wallet |
| 18 | Rotki | `rotki/rotki`, `frontend/app` | AGPL-3.0 | active | daemon (Python backend on `127.0.0.1`) | heavy | Portfolio and tax tool; upstream ships the backend as a container, which is the remote-able case |
| 19 | Zingo PC | `zingolabs/zingo-pc` | MIT | active | page + native (`zingolib` Rust N-API is the wallet core) | heavy | Zcash; the core is native, not a page |
| 20 | Firefly | `iotaledger/firefly`, `packages/desktop` | Apache-2.0 | releases to 2025-06, pushed 2026-09 | page + native (`@iota/sdk` N-API) | heavy | IOTA; same problem as Zingo |
| 21 | Ledger Live Desktop | `LedgerHQ/ledger-live`, `apps/ledger-live-desktop` | MIT | active | device (USB HID from main) | heavy | The largest trust win in this table: the Connect Kit incident was a swapped frontend. Needs a device capability or WebHID routing, and it is a large monorepo |
| 22 | KeepKey Desktop | `keepkey/keepkey-desktop`, `packages/keepkey-desktop` | GPL-3.0 | quiet since 2025-09 | device (`node-hid`, `usb`) + in-process REST server | heavy | |
| 23 | Cypherock cySync | `Cypherock/cypherock-cysync`, `apps/desktop` | AGPL-3.0 | active | device (HID and serial, from main) | heavy | Chromium has Web Serial and WebHID; the app uses neither from the renderer |
| 24 | Trezor Suite | `trezor/trezor-suite`, `suite/desktop-app` | T-RSL, **decision** | active | device (`usb` + transport bridge in-process) | heavy | Source-available, not OSI; the allowlist stops it until a person decides |
| 25 | OneKey Desktop | `OneKeyHQ/app-monorepo`, `apps/desktop` | O-SSL, **decision** | active | device (USB/HID/BLE from main) | heavy | Same licence stop as Trezor |
| 26 | Rabby Desktop | `RabbyHub/RabbyDesktop` | MIT (brand clause) | releases to 2025-11 | device (`node-hid`) and an embedded extension acting as a dapp browser | recon first | Likely an Electron program rather than a page; the recon decides |
| 27 | RoboSats | `RoboSats/robosats`, `desktopApp/` | AGPL-3.0 | active | daemon (bundled Tor) | heavy | The web client is a page; the coordinators are onion services, and Orivon has no Tor |
| 60 | Galleon | `Cryptonomic/Galleon` | MIT | dormant since 2024-07 | page (Tezos RPC) | cheap | Tezos; Umami (#3) is the maintained one, this is the page-shaped fallback |
| 61 | AirGap Vault | `airgap-it/airgap-vault` | MIT | active | page — an air-gapped, offline signer with no preload at all | cheap | A cold-storage vault across many protocols; ported at `apps/airgap-vault/`. Its two ways to receive a sign request, camera and clipboard read, are both denied by the shell to every origin — see [`airgap-vault-recon.md`](airgap-vault-recon.md) |

## Decentralized networks and developer tools

| # | App | Upstream | Licence | Status | Shape | Cost | What Orivon buys |
|--:|---|---|---|---|---|---|---|
| 28 | Audius | `AudiusProject/apps`, `packages/web` | Apache-2.0 | active | page (remote Audius APIs) | cheap | Web3 music streaming; the desktop build is the web client with an updater |
| 29 | IPFS Desktop | `ipfs/ipfs-desktop` | MIT | active | daemon (`kubo`, HTTP RPC) | medium | `ipfs-webui` is a page over kubo's RPC; against a user-run kubo it is the cheap case |
| 30 | Swarm Desktop | `ethersphere/swarm-desktop` | BSD-3-Clause | active | daemon (`bee`, HTTP API) | medium | Same pattern as IPFS Desktop |
| 31 | Sia Foundation desktop | `SiaFoundation/desktop` (`renterd`, `hostd`, `walletd`) | MIT | active | daemon (Go binaries, HTTP APIs) | medium | Three UIs over three daemons: three ports, one origin each |
| 32 | Remix Desktop | `remix-project-org/remix-project`, `apps/remixdesktop` | MIT | active | page + `fs`, git, ripgrep and a pty in main | medium to heavy | A poisoned hosted IDE can swap bytecode; the escape test on file paths decides the cost |
| 33 | LBRY Desktop | `lbryio/lbry-desktop` | MIT | dormant since 2023 | daemon (`lbrynet` JSON-RPC) | medium | Decentralized video; the company is gone, the protocol and the daemon are not |
| 34 | WebTorrent Desktop | `webtorrent/webtorrent-desktop` | MIT | no release since 2020, pushed 2026-09 | page + in-process torrent engine (TCP/UDP) | heavy | A page can only reach WebRTC peers; raw sockets would be a new capability |
| 59 | Quiet | `TryQuiet/quiet`, `packages/desktop` | GPL-3.0 | active | daemon (bundled Tor) + native (libp2p, OrbitDB) | heavy | Serverless team chat over Tor; the same Tor gap as RoboSats, plus a native backend |

## Trusted yesterday: messengers, vaults, notes, files and media

These are the apps where the thing the user trusts is the client itself: end-to-end encryption is
only as good as the build that does the encrypting.

| # | App | Upstream | Licence | Status | Shape | Cost | What Orivon buys |
|--:|---|---|---|---|---|---|---|
| 36 | Standard Notes | `standardnotes/app`, `packages/desktop` | AGPL-3.0 | active | page | cheap | E2EE notes; the desktop is the web app |
| 37 | Bitwarden Desktop | `bitwarden/clients`, `apps/desktop` | GPL-3.0 with Bitwarden-licensed parts, **decision** | active | page + native (`desktop-napi`: biometrics, SSH agent, autofill) | medium | A password vault is the strongest case for a build the user can reproduce |
| 38 | Ente Photos | `ente/ente`, `desktop/` | AGPL-3.0 | active | page + native (ML N-API, bundled `ffmpeg`) | cheap to medium | E2EE photos; ML and transcoding are features to refuse |
| 39 | Threema Desktop | `threema-ch/threema-desktop`, `apps/desktop` | AGPL-3.0-or-later | beta, active | page (crypto in WASM) | cheap to medium | The 2.0 client keeps its protocol in WASM, which is why it is cheap |
| 40 | Tuta | `tutao/tutanota` | GPL-3.0 | active | page + native (SQLCipher offline cache) | medium | E2EE mail; the offline cache is the one native member |
| 41 | Delta Chat | `deltachat/deltachat-desktop`, `packages/target-electron` | GPL-3.0-or-later | active | daemon (`deltachat-rpc-server`, JSON-RPC) | medium | Upstream's own browser edition already talks to that server remotely |
| 42 | Notesnook | `streetwriters/notesnook`, `apps/desktop` | GPL-3.0-or-later | active | page + native (SQLite) | medium | E2EE notes; the web app runs on IndexedDB |
| 43 | Logseq | `logseq/logseq` | AGPL-3.0 | active (DB version in beta) | page + native (SQLite, keytar); optional Python sidecar | medium | Upstream's browser build already uses the File System Access API |
| 44 | AFFiNE | `toeverything/AFFiNE`, `packages/frontend/apps/electron` | MIT (backend and native crate licensed separately) | active | page + native (Rust N-API in a utility process) | medium | Local-first docs with a hosted twin at `app.affine.pro` |
| 45 | Actual Budget | `actualbudget/actual`, `packages/desktop-electron` | MIT | active | daemon-shaped (`loot-core` and the sync server in a utility process) | medium | Upstream's browser client against a self-hosted sync server is the remote-able case |
| 46 | Filen | `FilenCloudDienste/filen-desktop` | AGPL-3.0 | active | daemon (`rclone` for the network drive); UI is `@filen/web` | medium | E2EE storage; the drive and sync are features to refuse |
| 47 | Whalebird | `h3poteto/whalebird-desktop` | GPL-3.0 | active | page | cheap | Fediverse client; remote APIs only |
| 48 | Joplin | `laurent22/joplin`, `packages/app-desktop` | AGPL-3.0-or-later | active | page + native (SQLite, keytar, ONNX) | heavy | The database and the plugin host live in main |
| 49 | Session | `session-foundation/session-desktop` | GPL-3.0 | active | page + native (`libsession_util`, SQLCipher: the protocol core) | heavy | Not a page until the core has a WASM build |
| 50 | Signal Desktop | `signalapp/Signal-Desktop` | AGPL-3.0-only | active | page + native (`libsignal`, SQLCipher, RingRTC: the core) | not a target | Listed so nobody re-opens it: the protocol is native in main |

## Everyday apps whose desktop is already the web app

Not crypto and not privacy tools, but the same property: the desktop build is the web app plus
an updater, and the user has been trusting the binary.

| # | App | Upstream | Licence | Status | Shape | Cost | What Orivon buys |
|--:|---|---|---|---|---|---|---|
| 51 | draw.io desktop | `jgraph/drawio-desktop` | Apache-2.0 | active | page (bundled, works offline) | cheap | The hosted twin is `app.diagrams.net`; the desktop exists so diagrams never leave the machine |
| 52 | Simplenote | `Automattic/simplenote-electron` | GPL-2.0 | active | page (Simperium sync API) | cheap | |
| 53 | Fluent Reader | `yang991178/fluent-reader` | BSD-3-Clause | active | page (fetches feeds directly) | cheap | Needs an open `https.connect`, the FreeTube pattern |
| 54 | Feishin | `jeffvli/feishin` | GPL-3.0 | active | page (the user's own Navidrome or Jellyfin); optional `mpv` daemon | cheap | A client for a server the user already runs; `mpv` is a feature to refuse |
| 55 | Bruno | `usebruno/bruno`, `packages/bruno-electron` | MIT | active | page + native (`node-pty`) | cheap to medium | Local-first API client; collections are files, so `orivon.fs` carries the whole thing |
| 56 | Insomnia | `Kong/insomnia`, `packages/insomnia` | Apache-2.0 | active | page + native (`node-libcurl` is the request engine) | medium | The requests go through libcurl in main; answering them with `fetch` changes what a request can do |
| 57 | TriliumNext | `TriliumNext/Trilium`, `apps/desktop` | AGPL-3.0-only | active | page + native (SQLite; the Express server runs inside main) | medium | Upstream's server edition is the same UI over HTTP, which is the remote-able case |
| 58 | Zettlr | `Zettlr/Zettlr` | GPL-3.0 | active | page + `fs`; spawns bundled `pandoc` | medium to heavy | A file-tree editor: the escape test on paths decides it |

## Checked and not listed

Each was read on the same day; the reason is the one that stops it.

- **No Electron app upstream.** The hosted DApp interfaces that would be the poster children
  for a trustless frontend (Uniswap, Safe, Aave, Snapshot, the ENS manager) are web-only, so
  there is no renderer target to keep. Nuclear and Jan moved to Tauri; Grayjay Desktop is .NET
  around CEF; Podverse has no desktop build; Cider 2 is closed source.
- **Wrappers around a remote site.** Wire, Proton Mail desktop, Jitsi Meet Electron, Revolt
  and its successor Stoat, Sengi's Electron host, Ferdium.
- **Archived, closed or gone.** MetaMask Desktop (proprietary, archived), Stacks Wallet
  desktop, Sphere by Horizen (no source), Mercury Wallet (repositories removed), Zap, Emerald
  Wallet, Lisk Desktop, Firo Client, Filecoin Station, NiceNode, Ganache UI, Radicle Upstream,
  Beaker, Patchwork. KeeWeb and the Oxen wallet are alive on Electron 13 and Electron 4
  respectively, which is a toolchain nobody should wrap.
- **Licence off the allowlist and nothing else to recommend it.** Lily Wallet (Elastic-2.0,
  dormant), Anytype (Any Source Available License, plus a Go daemon).
- **The helper is the product.** Frame (a system-wide provider is a main-process program),
  Wagyu Key Gen (the key derivation is Python), Specter Desktop (a shell around `specterd`),
  Keybase, Mullvad, Polar, Stereum, Mysterium, Internxt (a virtual drive), Agregore and Peersky
  (they are browsers), Cabal and Manyverse (native SSB stacks, dormant).

## Where to start

Cheap shape and a large trust win, in this order: Polkadot-JS Apps, Element, Standard Notes,
Audius, Alephium, Whalebird, Nault, BitShares UI, Umami, Threema, Ente. Each is a page over
remote APIs whose hosted or shipped copy is what users trust today, and each has a licence the
allowlist already accepts. Bitwarden is the highest-value medium port, and the one licence
decision worth making early. Among the everyday apps, draw.io, Simplenote, Fluent Reader and
Feishin are the page-shaped ones.

The device-shaped wallets share one open question, not one bridge: whether Orivon grants
WebHID and WebUSB to an app origin. Until the shell answers it, every one of them ports as a
software wallet with the hardware group refused by name, which is a real answer and it ships.

To advance a candidate: `orivon-port recon` on its clone, write the recon down beside
[`freetube-recon.md`](freetube-recon.md), then `orivon-port new <id>`.
