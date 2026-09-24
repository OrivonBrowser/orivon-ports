# The Lounge (`the-lounge.eth`)

The Lounge, the self-hosted web IRC client, running in Orivon with no server
behind it. Upstream is a Node server plus a web page; here the page is
upstream's own client build and the server's job — owning the IRC connections
— is done in the page over `orivon.net`: raw TCP for plain 6667, broker-side
TLS for 6697, broker-side DNS. The port runs in upstream's own **public
mode**: no login, no user store, nothing kept after the page closes. The
evidence and scope decisions are in
[`docs/the-lounge-recon.md`](../../docs/the-lounge-recon.md).

## Build and run

```sh
npm run fetch -- the-lounge
npm run build -- the-lounge
npm run serve -- the-lounge
```

Then open Orivon at `http://127.0.0.1:8879/`. The consent prompt asks for two
capabilities before anything runs:

- **Connect to any computer on the internet** (plain TCP) — IRC on port 6667,
  plus the DNS lookups that resolve a network's name.
- **Connect securely to any computer on the internet** (TLS) — IRC on port
  6697, the default in the connect form.

Both declare `*:*` — the user picks the network, there is no fixed list to
declare — plus the loopback spellings (`localhost:*`, `127.0.0.1:*`,
`[::1]:*`), because `*` deliberately means public unicast only and running an
IRC bouncer on localhost is a real The Lounge use case the manifest should
honestly name. Element's manifest makes the same `*:*` call for homeservers.

## What works

- The client UI is upstream's own build, byte for byte what `vite build`
  produces at the pinned commit. Every window, theme and keyboard shortcut is
  theirs.
- Connecting to IRC networks over TLS or plain TCP, with optional SASL PLAIN
  and server passwords. Nick-in-use retries with a random nick, like upstream.
- Channels: join, part, topic, kick, modes, userlists with mode prefixes.
- Messages, notices, actions, wallops, CTCP (including answering VERSION,
  PING, SOURCE and CLIENTINFO requests the way upstream's server does),
  whois, MOTD, /list into the channel-list window, invites, away/back,
  chghost-backed join hostmasks.
- Commands: the full list is in the client's autocompletion — /msg, /query,
  /join (forwarded raw to the server like upstream), /nick, /away, /topic,
  /mode, /kick, /invite, /whois, /ctcp, /raw, /list, /notice, /me, /slap,
  /connect, /disconnect, /quit, and upstream's honest "not connected" errors.
- Highlights: your nick in a channel message opens a mention, tracked in the
  mentions panel; queries always highlight, never self-messages.
- Unread and highlight counters per channel, history paging (last 100 per
  request, in memory), /clearHistory, sort of networks and channels.
- Settings the client syncs are kept in the page's localStorage, so theme,
  colours and layout survive a reload.
- Session messages live in memory (bounded at 10000 per channel, upstream's
  own public-mode shape).

## What is not here, and is not faked

The differences from real The Lounge are exactly upstream's public-mode
differences plus a few refusals. Each is an honest error or an absent feature,
never a stub that pretends:

- **No accounts and no persistence** — networks, credentials and scrollbacks
  exist for the session only. Reloading the page is starting over; the client
  asks before you leave.
- **No link previews** — upstream's server fetches every URL pasted into a
  channel. An app deciding to fetch arbitrary URLs on its own is a decision
  Orivon has not granted, so `msg:preview` is never emitted and links render
  as links.
- **No file uploads, no push notifications, no message search** — upload
  storage and SQLite message logs are server-side state the page does not
  keep; the client's UI for them stays dormant (`fileUpload: false`, push
  unsubscribed, search answers empty).
- **No ignore lists, ban lists, /mute or /rejoin** — server-side per-user
  state; these commands answer with an error that says so.
- **No custom highlight patterns** — upstream compiles the user's highlight
  list into a server-side regex; the port matches on your nick only.
- **No changelog/update checker** — the Versions window reports the port's
  version without phoning GitHub.

## Layout

```
recipe.json     pins the upstream commit; build is upstream's own `vite build`
orivon.json     the consent dialog: net.tcp.connect + net.https.connect, *:*
hooks.mjs       the serve-time HTML injections upstream's server would make
bridge/         the in-page engine (ours, ~1.8k lines):
  lounge-sio.js        socket.io v4 server behind a window.WebSocket shim
  lounge-irc.js        IRC client over orivon.net: codec, register, SASL, PING
  lounge-state.js      networks/channels/users/messages, wire-shape clones
  lounge-handlers.js   IRC events -> client messages (mirrors irc-events/)
  lounge-commands.js   input lines -> commands (mirrors inputs/)
  lounge-server.js     the socket API (configuration, init, input, more, ...)
  main.js              entry: installs the shim, boots the engine
```

The engine modules are ES modules bundled into one classic script by the
clone's own esbuild (`build.also` in the recipe), because the injected engine
must run before the client's module bundle opens its socket.
