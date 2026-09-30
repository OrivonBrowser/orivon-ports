# The Lounge port reconnaissance

Read against a local clone of **thelounge/thelounge** at `14590bfda615b3f3ee0ee8301a404d79a8076743`
(v4.5.2, MIT). Line numbers are that revision's. `orivon-port recon` does not apply: there is no
Electron preload. The Lounge is a Node server and a Vue client, so this note replaces the recon
step's member count with what the server needs from its host.

## The shape: a server, not a preload

| Fact | Evidence |
|---|---|
| A CLI package, not an Electron app | `package.json:7-9` (`bin`), `index.js:30-31` requires `dist/server/index.js` |
| The client is a Vite build into `public/` | `package.json:16` (`build:client`), `vite.config.ts:64` (`outDir`) |
| The server is TypeScript, compiled by `tsc` into `dist/` | `package.json:17` (`build:server`), `tsconfig.base.json` (`outDir: ./dist`, `module: commonjs`) |
| Private mode is the default: accounts, one JSON file each | `defaults/config.js:19` (`public: false`), `server/clientManager.ts:143-152` (`users/*.json`) |
| It listens on 9000 | `defaults/config.js:36` (`port: 9000`), `server/server.ts:191` (`server.listen`) |
| Its readiness line is "Available at ..." | `server/server.ts:206` |
| Its HTTP stack is `express` 4.20, `socket.io` 4.6 over `ws` 8.11 | `package.json` dependencies, `server/server.ts:219` (`wsEngine: ws.Server`), `defaults/config.js:210` (`transports: ["polling", "websocket"]`) |
| IRC is `irc-framework` over `net` and `tls` | `node_modules/irc-framework/src/transports/net.js:115-152` |
| Scrollback is SQLite through `node:sqlite` | `server/plugins/messageStorage/sqlite.ts:1`, `defaults/config.js:305` (`messageStorage: ["sqlite", "text"]`) |

The client bundle needs no port work: it is a page that talks to its own origin over `socket.io`.
The port is the server's host.

## What the server does that a page cannot

| Behaviour | Evidence | This port |
|---|---|---|
| Reads its install tree with `fs` | `server/server.ts:95` (static `public/`), `:408` (`public/index.html`), `server/config.ts:249-261` (`thelounge.webmanifest`), `server/plugins/packages/themes.ts:36` (lists `public/themes`) | The launcher writes it into the app's files |
| Locates that tree from `__dirname` | `server/rootpath.ts:3-6`, `server/config.ts:118-119`, `server/command-line/start.ts:28` | Each module gets a `__dirname` under the install root |
| Loads modules by a computed name | `server/client.ts:366` (26 `irc-events`), `server/plugins/inputs/index.ts:76` (23 inputs) | Bundle the sources, so esbuild resolves both directories; the build asserts every file is in |
| `require`s by a variable or a computed path | `server/command-line/start.ts:14-19` (`"../server"`), `server/config.ts:118` and `:215` (the two `config.js` files), `server/plugins/packages/index.ts:139` | `globalThis.require` over the shim's `createRequire`; the rest is a declared list |
| Sets a flag through CommonJS `module.exports` | `server/plugins/changelog.ts:87, 104` | A private `module` for that file |
| Writes its home, users and logs with synchronous `fs` | `server/command-line/index.ts:63-68` (`createPackagesFolder`), `server/command-line/start.ts:24-34` | Needs a cross-origin isolated app |
| Watches the users directory | `server/clientManager.ts:89`, `server/plugins/packages/index.ts:194` | `fs.watch` in the shim |
| Runs `git rev-parse` | `server/version.ts:15-20` | Fails inside upstream's own `try`, so the version has no commit suffix |
| Checks GitHub for a release | `server/plugins/changelog.ts:37` (`got` to `api.github.com`) | `https.connect` covers it |
| Follows links for previews | `server/plugins/irc-events/link.ts:420` (`got.stream`) | Off by default (`defaults/config.js:111`, `prefetch: false`); works when on |
| Serves uploads | `server/plugins/uploader.ts:129` (`sendFile`) | Off by default (`defaults/config.js:199-200`) |
| Optional native accelerators for `ws` | `node_modules/ws/lib/buffer-util.js:113`, `validation.js:117` (`require('bufferutil')`, `require('utf-8-validate')`, each in a `try`) | The launcher sets `WS_NO_BUFFER_UTIL` and `WS_NO_UTF_8_VALIDATE` |

## What the port refuses, and where the seam is

| Feature | Evidence | Verdict |
|---|---|---|
| Theme and plugin installs | `server/command-line/utils.ts:102-131` (`require.resolve("yarn/bin/yarn.js")`, `spawn(process.execPath, ...)`) | Refused: it spawns `yarn` |
| Web push | `server/plugins/webpush.ts:5-41` (`web-push`, `vapid.json`) | Refused: there is no push service |
| SOCKS proxy | `node_modules/irc-framework/src/transports/net.js:10, 92-98` | Refused: TLS over an existing socket |
| identd | `server/identification.ts:48-54`, `defaults/config.js:389-391` (`enable: false`, port 113) | Refused: a privileged port; off upstream |
| The dev server | `server/server.ts:84-87` (`await import("./plugins/dev-server")`, which imports `vite`) | Refused by name |
| `undici` | cheerio's `fromURL`, `node_modules/cheerio/dist/esm/index.js:11, 162` | Refused by name: nothing in the server calls it |
| `readline` prompts (`add` with no `--password`) | `server/command-line/users/add.ts:42-54` | The launcher always passes `--password` |

## The host has to give

The first bundle of the server's graph named these Node builtins as missing from the shim:
`tty` (`chalk`'s `supports-color`, `debug`), `readline` (`read`), `http2` (`got`'s
`http2-wrapper`), `node:sqlite`, and, through `undici` before it was refused, `node:perf_hooks`,
`node:diagnostics_channel`, `node:console` and `node:async_hooks`. Beyond builtins: `http.createServer`
with `upgrade`, a `net.Server` on loopback, `fs.watch`, synchronous `fs` in a Worker, and a
`createRequire` that loads a CommonJS file from the app's files.

## Verdict

**A port, at the cost of the host and not of the server.** Zero lines of upstream change, no
bridge members and no generic forwarder: the whole seam is where the server's files live, how its
builtins resolve, and one launcher page. Its risk is the host's completeness, and the build says
so by name when a builtin is missing. The cost that does not go away is that the server lives as
long as the app's last page, so The Lounge is not an always-on bouncer here.
