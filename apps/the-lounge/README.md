# The Lounge

The self-hosted web IRC client, as an Orivon app: **upstream's own Node server, unmodified, runs
in a Worker of the app**, and the page shows what that server serves. Accounts, saved networks,
SQLite scrollback, link previews and the client UI are upstream's; this directory holds a
recipe, a manifest, one esbuild config, four small bridge modules and a launcher page.

- Upstream: `thelounge/thelounge` v4.5.2, pinned in [`recipe.json`](recipe.json), MIT.
  [`UPSTREAM.md`](UPSTREAM.md) says what crosses into this repository (nothing of theirs).
- Reconnaissance, with `file:line` evidence: [`../../docs/the-lounge-recon.md`](../../docs/the-lounge-recon.md).
- Served at `http://127.0.0.1:8890` by `orivon-port serve`; the declared name is `lounge.eth`.

## Running it

It needs a checkout of **orivon-mvp** beside this repository, because the server is bundled
against orivon-mvp's Node shim:

```bash
ORIVON_MVP_ROOT=/path/to/orivon-mvp node src/cli.ts run the-lounge
```

`ORIVON_MVP_ROOT` defaults to `../orivon-mvp` relative to this repository, and the build stops
with a message naming the variable when `src/shim/bundler/esbuild-plugin.ts` is not there. The
build takes minutes: it clones upstream, runs `yarn install --frozen-lockfile` and upstream's own
`yarn build` (the Vite client and `tsc` over the server), then this port's
[`esbuild.orivon.config.mjs`](esbuild.orivon.config.mjs).

Open the served URL in Orivon and accept the prompt. The launcher then, in order:

1. writes upstream's install tree into the app's files (only when its stamp changed);
2. on the first run, asks for an account name and password and creates it with upstream's own
   `thelounge add`;
3. forks the server (`thelounge start -c port=9000 -c host=127.0.0.1`) and waits for its
   "Available at" line;
4. shows `http://lounge.localhost:9000/` in a full-size `<webview>`.

A collapsible log panel shows the server's output. When the server exits, the page says with
which code and offers a Restart button. If another tab of this app already started the server,
this tab finds the port held, stops its own copy and shows the running one: a child outlives the
tab that forked it and ends with the app's last page.

**Where data lives.** In the app's own files, never in the served tree: `lounge-home/` is upstream's
`THELOUNGE_HOME` (`config.js`, `users/*.json`, `logs/`, `storage/`, `packages/`) and `lounge-install/`
is the tree the launcher wrote for the server to read. Clearing the app's storage removes both.

## What it is granted, and why

[`orivon.json`](orivon.json) is what the consent dialog renders. `consentGranularity` is
`all-or-nothing`: the server cannot start without any one of these.

| Grant | Value | Why |
|---|---|---|
| `crossOriginIsolated` | `true` | The server runs in a Worker, and `node:sqlite` (the scrollback) and every synchronous `fs` call need a cross-origin isolated app |
| `net.tcp.listen.local` | `9000` | The server's own listener, on `127.0.0.1` only |
| `web.embed.origins` | `http://*.localhost:9000` | The `<webview>` may show a page only from a listener this app holds on that port |
| `net.tcp.connect` | `*:*`, `127.0.0.1:6667` | IRC servers are the person's choice, on any port. A wildcard host is declarable only with a wildcard port, so `*:6665-6669` is not available; `*:*` never reaches loopback, so a local IRC server needs its own entry |
| `net.https.connect` | `*:*` | TLS IRC (`tls.connect` is checked against this grant, not `tcp.connect`), `https` link previews, and upstream's release check against `api.github.com` |
| `net.concurrentSockets` | `128` | Each IRC network holds a socket, and so does every connection the shown page makes to the server |
| `fs.quotaBytes` | 1 GiB | Scrollback, logs, uploads (off by default) and the install tree |

## Refused by name

- **Theme and plugin package installs** (`thelounge install`, `upgrade`, `uninstall`, the packages
  UI): they spawn `yarn`. `server/command-line/utils.ts` finds it with `require.resolve`, which the
  bundle leaves as a declared call that is never reached.
- **Web push**: it needs a push service, which Orivon does not provide.
- **SOCKS proxies** (`irc-framework`'s `socks` option): they need TLS over an existing socket, which
  the shim's `tls` does not offer.
- **identd** (`identd.enable`, port 113): a privileged port. Off by default upstream.
- **Always-on presence**: the server ends with the app's last page, so The Lounge does not stay
  connected to IRC while Orivon is closed, which is what a hosted Lounge is for.
- **`thelounge start --dev`**: it starts Vite; the bundle carries `bridge/refused-dev-server.js` instead.
- **`undici`**: reached only by cheerio's `fromURL`, which the server never calls;
  `bridge/refused-undici.js` throws by name on every entry point.

## Design notes

**The bundle is built from upstream's TypeScript sources, not from `tsc`'s `dist/`.** `tsc` turns
`` import(`./plugins/irc-events/${plugin}`) `` (`server/client.ts:366`, 26 modules) and
`` import(`./${input}`) `` (`server/plugins/inputs/index.ts:76`, 23 built-in inputs) into
`require(s)`, which no bundler follows. esbuild on the sources resolves each directory as a glob and
bundles every file. The build asserts it: the metafile must hold every `.ts` file of both
directories, counted from the clone, so a module upstream adds is required without an edit here.
Upstream's own `yarn build` still runs first, so `tsc` still type-checks the server.

**esbuild runs with `platform: 'node'`.** Under `browser`, `ws` swaps in a build whose constructor
throws, and `irc-framework` swaps its TCP transport for a WebSocket one. With `node`, every builtin
is left for the shim's esbuild plugin to answer: it maps each one to a shim module, and a builtin it
cannot map fails the build naming the specifier and the importer, which is the list of what
orivon-mvp still has to build.

**The server reads its install tree with `fs`, and the launcher puts it there.** The server reads
`public/index.html`, `public/thelounge.webmanifest`, the `public/themes/` listing and every static
file (`server/server.ts:95, 408`, `server/config.ts:249-261`,
`server/plugins/packages/themes.ts:36`), and requires `defaults/config.js`
(`server/config.ts:118`). None of that is a fetch. The build copies upstream's `public/` (without
source maps) and `defaults/config.js` into `install/` with an `install.json` holding a stamp and the
file list; the launcher writes them under `lounge-install/dist/defaults/` and `lounge-install/public/`
when the stamp changes. That is `tsc`'s own layout, which upstream's `__dirname` arithmetic assumes
(`server/rootpath.ts:3-6` climbs two levels from `dist/server` to the directory holding `public/`).

**Each upstream module gets the names Node's CommonJS wrapper gives it.** The config's esbuild
plugin prepends, on the source's first line, a `__dirname` and `__filename` under
`lounge-install/dist/` (and a private `module` for the one file that sets a flag through
`module.exports`, `server/plugins/changelog.ts:87`) to the modules that read them, and to nothing
else. The port changes where a module believes it is, never what it says.

**`require` calls no bundler can follow are declared, not hidden.** `bridge/install-require.js`
points the `globalThis.require` that esbuild's `__require` holds at its own. A forked child already has a
`require` when the bundle starts and `__require` picks it once, so the bundle's banner
(`bridge/require-forwarder.js`) puts a forwarder there first. It answers `"../server"`
(`server/command-line/start.ts:19`, a name in a variable) from the bundle and hands every other name
to the shim's `createRequire`, which loads a CommonJS file from the app's files: the defaults
(`server/config.ts:118`) and the person's `config.js` (`server/config.ts:215`).
`bridge/bundle-plan.js` lists every other `require` left in the bundle with the reason it is safe,
and the build fails on one that is not on the list, or on a listed one that has gone.

**A computed dynamic import needs its extension in the bundle.** esbuild turns
`` import(`./${input}`) `` (`server/plugins/inputs/index.ts:76`) and the `irc-events` import
(`server/client.ts:366`) into a map keyed `./action.ts` while the call looks up `./action`: every module
is in the bundle and the lookup still misses, so the metafile gate cannot see it. The config's `onLoad`
adds `.ts` to the template in exactly those two files (`withGlobExtensions`, which fails the build when
upstream's text changes), and a second gate reads the bundle: every glob lookup must end in `.ts`, and
there must be one per rewritten import.

**SQLite starts before the server, and its WebAssembly sits beside the bundle.** `node:sqlite` is the
shim's `DatabaseSync` over a WebAssembly engine that starts asynchronously, so `bridge/server-entry.js`
imports `orivon-node-shim/sqlite-ready` first (a top-level `await`; the plugin resolves the name). The
engine fetches `sqlite3.wasm` relative to the file holding its code, which is `server.mjs`, so the
build copies each file the plugin's `shimAssets()` lists into `orivon-dist/` beside it.

**`install/` holds exactly what the server reads.** Run against the built bundle with the launcher's
layout, the server's synchronous reads of the install tree are `dist/defaults/config.js`,
`public/index.html`, `public/thelounge.webmanifest` and a listing of `public/themes`; the static files
it serves come from `public/`. Nothing reads `defaults/` or `package.json` at run time (upstream imports
the latter as JSON at build time), so neither is written.

**The child's `argv` and home.** A fork gives the module `process.argv = ['node', '<path>', ...args]`,
which upstream's commander parses (`start -c port=9000 -c host=127.0.0.1`). `THELOUNGE_HOME` is always
set, since without it upstream reads `.thelounge_home` from the install root.

**The launcher makes accounts with upstream's command, before the first start.** `add` needs the
`users/` directory and writes a `<name>.json` with a bcrypt hash; nothing in this port touches an
account. Creating it before the server starts means the server's first start finds it, without
relying on the server noticing a new file.

## What it needs from orivon-mvp

- `child_process.fork('/server.mjs', args, { silent: true, env })`, with the child's output on
  `stdout`/`stderr` and its `close` event.
- In that Worker of a cross-origin isolated app: synchronous `fs`, `fs.watch` for writes made in the
  same Worker, `http.createServer` with `upgrade`, `net` and `tls` client sockets, `node:sqlite`,
  and `module.createRequire(<file>)` loading a CommonJS file by absolute path from the app's files.
- `orivon-node-shim/sqlite-ready` and `shimAssets()` from the plugin, and `sqlite3.wasm` served beside
  `server.mjs`.
- `net.listen` on `127.0.0.1:9000` under `tcp.listen.local`.
- `<webview>` under `web.embed`'s local pattern, `loadURL`, and the `orivon-popup` and
  `orivon-download` events.
- At build time, an esbuild plugin at `$ORIVON_MVP_ROOT/src/shim/bundler/esbuild-plugin.ts`
  exporting `orivonShimPlugin()` and `virtualRoot`.
