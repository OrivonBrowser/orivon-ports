# `apps/bitsocial-node/`: Bitsocial Node as an Orivon app

**What lives here.** Bitsocial Node hosts Bitsocial communities from this computer: it runs pkc-js, Bitsocial's
protocol library, over Orivon's own IPFS node. pkc-js speaks to a kubo node over kubo's HTTP RPC, so what is written
here is the layer that answers that RPC from Orivon's node, with the mutable file system (MFS) kubo has and the node
does not, the Worker that runs pkc-js's RPC server on top of it, and the page module that starts the Worker. **No pkc-js source and no pkc-js build output is in this repository**: [`UPSTREAM.md`](UPSTREAM.md) has its
licence and where it goes instead.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | Where pkc-js is, at which commit, and how the app is built |
| [`orivon.json`](orivon.json) | The manifest: what the consent dialog shows a person |
| [`UPSTREAM.md`](UPSTREAM.md) | pkc-js's licence and the other bundled packages' (the board manager, the page sort, the challenges), what is ours, what to re-check when a pin moves |
| [`node/kubo/`](node/kubo/) | The kubo facade: `index.js` is the way in, [`SURFACE.md`](node/kubo/SURFACE.md) lists what it answers |
| [`node/worker/`](node/worker/) | The Worker: `main.js` is its entry, `run.js` its life, [`board-managers.js`](node/worker/board-managers.js) the 5chan board managers it keeps running (section The board manager), [`challenges.js`](node/worker/challenges.js) the anti-spam challenges it registers and [`board-challenges.js`](node/worker/board-challenges.js) the edit of a board's list (section The anti-spam challenges), [`listing-api.js`](node/worker/listing-api.js) the calls that get a board listed (section The listing calls), [`name-api.js`](node/worker/name-api.js) and [`name-claim.js`](node/worker/name-claim.js) the calls that give a board a name (section The name calls), [`seeding.js`](node/worker/seeding.js) and its modules the seeding of the communities a person follows (section The seeding calls), [`reach-api.js`](node/worker/reach-api.js) and [`relay-setting.js`](node/worker/relay-setting.js) how the node is reached and the relay a person names (section The reach calls), [`workarounds/`](node/worker/workarounds/) what it carries for gaps in Orivon's shim |
| [`node/orivon-id-challenge/`](node/orivon-id-challenge/) | The "Require an Orivon ID" challenge, ours: one file, its own licence notice, no dependency (section The anti-spam challenges) |
| [`node/test/`](node/test/) | Their tests, in plain Node, against stand-ins for the IPFS node and for pkc-js's server |
| [`node/tools/`](node/tools/) | The go-no-go runs against the real thing: the Worker under plain Node over the native node, a real kubo as the reader, and the same run in the Orivon shell (section Go/no-go) |
| [`page/`](page/) | The app's page, `node-client.js`, the module a page starts the Worker with, and `node-dashboard.js` with its modules in [`page/dashboard/`](page/dashboard/), the dashboard an app's "node" link opens (section The node dashboard) |
| [`build/`](build/) | The build: the Worker and the client bundled with Orivon's Node shim, the node component checked against its pin, and one small module per gap the build works past |

## The kubo facade

`createKuboFacade({ node, statePath, gateway })` returns `handle(Request) -> Response`: kubo's `/api/v0/*` for the
calls in [`SURFACE.md`](node/kubo/SURFACE.md), and the gateway (`/ipfs/`, `/ipns/`) on the same origin. Two ways reach
it:

- `installFetchHook(globalThis, 'http://127.0.0.1:<port>', facade)` answers `fetch` calls to that origin in the
  process, with no socket. kubo-rpc-client and pkc-js's own raw requests both use the global `fetch`, looked up when
  they call.
- `listenFacade(http, port, facade, onError)` serves the same handler on `127.0.0.1` for a caller outside the process.
  It refuses a `Host` that is not the loopback address (DNS rebinding) and any request with an `Origin` header, unless
  `allowedOrigins` lists it; `apiKey` adds a bearer token; `onError` hears of a request that failed, which its client
  sees as a bare 500.

Its dependencies are in `node/package.json` and install with `npm run bitsocial-node:install`; `npm test` runs its
tests.

## The Worker

`node/server.mjs`, which runs the bundle of [`node/worker/main.js`](node/worker/main.js) (section The packed node), is
forked by a page and runs, in this order: Orivon's IPFS node (the component at `/bin/ipfs-node`, started with `--serve`, kept running by
[`node-supervisor.js`](node/worker/node-supervisor.js)); the kubo facade in front of it; pkc-js's RPC server
([`rpc-server.js`](node/worker/rpc-server.js)); and then it tells the page `ready`. A page that connects before that is
refused with a 1006, so `ready` waits for the RPC server to be listening.

| What | Where it is |
|---|---|
| pkc-js's RPC (`PKCWsServer`) | `ws://localhost:9138/<key>`, with the desktop clients' options ([`pkc-options.js`](node/worker/pkc-options.js)): their four HTTP routers and six `.bso` name resolvers (one resolver on a browser with a light client, below), the data under the app's files, kubo at the facade's origin |
| The kubo facade for pkc-js | In the process: `installFetchHook` answers `fetch` calls to `http://127.0.0.1:50019` and to the gateway's origin with no socket |
| The media gateway and the page API | `http://localhost:6473`: the facade's gateway, and `POST /orivon/api/<call>` ([`gateway-only.js`](node/worker/gateway-only.js), [`page-api.js`](node/worker/page-api.js)); no other part of the kubo RPC is reachable on this socket, and a page's `fetch` needs its origin in `origins` |
| The IPFS node's HTTP API | `127.0.0.1:5351`, with a key the Worker makes and never sends anywhere; its P2P port is 4851 |
| What is kept | Under the app's files (`/orivon/app/bitsocial`): `pkc/` pkc-js's data, `node/blocks.db` the node's blocks, `facade/state.json` the file system's root |

**`isolated` is a run with no internet**, for a test or a local network, never for a person's node: the page's configuration
carries `isolated: { bootstrap: [<loopback peers>] }`, and the node is started with `--allow-local-dial` and its DHT from those
peers (`--test-bootstrap`) instead of the public ones, with no HTTP router unless `isolated.routers` names some (loopback
`http://127.0.0.1:<port>` origins, such as a kubo's own routing API, which a native node can ask and the wasm component, which asks
https only, cannot), and pkc-js is given no HTTP routers and no `.bso` name resolvers ([`config.js`](node/worker/config.js)
refuses a peer or a router that is not on loopback).

**The key is enforced here.** pkc-js lets a client in with no key when the connection's two ends are the same address, and a
page's connection to its own app's port arrives as `127.0.0.1`. [`rpc-guard.js`](node/worker/rpc-guard.js) is on the HTTP
server pkc-js is handed: an upgrade whose path is not `/<key>` is answered 403 before pkc-js sees it, and so is every plain
request but an export download.

The Worker tells the page with `process.send`: `node` (starting, up, restarting, failed), `status` (peer, reachability,
addresses, peer count, from the node's `/status` and, when it has it, `/orivon/swarm/peers`), `error` (the gateway or the
RPC port was not free, with the code), `ready` and `failed` (the stage and the code). A `{ cmd: 'status' }` message asks for a
status now, `{ cmd: 'stop' }` ends the Worker and the node.

## The packed node

The node's files are most of what an app opened from an `ipfs://` or `ipns://` address has to read before its node starts, and a
provider gives them at one or two megabytes a second, so the build ships them in a quarter of their size
([`build/pack.mjs`](build/pack.mjs)):

| File | What it is |
|---|---|
| `node/server.bundle.js.deflate` | The Worker's bundle, minified with esbuild's `keepNames` (pkc-js and its dependencies read class and function names), as a raw deflate stream |
| `node/server.mjs` | A file of a dozen lines ([`build/server-loader.mjs`](build/server-loader.mjs)): it fetches the stream, unpacks it with `DecompressionStream('deflate-raw')` and runs the text with `new Function`, strict and with the `await` the bundle has at its top. The bundle reads its address from `globalThis.__bitsocialServerUrl` where it would read `import.meta.url`, so `sqlite3.wasm` is found beside `server.mjs` as before |
| `bin/ipfs-node.p2/ipfs-node.core.wasm.deflate` | The node component's program as a raw deflate stream. The glue beside it (`ipfs-node.js`, jco's output) has its one line that loaded the program changed, so it fetches the stream, unpacks it as it arrives and compiles it with `WebAssembly.compileStreaming` ([`build/node-component.mjs`](build/node-component.mjs) `packGlue`; the build stops when jco's line is not there exactly once) |

- **Why `new Function` and not a `blob:` module.** The served policy admits `'unsafe-eval'` in `script-src` and no `blob:` there, and the
  bundle is the app's own hash-checked file; a `blob:` import is refused.
- **Why raw deflate, not gzip.** The files are the app's own format: it fetches the bytes and unpacks them itself, so no host has to name a
  `Content-Encoding` for them. A gzip file would be one `src/portable.ts` refuses (a plain static host derives no header for it); a raw
  deflate stream has no magic number and is not one. fflate makes it, not Node's zlib, whose hash depends on the builder's CPU, so the bytes
  are the same on every machine.
- **What is pinned.** `build/node-component-pin.mjs` carries, beside each file of the component, the size and sha256 of the packed form of the two files that have one (`packed`, written by the same command that pins the component). A build checks the packed program and glue it makes against them, so a changed packer, a changed glue line or a changed deflate library fails the build instead of changing the tree, and the apps' own pins (`build/node-bundle-pin.mjs`) name the packed files.
- **Debugging.** `BITSOCIAL_NODE_MINIFY=0` builds the readable bundle (the stack of an error then names the source's lines), and
  `BITSOCIAL_NODE_COMPRESS=0` ships the plain files and the pinned glue; both give back the tree as it was before the files were packed (a tree of the node app
  to read, not one to build an app from: the apps pin the packed files, and `fetch-node-bundle.mjs` refuses any other).
  A packed bundle's stack names `server.bundle.js` and a column of one long line.

## Where Ethereum is read

Three things read Ethereum, and only read: pkc-js's name resolvers (`.bso` and `.eth`, the `bitsocial` text record, for a client's reads and for the check of a
publication's author name), the `evm-contract` challenge, and the name calls' `check` and `transaction`. They all read through viem, which sends JSON-RPC with `fetch`, so the Worker
answers those requests in its own process ([`ethereum-reads.js`](node/worker/ethereum-reads.js), `installFetchHook` as for the kubo API: no socket, no port). The node sends and
signs nothing on any chain.

| The browser | Where a read goes |
|---|---|
| A browser whose `orivon.use` is a function | Through `orivon.use('ETH_NET_0_1_READONLY')`: the browser's light client, which checks each answer against Ethereum's consensus. The first use asks the person in the app's own tab, as any `orivon.use` does |
| Has no such function (the v0.1.0 tag answers a namespace of calls there), or the person did not allow it, or the light client does not answer | The six public servers the desktop clients use ([`eth-providers.js`](node/worker/eth-providers.js)), in order, exactly as before: 5 seconds each |
| A run with no internet (`isolated`) | Nothing: no resolver, no read |

On a browser with a light client the node has **one** name resolver, at the pseudo-origin `http://ethereum.orivon.invalid` (the `.invalid` top-level domain never resolves,
so a request that missed the hook would fail, never reach a server), in place of the six. pkc-js goes on to the next resolver when one finds no record, so the
fallback to public servers is inside that one endpoint: an answer of the light client, "no record" included, is final and is never asked again of a public server. The
`evm-contract` challenge is given the same endpoint as its `rpcUrls` when its owner named none and the chain is Ethereum (its own copy of viem would otherwise read a public
server of its own choosing); a board owner's own `rpcUrls`, and any other chain, are untouched and reach the servers they name. A browser with no light client gives the challenge nothing, and it reads as the desktop does.

The challenge reads a second thing on Ethereum whatever chain its board is on: an author's `.eth` or `.bso` name. It reuses the board's `rpcUrls` for that only when the board is on
Ethereum; on any other chain its own client asks the server its copy of viem names for Ethereum (`https://ethereum.reth.rs/rpc`, [`VIEM_MAINNET_URL`](node/worker/ethereum-reads.js),
which a test reads from that copy), and no option changes it. On a browser with a light client the Worker also answers that one address (`ensRoute`): the same endpoint, so the
name is read through the light client with the public servers behind it as for every other read, and nothing else is changed. The route answers a `POST` of a JSON-RPC read at
that address's one path; the endpoint refuses every method that is not a read, and any other request to that address is refused in the process and never reaches the network.
The route is not there on a browser with no light client (the name is read from `ethereum.reth.rs`, as the desktop does) and not in a run with no internet. A board on Ethereum
whose owner named `rpcUrls` never asks that address. An owner who names that very address as the Ethereum server has it answered through the light client too: the same answers,
checked by the light client.

How a read is chosen, in [`ethereum-reads.js`](node/worker/ethereum-reads.js):

- **Detection.** `orivon.use` is a function and the handle answers `blockNumber`. The probe is not counted as a read.
- **The handle's functions are not `window.ethereum`'s.** The light client's handle has `chainId`, `blockNumber`, `getBalance`, `getTransactionCount`, `getCode`, `getStorageAt`,
  `call`, `estimateGas`, `gasPrice` and `maxPriorityFeePerGas`. The endpoint maps each JSON-RPC request onto one of them and takes a request it cannot map (a log range, a receipt) to the public servers.
  A `call` that reverts is JSON-RPC error 3 with its data, never asked again of a public server.
- **Time and load.** The light client gets 8 seconds a read and at most 8 reads at once; after the browser gave no handle, or two reads in a row failed, it is left alone for 30 seconds
  and the public servers answer. A refusal as `invalid` falls back without counting as a failure, and a warning in the log names no address. So does a call that names no contract
  (viem checks a wallet's signature with one, and recovers the signer itself when nothing answers): a light client may not carry it, which says nothing of the reads it does carry.
- **Reads only.** A method that is not a read (`eth_sendRawTransaction`, `eth_sign*`, `personal_*`, `wallet_*`, `eth_accounts`, subscriptions) is answered -32601 and reaches neither path.
- **The dashboard says which path.** The name call `boards` also answers `ethereum: { path, why?, lightClient, public }`, and the name section draws one line from it
  ([`ethereum-words.js`](page/dashboard/ethereum-words.js)): read through the browser's light client, or from public servers, and why not the light client.
  The challenges call `boards` answers the same field, and the host line of the `evm-contract` challenge follows it ([`challenge-words.js`](page/dashboard/challenge-words.js)) when
  its owner named no `rpcUrls` and the chain is Ethereum: the light client, public servers until the person answers the browser's question or while it is off, and the
  server its own copy of viem names where the browser has no light client (`why: 'unsupported'`). `rpcUrls` name the hosts. On another chain the line says both reads: the chain's
  server (or the `rpcUrls`) for the contract, and for an author's name the light client while it answers, public servers until the person answers the question or while it is off, and
  `ethereum.reth.rs` on a browser with none. The line of the Orivon ID challenge, which reads a name's record through the name resolvers, names the light client while it answers and
  the six providers otherwise.
- **The manifests** of the node and of both apps declare `standards: ["ETH_NET_0_1_READONLY"]`, so the first-visit panel offers it up front. They keep their public `net` grants, because
  a browser with no light client reads from those servers.

A test that needs Ethereum with no public server sets `BITSOCIAL_ETH_PUBLIC=off` in the Worker's environment: the light client then answers alone, and a read it cannot answer fails, which a test sees.

## The page module

[`page/node-client.js`](page/node-client.js) is `startBitsocialNode({ authKey, ports, files, serverPath, origins, debug })`
(`debug` is optional: more of pkc-js's log namespaces for the Worker to write, section Design notes). It
tries `ws://localhost:<rpc>/<authKey>` first and uses what answers (another tab, or the person's own Bitsocial desktop or
command-line node: `reused: true`, and then it has no `process.send` status, only what the page API gives); otherwise it forks the Worker with
`serialization: 'advanced'` and resolves on `ready`. It returns `{ rpcUrl, gatewayUrl, snapshot(), on('status' | 'node' |
'error' | 'exit'), reachability(), stop() }`; `reachability()` is `public`, `private` or `unknown` for a bridge's
`getNodeReachability`. `authKeyFrom(localStorage)` makes the key once for every tab of an app. One page starts one Worker
per RPC port, however many times it asks. The build bundles it with the shim as `node-client.js`, which gives a page
`globalThis.BitsocialNodeClient`.

The handle also has `api(call, { query, signal })` and `stats()`, which read the node through the page API below, so a page
that reused a node, and a second page of the same app, see the same numbers as the page that started it. `reachability()`
of a reused node asks the page API too.

## The page API

A page of the app that runs the node can read it without the kubo API on any port a different app could be given. The Worker's
gateway socket (`gatewayOnly` in [`gateway-only.js`](node/worker/gateway-only.js)) answers `POST /orivon/api/<call>` for six
calls and nothing else: `id`, `swarm/peers`, `swarm/addrs/autonat`, `stats/bw`, `repo/stat` and `version`. Each needs the RPC
key as `Authorization: Bearer <key>` (the same key the RPC socket's path holds, compared in constant time): without it the
answer is 401, a method but POST is 405, a call off the list is 403, and every other path of the kubo API is 404 on this socket.
`id`, `swarm/peers`, `repo/stat` and `version` are the facade's own answers; `swarm/addrs/autonat` is the node's reachability as
`{ reachability: 'Public' | 'Private' | 'Unknown' }` (the node's `reach`, section Reachability and punching); `stats/bw` is the node's own
`GET /orivon/stats/bw` (`TotalIn`, `TotalOut`, `RateIn`, `RateOut`: bytes since the node started and bytes per second over the last five seconds,
in Kubo's field names), read by [`bandwidth.js`](node/worker/bandwidth.js) at each call when the node's `/health` names `bandwidth` in
`x-orivon-node-features`. A component built before the feature, a node that does not answer and a number that is not a figure
give null totals and rates: a page then reads "unknown", and a zero would read as a measurement. The count is the wire bytes of
the node's TCP sockets, so it includes handshakes and framing, and it does not count HTTP or DNS lookups.

The path is on the Worker's socket and not behind the Worker's `process.send` channel because a page that reused a node has no
handle on its Worker. A page that does not start the node does not need the module: [`apps/5chan/`](../5chan/) answers the desktop
client's calls to `http://localhost:50019/api/v0/` with this API and its own `fetch`.

## The board manager

The Worker runs 5chan's board manager ([`UPSTREAM.md`](UPSTREAM.md) says what is bundled and what the build changes): it archives
a board's oldest thread when the board holds more than its capacity (`perPage * pages`), purges an archived thread
after `archivePurgeSeconds`, and stops a thread rising after `bumpLimit` replies. One manager runs per board, as an RPC client
of the Worker's own server (`ws://127.0.0.1:<rpc>/<key>`). [`board-managers.js`](node/worker/board-managers.js) starts it
when it is turned on and at every Worker start (a board whose manager is on needs nothing asked of it after a restart), starts one
at a time, stops them all before the RPC closes, and starts one again when it stops, after a pause that doubles from 5 s to 5 min and
starts over after a minute of running. A manager that fails never reaches the Worker: its lines and the supervisor's go to
the Worker's warnings, as `board manager: ...` and `board manager error: ...` with the key taken out, so orivon://report carries them.
The page sort the bump limit lives in, `@pkcprotocol/active-page-sort`, is registered in [`pkc-options.js`](node/worker/pkc-options.js); a board
with no such sort in its settings is archived at capacity and is otherwise as it was.

What it keeps is in the app's files under `board-manager/`, in the manager's own shapes ([`board-config.js`](node/worker/board-config.js)): `global.json`
(`defaults`, the fields every board takes unless it sets them), `boards/<address>/config.json` (`perPage`, `pages`, `bumpLimit`, `archivePurgeSeconds`,
`moderationReasons`, and `enabled`, this app's: a board with none is on) and `boards/<address>/state.json` (the manager's moderator key and the
threads it archived). A board has a manager when it has a `config.json`. Defaults, when a board and `global.json` set nothing: 15 threads a page, 10 pages,
300 replies, 172800 seconds.

**The control channel** is `POST /orivon/manager/<call>` on the gateway socket ([`manager-api.js`](node/worker/manager-api.js)), with
`Authorization: Bearer <key>` and a JSON body of at most 16 KiB, answered as the page API is: 401 without the key, 405 for a method but POST, 403 for a call
off the list, 413 for a larger body, 400 for a value that is not a setting, 404 for a board the Worker neither hosts nor has a config for, 503 in a build with no board manager.
A page calls it as `handle.manager(call, body)` on the handle `startBitsocialNode` returns.

| Call | Body | Answer |
|---|---|---|
| `boards` | none | `{ boards: [view], defaults }`: every board the node hosts, and every board that has a config |
| `board` | `{ address }` | one `view` |
| `enable` | `{ address, config? }` | the `view`; creates the config when there is none and turns the manager on; a `config` patch is applied first |
| `disable` | `{ address }` | the `view`; stops the manager and keeps the config, with `enabled: false` |
| `config` | `{ address, config }` | the `view`; a value sets a field, `null` takes it back to the default; a board with no manager gets a config with `enabled: false` |
| `defaults` | none | `{ set, effective }`: `global.json`'s defaults, and what a board gets with them |
| `defaults/set` | `{ defaults }`, a patch as in `config` | the same answer as `defaults`; every running manager starts again with the new defaults |

A `view` is `address`, `hosted`, `started`, `managed` (has a config), `enabled`, `state` (`off`, `starting`, `running`, `backoff`, `stopping`),
`failures`, `restarts`, `lastError`, `lastErrorAt`, `since`, `nextAttemptAt`, `archivedThreads` (a count), `config` (what the board sets), `effective`
(the four numbers it runs with), `capacity` and `noArchive` (whether the board's community sets `features.noArchive`, read from the community the Worker runs: `true`, `false`, or `null`
when the board is not running or does not answer in 2 s). With `noArchive` the manager purges a thread past the limit at once instead of archiving it; a board owner sets it
in 5chan's own Board Settings, so the control channel has no call that changes it.

**A purge ends in `block/rm`.** pkc-js unpins a purged comment and then removes its blocks; the node refuses a block that a provide holds, so the facade
([`routes/content.js`](node/kubo/routes/content.js)) stops the provide and removes the block, and answers a block a pin keeps with an error line of its own, as kubo does, never a
failed call: a failed one stops the board's next update, and the purged thread stays on its pages.

**`state.json` is not sealed.** It holds the key the manager signs moderation with, and the manager's own code reads and writes it, so it is kept as the manager
keeps it, readable by whoever can read the app's files, as pkc-js's own database is. The node's keys are the ones sealed.

[`node/tools/board-manager.js`](node/tools/board-manager.js) (with [`board-client.js`](node/tools/board-client.js), the client it plays the app with) is the plain-Node run (the wasm component under wasmtime, as in section Go/no-go): a client of
the RPC creates boards, the control calls turn the managers on, and each result is read from the board's published pages: a limit of 3 threads archives the oldest
at the 4th, a short purge delay removes it, a bump limit of 2 holds a thread down against a board with the default, a board with no page sort archives too, and a
killed Worker comes back with its managers. `DRIVE_MODE=manager` of [`node/tools/shell/run.js`](node/tools/shell/run.js) runs the capacity case in the Orivon shell,
with the page turning the manager on.

## The anti-spam challenges

A board owner on a desktop node installs a challenge with `bitsocial challenge install <package>` and names the package in the
board's `settings.challenges[i].name`. The Worker has nothing to install into, so it carries the challenges the Bitsocial
projects publish, bundled and registered under the same package names, and a board that names one works as it does on the CLI.
[`challenges.js`](node/worker/challenges.js) is the list and the registration: `registerChallenges` puts each factory in
`PKC.challenges`, the registry pkc-js reads a name in (`settings.challenges[name] ?? PKC.challenges[name]`), before the RPC
server starts. `pkcOptions.challenges` is not used because the server's `setSettings` replaces it. Nothing of a challenge's code is
changed; what the build resolves to something the Worker has is in [`build/challenges.mjs`](build/challenges.mjs) (its header is the table).

| Challenge | Version | Runs | Calls (default) | Note |
|---|---|---|---|---|
| `@bitsocial/wordfilter-challenge` | 0.3.1 | bundled | none | a board that publishes `wordfilter/v1/rules` has its clients replace the word before they sign (5chan does, through the hooks' `applyCommunityWordfilters`), so a post written in 5chan is accepted with the word replaced; a client that does not apply the rules is refused |
| `@bitsocial/base64-challenge` | 0.1.1 | bundled | none | |
| `@bitsocial/captcha-canvas-challenge` | 0.1.5 | replaced | none | its `skia-canvas` is a native module: the build gives it [`pure-canvas.js`](node/worker/workarounds/pure-canvas.js), a canvas over pureimage (pure JavaScript) in DejaVu Sans, the one typeface the Worker carries; the same image size and colours, one font |
| `@bitsocial/voucher-challenge` | 0.1.4 | bundled | none | redeemed vouchers are kept in the board's own data folder |
| `@bitsocial/r9k-challenge` | 0.1.1 | bundled | none | its state is a file: set `statePath` under the app's files |
| `@bitsocial/flags-challenge` | 0.1.3 | bundled | `flags.5chan.app` (`serviceUrl`) | a country flag is checked by the issuer; a board-choice flag is not |
| `@bitsocial/spam-blocker-challenge` | 0.1.7 | bundled | `spamblocker.bitsocial.net` (`serverUrl`) | sends the publication and the board's signature to that server |
| `@bitsocial/evm-contract-challenge` | 0.1.7 | bundled | `ethereum.reth.rs` (`rpcUrls`), or the browser's light client | reads a contract through viem, from `rpcUrls`, or, with none and on Ethereum, through the browser's light client when there is one and otherwise from the server its own copy of viem names for the chain (`ethereum.reth.rs` for Ethereum), not through pkc-js's chain providers; it never sends a transaction. Its host line follows the node, for the contract and for an author's name: the light client while it answers, public servers while the person has not answered the browser's question or it is off, the server above on a browser with none; on another chain the contract is read from that chain's server and the name as above (section Where Ethereum is read) |
| `@bitsocial/ai-moderation-challenge` | 0.5.1 | bundled | `api.openai.com`, `api.typesafe.ai` (`apiUrl`, `triageApiUrl`, `jevApiUrl`, `promptUrl`) | sends each publication to the API it is set to; its cache and audit log are files, set `cachePath` and `auditLogPath` under the app's files |
| `@orivon/id-challenge` | 0.1.0 | ours, bundled | the browser's light client while the node reads Ethereum through it, otherwise the Ethereum nodes the Worker's name resolvers ask (6 hosts, none an option) | the poster's author name must be one label under `v1.orivonid.eth` whose `bitsocial` record holds the key that signed; refused with a one-sentence message that links `id.orivonstack.eth`. Off until a board owner chooses it (section The Orivon ID challenge) |
| `@bitsocial/mintpass-challenge` | 1.5.0 | left out | | needs a native module (sqlite3, through `@keyv/sqlite`); the list says "needs a native module; not available in this build" |

**The Orivon ID challenge.** `@orivon/id-challenge` ([`node/orivon-id-challenge/`](node/orivon-id-challenge/)) is the one challenge here that is not a Bitsocial package. It is
registered from the `OWN` list of [`challenges.js`](node/worker/challenges.js), beside the bundled list, and `list` answers it as `source: 'bundled'` with its
version and licence. A board owner who wants one person, one voice chooses it; a board that does not name it never runs it.

The proof is pkc-js's own, so the challenge only adds a shape. pkc-js 0.0.132 checks an author name before any challenge runs: a name with a capital letter is
refused, the name must resolve through the node's name resolvers (`bso-resolver`: `.eth` and `.bso`, the `bitsocial` text record) to the key that signed, and the
answer may be up to 30 minutes old (`publication-validation.js`, `checkAuthorIdentity`). A challenge then asks the matcher it is handed
(`authorIdentityMatcher.matchesIdentity`, `author-identity.js`), which resolves again with no cache and writes what it read back into the node's cache. The
challenge accepts a name that has exactly one label under `v1.orivonid.eth` (`.bso` read as `.eth`) and that the matcher says resolves to the signer. A poster
sets `author.name` to `<label>.v1.orivonid.eth` in lower case and a `bitsocial` text record on the ID's resolver that holds the author address. `.orv` is not
accepted: no Bitsocial node resolves it, so an author could never get past pkc-js's own check with it. A name with more labels is refused, because the holder of an
ID can mint names below it, and each would be another voice. A check on a token balance does not fit: an ID is an ERC-1155 token of the registry, whose `balanceOf`
takes a token id per label, and the ID's sign-in protocol is five navigations of a browser tab ending in a wallet signature, an exchange with the person that a post is not part of.

The refusal message is the challenge's one option, `error`, and the same text is the default. It reads in one sentence what to do and links
`https://id.orivonstack.eth`; a board owner may replace it (one line, at most 500 characters). When the name does not carry the key, the refused poster also reads why
("That name's "bitsocial" record holds a different address", or pkc-js's own reason the name could not be read). The node reads Ethereum for the name, so
`list` names the hosts the Worker's name resolvers ask and says (`viaNames`) that the dashboard's line names the browser's light client instead while the node reads Ethereum
through it. The Orivon ID contracts are live on Ethereum mainnet; a person buys an ID at `id.orivonstack.eth`, and until
that site opens no author has one, so a board that requires it refuses every post. The dashboard's preset says so in the same words.

The checks run on a fork of mainnet: [`node/tools/orivon-id.js`](node/tools/orivon-id.js) starts `anvil` from a public node's recent block
([`orivon-id-fork.js`](node/tools/orivon-id-fork.js)), buys a fixture ID on the fork as the ID site does (approve, deploy the buyer's resolver, commit, wait 61 seconds
of fork time, register, write the records) and runs the Worker with its name resolvers pointed at the fork (`ETH_RPC_URLS`, which only `tools/host.js` and a test
pass, and a page's config cannot set). One pkc-js client plays the board owner and the authors: the holder and the `.bso` spelling are accepted; no name, another key
that writes the ID's name, an unsold name, a name outside `.eth`, a name that resolves to the signer but is not an ID (`resolver.eth`, given the author's key on the
fork) and a record moved to another key are refused; the pages hold the accepted posts only, and the preset comes off again. Nothing is sent to a public chain: the
fork signs for accounts of the run and never forwards a transaction. `IPFS_NODE_BIN=<node> node node/tools/orivon-id.js` needs `anvil` (Foundry) and a public node
(`ORIVON_ID_FORK_RPC` first; `ORIVON_ID_FORK_BLOCK` pins the block, which anvil then caches); it exits 2 with no fork to run on.

The hosts are the manifest's own: [`orivon.json`](orivon.json) already grants HTTPS and TCP to any host, so a challenge needs no
grant of its own, and a challenge that is not bundled has none.

**The calls.** `POST /orivon/challenges/<call>` on the gateway's socket, with `Authorization: Bearer <authKey>` like the page API
([`challenges-api.js`](node/worker/challenges-api.js)), and `handle.challenges(call, body)` in the page module. Four calls, POST only, with a body that is
empty or a JSON object (16 KiB, 256 KiB for `apply`); another call is 403, a wrong key 401, and a Worker built with no challenges 503.

| Call | Body | Answers |
|---|---|---|
| `list` | none | `{ challenges, unavailable }`: each challenge is `{ name, source: 'pkc-js' \| 'bundled', version, licence, description, type, optionInputs, caseInsensitive?, asks?, hosts?, hostOptions?, note?, suggested?, error? }` and each entry of `unavailable` `{ name, version, licence, reason }`. `optionInputs` is the schema the challenge declares (`option`, `label`, `description`, `default`, `placeholder`, `required`); `asks` is what a poster is asked, in a sentence; `suggested` names a path under the app's files for each option that names a file (r9k's `statePath`, whose own default is in a home folder) |
| `boards` | none | `{ boards: [{ address, name?, publicKey?, started }] }`: the boards this node hosts |
| `board` | `{ address }` | `{ address, challenges, otherSettings }`: the board's `settings.challenges` as stored, and the names of its other settings. 404 for a board this node does not host |
| `apply` | `{ address, challenges, expect? }` | the same, once `challenges` is the board's list. 404 as above; 409 when `expect` (the list the page read) is not the list the board has now, and nothing is written; 400 with `{ Message, failures: [{ index, name, option, message }] }` when pkc-js refuses the list, which writes nothing |

A board's settings must give every option marked `required` a value, so whoever builds an entry from `list` fills those with `default` (or `suggested`). `apply`
reads the board's settings, replaces `challenges` and writes the whole back through the RPC server's own `editCommunity`, because an edit replaces `settings`
whole: a patch of `challenges` alone would drop `pages` and every other setting. A list the board already has is not written. The Worker never installs or
removes a challenge; it writes the list a page sends, and pkc-js says which challenge and which option it refuses.

**Their log reaches orivon://report.** The packages log with pkc-logger, whose `debug` the shim cannot run, so
[`challenge-logger.js`](node/worker/challenge-logger.js) takes its place for them and [`diagnostics.js`](node/worker/diagnostics.js)
turns each line into a warning of the Worker (`challenge: ...`, `challenge error: ...`), with the key left out.

**The run.** [`node/tools/challenges.js`](node/tools/challenges.js) is the plain-Node run: for each challenge it sets the challenge on a board
through `editCommunity`, publishes a comment the challenge must refuse and one it must accept, and reads the board's pages (the list is
read first, over the socket). The services the challenges call are local stand-ins ([`challenge-services.js`](node/tools/challenge-services.js)):
a chain with one fixture contract (read only), the issuer endpoints of spam-blocker and flags, and a model endpoint for ai-moderation; a captcha is
answered from the answer the library wrote to `CAPTCHA_TAP`. `IPFS_NODE_BIN=<node> node node/tools/challenges.js`, with the wasm component as in section Go/no-go.

## The listing calls

A board is listed on 5chan's home page, and a community on seedit's, by a request that two things only the node has make possible: the board's record as it
is published, and a signature made with the board's key. The control channel `POST /orivon/listing/<call>` on the gateway socket
([`listing-api.js`](node/worker/listing-api.js)) answers both and nothing else, as the board manager's channel does: `Authorization: Bearer <key>`
compared in constant time, a JSON body of at most 16 KiB, 401 without the key, 405 for a method but POST, 403 for a call off the list, 413 for a larger body,
400 for a value that is not a request, 404 for a board the Worker does not host, 409 for a board whose identity key the node does not hold, 503 while
pkc-js is not up. A page calls it as `handle.listing(call, body)`.

| Call | Body | Answer |
|---|---|---|
| `boards` | none | `{ boards: [{ address, name, publicKey }] }`: the boards the node hosts, with nothing of their records |
| `board` | `{ address }` | the record as a listing reads it: `address`, `name`, `publicKey`, `title`, `published`, `signable`, `features` (booleans, numbers and strings only), `challenges` (`[{ type, pendingApproval }]`: no description, no exclusion) and `rules` |
| `sign` | `{ address, file, owner? }` | `{ file, entry, message, signature, publicKey }` |

`address` is a board's name or its public key. [`board-records.js`](node/worker/board-records.js) finds it in the node's own list before pkc-js is asked
for it, so a page cannot make the node load a board it does not host. A board that has not published yet answers `published: false` and empty
`features`, `challenges` and `rules`; `signable` is false when the key the node holds for the board is not its identity key (a board whose owner
delegated signing to another key, which can sign a post but is not the board's address).

**What `sign` signs.** `file` is a directory file of the lists, `5chan-directories/5chan-<code>-directory.json` or
`seedit-directories/seedit-<code>-directory.json`, and anything else is 400; `owner` is a name ending `.bso` or `.eth`, put in a 5chan entry
and left out of a seedit one. The `entry` is what the list file holds for the board (5chan: `address`, `publicKey`, `addedAt`, `owner`; seedit:
`address`, `addedAt`, `publicKey`), with `addedAt` the node's clock in seconds. The `message` is four lines: `bitsocial-listing-request-v1`,
`list: bitsocialnet/lists`, `file: <file>` and `entry: <the entry as one line of JSON>`. The first line is a tag no other thing the key signs starts with (pkc-js
signs CBOR maps, never text), so the signature cannot be replayed as a post or a record. The `signature` is Ed25519 over the message's UTF-8 bytes, base64,
made with the board's signer ([`listing-request.js`](node/worker/listing-request.js), `@noble/curves`), which the Worker reads from pkc-js's board object and
never sends. The Worker checks it against the public key before it answers. A peer ID of an Ed25519 key holds the key's 32 bytes after a six-byte prefix,
so the board's address alone verifies it, with the one-line `node -e` command the request carries.

## The name calls

A board's address is its public key until its owner gives it a name. The control channel `POST /orivon/name/<call>` on the gateway socket
([`name-api.js`](node/worker/name-api.js), with [`name-claim.js`](node/worker/name-claim.js) under it) answers what a page needs to help a board's owner do
that, and nothing else, as the listing calls' channel does: `Authorization: Bearer <key>` compared in constant time, a JSON body of at most 16 KiB, 401 without
the key, 405 for a method but POST, 403 for a call off the list, 413 for a larger body, 400 for a name that cannot be one, 404 for a board the Worker does not host, 409,
502 and 503 below, 429 while two calls that read Ethereum are running. A page calls it as `handle.names(call, body)`.

| Call | Body | Answer |
|---|---|---|
| `boards` | none | `{ boards: [{ address, name, publicKey }] }`: the boards the node hosts, as the listing calls give them |
| `record` | `{ address, name }` | `{ address, name, ensName, key, value }`: the record the name must hold. Reads nothing from the network. 409 for a board whose key a name cannot hold |
| `check` | `{ address, name }` | `{ address, name, ensName, publicKey, outcome, resolved, resolver, errors? }`: whether the name points at the board (below) |
| `transaction` | `{ address, name }` | the record, and `{ chainId: 1, transaction: { to, data, value: '0x0' } }`: the transaction that sets it, as data for a wallet. 409 for a name with no resolver, 502 when no provider answered, 503 for a node with no provider |

**What a name is, as pkc-js 0.0.132 and `@bitsocial/bso-resolver` 0.0.10 read it.** `.bso` has no registry of its own: `foo.bso` is the ENS name `foo.eth`
(`normalizeBsoAliasDomain` in the resolver, and `areEquivalentNames` in pkc-js: `foo.bso`, `foo.eth` and `FOO.BSO` are one name). The record is the ENS **text
record with the key `bitsocial`** of that name, on **Ethereum mainnet**, whose value is the board's public key (an IPNS key, `12D3Koo...` of 52 characters or
`Qm...` of 46), optionally followed by `;key=value` segments. The resolver reads it with viem's `getEnsText`, which goes through ENS's universal resolver
(viem 2.55.1's `ensUniversalResolver`, deployed at block 23085558), so there is no contract of Bitsocial's. pkc-js asks its name resolvers (one for each of the
six public providers in [`pkc-options.js`](node/worker/pkc-options.js); one resolver, with the public providers behind it, on a browser with a light client) in order and takes the first record it finds. It checks a name only when a board takes it as its
address, and a name that does not point at the board is not refused: pkc-js emits an error event and goes on. So a board addressed by a name that points elsewhere is
a board nobody can find by that name, and nothing says so until the person checks.

**`record`** is that, spelled out: the name as ENS writes it (a capital letter is refused, as pkc-js refuses one in a board's address; so is a name ENS writes differently),
the key `bitsocial`, and the board's public key from the node's own list, never one the page sends.

**`check`** asks the name resolvers of the pkc-js instance that hosts the boards, which are the ones that check the name when the board takes it, in order, as pkc-js does: a
resolver that cannot handle the name is skipped, one that fails is left for the next, the first record found is taken, and every resolver gets 8 seconds. Nothing is
cached (pkc-js keeps the names it resolved for up to ten minutes; this reads fresh, so a record set a minute ago shows). `outcome` is `here` (the name points at the board),
`elsewhere` (at another key, in `resolved`), `none` (a resolver answered and holds no record), `invalid` (a record that is not a board's key), `unreachable` (no resolver
answered; `errors` has a line for each, with no address in it) or `no-resolver` (the node has none: a run with no internet).

**`transaction`** reads which contract stores the name's records from Ethereum (the providers of those same resolvers, in order) and answers the calldata of its
`setText(node, "bitsocial", key)`: `node` is the name's namehash, and the encoding is checked in [`node/test/name-claim.test.ts`](node/test/name-claim.test.ts) against one worked out by
hand from the ABI. That contract is the one the ENS registry holds for the name, `resolver(node)` of `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`: the one a name manager writes to.
It is not the answer of viem's `getEnsResolver`, which names the contract that reads go through, and for a `.eth` name that is `ENSV1Resolver`, a forwarding contract with no
records of its own and no `setText` (a transaction to it would fail and lose its fee). Provisional: only the registry that holds every `.eth` name today is read, so a name that
lives only in ENSv2's own registries is answered as having no resolver until that registry is read too. The node signs and sends nothing; the page hands the data to the
person's wallet.

**What the apps already do.** 5chan's Board Settings is an editor of the board's settings as JSON, with `address` among the editable keys, and 5chan's own text says
nothing of names, shows no record and checks nothing. seedit's Community Settings has an Address box and a `[?]` that says to set the text record `bitsocial` by hand and
then enter the `.bso` name, and checks nothing. Both let the owner change the address, so the dashboard changes none: it shows the record, checks the name and points to
that setting.

## The seeding calls

Seeding keeps the communities a person follows available while their owner is offline. It is off until a person turns it on. For each community on its
list it pins, in the node, the community's record, the first page of each sort and the page after it, and the post-update files; it announces them so
a reader that asks the network who has them finds this node; and it joins the community's pubsub topic, which the node announces too, so that a poster
behind a router and the owner can meet through it. [`seeding.js`](node/worker/seeding.js) is the scheduler,
[`seeding-pkc.js`](node/worker/seeding-pkc.js) opens a community through the Worker's own pkc-js (`createCommunity({ address })` and `update()`, the loop an app runs
for a community it has opened), [`seeding-pins.js`](node/worker/seeding-pins.js) reads what a record asks to keep,
[`seeding-store.js`](node/worker/seeding-store.js) keeps `seeding/state.json` under the app's files, and [`seeding-api.js`](node/worker/seeding-api.js) is the door.

**What the existing seeder does, and why this is fresh code.** `bitsocialnet/bitsocial-seeder` 0.10.15 (commit `6a5a790d7463f458918433eea706030c646e4ce8`, GPL-3.0-or-later, read
only from a clone):

| Question | The seeder | What this node does |
|---|---|---|
| What it keeps | A community's first-page CIDs, post-update CIDs and the routing CID of its pubsub topic, pinned through a `bitsocial daemon`'s kubo (`pin.add`); not every comment, and no media a post links to | The record, the first page of each sort, the page after it and the post-update files (at most 64 roots a community), and the topic joined |
| How it picks communities | The 5chan and seedit directories of `bitsocialnet/lists`, at most `MAX_COMMUNITIES` (10 by default) ranked by a hash of their identity and a random seed it keeps, plus any it is told | The communities the app's account follows, plus the ones a person adds, at most 200 |
| How it provides | The pubsub routing CIDs to the HTTP routers every 6 hours; the pins' announcements are kubo's own | The node's `POST /provide` for each root it pinned (section The node's routes); a full table of announced roots is logged, and the roots stay pinned |
| Its limits | `PIN_CONCURRENCY` (2), no disk quota (its README says to watch the disk) | A space limit a person sets (1 GB by default, 1 MB to 1 TB), checked after each pin; one pin at a time |
| Its licence | GPL-3.0-or-later | Not taken from it |
| Whether its core is a library | No: it is a service, built on a SQLite queue (`honker`, a native module that Orivon's dependencies may not have), connections made when its modules are imported, a kubo that answers `pin.add`, and a bundled daemon | Written here, to what it does |

**The list.** A community is on it because the app's account follows it (`origin: 'followed'`) or because a person added it (`origin: 'added'`). The account lives in the page's
own storage, which the Worker cannot read, so the page reads the active account's subscriptions from the app's IndexedDB and sends them with `follow`
([`follow-sync.js`](page/follow-sync.js): when the node client starts or finds the node, then at each check, 30 seconds apart, only when the list changed and never creating a database). `follow`
replaces the followed entries and keeps the added ones; a followed community a person took out is remembered in `ignored` and stays out when the page sends the list again, until it is added back. The
node keeps the last list it was sent, so seeding goes on from it at the next start, and a page that is not open sends nothing and changes nothing.

**What it does.** The node looks at the communities on the list, the ones you added first and then the ones the app follows, three at a time, so a community whose parts nobody answers holds up one place and not the pass. For each it opens the community, waits for its record (up to two minutes), pins what the record names, checks the limit after each pin (a pin that would pass the limit is taken back, and
the community says "Over the space limit" until the limit or the list changes), announces the pins, and joins the topic. The node never holds more than the limit; when the limit cannot hold every community, which ones fit depends on which finish first, and the rest say "Over the space limit". A pin waits up to two minutes for a part, and the node has 30 seconds to announce a root (an announce that is not answered in time is logged, and the pass goes on: it never holds back turning seeding off, which waits for a pass in flight to end; every wait of a pass ends when the pass is stopped, and a pin cut short is taken back without the pass waiting for the node's answer). Only the communities being looked at have an update loop running: a community is opened, looked at and let go (the log says "opened in N ms"), so the node runs three at most however long the list is, and a record that changed is seen at the next pass or at "Check now". A community that gave no record in two minutes says "Waiting for its record" and is tried again after a pause that doubles. A community whose record changes is pinned again and the roots it no longer names
are released. A part that nobody the node asks has (a 404 "no provider has this block", or a 504 "retrieval timeout" when no provider answered in time) does not stop the rest: the record and the pages are held, the community says "Held" with "Not found yet:" and the part's name,
and the part is asked for again after the pause below. A host that never announces its post-update folder leaves a seeder holding the record and the pages only; the record is what a reader needs first, so a record nobody has is an error.
A community that cannot be opened is tried again after a minute, then two, up to half an hour; every community is looked at again every ten minutes. A community this node hosts is left to the node and says
"Hosted by this node".

**What stops a pass.** Turning seeding off, adding a community, taking one out and changing the limit end the pass in flight at once: the wait for a part is cancelled, what the pass had pinned stays in the ledger, and the next pass starts with the change. A community that is slow to stop (it waits for a read in flight, a minute on a slow network) is not waited for. So turning seeding off frees what was kept without waiting for a part that is being looked for, and a community just added is looked at without waiting for the communities before it.

**What it frees.** Every pin seeding makes is written in the ledger (`held` in the state file) with whether seeding made it. Turning seeding off, or taking a community out, releases the roots seeding pinned and no
other community on the list also holds, then asks the node for one cleanup of its blocks (`repo/gc`). A pin that was there before seeding asked for it (a hosted community's, an app's) is never released by it.
`GET /orivon/repo/stat` counts every block of the node, so the repository size the dashboard shows includes what seeding holds.

**What it does not do.** It keeps the newest pages, not a community's history, and no media. It does not make a node reachable: a node behind a router serves what it holds only while a reader can get
to it (section The reach calls). The node serves Bitswap only for roots it announced, and announces at most 1024 roots (`--max-provided`), shared with the board manager's and the name records' roots; past that the rest stay pinned and are logged, and the node offers Bitswap the blocks of the roots it announced. The
Worker lives while an app page is open, so seeding does too.

`POST /orivon/seeding/<call>`, with `Authorization: Bearer <key>` and a JSON body of at most 16 KiB, as the board manager's calls (a call off the list is 403, a value it does not take 400, a build with no seeding 503):

| Call | Body | Answers |
|---|---|---|
| `state` | none | `{ enabled, limitBytes, usedBytes, working, lastRun, communities, ignored }`: each community is `{ address, origin, status, bytes, pins, updatedAt, recordAt, error, topic }`, its `status` one of `off`, `hosted`, `starting`, `waiting` (for its record), `holding`, `over-limit` and `error`; `lastRun` is `{ at, tookMs, communities, holding }` |
| `enable`, `disable` | none | the state; `disable` releases what seeding kept |
| `limit` | `{ bytes }` | the state; a whole number from 1000000 to 1000000000000 |
| `add`, `remove` | `{ address }` | the state; an address, a name or a public key |
| `follow` | `{ addresses }` | the state; the communities the app's account follows |
| `run` | none | the state; every community is looked at now |

## The reach calls

How the node is reached, and the relay a person names. [`reach-api.js`](node/worker/reach-api.js) answers `POST /orivon/reach/<call>` the way the seeding calls are answered; `state` is what the node says in its `/status` (`reach`, section Reachability and punching), what it says in
`/orivon/publishing` (the puts in flight, the punch counts and the circuits it gives out) and `/orivon/swarm/peers`, the bandwidth the page API reads, and the relay.

| Call | Body | Answers |
|---|---|---|
| `state` | none | `{ node, answered, reachability, reason, source, autonat, punch, peers, external, circuits, puts, bandwidth, relay }`: `node` is the supervisor's word (`starting`, `up`, `restarting`, `failed`), `reason` one of the node's twelve, each `circuits` entry `{ relay, peer, named }`, and `relay` is `{ address, peer, source, supported, holds }` |
| `relay/set` | `{ relay }` | the state; the address is `/ip4|ip6|dns4|dns6/<host>/tcp/<port>/p2p/<peer>` (400 for one that is not, or that names this computer or the local network outside a test), 409 for a node component that has no `--relay` |
| `relay/remove` | none | the state |

**The relay.** [`relay-setting.js`](node/worker/relay-setting.js) keeps the relay in `relay.json` under the app's files. What the page's configuration names (`relay` in `startBitsocialNode`'s options) is the value until a person
saves another; saving takes its place, and removing leaves the node with none, even when the page names one. A change that moves the relay starts the node again: the supervisor ends the node's process and starts it with the new
`--relay` after its usual pause, with the data kept (`node/blocks.db` and the keys are not touched), while the Worker, pkc-js's RPC server and the page's connection stay up; the apps' hosted communities start publishing
again when the node answers. `holds` is true when a circuit address of that relay is among the ones the node gives out, which is the node's own account of a reservation, not an answer from the relay.

## The node dashboard

[`page/node-dashboard.js`](page/node-dashboard.js) and the modules in [`page/dashboard/`](page/dashboard/) draw the node for a person: the dashboard the "node"
link of an app that runs the node opens. The build bundles them, with no shim (they only draw), into `node-dashboard.js`, which gives a page
`globalThis.BitsocialNodeDashboard`; `bundle.json` lists it beside `node-client.js`, so an app takes it as a build output checked by hash.

**An app keeps what is its own.** Its page frame (its heading and wording, its stylesheet, and how the `nd-` classes below look in it) and a script that calls
`BitsocialNodeDashboard.mountNodeDashboard({ root, node, app: { name, term, features, classes } })`: `root` is the element to draw into, `node` is the page's
`window.orivonBitsocialNode` (its `ready` settles with the handle `startBitsocialNode` returns, or with null), `app.name` is how the app calls itself,
`app.term` is its word for what a node hosts (`'board'`, or `'community'`, which [`terms.js`](page/dashboard/terms.js) turns into the sentences of a section),
`app.features` names the sections the app offers, and `app.classes` adds the app's own class to a role. The module draws the node's state, peer id, peer count,
reachability, repository size and the two addresses every five seconds, and leaves its state in `window.nodeDashboard` (`state`, `detail`, `stats` and
`sections`, where each section keeps what the node last said) for a test to read. Every element carries an `nd-<role>` class (`classesOf`), and the
elements a test drives carry `data-nd-board`, `data-nd-form`, `data-nd-field`, `data-nd-input`, `data-nd-action`, `data-nd-state`, and, in the challenges section, `data-nd-challenge-board`, `data-nd-challenge-row`, `data-nd-part` and `data-nd-rule`.

**A section shows by what the app names and the node answers**, never by an app's name. A section is `{ name, feature, mount }` in `SECTIONS`: `mount`
returns the element and its `refresh`, or null when the handle cannot offer it. A feature one app does not name is not drawn there, and a node that does not
answer a section's own call hides it (the board manager's `boards` call answering 403, 404 or 503 is a node with no board manager, an older one another tab
started, or a build without one). A later feature adds a module in `page/dashboard/` and a line in `SECTIONS`.

| Section | The app names | The node answers | Draws |
|---|---|---|---|
| [`board-manager.js`](page/dashboard/board-manager.js) | `board-manager` | `handle.manager('boards')` | A card for each board the node hosts (and each with a config), and the settings every board takes |
| [`listing.js`](page/dashboard/listing.js) | `listing` | `handle.listing('boards')` | A card for each board the node hosts: the directory to pick, what the board meets and misses of it, the signed request and its address on GitHub |
| the same file | `listing-signature` | `handle.listing('boards')` | The same cards with only the signed request, for an app that has its own link to a GitHub issue |
| [`name.js`](page/dashboard/name.js) | `name` | `handle.names('boards')` | A card for each board the node hosts: the name's record to set with a copy button for each part, whether the name points at the board, and, on a page with a wallet, the transaction that sets the record |
| [`challenges.js`](page/dashboard/challenges.js) | `challenges` | `handle.challenges('boards')` | A card for each board the node hosts: its challenges in words, and a draft to add, change, remove and order them and the excludes, applied in one step |
| [`seeding.js`](page/dashboard/seeding.js) | `seeding` | `handle.seeding('state')` | The switch, the space limit, a card for each community seeding keeps (its state, what it holds, where it came from), the ones a person took out, a field to add one, and the last check |
| [`reach.js`](page/dashboard/reach.js) | `reach` | `handle.reach('state')` | How the node is reached in a person's words, the relays that hold a place for it, the name records being sent, the traffic, and the relay field |

**The app's word for a board.** `app.term` is `board` (the default) or `community`: 5chan names `board`, seedit names `community`. [`terms.js`](page/dashboard/terms.js) gives each section
the four forms it builds its sentences from ("board", "boards", "Board", "Boards"), the board manager's field labels included, so a page never says the other app's word;
[`node/test/dashboard-terms.test.ts`](node/test/dashboard-terms.test.ts) draws every section for each app and fails on the word of the other.

**The board manager section.** A card has the board's address, the manager's state in words (off, starting, running since, trying again in N s after N failed
starts), the archived threads, the last error with how long ago, a switch for the manager, and the three limits as a board owner reads them: "Archive the oldest
thread when the board has more than N threads" (`perPage * pages`, so one field sets `perPage` to N and `pages` to 1), "Stop a thread moving up the board after N
replies" (`bumpLimit`) and "Delete an archived thread after N seconds, minutes, hours or days" (`archivePurgeSeconds`). A field left empty uses the default,
and says which ("Using the default: 150 threads (15 a page, 10 pages)", from the board's `effective` numbers); a field that had a value and is cleared sends
`null`; a field nobody touched is not sent, and a form with nothing changed asks the node nothing ([`board-form.js`](page/dashboard/board-form.js)). A whole
number above 0 is checked in the page; a value the Worker refuses (400) shows next to the field its message names, and any other refusal in the form's own
message. The manager has no setting that turns archiving off, so the form has no such switch. An archived thread stays on the board, marked archived, until its
purge delay has passed, and the card's count goes back down when the node purges it; 5chan keeps a copy of each board it has shown, so a browser that showed the
board before the purge lists the thread until that copy is cleared, and a browser with none lists the board without it. Turning the manager on sends what is typed in the same call. The second form, "Settings for every board", sends `defaults/set`. A refresh keeps a
form a person has changed as it is, and draws the node's state beside it. [`node/test/node-dashboard.test.ts`](node/test/node-dashboard.test.ts) draws it all
into a small stand-in for a document ([`node/test/support/fake-dom.ts`](node/test/support/fake-dom.ts)).

**The challenges section.** A card for each board says what the board asks of a poster, one challenge after another in the order pkc-js runs them: the challenge's
name, what it asks in a sentence (`asks`, or the challenge's own description), the board's own description and the hold for a moderator's approval when set, and
who is not asked (each exclude rule in words: "Not asked of: a moderator or an admin; or an author with a post score of at least 5."). A board with none asks nothing
and anyone can post. A board is read once, when its card is drawn, and the draft a person edits is kept across refreshes. Edit opens a challenge's form, built from
the options it declares in its order and its own words: a required option is filled with its default, the others are empty with the default shown beside them, a
true-or-false option is a choice, a key or token is a hidden value, JSON is a box and is checked, and an option meant for clients (wordfilter's `wordfilter/v1/rules`)
is published by default, never a credential or a list of RPC URLs. An exclude rule is the fields pkc-js 0.0.132 names (`roles`, `publicKeys`, `names`, the scores,
counts and ages, the publication types, a rate limit, the challenges passed and the reputation in other boards): the page writes `roles`, `publicKeys` and
`names` and never `role` or `address`, and reads a rule written with those as the new ones, counting it as a change. A challenge this node does not have, or a file
path, is shown and kept as it is, and can be moved or removed; an option or a field the page does not know is written back as it was. The picker lists the presets first, under "Presets" (the node must list the challenge; [`challenge-presets.js`](page/dashboard/challenge-presets.js) names them, today
"Require an Orivon ID"), then the other challenges under "Installed challenges". A preset adds its challenge with its defaults and shows the host line
and what the challenge asks like any other; it is off until a person chooses it and never added by itself. Before a challenge is added, the
card names the host it reaches in one line, which is a Level 1 (Web2) connection for the Web3 Score (a challenge that reads Ethereum with no server named says where the node reads it
now, and the line follows the node at each refresh). "What applying changes" lists in words each added, removed,
moved and changed challenge (the names of the options changed, never their values) and what is not accepted shows next to its field, so nothing is written until
Apply, which sends the whole list with the list that was read: a board that changed meanwhile is refused and offered to be read again. The module's own tests are
[`challenge-excludes.test.ts`](node/test/challenge-excludes.test.ts), [`challenge-model.test.ts`](node/test/challenge-model.test.ts) (held against pkc-js's own
schema, read from the installed package) and [`challenges-section.test.ts`](node/test/challenges-section.test.ts).

**The listing section.** The directories are read from GitHub, from the lists' defaults file of the app's family
(`raw.githubusercontent.com/bitsocialnet/lists/master/5chan-directories/5chan-directories-defaults.json`, or `seedit-directories/seedit-directories-defaults.json`), as
the apps read them: once when the node hosts a board, and again after a minute when GitHub did not answer. A card has the board's address, a choice of
directory, and, for 5chan, what the board still needs of it: one line for each requirement, "Met: ..." or "Missing: ... (set features.safeForWork in the board's
settings)", and a badge that says "Meets all 6" or "Misses 2 of 6". [`listing-requirements.js`](page/dashboard/listing-requirements.js) is the check 5chan
runs when a board is added to a directory, as fresh code against the board's own record: the poster-ID mode the directory sets, safe for work (a safe-for-work
directory takes only a board that says so, a not-safe-for-work one only a board that does not), a thread that must link to a picture or a video when the directory
says so, no gallery (`maxPostGalleryItems` and `maxReplyGalleryItems` unset or 0), at least one challenge that holds a new poster's first posts for a moderator
(`pendingApproval`), and the directory's own rules as the first rules of the board, in order. The check reads the record through the node's `board` call and
reads it again every 30 seconds, so a setting changed in 5chan's Board Settings shows here without a reload. A board that has published nothing yet says so and checks by
itself; a board whose key the node does not hold says so and offers no request.

"Prepare the request" asks the node to sign and draws the request in full (the title, the body, and the signature on a line of its own), before anything is sent. 5chan's
"Open on GitHub" opens `https://github.com/bitsocialnet/lists/issues/new` with that title and body in the address, in a new tab, only when the address begins there;
"Copy the text" puts the body on the clipboard. The node and the page send nothing: the person presses "Submit new issue" on GitHub, and that issue is
the request. 5chan's card also takes the name that owns the board (`your-name.bso`), which goes in the entry. seedit's own "Propose a community" link
opens a GitHub issue from a template that has no entry, no signature and no check, so `listing-signature` offers only what that link lacks, the entry and the
signature to paste into it, with no requirements (seedit's directories set none a record can be checked against) and no "Open on GitHub".

GitHub documents addresses that fill in a new issue, a pull request, a release or a new file, and none that fills in an edit of a file that exists, so
a request to add one entry to a list file is an issue whose body holds the entry. Provisional: an address that opens an edit of an existing file with new text,
if GitHub takes one, would let the card open a pull request instead. Bitsocial has no listings community that takes a request (the lists' README names a pull
request or a Telegram message, and its voting runs on a test network only); one would take the signed request in place of the issue.

**The name section.** A card has the board's address, whether the board has a name ("Named music.bso" or "No name yet"), a field for the name (filled with the board's own name when it
has one, and left alone while a person types), and three buttons. "Show the record" asks the node for the record and draws it exactly: the name as ENS spells it (with a line that says so
when a `.bso` name was typed), the record key `bitsocial` and the board's public key, each with its own copy button; it needs no wallet, and a person sets it in any name manager.
"Check the name" asks the node's `check` and says what it found in a board owner's words: that the name points at this board (and then that the last step is the board's address, in
the app's own settings, which the app names to the module as `app.addressSetting`), that it points at another board, that it has no record yet, that its record is not a board's key,
or that Ethereum could not be read. A check runs when a person presses the button and not at the dashboard's refresh, because each one asks the public providers. The answers to the
name in the field are taken back when the name changes.

The transaction is offered only where the page has a wallet: a `window.ethereum` with a `request` method, looked for again at each refresh. "Prepare the transaction" asks the node for
it and says in four lines what it does before the wallet is asked anything: one transaction on Ethereum mainnet from the account the person picks, to the name's resolver, to set the
text record `bitsocial` of the name to the board's key; it sends no money and the network fee is the person's; only an account that manages the name can do it; and the wallet shows
it and asks for a confirmation. The calldata is drawn below. "Ask my wallet to send it" then asks the wallet for its accounts and its chain (a chain that is not mainnet is not sent
to), and sends `eth_sendTransaction` with exactly the `to`, `data` and `value` shown. A decline in the wallet is "Nothing was sent". Changing the name in the field takes the prepared
transaction back, so one prepared for a name is never sent for another. A page with no wallet is told so in one line, which says how a wallet would help, and has no button.

What a page gets of a wallet depends on the Orivon build. Orivon v0.1.0 gives an app page none: no `window.ethereum`, no EIP-1193 provider and no `orivon.*` member for one (its
contracts have none, and its compatibility matrix lists the wallet global as not injected). A wallet extension a person installed can inject a provider into some tabs, those of a
granted app served from the network, and not into a tab of an app served from its pinned copy on a loopback address, which these apps are in a plain run; provisional, since no extension
was run against these apps. A shell that installs `window.ethereum` and the EIP-6963 announce in the top frame of an ordinary or app tab gives the section a provider, and the section uses it when it
finds it. Reads of Ethereum always go through the
node's own providers (the six `.bso` resolvers' public RPCs, as pkc-js does), never through the page's wallet.

**The seeding section.** A switch ("Turn seeding on"), the space limit ("Use at most N MB, GB or TB", 1 GB by default, saved as bytes), "Space used" as "N kB of N GB", and the last check ("2 min ago: 3 of 3 held", or "Checking now" while a pass runs). A card for each
community has its address, a badge for its state ("Held", "Waiting for its record", "Over the space limit", "Hosted by this node", "Could not be read"), what it holds ("5 kB in 3 files"), where it came from ("Followed in seedit"
or "Added here") and when it was last updated, and "Take it out". A community a person took out is listed under "Communities you took out" with "Seed it again". "Add the community" takes an address, a name or a key.
The page refuses a limit that is not a whole number above 0 before it asks, and shows the node's own refusal of one outside its bounds as "Use a size from 1 MB to 1 TB". The section hides for good on a 403, 404 or 503.
[`node/test/seeding-section.test.ts`](node/test/seeding-section.test.ts) draws it over the Worker's own seeding calls and scheduler.

**The reach section.** The node's state ("Running", "Restarting"), its word as the page's other sections say it ("Reachable from the internet" or "Not reachable from the internet (behind a router)") and the reason in a sentence a person reads
([`reach-words.js`](page/dashboard/reach-words.js) has one for each of the node's twelve reasons, and [`node/test/reach-section.test.ts`](node/test/reach-section.test.ts) fails when the node gains one it has no sentence for; a reason a newer node adds is shown as "The node says: <reason>."),
the peers, the relays that hold a place for it (the one a person named marked), the name records being sent ("2 waiting, 7 sent, 1 tried again, 0 given up") and the traffic. Under "A relay" one sentence says why: from behind a
home router nobody on the internet can start a connection to the node, a relay is a public computer that accepts it for the node, and Orivon names none. The field takes the relay's address; "Save and restart the node" and
"Remove the relay and restart" say before they are pressed that the node starts again with its data kept, and the line under the field says whether the relay holds a place for the node yet ("it holds no place for the node yet. The node asks it after it starts,
and this page checks again by itself"). A node component with no `--relay` says so and offers no field.

## Putting the node in a port

`orivon-port build bitsocial-node` writes a tree whose `bundle.json` lists, with the size and sha256 of each, what a page
needs to run the node: everything under `node/` (`server.mjs` and the packed `server.bundle.js.deflate`, and `sqlite3.wasm` beside the Worker, where
the shim's SQLite engine looks for it), `node-client.js`, `node-dashboard.js` and everything under `bin/` (the node component and its licences). An app that runs the node takes
those files as a build output checked by hash, as Share takes the IPFS node, and never imports files of this app.

## The node's routes

The facade talks to Orivon's IPFS node over its loopback HTTP API. Every call carries `x-orivon-key`, and the node
keeps this app's blocks, pins and IPNS keys apart by `x-orivon-partition` and `x-orivon-keys`. An error is a non-2xx
status with a plain-text reason. [`node/kubo/node-client.js`](node/kubo/node-client.js) has one method per route.

| Route | Used for |
|---|---|
| `GET /id`, `GET /status` | The peer, and the addresses it listens on and is seen at |
| `POST /orivon/block/put?codec=&pin=` | Every block the importer and the MFS make; answers `{cid,size}` |
| `GET /ipfs/<cid>?format=raw` | One block, to read a directory the MFS holds |
| `DELETE /orivon/block/<cid>` | `block/rm` |
| `POST /orivon/pin/<cid>`, `DELETE /orivon/pin/<cid>`, `GET /orivon/pins` | Pins are roots; the node pins one DAG at a time and answers 429 to a second, which the client retries |
| `GET /orivon/cat/<cid>[/path]?offset=&length=` | File bytes: `cat`, `files/read`, the gateway |
| `GET /orivon/resolve/<cid>[/path]` | The CID a path names |
| `GET /orivon/ls/<cid>` | Directory entries |
| `GET /orivon/repo/stat`, `POST /orivon/repo/gc` | `repo/stat`, `repo/gc` (the CIDs it dropped) |
| `GET /orivon/swarm/peers` | `swarm/peers`: `{peers:[{peer,addr}]}`, the peers the node is connected to now |
| `POST /orivon/provide/<cid>?recursive=` | `routing/provide` |
| `POST /orivon/ipns/keys/import?label=`, `POST /orivon/ipns/keys`, `GET /orivon/ipns/keys`, `DELETE /orivon/ipns/keys/<label>` | `key/import` (409 when the label exists), `key/gen`, `key/list`, `key/rm` |
| `POST /orivon/ipns/publish` | `name/publish`; answers `{name,value,sequence}` |
| `GET /orivon/name/resolve/<name>` | `name/resolve`, one hop; the facade follows `/ipns/` values itself |
| `POST /orivon/routing/put?key=/ipns/<name>` | `routing/put`; the record is then served at `GET /ipns/<name>?format=ipns-record` |
| `POST /pubsub/sub?topic=`, `POST /pubsub/pub?topic=`, `GET /pubsub/ls`, `GET /pubsub/peers[?topic=]` | `pubsub/*`; a message is `{from,data,seqno,topicIDs}` with `data` and `seqno` in base 64 |

## Go/no-go: a community read and posted to by another client

[`node/tools/`](node/tools/) proves the whole path, with nothing standing in: a community hosted by the Worker, through the
facade and Orivon's IPFS node, is resolved and read by a separate, unmodified Bitsocial client (pkc-js over a real kubo
0.43), which then posts, answers the community's challenge over pubsub and sees the post in the community's next update.
The scenario ([`scenario.js`](node/tools/scenario.js)) is the same wherever the host runs; it times the first resolve, the
post to its challenge verification, and the post to its appearing in the community's update.

| Run | What hosts | How |
|---|---|---|
| Plain Node, loopback only | [`host.js`](node/tools/host.js): `worker/run.js` with the native build of the node | `IPFS_NODE_BIN=<native node> KUBO_BIN=<kubo> node node/tools/go-no-go.js`; prints one JSON result |
| Plain Node, the wasm component | the same, with the component run by wasmtime ([`wasmtime-node.js`](node/tools/wasmtime-node.js)) in place of the native binary | `WASMTIME=<wasmtime> WASM=<ipfs-node.wasm> WASM_DIRS="/tmp /dev/shm" IPFS_NODE_BIN=node/tools/wasmtime-node.js KUBO_BIN=<kubo> node node/tools/go-no-go.js`; it tells a fault of the component from a fault of the shell |
| The Orivon shell | the app's page and Worker, the node as the wasm component | [`node/tools/shell/run.js`](node/tools/shell/run.js) (`ORIVON_MVP_ROOT` names a built Orivon checkout); the script serves the built app, which starts the Worker as a person's browser does, and starts the reader's kubo in the same run |
| Two Workers, seeding | [`seeding.js`](node/tools/seeding.js): two `host.js` Workers on loopback, a kubo that is the reader and the circuit relay, and two fresh kubo clients | the native build: `IPFS_NODE_BIN=<native node> KUBO_BIN=<kubo> node node/tools/seeding.js` (the wasm component asks HTTP routers over https only, which loopback has none of). A hosts a community, holds a place on the relay and a reader posts to it; B follows it with seeding on and asks the kubo's routing API (`isolated.routers`, section The Worker) for providers; A is killed, and a client that holds none of it loads the record, whose first page carries the post, from B; turning seeding off on B takes the record away from a client that asks afterwards |
| The real network | the Worker under plain Node on a computer behind a router, with the node's own defaults (the public DHT, the four HTTP routers) | [`network-host.js`](node/tools/network-host.js) creates a community, prints its address and challenge answer, and samples the node's connections and failed dials every 10 s; [`network-reader.js`](node/tools/network-reader.js) runs on a public machine with a kubo of its own and reads and posts |

The first three run `isolated` (section The Worker): no internet, the node dials loopback and its DHT starts from the reader's
kubo, and pkc-js has no HTTP routers and no name resolvers. The reader's kubo has no bootstrap peers and listens on loopback only,
and is connected to the node's P2P port by the run. The native node is built from a checkout of Orivon's IPFS node, which this
repository does not hold.

The shell run also counts, from the test, the calls the shell's broker receives on its control channel (`controlCalls`,
`controlTotals` and `controlPaths` in its result): the broker holds an origin to 200 control calls and 100 more each second,
and a running node component's SQLite uses most of that while a community starts.
The Worker asks the RPC server start again after a refusal for that reason, and the scenario asks a community's `start` again
when the host's list of local communities came back empty.

Under plain Node pkc-js's database needs the native binding of `better-sqlite3`, which `npm run bitsocial-node:install` (an
install without scripts) does not build: `npm rebuild better-sqlite3 --prefix apps/bitsocial-node/node` fetches it, and
`orivon-port build` installs again without scripts and removes it. `go-no-go.js` says so when it is missing. The shell run
does not use it: the Worker's SQLite is the shim's.

The shell run reaches the reader's kubo on `127.0.0.1`, which the manifest's `*:*` does not cover: the script adds that port to
the manifest it serves.

Measured on the real network with the native node and the plain-Node Worker (provisional: one home connection behind a router,
one reader on a public machine): with no punching the node's AutoNAT verdict stays `private`, it announces no address and no
provider record, and a routers-only reader never loads the board. With `--serve --publish --punch-port` and a reader on a public
machine, the board was read and posted to from the reader in three runs: through the HTTP routers the resolve took 3 to 5 s and the
post showed 2.5 to 4.5 s later, through the DHT the resolve took 13 to 17 s. The connection starts relayed and turns direct about
0.5 s later. The Worker now starts the node this way (section Reachability). The same run from the shell is not measured here:
the shell's test run is in a network namespace with no inbound path (`node/tools/shell/network.js` is the script for a computer
that is behind a router).

## Reachability and punching

A person's node sits behind a home router. The Worker starts it with `--serve --publish --punch-port <the p2p port>` (never
`--p2p-port` with it: the two exclude each other) and the four HTTP routers; `--relay <multiaddr>` is added only when the Worker's
configuration names a relay (`relay`, a public address; there is no default, as Orivon's own node names none). A node the person
reaches over a punched port holds two relay reservations and AutoNAT stays `unknown`, so AutoNAT alone would tell 5chan and
seedit that a reachable node is not reachable. The node says what a reader can do instead: `reach` in its `/status` is
`{ state, reason }`, `public` only for a path shown to carry data to a reader (AutoNAT, an opened punch, a relay that sends no
limit). [`reachability.js`](node/worker/reachability.js) takes that answer as it is (`readReach`), and `swarm/addrs/autonat`,
`reachability()` and the status the Worker sends all use it:

| Reason the node gives | Answer | What it says |
|---|---|---|
| `autonat` | `public` | AutoNAT confirmed a direct address |
| `punched` | `public` | a hole punch opened a direct connection |
| `named-relay`, `open-relay` | `public` | the relay the person named, or one the node found, holds a place and sends no limit |
| `punch-ready` | `unknown` | the relays agree on the address a visitor is told, and no punch has been tried |
| `punch-failed` | `unknown` | the relays agree and every punch so far failed |
| `looking` | `unknown` | a relay, a second sight of the address or a relay's limit is still awaited |
| `not-measured` | `unknown` | nothing has been measured |
| `relay-limited` | `private` | every relay limits its circuits and the node cannot punch |
| `symmetric-nat`, `no-public-relay`, `not-reachable` | `private` | the router gives each destination its own port; no relay holds a place; AutoNAT dialed and failed |

A reason a newer node adds passes through as it is. A component that sends no `reach` (one built before the node gained it) is
read by the Worker itself, from what `/status`, `/orivon/provided` and `/orivon/publishing` report, and the status says
`source: 'worker'` where the node's own answer says `source: 'node'`. That reading cannot see that a relay limits its circuits,
so it answers `public` for one:

| Fallback: state of the node | Answer |
|---|---|
| AutoNAT says `public`, or `unknown` with a confirmed public address | `public` (`autonat`) |
| a hole punch succeeded (`punched` above 0) | `public` (`punched`) |
| a named relay holds a place for the node | `public` (`named-relay`) |
| the punch is `ready` and no attempt failed | `public` (`punch-ready`) |
| the punch is `ready`, some attempts failed and none succeeded | `unknown` (`punch-failed`) |
| `symmetric-nat`, or no public relay | `private` (the same word as the punch state) |
| the punch is still `checking` | `unknown` (`looking`) |
| no punch in the build or in the flags | `private` if AutoNAT says so (`not-reachable`), else `unknown` (`not-measured`) |

5chan and seedit show their "not reachable" alert only on `private`; `public` and `unknown` hide it, so an unfinished check never
alarms. kubo in the same state (AutoRelay with reservations) keeps AutoNAT's `Private`, because libp2p separates reaching a
node over a relay from being reachable; the node's `reach` is the measure that matches what a board needs, which is
that a reader can connect. The Worker writes one warning line when the answer or its reason changes (`reachability <answer>
(<reason>: <what it says>): hole punch ..., N of M relays hold a place, ...`, counts and states only, never an address or a peer;
for the fallback the parentheses say `read by the Worker: the node gives no reach`). A warning is
the level that reaches a bug report from orivon://report: the Worker's `console.log` and `console.info` stay in the app's own
console, while its `console.warn` and `console.error` arrive in the shell's output (measured with `DRIVE_PROBE=1`).

## Design notes

- **The node's keys are sealed under a secret kept beside its database, never in memory only.** pkc-js keeps every
  community's private key in its own database and imports it into the node when it starts the community, so pkc-js's copy
  is the source of truth and the node's vault could be in memory. It is not, because the node also holds each name's last
  record, and with it the sequence the next record must pass: a node that forgets it after a restart publishes sequence 0
  and every peer keeps the older record. `--key-secret` keeps `keys.db` (beside `blocks.db`, which a cache clear deletes
  and this file survives); [`key-secret.js`](node/worker/key-secret.js) makes the secret once, in `node/keys.secret` under the
  app's files, and reads the same one at every start. A file that holds anything else stops the Worker (`keys` stage): a new
  secret would lock the keys the old one sealed. A `keys.db` sealed under another secret is reported to the page as the
  error `keys-locked`, and nothing is changed or deleted. The secret sits next to the file it opens, so it protects
  against a copied `keys.db`, not against a person who can read the app's files, where pkc-js's own database keeps the same
  keys in the clear. `--max-ipns-keys 64` lifts the node's default of 8 keys: a community is one key.

- **`add` runs in the facade.** pkc-js addresses what it adds by the CIDv0 `ipfs add` gives (dag-pb leaves, 256 KiB
  chunks, sha2-256), and the node's own add makes raw-leaf CIDv1, so the importer runs here with kubo's defaults and
  each block goes to the node through `block/put`.
- **The MFS is a tree in memory over UnixFS blocks in the node.** A write stores the file's blocks at once; the
  directories along its path are rebuilt and stored at flush, root last. The root's CID is kept in the state file, so
  the next run opens the same tree, and a root the node no longer has starts an empty one.
- **A flush pins the new root and unpins the one before.** A replaced root that could not be unpinned is kept in the
  state file and tried again. Operations run one at a time, and a flush asked while others wait covers all of them,
  because the node pins by walking the whole DAG.
- **Directories shard like kubo's.** Links past 256 KiB go into a HAMT of dag-pb nodes (fanout 256, murmur3), the
  layout the UnixFS importer writes, so a directory of any size stays under the node's block limit and `ls` and
  `read` open directories made by kubo.
- **Configuration is the facade's own.** `config` answers `Addresses.Gateway` with the gateway option and stores
  what pkc-js sets (`Routing`, `Provide.DHT.SweepEnabled`); the routers are handed to the node at launch, and
  `shutdown` is accepted and does nothing.
- **The gateway serves files only**, marked `nosniff` and sandboxed, with a content type from the name or the first
  bytes, and `Range`; `?format=ipns-record` is the node's signed record, passed through.
- **The Worker is one file bundled for the shim.** Its dependencies (pkc-js and `@bitsocial/bso-resolver` at the desktop
  clients' versions, the facade's own) install from `node/package-lock.json`; the build takes the shim from the Orivon
  checkout `ORIVON_MVP_ROOT` names, and the same sources build against v0.1.0 and against main.
- **Each gap in Orivon's shim has one module, deleted on its own once Orivon closes it.**

  | Gap | Module | What it does |
  |---|---|---|
  | `node:v8`, `node:cluster`, `node:stream/web` and `dns/promises`' `Resolver` have no shim module | [`build/gap-stubs.mjs`](build/gap-stubs.mjs) | each becomes a module that loads, because code paths a node runs never call them |
  | `require('worker_threads')`, the SQLite module and `stream/web` are not reachable at run time, and `markAsUncloneable` is missing | [`node/worker/workarounds/register-builtins.js`](node/worker/workarounds/register-builtins.js), [`shim-builtins.js`](node/worker/workarounds/shim-builtins.js) | registered in the shim's registry, with a plain object for `worker_threads` that has `markAsUncloneable` |
  | v0.1.0 offers no public way to reach that registry | [`build/gap-registry.mjs`](build/gap-registry.mjs) | the registry is imported from the shim's source file in the Orivon checkout |
  | `crypto.randomFillSync(Uint8Array)` throws | [`build/gap-uuid.mjs`](build/gap-uuid.mjs) | uuid's pool is filled with `getRandomValues` |
  | `dns.setDefaultResultOrder` is refused | [`build/gap-dns.mjs`](build/gap-dns.mjs) | pkc-js's call is wrapped in a `try` |
  | `fs.utimes` is missing, so proper-lock-file's start lock fails | [`build/gap-lock.mjs`](build/gap-lock.mjs), [`node/worker/workarounds/process-lock.js`](node/worker/workarounds/process-lock.js) | the library's region of pkc-js's chunk is replaced by a lock held in the process (one Worker holds the data directory); the lock directory is still made and removed, since pkc-js checks it before it unlocks |
  | The shim's SQLite has no locking and each connection remembers a file's size, so two connections to one file corrupt it, and pkc-js's `LRUStorage` opens one per cache name on `<data>/lru-storage` (the name-resolution cache and the evm-contract challenge's wallet cache): once the wallet cache wrote, name resolution failed with `database disk image is malformed` | [`build/gap-lru-storage.mjs`](build/gap-lru-storage.mjs) | each cache name has a file of its own, `<data>/lru-storage-<cache name>`, one connection to each. An `lru-storage` file from an earlier run is left where it is and never opened: a cache, which starts empty again (the wallet cache also holds the last signed time of each author wallet, so one old wallet signature is accepted once more). The other places pkc-js opens a file twice are listed in the bullet after the table |
  | `util.formatWithOptions` is missing, so pkc-js's bundled `debug` throws at its first log line | [`build/gap-debug-log.mjs`](build/gap-debug-log.mjs) | the write of that `debug` copy (the one in pkc-js's `util-*` chunk) calls `globalThis.__bitsocialPkcLog` when the Worker sets it, and `process.stderr.write` otherwise |
  | `Buffer` does not know the 'base64url' encoding (the shim's is the `buffer` package, v6), so the spam-blocker challenge's `Buffer.from(bytes).toString('base64url')` threw and pkc-js reported "invalid getChallenge response from community challenge" for every post the challenge was asked about | [`node/worker/workarounds/base64url.js`](node/worker/workarounds/base64url.js) | `toString`, `from` and `isEncoding` of the Worker's `Buffer` answer 'base64url' as Node's do, and a Buffer that already knows it is left alone |
  | `stream.Readable.toWeb` is missing, so a request with a body to the gateway socket answered 500 | [`node/kubo/listen.js`](node/kubo/listen.js) | the request's body is made into a web stream from its own events, which works in Node as well, so there is nothing to delete |
  | A response written to a connection that said `Connection: close` (what the shell's fetch says) can be cut: the shim's server closes the connection and the close reaches the page before the end of the body | [`node/worker/workarounds/keep-alive.js`](node/worker/workarounds/keep-alive.js) | the gateway's answers say `Connection: keep-alive`, so the page closes the connection when it has the body |
  | A node killed in the middle of a database transaction leaves `blocks.db.lock` and `keys.db.lock` (SQLite keeps its lock as a directory where there are no file locks), and a start after that could fail with "database is locked" | [`node/worker/left-locks.js`](node/worker/left-locks.js) | before each start the Worker removes both directories, only while nothing answers on the node's API port, since whoever held them is then gone. The 0001-0021 component still leaves the directories (and `blocks.db.owner` and journals) after every `kill -9` in a write (5 of 5, under wasmtime), but takes the database over by its own lease and starts in about 3 s with them present: the removal is no longer what makes a start work, and costs nothing, so it stays as a second guard |
  | Starting the node again soon after it was killed fails with `os error 33` | [`node/worker/node-supervisor.js`](node/worker/node-supervisor.js) | a start waits for the previous child's exit and a pause that grows while starts fail |
  | The first seconds of a node empty the origin's bucket of calls (200, refilled at 100 a second): its dials get `os error 33`, a database file cannot be opened, a form waits on "saving" | the node component itself (its dial pace and back-off) | the node holds its dials to 40 a second with a burst of 60, and does not redial an address that just failed |

  [`build/text-patch.mjs`](build/text-patch.mjs) makes every text patch throw when the text it expects is gone (the
  LRU storage one also when it appears twice), and the build stops when a patch matched no file, so moving the pkc-js pin
  cannot ship half a fix; `node/test/build-workarounds.test.ts` runs each against the installed files.
- **The shim's SQLite holds one connection to a file at a time, and the Worker keeps to it where it can.** The shim has no
  locking and each connection remembers a file's size from its first ask (`src/shim/sqlite/README.md` in Orivon), so a
  second connection that writes makes the first fail with `database disk image is malformed`. Every file the Worker opens
  is pkc-js's (nothing of ours opens one, and the board manager's client has no data path, so its stores are in memory):

  | File | Opened by (pkc-js 0.0.132, `dist/bundled/chunks`) | Connections |
  |---|---|---|
  | `<data>/lru-storage-<cache name>` | `LRUStorage`, `node-*.js:35051` over `SqliteCache`, `:34942`: the name-resolution cache and the evm-contract challenge's wallet cache | one each, which [`gap-lru-storage.mjs`](build/gap-lru-storage.mjs) makes of pkc-js's one file for both |
  | `<data>/storage.db` | `Storage`, `node-*.js:30495`, made by each pkc-js instance | one, and two for up to 60 s after the RPC `setSettings` (a person saving pkc-js's options): the server makes a new instance and keeps the old one while a publication ends (`rpc/src/index.js:894-908`) |
  | `<data>/communities/<address>` | `DbHandler`, `local-community-*.js:1392`, one per community; pkc-js closes it first (`destoryConnection`, `:1706`, `:3805`, `:6787`) before it migrates, renames or deletes the file | one, and a read-only second while `pkc.communities` lists the community (`readLocalCommunityIdentity`, `rpc-local-community-*.js:117847`) or an export copies it (`:118011`): neither writes, so nothing is corrupted, but one that meets a transaction the first has open can fail, and the community is missing from that one list |
  | `<data>/rpc-server/rpc-state.db` | the RPC server, `rpc/src/index.js:267` | one |

  The `setSettings` overlap is not patched: it needs Orivon's shim to hold the second connection, a change to Orivon
  and not to this app; nothing of ours, and no spec, saves pkc-js's options through the RPC. Undici's cache store has a `DatabaseSync` in three
  chunks and is never constructed. The node component's `blocks.db` and `keys.db` are its own, under its lease, and do not
  go through the shim.
- **The component's flags are pinned with its hashes, and it is fetched by CID.** The component is Orivon's IPFS node
  ([OrivonBrowser/orivon-ipfs-node](https://github.com/OrivonBrowser/orivon-ipfs-node), MIT or Apache-2.0, its two
  licence files copied beside it), built at a revision whose additions are not yet in that repository's public history,
  and published on IPFS as one folder. [`build/node-component-pin.mjs`](build/node-component-pin.mjs) names the folder's
  CID and lists the node's command-line options beyond the ones every build has (the Worker passes only those, because
  an option the component does not know ends it at once); it holds each file's size and sha256 too. The build fetches
  each file from `<gateway>/ipfs/<cid>/<path>` on `ipfs.orbitor.dev`, `ipfs.filebase.io` and `trustless-gateway.link`
  in turn, and a gateway that errors or sends other bytes than the pin's hands the file to the next, so a plain GET
  checked against the pin is the whole check and no gateway has to be trusted. When none sends it, the build stops and
  names the CID, the file and what each gateway did. `BITSOCIAL_IPFS_NODE_DIR` names a directory that holds the files
  (flat, or under `ipfs-node.p2/`) and is read instead, for a network whose resolver hijacks the gateways or for a trial
  build; each file must match its pin either way. `node build/node-component.mjs <directory> --flags a,b --features x,y
  --cid <cid>` rewrites the pin from a build and the CID it is published under, so moving to another build is one
  command.
- **The Worker calls the node's API over `http`, one socket a request.** A Worker's `fetch` is the engine's, which holds a
  page to six connections to one host and port, and the node's API is one; a few slow reads (a name nobody answers, a
  file nobody serves) then kept a community's key import, which its first signed record waits for, out of the six.
  [`kubo/http-fetch.js`](node/kubo/http-fetch.js) is a `fetch` over `http.request`, as the desktop's Node calls the node
  (no agent pools sockets there, and Orivon's `http` client runs each request over a real `net.Socket` of its own):
  `createNodeFetch` sends the node API's own origin over it and any other URL to the process's `fetch`, and the node
  client, the health check and the status and bandwidth readers take it. `worker/main.js` turns it on;
  `BITSOCIAL_NODE_FETCH=fetch` in the Worker's environment goes back to the engine's `fetch`, for a measurement. It
  sends `Connection: close`, asks for no compression and does not follow a redirect, which the node's API never sends,
  and it asks a call again when the origin's call limiter refused it (the shim's `http` dial, unlike its `net.Socket`,
  does not). `BITSOCIAL_FACADE_TRACE=1` still writes each call.
- **With no pool the node's own limit is the one that matters, so the node serves 64 requests at once and the Worker
  holds none back.** The node answers 503 "gateway busy" to a request that waits more than 2 s for one of its 8 places.
  Ten slow reads out at once hold all 8, and a block put or a name's own record behind them is refused again and again
  until they end, 25 s on: the page waited 26 to 37 s for the first signed record in 4 of 16 runs; with this change 16 of 16 runs
  (8 each in Orivon v0.1.0 and a newer Orivon build, no CPU cap) had it 2.1 to 4.8 s after the press. `nodeArgs` passes
  `--max-concurrent-requests` (`NODE_REQUESTS`), and over `http` [`kubo/lanes.js`](node/kubo/lanes.js) puts no limit on the
  slow reads, because its share of the engine's six also queued a read of a block the node holds (a community's own
  record) behind them for up to 20 s. The lanes stay for `BITSOCIAL_NODE_FETCH=fetch`; `BITSOCIAL_SLOW_CALLS=share` brings
  their share back over `http`, and a number sets how many slow reads may be out.
- **Every refusal the facade makes is in the log.** [`facade-trace.js`](node/worker/facade-trace.js) writes the method,
  the path and the status of each answer of 400 or more, at most forty a minute, because pkc-js reads a refused kubo call
  as a retry or as its own error and neither names the route. The Worker's lines reach the page's console as
  `[bitsocial-node] ...`.
- **pkc-js's own log reaches the page, for the lines that explain a start.** pkc-js writes its log with `debug`, which
  writes nothing unless `DEBUG` names the namespace, and its bundled copy of `debug` calls `util.formatWithOptions`,
  which Orivon's `util` does not have. [`build/gap-debug-log.mjs`](build/gap-debug-log.mjs) turns that one write into a
  call of `globalThis.__bitsocialPkcLog`, which [`diagnostics.js`](node/worker/diagnostics.js) sets to a warning of the
  Worker (`pkc-js <time> <namespace> <message>`, one line, at most 1500 characters), so it reaches the page's console and
  orivon://report as the facade's refusals do. [`enable-diagnostics.js`](node/worker/enable-diagnostics.js) sets `DEBUG`
  before pkc-js loads: always the namespaces of the RPC server's start-up (what it auto-starts at boot, the HTTP router
  set-up it waits for), and, when the page's `startBitsocialNode` call passes `debug` (a comma list of namespaces, such
  as `pkc-js:local-community:*`), those too. [`config.js`](node/worker/config.js) refuses a `debug` that is anything but
  a list of namespaces.
- **A board comes back when the Worker starts again, by pkc-js's own auto-start.** pkc-js's RPC server starts, at boot,
  every community its state database lists as started and not explicitly stopped (`_autoStartPreviousCommunities`),
  after the HTTP router set-up settles; with the node's lines in the log it is `Auto-starting 1 communities` and, about
  six seconds after `ready`, `Successfully auto-started`. The Worker adds nothing to that and must not start the
  communities it finds itself: a community the page created is started by the page (5chan's create-board form calls
  `start`), and a start of one already started is an error (`ERR_COMMUNITY_ALREADY_STARTED`) that the page would show.
  What loses the board after a restart is on the page's side: an app whose pkc-js client asks for its connection before
  the Worker listens is never answered again (the apps' bridges hold the bundle until the node answers).
  [`node/tools/restart.js`](node/tools/restart.js) is the plain-Node run of the Worker's part (a community started, the
  Worker killed with no stop message, started again, whether and when `updatedAt` moves) and `DRIVE_MODE=restart` of
  [`node/tools/shell/run.js`](node/tools/shell/run.js) is the same in the Orivon shell.
- **The gateway is a socket and the RPC never is.** pkc-js reaches the facade inside the process, so the page can reach
  nothing but media and the six calls of the page API on a socket.
- **The challenges are registered in pkc-js's static registry, by package name, and one native module is replaced.** The CLI does the same
  (`PKC.challenges[package] = factory`), so a board that names `@bitsocial/wordfilter-challenge` is configured identically on both. A challenge
  whose dependency is native is run on a pure-JavaScript replacement when the replacement keeps its behaviour (the captcha, whose only native use is
  drawing a PNG) and is left out, with its reason in the list, when not (mintpass keeps its cooldowns in sqlite3).
- **The dashboard is one module in the node bundle, not a copy in each app.** Every feature that adds a screen to the dashboard (the board manager's, and the
  ones after it) is one section of it, so two apps cannot drift apart, and an app still looks like itself: the module's markup is semantic (`nd-` classes, a
  `data-nd-` hook for each thing a test drives) and the app's frame styles it from its own stylesheet. The module is plain JavaScript over a `document` it is
  handed, so its tests draw into a stand-in for one and the same file runs in the page.
- **A board's challenges are edited by reading its settings, replacing `challenges` and writing the whole back.** pkc-js replaces `settings` on an edit, so a
  write of `challenges` alone would drop the board's `pages` and every other setting. The Worker does the read and the write (the server's own `editCommunity`, which
  validates every challenge's options) so the page needs no RPC client, one apply is one write that pkc-js accepts or refuses whole, and a stale page is caught by
  the list it read.
- **A listing request is signed by the board's key, and the node signs it.** The key that proves a board is its owner's is the board's own identity key, which pkc-js keeps
  in the Worker and a page never holds, so the page asks the node to sign a message of a fixed shape and shows it in full before it goes anywhere. Ed25519 over text
  needs no new key and no wallet, and the board's address alone verifies it (section The listing calls). `@noble/curves` is the dependency it added, JavaScript with
  no native part.
- **A reused node reports through the page API.** Another tab's Worker reports to its own page over `process.send`; the page
  that reused it reads the same numbers from `/orivon/api/`, so it shows the node's peers, repo size and reachability.
- **A name is checked by the node's own resolvers and set by the person's own wallet.** The check is made by the name resolvers of the pkc-js instance that hosts the boards, so it
  is the check that matters: what pkc-js reads when a board takes the name. The page never reads Ethereum itself, so the apps' manifests need no new host. The transaction is data
  the node prepares (the resolver contract, read from the ENS registry through the same providers, and the calldata of `setText`) and the page hands to a wallet: the node holds no key of the person's
  and signs nothing, and a page with no wallet shows no button, so the record to set, which is all a person without a wallet needs, is never withheld. `viem` is a direct
  dependency for the transaction's calldata and the resolver read (the `.bso` resolver already brings the same version), and `npm ci` then also lists `utf-8-validate`, an optional
  peer of `ws` that an install without scripts never builds.
- **The dashboard does not change a board's address.** 5chan's Board Settings and seedit's Community Settings both do, and an app's own settings are where a person already looks;
  the check says where. pkc-js accepts a board's change of address to a name that points elsewhere (it emits an error event and goes on), which is why a check comes before the
  change.
- **Seeding is fresh code, and the follow list is read in the page.** The seeder's core is a service on a native SQLite queue and a bundled daemon, which this Worker cannot carry
  (section The seeding calls); what it does is a loop of pins and announcements, which the node's own calls already do. The communities a person follows are in the app's IndexedDB account,
  which only a page reads, so the page sends them to the node and the node keeps the last list: a page that is not open changes nothing, and the Worker, which lives while a page is open, is the only thing
  that seeds. pkc-js's RPC could list the communities the node hosts but not the ones an account follows, which is why the account is read where it is kept.
- **Seeding writes down what it pinned, and releases only that.** The node's pins are one set: a hosted community's blocks, a name's record and a seeded page can be the same block. The ledger (`held` in `seeding/state.json`) says
  which pins seeding made, so turning seeding off unpins those, minus the ones another community on the list also holds, and never one that was there before, and asks the node for one cleanup after the last. A page
  whose pin would pass the limit is taken back at once, not trimmed later, so the space used never passes the limit between two looks.
- **Seeding stops on a limit, not a quota of communities.** A person knows how much disk they give, not how many communities fit in it, so the limit is bytes, checked after each pin on what the node reports the pin weighs. The
  node announces 1024 roots in all, shared with other users of the table; a root it cannot announce stays pinned and is logged, and seeding does not ask for it again.
- **The relay field restarts only the node, and the saved choice wins over the page's.** The relay is one of the node's start options, so naming one is the supervisor's restart with new arguments: the Worker, its RPC and the
  page's connection stay up, and the node's data is not touched. The page's own `relay` option is the first value, so an app that ships one keeps working; what a person saves replaces it, and removing it
  leaves none, so a removed relay never comes back at the next start. Orivon names no relay and neither does the dashboard, which says why one helps and leaves the choice to the person.
- **The reach section does not reuse the board manager's form.** That form is three numbers with a default each, a patch that sends only what changed and a field error keyed to the Worker's setting names;
  a relay is one address with no default, so [`settings-form.js`](page/dashboard/settings-form.js) would carry nothing of its own. The sections share what they have in common instead: the
  `nd-` roles, the `data-nd-*` hooks, the refusal handling (a 403, 404 or 503 hides the section) and the section contract.
