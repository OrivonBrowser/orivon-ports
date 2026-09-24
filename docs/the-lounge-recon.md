# The Lounge: port recon

Read from the upstream clone at `v4.5.2` (commit `14590bfda615b3f3ee0ee8301a404d79a8076743`) on
2026-09-24. The method is [`porting-guide.md`](porting-guide.md); this is the evidence the port
at [`apps/the-lounge/`](../apps/the-lounge/) was built from.

## The shape is not any the guide lists

`orivon-port recon` reads this repository as an Electron app and answers zero everywhere: no
preload, no `exposeInMainWorld`, no `ipcMain` handler, no `electron` import. That is the true
answer, not a missed preload. **The Lounge is a Node server and a web page** — the client in
[`client/`](https://github.com/thelounge/thelounge/tree/v4.5.2/client) is a Vue app served by the
Node server in `server/`, and the two meet over socket.io, not over a preload bridge.

So the question the recon has to answer is the daemon question from
[`port-candidates.md`](port-candidates.md): can the page reach its helper? For The Lounge the
answer decides the whole port, and it is **yes, differently than the candidates table imagines**.
The helper is not a daemon the user runs elsewhere — it is the thing Orivon exists to replace:

| The server does | Evidence | What replaces it |
|---|---|---|
| Keeps IRC connections (TCP 6667 / TLS 6697) | `server/models/network.ts` builds `irc-framework` clients | `orivon.net.connect` / `orivon.net.connectSecure` — the exact capability a browser can never have |
| Speaks the IRC protocol | `irc-framework` (pinned `github:kiwiirc/irc-framework#9578e59`) | an in-page IRC client, [`bridge/src/irc.js`](../apps/the-lounge/bridge/src/irc.js) |
| Translates IRC events into client messages | `server/plugins/irc-events/` (25 files) | [`bridge/src/handlers.js`](../apps/the-lounge/bridge/src/handlers.js) |
| Answers the client's socket.io events | `server/server.ts` `initializeClient` | [`bridge/src/server.js`](../apps/the-lounge/bridge/src/server.js) |
| Persists users, networks, scrollbacks (SQLite) | `server/plugins/messageStorage/`, `server/plugins/storage.ts` | **nothing** — see the scope decision below |

The client is kept byte for byte; the server is re-created in the page. That is the porting
guide's "Orivon takes the helper's place" taken literally, and it is the honest shape for Orivon:
an IRC client whose connections, credentials and traffic live on the user's machine, granted per
origin, instead of on a server operator's.

## The transport, and the one shim it needs

The client opens a **socket.io v4 connection to its own origin**:

- `client/js/socket.ts` — `io({transports: JSON.parse(document.body.dataset.transports || ...),
  path: window.location.pathname + "socket.io/", autoConnect: false})`. The transports list and
  the `public` body class are **injected by the server at serve time** (`server/plugins/html-config.ts`
  replaces `<!--thelounge-transports-->` and `<!--thelounge-bodyclass-->` placeholders left in the
  built `index.html`).
- There is no setting that points the client at another server, so the daemon shape from the
  candidates table (serve the page, run the server elsewhere) would require a fork. Not taken.

The port therefore serves the placeholders' answers itself and takes over the transport:

- `hooks.mjs` writes `public` into the body class (no user accounts exist in the port) and
  `["websocket"]` into the transports attribute — upstream's default also offers polling, which
  a static file server cannot answer.
- `bridge/src/sio.js` replaces `window.WebSocket` before the bundle runs and speaks the
  engine.io v4 / socket.io v4 framing the client expects: open packet, namespace connect, `42`
  event packets, ping/pong. The client's own socket.io-client then works unmodified.

This is the port's one structural difference from every sibling: there is no preload global to
re-create, so there is no `members.json` and the kit's declaration machinery does not apply. The
bridge file is one script (bundled from `bridge/src/*.js` by the clone's own esbuild, so no
source file here exceeds the size limit) that installs the shim and the in-page server.

## The client-to-server API surface, inventoried

From `shared/types/socket-events.d.ts` — the surface is **typed in the shared tree**, which is
what makes this port estimable at all. Server→client: 40 events. Client→server: 27. Both are
consumed or answered by the engine; the expensive ones are `init` (the whole network tree) and
`msg` (every chat line), whose payload shapes live in `shared/types/msg.ts`,
`shared/types/network.ts` and `shared/types/chan.ts`, and are reproduced field for field in
[`bridge/src/state.js`](../apps/the-lounge/bridge/src/state.js).

Command surface: `server/plugins/inputs/` defines 22 built-in commands; the client's autocompletion
list comes from the server's `commands` event. The engine answers with the commands it implements;
[`bridge/src/commands.js`](../apps/the-lounge/bridge/src/commands.js) routes them.

## Scope decisions

**Public mode, session-scoped.** Upstream's public mode (no user accounts, networks and
scrollbacks lost when the page closes) is the closest upstream analogue to what a port can be:
there is no user store to log into and no SQLite to keep. The port runs upstream's public mode,
and its known gaps are the ones upstream's own public mode has. Server-side settings sync is kept
by storing what the client syncs in the page's localStorage.

**Network credentials stay in the page.** Upstream stores network passwords and SASL secrets in
the server's per-user config files, encrypted-at-rest by nothing. The port keeps them in page
memory for the session, which is strictly smaller than upstream's surface and is where an Orivon
app can keep them today. A credential capability for app secrets is an orivon-mvp question, not a
port decision.

**What is refused rather than faked.** Link prefetch (`msg:preview` — the server fetches every
URL pasted; needs a decision about what an app may fetch unattended), file uploads, web push,
message search over SQLite, LDAP and the changelog/update checker are not built and are not
answered with fake data. The client already degrades: without `msg:preview` events links render
as plain links, with `fileUpload: false` the upload UI never mounts.

**Highlights** are the sender-nick match upstream does by default plus the user's own nick;
upstream's custom highlight regexes are a per-user setting parsed server-side and are not built.

## Verdict

Portable, at the cost of one file family no other port has: an in-page IRC client and an in-page
socket.io server, ~1,500 lines of our code, all of it under `apps/the-lounge/bridge/`, none of it
upstream's. The client bundle is upstream's own `vite build`, unmodified — its webpack-era
sibling ports need build wrappers; this one does not, because `vite.config.ts` already sets a
relative `base` and writes everything it serves into one directory.
